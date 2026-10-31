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

- One WebSocket per call at `/api/voice/call`, upgraded through `@hono/node-server`'s `upgradeWebSocket`. The codec is `src/server/voice/ws.ts` (`MiniWebSocketServer`, no `ws` dependency): RFC 6455 masked client frames, fragmentation, ping/pong, close, 1009/1007/1002 on size, encoding, and protocol faults.
- The session cookie is the only credential. `requireUser` runs before the upgrade; the session hash is kept and re-checked on every ping (`sessionAlive`), so revoking a session ends the call within 10 s. `Origin` must match the request origin (including `x-forwarded-proto`/`x-forwarded-host` behind a proxy) or `OKAYCHAT_PUBLIC_URL`; a missing Origin or `Sec-Fetch-Site: cross-site` gets HTTP 403 before the upgrade.
- One call per account in `CallRegistry`. A second start without takeover gets `busy`; with takeover the older call ends first. `StartLimiter` allows 10 starts per account per 10 minutes (in memory, reset on restart).
- A call is bound to the chat that started it. The server checks ownership at `start`; `tmp_` temporary chats are accepted because they are never stored. The client also ends the call if the open chat changes, so audio can never land in another chat.
- Call sockets carry no secrets: availability, errors, transcripts, and SDP only. OpenAI API keys are read from the encrypted connection on the server; the browser never sees one.

## Local pipeline

1. The server warms the account's Piper voice and the admin's Whisper model (`/warm` on the worker, which downloads on first use) and reports the chosen voice in `ready`. The call UI shows "Preparing voice models…" while it waits.
2. The browser opens the microphone with `echoCancellation`, `noiseSuppression`, and `autoGainControl`. A capture AudioWorklet emits 40 ms Int16 frames; unusual AudioContext rates are linearly resampled to 16 kHz.
3. `VoiceActivity` (energy dB, 3-frame attack, 700 ms hangover, 200 ms pre-roll, 250 ms minimum, 60 s cap) endpoints utterances. Frames are streamed; a partial transcript arrives about once per second of new speech for the first 20 s, and the final transcript when the user pauses.
4. **Only the final transcript appends a message.** It is appended through `aui.thread.append` with `metadata.modality = "voice"` and `metadata.custom.voiceCall = "local"`, so the ordinary `/api/chat` turn runs with the chat's model, tools and approvals, RAG/knowledge, memory, MCP, email, compaction, cancellation, history persistence, and usage. There is no second chat path.
5. `voiceCall` is added to the *per-turn* context block beside the spoken user message (`turn.ts`, `withVoiceNotes`), never to the shared system prefix. It is derived from stored metadata and replayed byte-for-byte, so it does not break prompt caching. The temporary-chat path does the same per message.
6. The streamed reply text is cut into sentences by `SentenceChunker` (no cut before the character after punctuation arrives, fenced code skipped, 600-character cap) and sent as `say`. The server synthesizes sentences strictly one at a time; each is streamed back as binary frames with a 4-byte sentence id. `JitterBuffer` waits for a 180 ms cushion, keeps order, and the playback AudioWorklet plays a gapless FIFO with no overlapping sentences.
7. **Barge-in** while speaking or thinking immediately clears local audio, sends `say.cancel` (server aborts the queued/running synthesis and drops later sentences), calls `aui.thread.cancelRun()` (the normal `/api/chat/:streamId/cancel` path), and starts a new utterance. Sentence ids at or below the cancellation are dropped, so a late frame cannot restart playback. The state stays `interrupted` until the next turn.

## OpenAI Realtime (optional)

- Available when the account has an OpenAI chat connection (or an admin-shared one it may use) and the model policy allows the chosen Realtime model. The voice is `speech.call.realtimeVoice`, else the read-aloud Realtime voice, else `marin`.
- The browser creates an `RTCPeerConnection` with a microphone track and an `oai-events` data channel, sends its offer as `rt.offer`, and sets the server's `rt.answer`. The server posts the SDP plus the session (`instructions`, input transcription, semantic VAD with `interrupt_response`, output voice) to `${baseURL}/realtime/calls`.
- Final user and assistant transcripts arrive on the data channel. They are committed as `modality: "voice"` messages in the starting chat through assistant-ui's voice session, and appear as history after the call.
- **Honest scope:** the Realtime model answers directly. It does not use this chat's tools, knowledge collections, memory, MCP servers, compaction, or attachments, and its usage is billed by OpenAI outside okaychat's `usage` table. The server puts the most recent ~6,000 characters of this chat into its instructions as data (wrapped with `wrapUntrusted`), so the conversation has context but is not the normal chat pipeline. The call view says this while a Realtime call is active.
- On a signalling error, a failed setup, a lost data channel, or a dropped peer connection, the controller disconnects the voice session and sends `rt.failed`. The server switches the *same* call to the local pipeline (`ready` with `fallback`) and the microphone starts. If local is unavailable, the call ends with the Realtime error and a Retry. There is no automatic reconnect loop.

## Call UI

`src/web/speech/call/`:

- `CallView.tsx`: a Base UI `Dialog` — full screen on phones, a large sheet on desktop. Live meter, state text (Connecting/Preparing/Listening/Thinking/Speaking/Interrupted/Ended/Error), engine and voice, elapsed time, a scrolling transcript (new exchange only), mute, and one obvious End. The engine can be chosen before starting. Focus is trapped and restored by the dialog.
- Keyboard: Space toggles mute unless a button/field has focus (so Space still activates that control), Escape ends and closes, and `chat.voiceCall`, `call.start`, `call.mute`, `call.end`, `call.retry` are commands in the registry/command list. The composer's phone button appears only when `GET /api/voice` reports a usable engine.
- `state.ts` is the pure state machine; `vad.ts`, `chunker.ts`, `jitter.ts`, and `media.ts` (resampling) are pure and tested. `controller.ts` owns the socket, the local media, the runtime turn, sentence ids, barge-in, and cleanup. `realtime.ts` is the WebRTC adapter.
- Reduced motion shows a static level bar instead of the animated meter. Semantic tokens and `depth-*` utilities are used for light/dark; controls are at least 44 px on touch and the layout works at 360 px.
- Ending, retry, unmount, tab close (`pagehide`), and a chat switch all stop microphone tracks, close AudioContexts/WebRTC/sockets, and cancel an in-flight turn. Late microphone or WebRTC permission results stop their own tracks if the call is gone.

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

Non-fatal notices (`limit`, `voice`) leave the call running.

## Privacy

- Voice-call audio is **never recorded, written to disk, or retained**, even when an admin enables dictation recording retention. PCM lives in memory for one utterance; synthesized audio lives in memory for one sentence and in the browser's AudioWorklet queue.
- The server log records only counters at the end of a call (engine, speech-to-text seconds, characters sent to speech); never audio, transcripts, or secrets.
- The local engine keeps audio inside the server and the speech worker. The Realtime engine necessarily sends microphone audio to OpenAI; choosing local never falls back to the cloud.
- STT seconds and TTS characters are counted per call. Chat model usage is recorded by the normal `/api/chat` path. Speech counters are not added to the token `usage` table (the existing read-aloud/dictation routes do not persist speech usage either).

## Latency budget

Target: **first audio under 1.5 s after the user stops speaking on a warm worker** (Whisper base on CPU, Piper medium, LAN client). This is a design target, **not measured** on reference hardware in this branch. The budget is: final Whisper (~0.3–0.8 s) + first chat tokens (~0.3–1 s) + first sentence cut + Piper (~0.1–0.4 s) + network. A cold model download can take minutes and is shown as "Preparing voice models…"; it is not part of the call timer or this target. The first sentence is spoken as soon as its text is complete, not after the whole reply.

## Hard limits

`src/server/voice/limits.ts`:

- Call duration 30 min (default, `OKAYCHAT_VOICE_MAX_MINUTES`), idle 5 min without an utterance or sentence (`OKAYCHAT_VOICE_IDLE_MINUTES`), socket silent 45 s without a ping (client pings every 10 s).
- One utterance 120 s, also capped by the admin's `maxRecordingSeconds`; one call's microphone audio 64 MiB; one `say` 1,500 characters; all speech 200,000 characters; 64 queued sentences; one WebSocket message 256 KiB; 10 starts/account/10 min.
- Over-limit audio is not buffered without bound: a slow client gets a non-fatal `limit` notice and the sentence is marked `said ok:false`.

## Operating needs

- Speech worker: `OKAYCHAT_SPEECH_URL` (compose sets it). Models download on the first call (`/warm`), and `/release` stops idle engine children after the last call on the server ends, returning memory/VRAM. An engine that is synthesizing for another account keeps running. The worker runs one transcription and one synthesis at a time: concurrent calls share them, and a partial transcript that finds the engine busy is skipped rather than queued.
- Admin → Voice: enable Whisper and Piper, choose the Whisper model and default Piper voice. The account's read-aloud voice is used when set, else the admin default. Read aloud does not have to be switched on for calls.
- Realtime: connect OpenAI in Settings → Providers (or an admin shares a key with the account and grants the model). No client-side key.
- Reverse proxy: forward `Upgrade`/`Connection` headers for `/api/voice/call`, or set `OKAYCHAT_PUBLIC_URL`.

## Tests

- `src/server/voice/ws.test.ts`: masked text/binary, fragmentation, ping/pong, protocol errors, 1009/1007, close handshake, handshake rejection.
- `src/server/voice/session.test.ts`: auth-facing ownership, one-call limit/takeover, partial/final transcripts, fake STT/TTS success and errors, barge-in, malformed messages, byte/utterance/duration caps, cleanup and counters.
- `src/server/voice/backend.test.ts`: Origin rules, availability without warming, route auth/origin, missing OpenAI key, mocked Realtime SDP exchange (multipart form, bearer header, session JSON), local-only fallback, WAV parsing.
- `src/server/voice/turn.test.ts`: voice metadata recognition and the per-turn note.
- `src/web/speech/call/{state,chunker,vad,jitter,media,realtime}.test.ts`: state transitions including interrupted, streaming sentence boundaries, no-overlap/underrun/overflow/cancel, synthetic silence/speech endpointing, resampling, and Realtime event → transcript/mode mapping.
- Not run in this branch: a real browser/microphone, a real speech-worker container round trip, a real OpenAI Realtime call, and the Docker integration suites. The latency target is unmeasured. These need the orchestrator/hardware.

## Honest remaining risks

- Realtime depends on OpenAI's current WebRTC signalling and event names. The exchange is tested against a mock, not the live API.
- Voice-activity detection is energy-based. Very noisy rooms may trigger early or miss quiet speech; echo cancellation mitigates, but speaker bleed can still cause a false barge-in.
- The local pipeline is turn-based: it cannot interrupt between the user's final transcript and the server's model stream except by cancelling the run, and a cancelled reply remains in history as an incomplete assistant message (no audio). Speech that continues while a final transcript is still being produced is held (up to 5 s) and then treated as the next utterance; if it is clearly speech, it barges into the reply for the previous segment.
- Chat turn persistence still runs through the browser's assistant-ui history adapter, as with typed messages. A call in a tab that is closed mid-turn keeps the server generating until its cancel/stream timeout, like a typed turn.
- A reply that needs tool approval (or a generative-UI interaction) is not answerable inside the call view; the model waits while the call says "Thinking". End the call to review and approve it in the chat.
- `GET /api/voice` asks the worker `/health` (3 s cap) before offering the local pipeline, so a stopped worker hides the call button instead of starting a doomed call. It never downloads or loads a model; a worker restarting during that probe briefly hides the button. Models loading for another call still report available because idle children are not required.
- Realtime usage is not in okaychat's usage dashboard.
