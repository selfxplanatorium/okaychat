# Browser worker

Built 2026-10-25, boundaries reworked the same day. Chromium and Scrapling run in their own container (`browser` in
compose, `src/browser/`), not in the app. The app keeps every ownership check, looks up the bytes, and sends the
worker a fixed job type; the worker has no app data, database, provider keys, `OKAYCHAT_SECRET`, or host mounts.

## Services

```
            browser network (has internet)                 sandbox network (internal)
 browser ◄──────────────── okaychat (app) ─────────────────────────────► sandbox
  │  job API :8080, bearer token          │  default network                runner :8080, bearer token
  │                                       ▼                                 runs: own netns, loopback only
  │                                    searxng
  └─ egress proxy (uid egress) ──► public internet (TCP) only
```

Inside the worker container every process has its own user (`docker/browser-entrypoint.sh`):

| Process | User | Listens | May connect to (firewall) |
| --- | --- | --- | --- |
| Job API (role `dispatch`): checks the token, relays jobs. No browser | `jobs` 10001 | 0.0.0.0:8080 | the slot ports and the fetch port, on loopback |
| Render slot N (role `render`): one job, its own Chromium, then the process exits | `slot100NN` 10011… | 127.0.0.1:810N | the egress proxy, on loopback |
| Fetch server (role `fetch`) with Scrapling and its browser as stdio children | `scrape` 10002 | 127.0.0.1:8093 | the egress proxy, on loopback |
| Egress proxy | `egress` 10003 | 127.0.0.1:3128 | DNS to the resolvers in `/etc/resolv.conf`; TCP to public addresses |
| tini and the supervisor shells (restart slots, fetch server, proxy) | root, only `SETUID`, `SETGID`, `SETPCAP` | — | the job API port (health check) |

`BROWSER_MAX_JOBS` (default 2, at most 8) sets the number of slots, so it is still the number of renders at once.

## Job API

`src/browser/api.ts`. Every route except `/health` needs `Authorization: Bearer <token>`.

| Route | Body | Result |
| --- | --- | --- |
| `GET /health` | | `{ ok, chromium, scrapling, egressEnforced, running, waiting, slotsReady, slots }`; 503 unless the token, Chromium, and at least one slot are there |
| `POST /v1/render` | `{ kind: "pdf", html, pdf? }` | `{ pdf }` (base64, at most 50 MB) |
| | `{ kind: "screenshot", html, network: "offline" \| "cdn", width?, maxHeight?, contentSelector? }` | `{ png, width, height, errors }` |
| | `{ kind: "pdf-page" \| "docx-page", file, page }` | `{ png, width, height, label, errors }` |
| `POST /v1/fetch` | `{ url }` | `{ title, content }`, or `{ title: null }` when Scrapling could not read it |

Errors are `{ error, model }`; `model: true` (HTTP 422) marks a message for the model, such as "This PDF has 2 pages."
Bodies are capped at 72 MB. There are no job ids: a result goes back only on the request that started it.

## Authentication and the token

The app creates a random 256-bit token on first start (`browserToken()` in `src/server/browser.ts`) in
`OKAYCHAT_BROWSER_TOKEN_FILE`, mode 0640. In compose that file is in the `okaychat-browser-token` volume; the app's
entrypoint makes the directory `node:10001`, mode 2750 (setgid), so the file's group is 10001, the worker's `jobs`
user. The worker mounts the volume read-only. Result: the job API reads the token; render slots, Scrapling, and the
proxy cannot (tested). No `.env` entry is needed.

The token authorizes render and fetch jobs on the worker, nothing in the app. Slots and the fetch server take no token:
they listen on loopback, and the firewall lets only the `jobs` user connect to them.

## Two rendering policies

| Mode | Used for | Network |
| --- | --- | --- |
| offline | `htmlToPdf` (documents, chat export), PDF and Word page previews (pdf.js, docx-preview from the worker's own `node_modules`), SVG artifacts, spreadsheet previews | Only the document and the files the job staged |
| cdn | HTML and React artifact screenshots | Also `FRAME_NETWORK_HOSTS` (jsDelivr, esm.sh, unpkg, Google Fonts) over https, through the egress proxy |

Per job: a fresh slot process with a fresh Chromium, a fresh context, WebSockets closed, WebRTC and WebTransport
removed before page script runs, DNS limited by `--host-resolver-rules`, `serviceWorkers: "block"`. Blocked requests
come back in `errors` ("Blocked request to …: this render is offline; …" or "…: previews can load only from …").
`file://` and paths that climb out of a served directory are refused.

## Egress: exact boundaries

Two layers.

1. The egress proxy (`src/browser/egress-proxy.ts`) resolves every destination, refuses unless every address is
   public (`publicAddress()`), and connects to the address it checked (no rebinding). Encodings like `0x7f000001`,
   `2130706433`, `0177.0.0.1`, `[::ffff:…]` are normalized before the check. It identifies its client by the uid that
   owns the connecting socket, read from `/proc/net/tcp`: the kernel records that uid when the socket is created, so
   the client cannot choose it. The entry is looked up by the exact local and peer address and port of the accepted
   connection; if it is missing or unparsable the client gets no policy and is refused. Policies: `scrape` → any
   public address; slot users → only the CDN hosts on ports 80/443; anyone else → refused.
2. The firewall (`docker/browser-firewall.sh`, iptables-nft or legacy, IPv4 and IPv6, in the container's own network
   namespace) lets each user open only the connections in the table above. Everything else is rejected, including
   UDP, ICMP, DNS from anyone but the proxy, connections to the container's own address, and IPv6. The proxy user may
   use only TCP to public addresses, plus DNS to the configured resolvers (127.0.0.11 on compose networks; the host's
   resolvers on the default bridge, port 53 only).

What code running as each user can reach, after arbitrary code execution as that user:

| User | Reaches |
| --- | --- |
| a slot user (compromised render Chromium) | the CDN hosts only, through the proxy. Not Scrapling (no port; the fetch server's port is refused), not the job API, not other slots, not the token |
| `scrape` (compromised page in Scrapling) | any public address, through the proxy. Not the slots, the job API, or the token |
| `jobs` | the slots and the fetch server, so the same as the app's jobs. No network |
| `egress` | public addresses over TCP, DNS to the resolvers. Not private, loopback, link-local, or the container's own address |

No worker user can take another's identity: they differ in uid, have no capabilities and `no_new_privs`, inherit no
descriptors beyond stdio (`setpriv` starts each process), cannot read each other's `/proc/<pid>/environ`, `fd/`, or
`mem` (tested), and cannot get a socket the proxy would attribute to another uid.

Earlier design, fixed: the render job server and its Chromium shared a uid with Scrapling's MCP token in their
environment and an allowed path to Scrapling's MCP port, so a compromised renderer could have used Scrapling to reach
any public address. Scrapling now has no port or token, and renders run in slots under other users.

## Start-up and privileges

The entrypoint runs as root with `NET_ADMIN`, `CHOWN`, `SETUID`, `SETGID`, `SETPCAP`. It installs the firewall, checks
that `jobs`, `scrape`, every slot user, and root are refused to 192.0.2.1 and that the proxy user is refused to
loopback, creates the users' scratch directories, then drops `NET_ADMIN` and `CHOWN` from the bounding set (this
needs `SETPCAP`) and execs tini as PID 1. If any rule fails to install, any check fails, or the capabilities are still
there afterwards, it exits 1 before starting anything (tested without `NET_ADMIN` and without `SETPCAP`). Worker users
are started with all capability sets empty and `no_new_privs`.

`docker exec` into the worker still runs with the container's configured capabilities, so a host admin can change the
rules; that is expected.

## Cross-job visibility

Normal operation (no exploit): each job gets its own browser process and context in its own slot, so cookies, storage,
cache, and DOM are never shared between jobs. Nothing is written to disk except the slot's scratch directory, which is
emptied before every slot start.

After a browser compromise:

| Attacker | Sees |
| --- | --- |
| a render slot | its own job only. Other slots run under other users (environment, memory, descriptors refused); the slot process exits after the job, so the next job in that slot starts in a new process with a new Chromium. Process command lines are visible to everyone in the container and contain no job content (HTML and files travel over HTTP bodies) |
| `scrape` | concurrent fetches (at most `BROWSER_MAX_FETCHES`, 2), which share the user: their URLs and page content |

The worker logs only error messages (truncated to 200 characters), never job contents.

## Chromium sandbox

Chromium runs with `--no-sandbox`. Its namespace sandbox needs unprivileged user namespaces with capabilities inside
them; tested on this host (Ubuntu 26.04, kernel 7.0, `kernel.apparmor_restrict_unprivileged_userns=1`), it fails with
"No usable sandbox" under Docker's default seccomp profile, a profile allowing the namespace calls, and even
`seccomp=unconfined` plus `apparmor=unconfined`. The SUID helper is ruled out by `no-new-privileges`. Enabling it would
need host AppArmor changes. The per-user processes, firewall, and per-job slots above are the compensating controls.

## Limits and lifecycle

- One job per slot. The job API waits up to `BROWSER_QUEUE_MS` (30 s) for a healthy idle slot, then answers 503. A
  slot that has taken its job reports unhealthy until it has exited and been restarted (about 0.2 s plus start-up).
- `BROWSER_JOB_TIMEOUT_MS` (25 s) per job. At the timeout, or when the app's request goes away, the job's context is
  closed; if Chromium does not let go within 5 s it is killed. Slots exit after each job either way.
- Measured: a PDF job takes 1.0–1.7 s end to end with a fresh slot and Chromium.
- The supervisor restarts slots, the fetch server, and the proxy when they exit; if the job API exits, the container
  exits and Docker restarts it. The Docker health check calls `/health`.
- `/tmp` is a 512 MB tmpfs with a 0700 directory per user; the root filesystem is read-only.

## App side

`src/server/browser.ts` (client, token), `documents/render.ts`, `documents/visual.ts`, `tools/scrapling.ts`.
`rendererAvailable()` is true when `OKAYCHAT_BROWSER_URL` is set; failures surface as tool errors.

## Development

- `npm run dev` also runs `npm run dev:browser`: the worker in one local Node process on 127.0.0.1:8791 (role `all`,
  `scripts/dev-browser-worker.mjs`), started with a clean environment (no `OKAYCHAT_SECRET`) and the app's token file
  `data/browser-token`. It uses Playwright's local Chromium and an in-process egress proxy. No firewall, no separate
  users, no slots: application checks only; `/health` reports `egressEnforced: false`.
- `scripts/dev-browser.sh` builds and runs the hardened container on 127.0.0.1:8792 (it mounts a 0644 copy of the
  token, since the container's `jobs` user cannot read the app's 0640 file there). Set
  `OKAYCHAT_BROWSER_URL=http://127.0.0.1:8792` in `.env` and restart `npm run dev` to use it.
- Tests use `startTestWorker()` (`src/browser/test-worker.ts`) and `createWorker("dispatch")` against fake slots.

## Verification

`test/integration/run.sh` (isolated compose project) and the unit tests check:

- Per user, with the fixture and positive controls: the TCP matrix above (fixture, app, 1.1.1.1:443, job API by
  loopback and by the container's own address, fetch server, each slot, proxy, the former Scrapling port, IPv6
  loopback and public); UDP from every user leaves the fixture's counter at zero while the tester's datagram arrives;
  only the proxy user resolves names; only `jobs` reads the token; no user reads another's environment, descriptors,
  or memory; every non-root process has empty capability sets and `no_new_privs`; no root process holds `NET_ADMIN` or
  `CHOWN`; the job API user runs no browser.
- Proxy policy: slots reach the CDN and are refused example.com and the fixture; `scrape` reaches example.com and is
  refused the fixture, a rebinding name, loopback forms, encodings, metadata, service names, link-local, `0.0.0.0`;
  `jobs` and root cannot reach the proxy.
- Rendered pages reach no private destination; CDN mode loads only allowlisted hosts; Scrapling reads public pages
  only; offline PDF and page shots; a new slot process per job; recovery after killing Chromium and the proxy; start
  refused without `NET_ADMIN` or without `SETPCAP`.
- Unit: offline staging, traversal, hung jobs and slot release, cancellation, browser replacement, token and job
  validation, the job API's slot handling.

## Image

`docker build --target browser`: node:22-bookworm-slim, Scrapling's venv, Playwright Chromium 1248 with its system
dependencies, iptables, and only the worker's Node packages (`scripts/browser-modules.mjs`).

## Platforms

Verified on Linux amd64 (Docker 29.9, Ubuntu 26.04 host, iptables-nft) on compose networks and on the default bridge.
Not verified: arm64, rootless Docker, Docker Desktop. Where no iptables backend works in a container, or the
capabilities cannot be dropped, the worker refuses to start.

## Residual risks

- A Chromium exploit (no OS sandbox) gets one slot user (its own job, the CDN hosts) or `scrape` (concurrent fetches,
  public internet), as listed above. It finds no stored data or secrets and cannot reach the app, SearXNG, the sandbox,
  the host, or the LAN.
- Kernel exploits and container escape are not prevented by any of this.
- In cdn mode a preview can send data to the allowlisted CDNs in URLs, as the artifact frame in the user's browser can.
