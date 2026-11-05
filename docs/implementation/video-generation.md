# Video generation

The durable worker and authenticated status/file routes are implemented. Settings → General → Video generation, inline playback and the Library video filter are implemented. Importing modules performs no provider work;
`index.ts` explicitly recovers leases, starts the worker/maintenance, and stops timers on shutdown.
Paid admission is available only through the guarded interactive tool and direct owned retry.

## Contracts and credentials

`src/shared/video.ts` defines public receipts/status DTOs, closed states/errors, supported parameters,
and versioned USD list prices. Models are curated: xAI `grok-imagine-video-1.5-lite` and
`grok-imagine-video-1.5`, and Replicate `google/veo-3.1-fast`. The subset is 4/6/8 seconds,
720p/1080p, landscape/portrait, with audio. Replicate starting images require 8 seconds.
xAI Lite 1080p is upscaled. Estimates use output seconds plus one starting-image input charge;
they are not invoices. Settings default to disabled and persist through the strict settings API; services stay disabled until the account explicitly enables them.

Private credentials reuse `xai` and `image-replicate` through `getOwnConnection`. The latter ID is
historical and must not be renamed. Disabled or missing private keys never fall back to shared keys.
Custom base endpoints are refused, including a trailing-slash variant of the canonical URL.
The fingerprint hashes connection ID, canonical endpoint, and a key digest; it contains no key.
The worker resolves and compares it before each request and repeats the live receipt-origin, chat restriction, assistant-family, voice, account permission and service checks. Queued work cannot dispatch after the chat becomes restricted or its assistant loses the video family.

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
cap, exclusive 0600 output creation, incremental hashing, fsync, and cleanup on failure. The worker creates private staging directories and publishes validated output atomically. Owner-qualified local GET/HEAD supports one byte range and private cache validators; no vendor URL is served.

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
video tables/columns removed. No test calls a vendor. Worker crash/cancel/unknown-billing recovery, ownership routes, quota/accounting and client status tests are implemented. Service/key and Library ownership/filter/pagination tests are implemented; reference normalization/ownership/bounds/staging recovery is covered by `reference.test.ts`.
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
Retry authorization, confirmed UI retry, completed-reference fork retention and inert share/archive projections are implemented. Reference-image and Library lifecycle suites exercise these boundaries.

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
child per parent, and never changes service/model/parameters. The inline UI confirms the possible additional charge before retry. Settings API validates a strict opt-in map.

Completed same-account video references survive forks. Pending jobs are not copied. Public shares
show only an inert tool record. Markdown/PDF exports describe an omitted video; native archives redact
video tool IDs/requests, omit video bytes, and reject video MIME assets. Imported video records are inert.
Output publication uses a same-filesystem exclusive hard link followed by staging unlink, instead of
an overwriting rename, so an obsolete lease cannot replace a newer immutable final file. Parent fsync
and the outcome/file/usage transaction retain the same recovery boundary.

## Inline card

`VideoToolCard` renders the native local player with controls/playsInline/preload=metadata and no
autoplay, plus stage, elapsed time, bounded attempt details, safe errors, cancellation and a confirmed
paid retry. A decoding failure keeps the download link and never starts another generation. The card
reconciles missing accepted results through the thread/assistant/tool-call lookup, and follows the
latest retry. It stays inline through assistant-ui grouping.

`VideoJobClient` keeps status separate from message/LLM metadata, ignores old revisions and late
account responses, closes terminal/offscreen streams, caps five concurrent streams and a 200-entry
session cache, and refreshes via GET on reconnect. Sign-out clears it. Pure client tests exercise
ordering, visibility, account switching, slot limits, offline status, and malformed snapshots.
Usage totals now label known subtotals and unknown video-charge counts without changing token meters.

## Settings, Library and message details

Settings → General lists both services with explicit opt-in, curated models, duration/aspect/resolution
defaults, per-second/per-clip estimates, audio/upscale/reference notes and cancellation billing limits.
xAI links to the private Providers connection. Replicate uses the existing `image-replicate` key and
warns that changes/removal affect images too. Existing shared image credentials remain labelled as shared in image settings and are not offered to video. Shared-only, disabled, noncanonical-endpoint and retired
model states withhold generation; a retired stored model remains visible until explicitly corrected.
Settings writes never mutate image service preferences. Reads/writes are account-scoped and stale
responses cannot overwrite a newer account or selection.

Library videos are completed local files only: one `video:<id>` row, no pending jobs, thumbnails or
preloading grid players. Chat/project filtering checks every surviving owned reference, without duplicate
rows. Origin metadata falls back to a surviving chat. All four keyset sorts are unchanged. Preview uses
the same native player; downloads are ordinary authenticated local links. Confirmed global deletion
removes all references and bytes and historical cards show unavailable. Opaque video uploads stay `other`.
Message Details links media attempts back to the originating card, with separate charges; it never adds
them to LLM generation metadata. Card details also open that panel.

The `video` namespace is required in all shipped locales, as are its permission and assistant-family
labels. English, German, Spanish, French, Italian and European Portuguese have explicit entries.
No browser playback or live provider acceptance has been performed.

## Reference validation and acceptance

`reference.test.ts` covers owned legacy BLOB and file-backed rasters; foreign, missing and forged media
references; URL/path rejection; SVG/HTML, corruption and animation rejection; the 25 MiB/100 MP bounds;
orientation and white alpha compositing; no upscaling and 1280-pixel output bounds; the 1% aspect
constraint; the JPEG quality ladder/256 KiB ceiling; encrypted digest retention; upload deletion after
submission; staging tampering; and terminal cleanup. All transport execution is fake and assertions
include zero submissions/usage on invalid references. The shared sharp queue is reused; no video is
decoded by sharp.

Automated acceptance uses `npm run typecheck`, `npm test`, and `npm run build`, plus the video worker,
provider/security/reference/Library/route/client suites and `storage-migrations.test.ts`. The latter
rewinds earlier schemas, tests the video rollback seam, reopens twice, and checks foreign keys. Worker
fixtures cover the pre-POST crash, ambiguous POST, saved ID, partial download, durable published-file
adoption, cancellation/deletion races, expired leases, shutdown, uncertain billing, exact settlement
and retained quota when cleanup fails. These tests perform no live vendor generation. UI source checks
cover locale coverage, logical direction, settings anchors and client visibility/account/revision state.
Container inspection fixtures establish structural acceptance only; browser playback and live account
acceptance have not been performed or claimed.

## Storage, backups and operating limits

Back up the database and `videos/` together; include `video-staging/` when preserving in-flight jobs.
Private files are stored beneath the configured data directory, with no additional Docker service.
Run one app process per database. Keep the private key enabled and unchanged while jobs run. A request
body is retained encrypted for 24 hours; terminal receipts normally retain 30 days and a completed video's
minimal receipt remains while its file exists. Missing output is unavailable, never regenerated.
Hourly maintenance retries failed cleanup; bytes/reservations stay charged until removal succeeds.

Known limitation: retrying a job after its starting image was normalized copies the retained digest
into a new job without copying its staged JPEG. That retry fails locally before submission; start a
new chat request with the owned image instead. Text-only retries are unaffected.

The inspector is a deliberately narrow H.264/AAC MP4 container check, not full decoding or sanitization.
Local cancellation, unknown submit outcomes, provider charges after local validation/storage failure,
expiring provider outputs and list-price versus invoice differences remain explicit operating limits.

## Deliberate deferrals

Additional transports/model discovery, shared-key video policies, arbitrary endpoints/models,
callbacks/webhooks, partial playable streaming, generic video uploads, longer clips/4K/square, multiple
outputs/references, last-frame interpolation/editing/extension, audio controls, server thumbnails,
transcoding/full decoding, public-share playback, archive byte round trips, completion notifications or
extra LLM replies, invoice reconciliation, automatic paid resubmission, and multiple worker processes
are outside this increment. No endpoint is silently replaced when a curated capability retires.
