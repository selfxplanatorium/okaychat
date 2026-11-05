# Video generation foundation

Only the persistence and transport foundation is implemented. There is **no video tool, worker,
route, setting, player, or Library integration yet**. Importing these modules performs no provider work.
Do not expose paid video settings until admission, quota reservations, recovery, settlement,
cancellation, authorization and the fake-worker failure matrix are implemented together.

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
A future worker must resolve and compare it before every request and check live account permissions.

## Persistence

One append-only migration after outgoing webhooks creates `video_jobs`, `videos`, `video_threads`,
and the usage linkage/cost-state columns and indexes. Its failure seam is
`OKAYCHAT_TEST_FAIL_MIGRATION=video-generation`. The schema is dormant: nothing currently inserts jobs
or videos. Existing usage defaults to estimated. Future job settlement must be transactional and
idempotent through `usage_video_job`; a video receipt is separate from an LLM generation receipt.

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
must create a private staging directory and perform atomic final persistence later. No output is
served by this increment.

## MP4 inspection

`video/mp4` is established from bytes, not an upstream MIME assertion. The descriptor-based inspector
seeks over media payloads and bounds metadata to 4 MiB, boxes to 10,000, depth to eight and tables to
10,000 entries. It checks compatible brands, nonfragmented local sample data, H.264 `avc1`/`avcC`,
optional AAC-LC `mp4a`/`esds`, identity rotation, duration, dimensions, frame rate, chunk/sample counts,
media ranges and cross-track overlap. Unsupported codecs, external data references, fragmented MP4,
non-unit/negative or unsupported edit lists fail closed. This deliberately narrow subset may reject
otherwise valid provider files. Broaden it only with reviewed local fixtures and documentation.

This is container validation, **not full frame decoding**. It cannot establish that every compressed
packet decodes or remove concealed payloads. Future playback must remain an authenticated local native
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
