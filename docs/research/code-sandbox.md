# Code sandbox (`run_code`)

Built 2026-10-20. Models run Python 3.12 and Bash in a separate container, one workspace per chat.

## Design

- One shared container (`sandbox/`), not one per user or chat. Per-user containers would cost idle memory, cold starts, lifecycle code, and Docker socket access for the app. Isolation inside the container comes from the rules below.
- The app container is never used to run code: it holds `OKAYCHAT_SECRET`, `/data`, and the network route to SearXNG.
- `sandbox/runner.py` is a stdlib HTTP service. The app calls it with `OKAYCHAT_SANDBOX_TOKEN` (bearer). `src/server/tools/sandbox.ts` holds the tool, the download route, and workspace deletion.
- Workspace id = first 32 hex chars of `sha256("sandbox:" + userId + ":" + threadId)`. The sandbox never sees user or thread ids.

## Safeguards

| Risk | Control |
| --- | --- |
| Reading another chat's files | Each workspace is a `0700` directory owned by its own uid (20000–29999). `/work` is `0711`, so names cannot be listed |
| Leftover or background processes | Runs in a workspace are serialized. After each run every process of that uid is killed, found by the real uid in `/proc/*/status` (a non-dumpable process shows as root-owned in `/proc`) |
| Fork bombs, memory, CPU, disk | `prlimit` per run: processes 64 (counted per uid), address space 2 GB, CPU time, file size, 256 open files. A watchdog stops runs that grow the workspace past 1 GB. Container: 2 GB memory, 2 CPUs, 512 pids |
| Poisoned packages or files outside the workspace | Read-only root filesystem. `/tmp` is a tmpfs; files a run leaves there or in `/dev/shm` are deleted after it. `HOME` and `TMPDIR` point into the workspace |
| Token theft | The runner pops `SANDBOX_TOKEN` from its environment and gives children a fixed environment. Its `/proc/<pid>/environ` is unreadable to workspace uids |
| Symlink tricks against the root runner | Downloads resolve the real path and require it inside the workspace. Writes use `O_NOFOLLOW` and refuse symlinked parents. The runner recreates `.okaychat/` if code replaced it. All happen under the workspace lock, when no process of that uid is alive |
| Network | Compose puts the sandbox only on an `internal` network: no internet, no SearXNG, no host. The app reaches it by name |
| Privilege | `cap_drop: ALL` plus CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, KILL; `no-new-privileges`. Only the runner is root |
| Untrusted output files on the app origin | Downloads are served with `Content-Disposition: attachment`, `CSP: default-src 'none'; sandbox`, and `nosniff`. `<img>` previews still work, and a direct SVG cannot run script |

Verified against the real container on 2026-10-20: cross-workspace reads, `/work` listing, token in env and `/proc`, read-only root, `/tmp` cleanup, background and `setsid` and non-dumpable processes, timeout, fork bomb, 3 GB allocation, output cap, symlink downloads to another workspace and `/etc/passwd`, `.okaychat` symlink swap, upload path traversal, and no egress on an internal network.

Not covered: kernel or container escapes (same blast radius as any container), and side channels between concurrent runs such as CPU timing.

## Retention

The sandbox is scratch space, never the source of truth:

- Every workspace is wiped ~30 minutes after its last run (`SANDBOX_IDLE_MINUTES`, default 30; a completed run touches the workspace's mtime; expiry is rechecked under its lock). The sweep runs in a background thread and kills the workspace's uid processes. The container also wipes every workspace when the runner starts.
- Right after each run, the app downloads the files the run produced and stores them in SQLite (`sandbox_files` table), counted against the user's storage quota (see below). Download URLs in the tool result point at `/api/sandbox/:threadId/stored`, which serves the stored copy with the same untrusted-content headers. Files over the runner's 50 MB download cap keep a direct sandbox URL and die with the workspace; the tool result then carries a `storageWarning` for the model.
- Rewriting a file in a later run replaces its stored copy instead of piling up versions, charging only net byte growth. The Library lists, previews, downloads and deletes these copies. Deleting the chat deletes the stored copies (foreign-key cascade).

## Behavior

- Each call is a new process: variables do not persist, files do — until the workspace is wiped (see Retention). Background processes end with the call.
- Output keeps the first 48 KB and last 16 KB of each stream. Timeout default 60 s, max 300 s. Up to 4 runs at once; a run waits up to 30 s for a slot.
- Stop in the chat calls `/cancel`, which kills the workspace's processes.
- Attachments: every non-anonymous attachment is stored regardless of sandbox configuration (`/files/store`) and its header carries `file_id`; `input_files` copies it into the workspace. Saved outputs also return a `fileId` accepted by `input_files`, so a later run can restore their durable bytes after scratch expiry (using a safe basename). Images retain their original data URL message parts as well.
- Created or changed files come back with app download URLs (`/api/sandbox/:threadId/stored?path=` (scratch proxy fallback: `/files?path=`)). `toModelOutput` strips the URLs. Images render inline in the card.
- Not offered to anonymous chats or sub-agents. Settings → General toggles it per user; it shows only when the server has `OKAYCHAT_SANDBOX_URL` and a 32+ character token.

## Runner API

All routes except `/health` need `Authorization: Bearer <token>`. `ws` is `[a-f0-9]{16,64}`.

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness |
| `POST /workspaces/:ws/run` | `{ language, code, timeout }` → `{ exitCode, stdout, stderr, stopped, durationMs, files, deleted }` |
| `POST /workspaces/:ws/cancel` | Kill the workspace's processes |
| `GET /workspaces/:ws/files` | List files (hidden: `.okaychat`, `.cache`) |
| `GET /workspaces/:ws/files?path=` | Download, 50 MB max |
| `PUT /workspaces/:ws/files?path=` | Upload, 50 MB max |
| `DELETE /workspaces/:ws` | Delete the workspace |

Runner env: `SANDBOX_MAX_TIMEOUT` (300), `SANDBOX_MEMORY_MB` (2048), `SANDBOX_WORKSPACE_MB` (1024), `SANDBOX_MAX_PROCS` (64), `SANDBOX_CONCURRENCY` (4), `SANDBOX_IDLE_MINUTES` (30), `SANDBOX_TTL_DAYS` (14, superseded in practice by the idle sweep).

## Image

`python:3.12-slim-bookworm` plus pinned packages in `sandbox/requirements.txt` (numpy, pandas, scipy, matplotlib, sympy, scikit-learn, pillow, openpyxl, python-docx, pypdf, requests, beautifulsoup4, lxml, pyyaml, tabulate) and curl, jq, sqlite3, git, zip, unzip, file, ripgrep. About 840 MB. To allow internet access, add a non-internal network to the `sandbox` service; the tool description already tells models it may be blocked.
