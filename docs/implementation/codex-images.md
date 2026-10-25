# Image generation through the Codex CLI

The relay is implemented in `src/server/tools/image.ts`; per-user login and credentials live in `src/server/codex.ts`. The Docker image installs the CLI version pinned in the Dockerfile.

## Why Codex

Each user's own ChatGPT plan pays for the images. No OpenAI API key, no server-wide billing. The CLI has a built-in image tool that a prompt invokes with `$imagegen`.

## Login

`codex login --device-auth` prints a link (`https://auth.openai.com/codex/device`) and a one-time code like `5KSN-DYDCY` (expires in 15 minutes), then waits until the user approves and writes `$CODEX_HOME/auth.json`. Output has ANSI colors. Strip them before matching.

`codex login status` prints `Logged in using ChatGPT` (exit 0) or `Not logged in` (exit 1).

## Credentials at rest

okaychat encrypts secrets at rest, but the CLI only reads a plain `auth.json`. `src/server/codex.ts`:

1. Stores `auth.json` AES-256-GCM encrypted in `codex_auth`.
2. Per run, writes it to a fresh `CODEX_HOME` under `$OKAYCHAT_DATA_DIR/codex-tmp/` (mode 0700). `HOME` points there too.
3. After the run, re-encrypts `auth.json` if the CLI refreshed the token, then deletes the directory.
4. Serializes runs per user. The refresh token rotates, so two parallel refreshes would leave one revoked.

Do not use a dir under `/tmp` for `CODEX_HOME`. The CLI warns and refuses to create helper binaries there.

## Generation

The server invokes `codex exec` as a relay with these controls:

- `--ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check`, `--sandbox read-only`
- Disabled features: `memories goals shell_tool unified_exec hooks plugins apps browser_use computer_use multi_agent`. `web_search="disabled"`, `skills.include_instructions=false`, `--enable skip_host_skill_discovery`.
- `-c model_instructions_file=<relay.txt>` replaces the coding instructions with a short relay prompt.
- `--output-schema` forces `{ "generated_png_paths": [abs path] }`, `--output-last-message` writes it to a file.
- `-m gpt-5.6-luna -c model_reasoning_effort="none"` keeps the text relay cheap. If stderr reports `model is not supported`, retry once with the account default.
- References: `--image <png>` per file, then `-- -` so the prompt comes from stdin (`--image` is variadic).
- Accept only a real PNG whose realpath is inside `$CODEX_HOME/generated_images/`.
- Errors: `ERROR: {json}` lines on stderr. Surface only `error.message`. The transcript echoes the prompt.

### Prompt fidelity

The chat tool passes the user's image request in their own words, allowing only
light cleanup and resolving conversational references. Short or vague requests
are valid; the assistant must not invent style, composition, lighting, colors,
text, aspect ratio, or other details. Embellishment requires an explicit user
request or their agreement first.

The Codex relay is instructed to forward that prompt verbatim to its image tool,
excluding the `$imagegen` invocation. The server itself only prepends that
invocation; it does not expand the prompt. These instructions apply at both model
boundaries because the chat model's tool arguments and Codex's image-tool call
can each otherwise introduce unwanted details.

Output lands in `$OKAYCHAT_DATA_DIR/images/<userId>/<id>.png`, indexed in `images`, served by `GET /api/images/:id` (owner only). Deleting a thread deletes its images.

## Docker

`npm install -g @openai/codex@0.163.0` in the runtime stage (`--build-arg CODEX_CLI=false` skips it). `OKAYCHAT_CODEX_COMMAND` overrides the binary.

## Limits

- No image model selector. The backend picks the model.
- Resolution is selected by the image backend. The app does not pass size or quality flags.
- Generation time depends on the backend. The tool times out after five minutes and stops when the chat request is aborted.
