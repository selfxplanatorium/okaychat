# Video generation foundation

The durable worker and authenticated status/file routes are implemented. There is still **no settings toggle, player or Library integration**. Importing modules performs no provider work;
`index.ts` explicitly recovers leases, starts the worker/maintenance, and stops timers on shutdown.
Paid admission is available only through the guarded interactive tool and direct owned retry.

## Contracts and credentials

`src/shared/video.ts` defines public receipts/status DTOs, closed states/errors, supported parameters,
and versioned USD list prices. Models are curated: xAI `grok-imagine-video-1.5-lite` and
`grok-imagine-video-1.5`, and Replicate `google/veo-3.1-fast`. The subset is 4/6/8 seconds,
720p/1080p, landscape/portrait, with audio. Replicate starting images require 8 seconds.
xAI Lite 1080p is upscaled. Estimates use output seconds plus one starting-image input charge;
they are not invoices. Settings contracts default to disabled; settings persistence is not wired yet.

Private credentials reuse `xai` and `image-replicate` through `getOwnConnection`. The latter ID is
historical and must not be renamed. Disabled or missing private keys never fall back to shared keys.
Custom base endpoints are refused, including a trailing-slash variant of the canonical URL.
The fingerprint hashes connection ID, canonical endpoint, and a key digest; it contains no key.
The worker resolves and compares it before each request and checks live account permissions and service settings.

## Persistence

One append-only migration after outgoing webhooks creates `video_jobs`, `videos`, `video_threads`,
and the usage linkage/cost-state columns and indexes. Its failure seam is
`OKAYCHAT_TEST_FAIL_MIGRATION=video-generation`. Admission reserves 64 MiB output, 256 KiB reference and 32 KiB receipt atomically, with one active job/account, two global open jobs and 20 admissions/day. Tool-call identity and retry-parent uniqueness dedupe admission before live reauthorization. Settlement and terminal outcomes commit together through `usage_video_job`, with five zero token fields and explicit unknown cost. A video receipt is separate from an LLM generation receipt.

## HTTP boundaries

Adapters accept an injected fetch for local tests, use fixed API origins/paths, reject opaque IDs
outside `[A-Za-z0-9_-]{1,200}`, and never retry submits. POST timeouts are 30 seconds, GETs 15,
cancel 10; JSON is capped at 1 MiB. A malformed successful submit is an ambiguous dispatch and must
never be automatically reposted. Replicate submission returns its ID even on immediate success;
the caller must persist it before polling. Polls expose normalized states, billing duration, and
an opaque internal download descriptor; vendor bodies and URLs are not public DTOs.

CDN descriptors only accept HTTPS `vidgen.x.ai`, `replicate.delivery`, or a proper subdomain of the
latter, without userinfo, fragment, or nonstandard port. Downloads use `pinnedRequest` from
`public-fetch.ts`: DNS is checked at connection time, private addresses refused, redirects never
followed, no credentials forwarded. Downloads have a 60-second deadline, a 64 MiB decompressed-byte
cap, exclusive 0600 output creation, incremental hashing, fsync, and cleanup on failure. The caller
must create a private staging directory and perform atomic final persistence later. Owner-qualified local GET/HEAD supports one byte range and private cache validators; no vendor URL is served.

## MP4 inspection

`video/mp4` is established from bytes, not an upstream MIME assertion. The descriptor-based inspector
seeks over media payloads and bounds metadata to 4 MiB, boxes to 10,000, depth to eight and tables to
10,000 entries. It checks compatible brands, nonfragmented local sample data, H.264 `avc1`/`avcC`,
optional AAC-LC `mp4a`/`esds`, identity rotation, duration, dimensions, frame rate, chunk/sample counts,
media ranges and cross-track overlap. Unsupported codecs, external data references, fragmented MP4,
non-unit/negative or unsupported edit lists fail closed. This deliberately narrow subset may reject
otherwise valid provider files. Broaden it only with reviewed local fixtures and documentation.

This is container validation, **not full frame decoding**. It cannot establish that every compressed
packet decodes or remove concealed payloads. Playback must remain an authenticated local native
player with a safe download fallback and no automatic paid regeneration on decoding failure.
Hand-authored tests establish structural acceptance, not successful browser playback.

## Evidence and checks

Contracts rechecked against [xAI generation](https://docs.x.ai/developers/model-capabilities/video/generation),
[xAI prices](https://docs.x.ai/developers/pricing), and the
[Replicate schema page](https://replicate.com/google/veo-3.1-fast/api/schema) on 2026-11-05.
Curated price records retain their source URLs and date. There is no live discovery or silent endpoint
replacement. Revalidate availability before enabling the feature.

`video/core.test.ts` uses fake providers, hand-authored MP4 containers, mocked private DNS and local
streams. `storage-migrations.test.ts` checks rollback/reopen and rewinds older schema fixtures with
video tables/columns removed. No test calls a vendor. Worker crash/cancel/unknown-billing recovery,
reference normalization, ownership routes, quota/accounting and UI tests remain required in later phases.
No dependencies, binaries, container services or raster/image execution behavior were changed.

## Worker and recovery

`VideoWorker` has explicit start/stop, a two-task ceiling, 45-second leases renewed every 10 seconds,
and epoch/state/revision guards on writes. Tests inject the clock, provider, file and failure boundaries.
Submitting is durable before POST, provider IDs encrypted before polling; there is no POST retry.
On restart a submitting row without an ID becomes `submission_unknown` with unknown billing. Polling
resumes the same ID; partial downloads are removed and fetched again. A final published file can be
reinspected/adopted without a provider call. Successful provider billing evidence is saved before
local download/inspection, including host rejection; local failure still settles that cost.

Cancellation persists first and aborts local active I/O. xAI reports unsupported remote stopping;
Replicate uses its explicit cancel API, never interpreting remote stop as a refund. Cancellation wins
against late success unless the success transaction already committed. Browser disconnection and text
turn completion have no connection to media cancellation. Threads clear retained requests and cancel
open jobs before deletion. Account deletion removes video rows before parent jobs, then file trees.
Hourly maintenance retries staging/unreferenced cleanup; reservations remain until bytes are gone.

SSE emits current snapshots, not an event replay log: five streams/account, a 60-second lifetime,
2-second database checks and 15-second heartbeats, bounded slow-consumer buffering, live session and
feature checks. Terminal snapshots close streams. Foreign/missing IDs match. No public submit route.
The worker tests cover pre/post-submit crashes, unknown billing, ID/download/final-file recovery,
lease replacement, local validation charges, five transient polls, deadlines and cancellation races.
Retry authorization/UI and full fork/share/archive lifetime integration are still upcoming.

## Interactive tool boundary

`generate_video` is assembled only for stored ordinary interactive tool-calling turns, with the
independent `videos` feature/family, service opt-in and no active voice call. Excluded modes include
comparison, schedules, delegates, research workers, temporary/restricted chats, channels, evaluations
and the external API. Execution repeats live checks, including receipt ownership/origin and the
current model capability after asynchronous lookup. The receipt getter is assigned after tool
assembly, before execution. The outbound risk annotation uses the existing taint approval gate.

Acceptance is `{version:1,jobId,accepted:true,state:'queued',service,model}`; model output explicitly
says started. Replaying a call returns the original receipt even after preferences change. Explicit
Stop cancels only jobs attached to that LLM receipt; transport disconnects do not cancel video work.
Direct retry checks expected revision and policy, keeps the original receipt/config, creates one
child per parent, and never changes service/model/parameters. UI confirmation is still required before
exposing this paid action. Settings API validates a strict opt-in map; no settings toggle is shipped yet.

Completed same-account video references survive forks. Pending jobs are not copied. Public shares
show only an inert tool record. Markdown/PDF exports describe an omitted video; native archives redact
video tool IDs/requests, omit video bytes, and reject video MIME assets. Imported video records are inert.
Output publication uses a same-filesystem exclusive hard link followed by staging unlink, instead of
an overwriting rename, so an obsolete lease cannot replace a newer immutable final file. Parent fsync
and the outcome/file/usage transaction retain the same recovery boundary.
