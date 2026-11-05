# ChatGPT plan connection

Chat credentials use Sign in with ChatGPT (SIWC), separate from the Codex CLI image login. The provider id and saved `chatgpt/<slug>` selections remain unchanged. CLI credentials are never migrated into OAuth registrations or used as a fallback for chat.

## Availability

The desktop helper flow is experimental and **off by default**. `OKAYCHAT_CHATGPT_OAUTH_ENABLED=true` and a canonical root HTTPS `OKAYCHAT_PUBLIC_URL` are both required. The flag records deployment readiness, not approval by OpenAI. Do not enable a release until consenting-account checks confirm server-side code exchange using the helper's loopback URI, public model/Responses endpoints, namespaced tools, expiry/rotation and the intended deployment category. These live gates have not been performed in this worktree.

Official references rechecked 2026-11-05: [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [VM deployments](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), and issuer discovery. The VM documentation describes local exchange followed by protected credential transfer; server exchange of a desktop-relayed code remains an application-specific proposal requiring live acceptance. If rejected, design that documented import alternative rather than weakening callback checks.

Mobile users set up or reconnect on a desktop and return to the app. There is no arbitrary public callback or direct phone OAuth in this mode. Managed hosting eligibility must be confirmed separately.

## Modules and boundaries

- `chatgpt-oauth.ts`: fixed production endpoints, PKCE, callback parsing, bounded form transport, maintained RS256 verification through `jose`, token-response parsing and revocation. Access tokens stay opaque. Token response scopes, never callback scopes, grant inference.
- `chatgpt-oauth-store.ts`: encrypted row-bound identities/credentials, stable per-user host ID, registration generation and token version, single-flight refresh with durable sending/uncertain markers. One SQLite writer is required.
- `chatgpt-oauth-routes.ts`: authenticated status/actions, canonical Origin plus session synchronizer CSRF, one-use session-bound launch download, narrowly scoped nonbrowser helper capability routes. All responses disable caching/referrers. Application logging skips these routes; configure proxies to omit their query strings and credentials too.
- `scripts/chatgpt-connect.mjs`: desktop Node helper. The launch file grants authority to finish one pending connection: never share it. No tokens, PKCE verifier or nonce are in the launch file. The helper validates the deployment and loopback listener before opening authorization. No network script piping is required.
- `catalog/chatgpt.ts` and `chatgpt-sse.ts`: public `/v1/models` and `/v1/responses`, scoped catalog cache, request adaptation, namespace mapping, terminal stream validation and utility collection.

Each model handle pins the active registration and generation. Switching, disconnecting or reconnecting invalidates old handles; token refresh only increments token version. A failed compare-and-save never returns the orphan token. Ambiguous rotation stops automatic refresh and asks for reconnect, including sending markers found after restart.

The request adapter uses stateless history, system-to-developer conversion and application function tools under `okaychat`. Hosted tools are excluded. Unknown model capabilities stay conservative. Estimated context/output display limits are 32,768/4,096 when metadata is absent; output limits are informational, not enforced upstream. Explicit cache keys/retention/breakpoints remain off until separately verified. Reported cached usage stays authoritative; plan percentage/reset/tier are unavailable. Catalog and OAuth calls do not write usage.

## Operating constraints

SQLite uses WAL with `synchronous=FULL` so refresh sending/replacement commits survive power loss. This adds a durability sync per commit and can increase write latency. Do not run two refresh owners against a copied database. A replacement restore retains host IDs; a distinct live deployment needs new host IDs and fresh sessions. Never copy active rotating sessions into a second live writer.

The append-only migration preserves image auth bytes, model refs, favorites and chat history. It removes obsolete chat-provider secrets/custom endpoints and unusable shared rows. Rolling back binaries may resume their old chat behavior with untouched CLI auth; do not erase chat data by down-migrating the database.

Automated fixtures use ephemeral databases, mock fetch and locally signed RSA identities. Live helper admission, real tool execution through the public plan grant, real rotation, mobile return and image/chat independence still need release acceptance. No availability or capability claim should be made from mocked fixtures alone.
