# Ollama

Ollama is a first-class provider (`format: "ollama"`, provider id `ollama`), not a custom OpenAI-compatible endpoint. The existing `custom-*` OpenAI-compatible flow stays unchanged for LM Studio, vLLM, and older proxies.

The native code lives in `src/server/catalog/ollama.ts` (transport and model metadata), `src/server/ollama-model.ts` (the AI SDK adapter), `src/server/catalog/ollama-routes.ts` (health, pull, delete), and `src/web/components/settings/OllamaSettings.tsx` (the Providers panel). `src/server/llm.ts` selects the native adapter for `format: "ollama"`.

## Connection

A connection is a normal `provider_connections` (or `shared_connections`) row with `provider_id = "ollama"`. It stores only `base_url`, the enabled switch, and `config_json.name`; there is no API key. The default address is `http://127.0.0.1:11434`, and it is written to the row when no address is supplied, so the guarded rule applies even to an omitted URL. Inside Docker that loopback address belongs to the app container, so a daemon on the host is normally reached at `http://host.docker.internal:11434` (Linux users may need `host-gateway`). A path prefix is kept, so a reverse proxy such as `https://host/ollama` works.

Saving an address uses the same encrypted connection flow as every provider. Changing the origin only matters for keys; Ollama has none. The generic provider switch, disconnect, and server-wide audience controls keep working.

## Native endpoints

| Endpoint | Use |
| --- | --- |
| `GET /api/version` | Version shown by the connection test / health line |
| `GET /api/tags` | Installed names, sizes, digests, family, parameter size, quantization |
| `POST /api/show` | `capabilities` and `model_info` (architecture, context length, embedding length) |
| `GET /api/ps` | Loaded models, VRAM size, expiry |
| `POST /api/chat` | Chat streaming (NDJSON) |
| `POST /api/embed` | Embeddings (data layer only; no UI yet) |
| `POST /api/pull` | Pull with streamed layer progress |
| `DELETE /api/delete` | Remove an installed model |

### Model metadata

`/api/show` is authoritative. The adapter uses it instead of models.dev:

- `capabilities` selects tools (`tools`), images (`vision`), and thinking (`thinking`).
- `model_info[<architecture>.context_length]` fills the context window. A daemon that omits it falls back to 4096; that is a fallback, not a fabricated catalog value.
- Only models with the `completion` capability reach the chat picker. Embedding-only models stay in the management inventory so they can be pulled or deleted.
- Tag details fill family, parameter size, and quantization. `/api/ps` marks loaded models and adds VRAM/expiry.
- Refs are `ollama/<name>`, and `<name>` keeps tags, namespaces, and registry prefixes (`ollama/hf.co/user/model:Q4_K_M`). `resolveModel` splits the ref at the first slash, so slashes inside the native name stay in the id and remain unique.

An unreachable daemon during a metadata refresh keeps the last good list, so a chat whose model was already listed does not suddenly become unknown. `resolveModel` rechecks once for an unknown Ollama ref so a stopped daemon returns an actionable message instead of "Unknown model".

The tag list is cached for 60 seconds and each `/api/show` result for 10 minutes. Shows run four at a time. A successful pull, a delete, or a connection save clears the caches. An expired tag list is refreshed behind the request; the first page load after a restart waits for it.

## Chat adapter

The installed AI SDK is v7 and speaks `LanguageModelV4` (`specificationVersion: "v4"`), not V2. `ollama-model.ts` implements that interface directly in-repo; no extra provider package or dependency is needed. `llm.ts` builds it with the model id, base URL, the connection's guarded bit, and the `thinking` capability, and leaves `markCache` as a plain system+messages passthrough.

Mapping from the neutral prompt:

- System messages pass through as separate native `system` messages. There are no cache-control fields to add.
- User text parts join; image files become the native `images` base64 array. Inline text files become text. A non-image file that is not text is rejected with a clear error instead of being dropped. HTTP image URLs are rejected because Ollama needs the bytes in the request.
- Assistant text and tool calls map to `message.content` and `tool_calls`. Prior thinking is intentionally not replayed.
- Tool results become `role: "tool"` messages with `tool_name` and the result text. JSON results are stringified; images in tool results are called out as text-only.
- Native tools use the `{ type: "function", function: { name, description, parameters } }` shape. `toolChoice: "none"` omits `tools` so the final answer step can run; `required` is passed through with a warning because Ollama decides for itself, and `tool` narrows the list to that one function.
- `temperature`, `top_p`, `top_k`, `num_predict`, `stop`, `seed`, `presence_penalty`, and `frequency_penalty` go in the native `options` object. `responseFormat` JSON becomes `format` (a JSON schema when one is supplied). Reasoning maps to `think` only for models whose `/api/show` capabilities include `thinking`.
- Streaming parses NDJSON: `message.content` becomes text deltas, `message.thinking` becomes reasoning deltas, and `message.tool_calls` becomes tool-input plus tool-call parts. Ollama does not send tool-call ids, so the adapter generates unique ids. `done_reason` maps to the AI SDK finish reason; data-bearing tool calls map to `tool-calls`. `prompt_eval_count` and `eval_count` fill input/output token usage. `doGenerate` uses the same mapping with `stream: false`.
- `abortSignal` reaches the HTTP request and closes the response body. A user Stop, a cancelled pull, or a closed tab does not leave a retry loop running.

## Model management

- `GET /providers/ollama/status` (and the admin equivalent) reports version, installed count, and loaded count. `POST /providers/ollama/test` tests the address currently in the form, before it is saved.
- `GET /providers/ollama/models` returns the inventory: every installed model, metadata, and `/api/ps` loaded state. A model whose `/api/show` fails still appears with a `showError` badge.
- `POST /providers/ollama/pull` streams `application/x-ndjson` progress lines. The parser handles split chunks, multiple lines per chunk, `\r\n`, and a final line without a newline. `{ "error": ... }` lines become a visible error. Only one pull per user and daemon runs at a time.
- `DELETE /providers/ollama/models` removes a model. The UI asks for confirmation first.
- `POST /api/embed` supports `input` as a string or array and returns the embedding vectors. This is the data layer for later knowledge/RAG work; there is no embeddings UI.

Cancelling a pull aborts the app's HTTP request and closes the response body. Ollama may continue downloading in the daemon after the client disconnects; the UI says so. There is no separate daemon-side cancel endpoint.

## Security and permissions

Native requests use the same transport rule as every other user-chosen URL:

- `Connection.guarded` is set for a non-admin's own base URL. `ollamaRequest` then uses `publicFetch`, including on every redirect, for status, tags, show, ps, chat, embed, pull, and delete. Loopback, private, link-local, and tailnet addresses are refused. The route-level `privateUrlError` also refuses an unsaved local test URL for non-admins.
- Admins may use `127.0.0.1`, `host.docker.internal`, and LAN addresses, matching the custom OpenAI-compatible provider rule. `publicFetch` is not weakened.
- Health and inventory read the connection the user can use (own, else the audience-approved shared row). Pull and delete require a row the user owns. A viewer of a shared connection gets read-only inventory; the Admin → Providers page (`/api/admin/providers/ollama/*`) is the only place the shared daemon's models change.
- Admin routes are behind `requireAdmin`. No management endpoint accepts an arbitrary URL or connection id: the address is either the owned stored row or an unsaved test address that passes the same SSRF check.
- Native management errors are returned, not swallowed: daemon unreachable, model missing, pull failure, and malformed embedding responses all reach the settings panel.

## Limitations

- Ollama has no cache breakpoints or cache keys. The adapter sends none; the daemon manages its own KV/prefix reuse. Context compactions and model switches start cold.
- `toolChoice: "required"` is not enforceable natively and only produces a warning. Tool-call ids are generated because the daemon does not provide them. Prior assistant thinking is not replayed.
- Assistant messages can carry only text and tool calls; file content there is rejected. Tool result images are not sent, only a text marker.
- When `/api/show` omits `context_length`, the adapter uses 4096. Metadata is not merged from models.dev, so a conflicting catalog value can never override the daemon.
- A cancelled pull can keep running in Ollama. A daemon restart or model change also invalidates the app's caches only on the next refresh.
- The model picker uses the existing context and capability rendering; parameter size, quantization, VRAM, and loaded state appear in the management panel, not the picker.
- The inventory is fetched when the Ollama panel opens or a pull/delete completes; another tab or an external `ollama pull` appears after Refresh.
