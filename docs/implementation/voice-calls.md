# Voice calls

A voice call is a continuous spoken conversation with the assistant: talk, hear the reply as it is generated, interrupt, and keep going. Two engines share one call view:

1. **Local pipeline (default, no account keys):** microphone VAD → PCM16 to the server → faster-whisper partial and final transcripts → a **normal chat turn** → the reply's sentences → Piper audio → AudioWorklet playback.
2. **OpenAI Realtime (optional):** the account's OpenAI key stays on the server; the browser gets only an SDP answer. Speech-to-speech runs directly on OpenAI. If it cannot start, the same call falls back to the local pipeline with a visible reason.

Read aloud and dictation are unchanged; see `docs/implementation/speech.md`. The call protocol is `src/shared/voice.ts`.

## Transport and security

```
browser ── WebSocket /api/voice/call ── server CallSession ── speech worker (Whisper/Piper)
   │                                              └────────── OpenAI Realtime signalling (SDP only)
   └── normal /api/chat turn (assistant-ui transport)
```

- One WebSocket per call at `/api/voice/call`, upgraded through `@hono/node-server`'s `upgradeWebSocket`. The codec is `src/server/voice/ws.ts` (`MiniWebSocketServer`, no `ws` dependency): RFC 6455 masked client frames, fragmentation (bounded to 1,024 fragments and 256 KiB), ping/pong, close (1-byte payloads, invalid codes, and invalid UTF-8 reasons are protocol errors), minimal extended lengths, 1009/1007/1002 on size, encoding, and protocol faults. A throwing message handler is not misreported as bad UTF-8.
- The session cookie is the only credential. `requireUser` runs before the upgrade; the session hash is re-checked by a server timer, not only by client pings, so a revoked session ends within ~5 s even while preparing or while a client streams audio without pinging. `Origin` must be a canonical serialized `http(s)` origin (no credentials, path, query, or fragment) that matches the request origin (including `x-forwarded-proto`/`x-forwarded-host` behind a proxy) or `OKAYCHAT_PUBLIC_URL`; the only scheme mismatch allowed is an `https` page behind an `http` TLS-terminating proxy on the same host. A missing or malformed Origin, `ftp:`/`file:`, a host-spoofing spelling, or `Sec-Fetch-Site: cross-site` gets HTTP 403 before the upgrade.
- One call per account in `CallRegistry`. A second start without takeover gets `busy`; with takeover the older call ends first. `StartLimiter` allows 10 starts per account per 10 minutes (in memory, reset on restart).
- A call is bound to the chat that started it. The server checks ownership at `start`; `tmp_` temporary chats are accepted because they are never stored. The client captures that chat's runtime at start and ends the call if the open chat changes, so audio and cancellations can never land in another chat.
- The server watchdog runs from the upgrade, not only from `ready`: start, preparation (10 minutes, plus the 45 s silent-socket rule), duration, and idle limits all apply in every phase. A model warm cannot keep an abandoned connection alive.
- Call sockets carry no secrets: availability, errors, transcripts, and SDP only. OpenAI API keys are read from the encrypted connection on the server; the browser never sees one.

## Local pipeline

1. The server warms the account's Piper voice and the admin's Whisper model (`/warm` on the worker, which downloads on first use) and reports the chosen voice in `ready`. The call UI shows "Preparing voice models…" while it waits.
2. The browser opens the microphone with `echoCancellation`, `noiseSuppression`, and `autoGainControl`. A capture AudioWorklet emits 40 ms Int16 frames; unusual AudioContext rates are linearly resampled to 16 kHz. The permission prompt is bounded (20 s) and a prompt that answers late has its tracks stopped. A context that cannot resume is a visible failure, not a silent call; a mute chosen while the prompt was open is applied when tracks exist.
3. `VoiceActivity` (energy dB, 3-frame attack, 700 ms hangover, 200 ms pre-roll, 250 ms minimum, 60 s cap) endpoints utterances. Frames are streamed; a partial transcript arrives about once per second of new speech for the first 20 s, and the final transcript when the user pauses. The server accepts even-byte PCM16 frames only, runs at most one final and one partial transcription per call, and refuses a new utterance start while a final is running with a protocol error plus an empty `final` ack, so the client never waits forever.
4. **Only the final transcript appends a message.** It is appended through the bound chat runtime with `metadata.modality = "voice"` and `metadata.custom.voiceCall = "local"`, so the ordinary `/api/chat` turn runs with the chat's model, tools and approvals, RAG/knowledge, memory, MCP, email, compaction, cancellation, history persistence, and usage. There is no second chat path.
5. `voiceCall` is added to the *per-turn* context block beside the spoken user message (`turn.ts`, `withVoiceNotes`), never to the shared system prefix. It is derived from stored metadata and replayed byte-for-byte, so it does not break prompt caching. The temporary-chat path does the same per message.
6. The streamed reply text is cut into sentences by `SentenceChunker` (no cut before the character after punctuation arrives, fenced code skipped, 600-character cap) and sent as `say`. The server synthesizes sentences strictly one at a time; each is streamed back as binary frames with a 4-byte sentence id. `JitterBuffer` waits for a 180 ms cushion and keeps order. The playback AudioWorklet plays a gapless FIFO with no overlapping sentences; an arriving chunk never rewinds the chunk being played, and the FIFO is bounded to 30 s of audio, dropping (and reporting an overflow notice for) audio that cannot keep up instead of growing without bound. Audio and `said` acknowledgements that arrive before the worklet exists are queued in wire order and flushed once it is ready.
7. **Barge-in** while speaking or thinking immediately clears local audio, sends `say.cancel` (server aborts the queued/running synthesis and drops later sentences), cancels only the run this call started in its bound chat, and starts a new utterance. Sentence ids at or below the cancellation are dropped, so a late frame cannot restart playback. The state stays `interrupted` until the next turn.

## OpenAI Realtime (optional)

- Available when the account has an OpenAI chat connection (or an admin-shared one it may use) and the model policy allows the chosen Realtime model. The voice is `speech.call.realtimeVoice`, else the read-aloud Realtime voice, else `marin`.
- Credentials and grants are read again when the SDP offer arrives: a key removed or model revoked during microphone/WebRTC setup cannot make an upstream request. A changed model requires a new call.
- The browser creates an `RTCPeerConnection` with a microphone track and an `oai-events` data channel, sends its offer as `rt.offer`, and sets the server's `rt.answer`. The server posts the SDP plus the session (`instructions`, input transcription, semantic VAD with `interrupt_response`, output voice) to `${baseURL}/realtime/calls`. Setup counts as running only after the data channel is open and the peer is connected (15 s bound). A data-channel `error` event, a channel error, a lost connection, or an output `play()` rejection fails the setup and falls back instead of leaving a silent call.
- Final user and assistant transcripts arrive on the data channel. They are committed as `modality: "voice"` messages in the starting chat through assistant-ui's voice session, and appear as history after the call.
- **Honest scope:** the Realtime model answers directly. It does not use this chat's tools, knowledge collections, memory, MCP servers, compaction, or attachments, and its usage is billed by OpenAI outside okaychat's `usage` table. The server puts the most recent ~6,000 characters of this chat into its instructions as data (wrapped with `wrapUntrusted`), so the conversation has context but is not the normal chat pipeline. The call view says this while a Realtime call is active.
- On a signalling error, a failed setup, a lost data channel, or a dropped peer connection, the controller disconnects the voice session and sends `rt.failed`. The server switches the *same* call to the local pipeline (`ready` with `fallback`) and the microphone starts. The call view shows the translated failure reason and fix for the fallback code, never the provider's raw diagnostic. If local is unavailable, the call ends with the Realtime error and a Retry. There is no automatic reconnect loop. A Realtime setup that ends while `getUserMedia` is still pending stops the late stream, and the installed `createVoiceSession` disposes controls (and therefore the peer, channel, and tracks) when the call ends before setup returns.

## Call UI

`src/web/speech/call/`:

- `CallView.tsx`: a Base UI `Dialog` — full screen on phones, a large sheet on desktop. Live meter, state text (Connecting/Preparing/Listening/Thinking/Speaking/Interrupted/Ended/Error), engine and voice, elapsed time, a scrolling transcript (new exchange only), mute, and one obvious End. The engine is an accessible radio group (arrow keys) that can be chosen before starting. Focus is trapped and restored by the dialog.
- **Local is the default and never silently becomes cloud.** If local is unavailable, Start is disabled, the local option explains why, and the user must pick Realtime explicitly; loading availability does not move the preference to Realtime. A worker that is configured but currently down still shows the call button and the view's Retry re-probes `GET /api/voice`. Realtime → local fallback (explicitly chosen Realtime) still works.
- **A call needs the chat's spoken turn to own the chat.** The composer button, the `call.start` command, and `CallController.start` all refuse while the chat is running a reply, dictating, or showing cached history the server has not replaced yet. The reason is shown (Chat busy / Chat still loading). Starting a call stops any read-aloud in that chat, and automatic read-aloud is suppressed while a call is active, so two TTS outputs never overlap. Dictation and read-aloud outside a call are unchanged.
- Keyboard: Space toggles mute anywhere on the call surface (buttons are still activated with Enter; Space is taken by the shortcut), Escape ends and closes, and `chat.voiceCall`, `call.start`, `call.mute`, `call.end`, `call.retry`, `call.refresh` are global-scope commands, so they also run from the command list while the call dialog is open. The composer's phone button appears when any engine is configured, even if currently unreachable.
- `state.ts` is the pure state machine; `vad.ts`, `chunker.ts`, `jitter.ts`, and `media.ts` (resampling) are pure and tested. `controller.ts` owns the socket, the local media, the runtime turn, sentence ids, barge-in, and cleanup. `realtime.ts` is the WebRTC adapter.
- Every start has a generation. A late `initialize`, handshake, `getUserMedia`, Realtime setup, or Player `ensure` from an ended or retried call stops only the resources it captured and cannot mutate, fail, or close the newer call. A socket still CONNECTING is closed with a bounded handshake timeout, and its late `onopen` sends no `start` or pings. The controller appends to and cancels only the chat runtime captured at start, so switching chats cannot append into or cancel the new chat's run.
- Reduced motion shows a static level bar instead of the animated meter. Semantic tokens and `depth-*` utilities are used for light/dark; controls are at least 44 px on touch and the layout works at 360 px.
- Ending, retry, unmount, tab close (`pagehide`), and a chat switch all stop microphone tracks, close AudioContexts/WebRTC/sockets, and cancel only the call's own in-flight turn. Late microphone or WebRTC permission results stop their own tracks if the call is gone.

## Failure states and fixes

Every failure renders a translated reason, a fix, and Retry. Retry releases the previous call's resources first.

| Code | Shown as | Fix |
| --- | --- | --- |
| `mic` | Microphone blocked | Allow the microphone for this site |
| `insecure` | HTTPS required | Serve okaychat over HTTPS or localhost |
| `unavailable` | Voice calls unavailable | Admin enables Whisper/Piper or the account connects OpenAI |
| `worker` | Speech worker offline | Start the speech worker container |
| `model` | Whisper model missing | Install/choose the model in Admin → Voice |
| `voice` | Piper voice missing | Install/choose the voice in Settings/Admin → Voice |
| `network` | Connection lost | Check the network; Retry |
| `busy` | Call already open | End the call in the other tab/device |
| `rate` | Too many calls | Wait a few minutes |
| `thread` | Chat missing | Start from a chat that still exists |
| `limit` | Call limit reached | Start a new call |
| `idle` | Call timed out | Start when ready |
| `duration` | Time limit reached | Start a new call |
| `realtime` | Realtime could not start | Falls back to local when possible; Retry or choose local |
| `replaced` | Call moved | Taken over in another tab |
| `protocol` | Call protocol error | Reload and retry |
| `unauthorized` | Session expired | Sign in again |
| `origin` | Call blocked | Open okaychat from its own address |
| `chatBusy` | This chat is busy | Stop the current reply or dictation |
| `chatLoading` | This chat is still loading | Wait for the chat to finish loading |

Non-fatal notices (`limit`, `voice`) leave the call running.

## Privacy

- Voice-call audio is **never recorded, written to disk, or retained**, even when an admin enables dictation recording retention. PCM lives in memory for one utterance; synthesized audio lives in memory for one sentence and in the browser's bounded AudioWorklet queue.
- **Transcripts are chat messages.** The local engine appends each final transcript as a normal user message and the reply is stored normally, so both remain in the chat history like typed messages. Temporary chats are the exception: they save no thread, messages, usage, uploads, artifacts, or memory. The call view's privacy line says exactly this.
- The server log records only counters at the end of a call (engine, speech-to-text seconds, characters sent to speech); never audio, transcripts, or secrets.
- The local engine keeps audio inside the server and the speech worker. The Realtime engine necessarily sends microphone audio to OpenAI; choosing local never falls back to the cloud, and choosing Realtime may fall back to local.
- STT seconds and TTS characters are counted per call. Chat model usage is recorded by the normal `/api/chat` path. Speech counters are not added to the token `usage` table (the existing read-aloud/dictation routes do not persist speech usage either).

## Latency budget

Target: **first audio under 1.5 s after the user stops speaking on a warm worker** (Whisper base on CPU, Piper medium, LAN client). This is a design target, **not measured** on reference hardware in this branch. The budget is: final Whisper (~0.3–0.8 s) + first chat tokens (~0.3–1 s) + first sentence cut + Piper (~0.1–0.4 s) + network. A cold model download can take minutes and is shown as "Preparing voice models…"; it is not part of the call timer or this target. The first sentence is spoken as soon as its text is complete, not after the whole reply.

## Hard limits

`src/server/voice/limits.ts`:

- Call duration 30 min (default, `OKAYCHAT_VOICE_MAX_MINUTES`), idle 5 min without an utterance or sentence (`OKAYCHAT_VOICE_IDLE_MINUTES`), socket silent 45 s without a ping (client pings every 10 s), preparation 10 min from upgrade. The watchdog applies these in every phase, from the constructor.
- One utterance 120 s, also capped by the admin's `maxRecordingSeconds`; one call's microphone audio 64 MiB; one `say` 1,500 characters; all speech 200,000 characters; 64 queued sentences; one WebSocket message 256 KiB; 10 starts/account/10 min; at most one final and one partial transcription running at a time (further utterance starts are refused with a final ack); even-byte PCM16 frames only.
- Over-limit audio is not buffered without bound: a slow client gets a non-fatal `limit` notice and the sentence is marked `said ok:false`. The playback worklet holds at most 30 s of audio and reports an overflow notice for what it drops.

## Operating needs

- Speech worker: `OKAYCHAT_SPEECH_URL` (compose sets it). Models download on the first call (`/warm`), and `/release` stops idle engine children after the last call on the server ends, returning memory/VRAM. An engine that is synthesizing for another account keeps running. The worker runs one transcription and one synthesis at a time: concurrent calls share them, and a partial transcript that finds the engine busy is skipped rather than queued.
- Admin → Voice: enable Whisper and Piper, choose the Whisper model and default Piper voice. The account's read-aloud voice is used when set, else the admin default. Read aloud does not have to be switched on for calls.
- Realtime: connect OpenAI in Settings → Providers (or an admin shares a key with the account and grants the model). No client-side key.
- Reverse proxy: forward `Upgrade`/`Connection` headers for `/api/voice/call`, or set `OKAYCHAT_PUBLIC_URL`.

## Tests

- `src/server/voice/ws.test.ts`: masked text/binary, fragmentation and the fragment cap, ping/pong, minimal extended lengths, protocol errors, 1009/1007, close payload validation, close handshake, handshake rejection, and a throwing handler that is not misreported as bad UTF-8.
- `src/server/voice/session.test.ts`: auth-facing ownership, one-call limit/takeover, partial/final transcripts, fake STT/TTS success and errors, barge-in, malformed messages, byte/utterance/duration caps, one-final/one-partial concurrency with refusal acks, odd-byte PCM, preparation/revocation/duration watchdogs with an injected clock, cleanup and counters.
- `src/server/voice/backend.test.ts`: canonical Origin rules (crafted spellings included), availability without warming, route auth/origin, missing OpenAI key, mocked Realtime SDP exchange (multipart form, bearer header, session JSON), local-only fallback, WAV parsing.
- `src/server/voice/turn.test.ts`: voice metadata recognition and the per-turn note.
- `src/web/speech/call/{state,chunker,vad,jitter,media,realtime}.test.ts`: state transitions including interrupted, streaming sentence boundaries, no-overlap/underrun/overflow/cancel, synthetic silence/speech endpointing, resampling, and Realtime event → transcript/mode mapping.
- `src/web/speech/call/worklets.test.ts` executes the actual playback worklet string under a fake `AudioWorkletProcessor`/`sampleRate`/`registerProcessor`: mid-chunk enqueue preserves the exact sample sequence, cancel clears, and the FIFO cap drops with an overflow message.
- `src/web/speech/call/controller.test.ts` drives the real controller with a fake runtime, Player, microphone, and socket: audio and `said` wait for a deferred worklet and flush in order, a failed worklet fails the call, cancel during setup cannot restore audio, late initialize/socket/microphone work cannot mutate or close a retried call, a mute set early is applied, and ending cancels only the run in the bound chat. It also checks the chat-run/cached-history/dictation barrier.
- Playback drains completed empty sentences before the next sentence, including when several sentences arrive while the worklet is opening. Realtime media controls and cleanup use the captured owning chat, as do local turns.
- `src/web/speech/call/connection.test.ts`: closing a CONNECTING socket, late `onopen` sending nothing, explicit `end` on close, and the handshake timeout.
- Not run in this branch: a real browser/microphone, a real speech-worker container round trip, a real OpenAI Realtime call, and the Docker integration suites. The latency target is unmeasured. These need the orchestrator/hardware.

## Honest remaining risks

- Realtime depends on OpenAI's current WebRTC signalling and event names. The exchange is tested against a mock, not the live API.
- Voice-activity detection is energy-based. Very noisy rooms may trigger early or miss quiet speech; echo cancellation mitigates, but speaker bleed can still cause a false barge-in.
- The local pipeline is turn-based: it cannot interrupt between the user's final transcript and the server's model stream except by cancelling the run, and a cancelled reply remains in history as an incomplete assistant message (no audio). Speech that continues while a final transcript is still being produced is held (up to 5 s) and then treated as the next utterance; if it is clearly speech, it barges into the reply for the previous segment.
- Chat turn persistence still runs through the browser's assistant-ui history adapter, as with typed messages. A call in a tab that is closed mid-turn keeps the server generating until its cancel/stream timeout, like a typed turn.
- A reply that needs tool approval (or a generative-UI interaction) is not answerable inside the call view; the model waits while the call says "Thinking". End the call to review and approve it in the chat.
- The playback queue is deliberately bounded: a reply synthesized much faster than it plays can exceed 30 s of queued audio, in which case later chunks are dropped and a translated notice appears. This is explicit truncation, not a silent gap.
- `GET /api/voice` asks the worker `/health` (2 s cap) to report the local pipeline, but its result no longer hides the entry point: a configured worker that is down still shows the call button, and Retry re-probes. Opening the call view also re-probes. It never downloads or loads a model; models loading for another call still report available because idle children are not required.
- A successful direct health check clears the speech registry's cached outage before `/warm`, so recovery works inside its TTL/cooldown too. A subsequent `service_unavailable` from warming or synthesis is shown as a worker outage rather than a missing model/voice.
- Local and Realtime transcripts are stored as normal chat messages, so they are visible in history and to any later chat turn (except temporary chats). The privacy line states this; audio itself is still never recorded.
- Realtime usage is not in okaychat's usage dashboard.
