# Speech: read aloud and speech to text

Read aloud turns replies into audio, and speech to text fills the composer from the microphone or an attached audio file. Engine definitions live in `src/shared/speech.ts`. The server side is `src/server/speech/`, the client side `src/web/speech/`, and the local engines run in the speech worker (`speech/`).

## Engines

| Read aloud | Credential | Notes |
| --- | --- | --- |
| Piper (on this server) | speech worker | Default once read aloud is switched on. 40+ languages, voices download on first use |
| Browser | none | `speechSynthesis`. May be silent: Linux needs speech-dispatcher plus a voice, some browsers ship none. The settings page warns |
| OpenAI | `openai` chat connection | `POST /audio/speech`, mp3. `instructions` only for non-`tts-1` models |
| OpenAI Realtime | `openai` chat connection | One WebSocket session per piece, audio-only output, PCM16 24 kHz wrapped as WAV |
| Azure AI Speech | own key + region | SSML to `{region}.tts.speech.microsoft.com`, 24 kHz mp3. Voices from `voices/list` |
| ElevenLabs | own key | `/v1/text-to-speech/{voice}`, voices from `/v2/voices`, models from `/v1/models` |
| Mistral | `mistral` chat connection | `POST /audio/speech` with `voice_id`, base64 `audio_data`. Voices from `/audio/voices` |
| OpenAI-compatible | own base URL (+ optional key) | Kokoro-FastAPI, openedai-speech, LocalAI, speaches |

| Speech to text | Credential | Notes |
| --- | --- | --- |
| Browser | none | Web Speech API. Needs HTTPS; Chrome and Edge send audio to their vendor; Firefox and Zen have none. Default for dictation |
| Whisper (on this server) | speech worker | faster-whisper, model chosen by the admin. Opt-in per user |
| OpenAI, Groq, Mistral | chat connection | `POST /audio/transcriptions` (multipart) |
| Deepgram | own key | `/v1/listen`, raw body, `Token` auth |
| ElevenLabs Scribe | own key | `/v1/speech-to-text`, `scribe_v2` |
| Azure AI Speech | own key + region | Fast transcription API; no locale means language identification |
| OpenAI-compatible | own base URL (+ optional key) | speaches, LocalAI, whisper.cpp server, vLLM |

Speech-only keys are provider connections named `speech-<service>` (`azure`, `deepgram`, `elevenlabs`, `compatible-stt`, `compatible-tts`), so they get the same encryption, admin sharing, and private-address rules as chat keys. Azure stores `https://<region>.api.cognitive.microsoft.com` as its base URL. These ids are not in models.dev, so they never appear in the provider list. Admins share them from Admin → Voice.

## Settings

`settings.speech` (validated by `speechSettingsSchema` in `speech/config.ts`):

- `tts`: `engine` (default `off`), `autoPlay`, `speed` (0.5–2, applied as the audio element's `playbackRate` so it is the same for every engine), `split` (`sentence`, `paragraph`, `none`), per-engine `models` and `voices`, and `instructions` (speaking style for OpenAI and Realtime).
- `stt`: `engine` (default `browser`), `language` (ISO 639-1, empty detects), `silenceSeconds` (0 records until stopped), per-engine `models`.

Server-wide settings live in `server_settings` key `speech` (`AdminSpeechSettings`): `retentionHours` (default 0), `maxRecordingSeconds` (600), and `local` (Piper and Whisper switches, Whisper model, VAD, default Piper voice). Changing the Whisper model or default voice starts its download in the worker right away.

## Client

- `adapters.ts` (`useVoiceAdapters`) gives the chat runtime a `speech` adapter only when read aloud is on and its engine is ready, and a `dictation` adapter only when dictation can work here. A missing adapter hides its button. The adapters are created once and read the current settings when they start.
- `synthesis.ts`: `ServerSpeechAdapter` cleans the Markdown (`text.ts`: code, tables, links, math), splits it, and fetches the next piece while the current one plays. Pieces under 50 characters or 4 words join the previous one; none exceeds 1500 characters. One shared `<audio>` element is unlocked on the first user gesture, which lets automatic playback start later (WebKit). `BrowserSpeechAdapter` applies the chosen voice and rate.
- `recorder.ts`: `RecorderDictationAdapter` records with MediaRecorder (Opus in WebM or Ogg, 32 kb/s), stops on silence below −45 dB after speech was heard (when `silenceSeconds` > 0) or at the admin's length limit, then uploads the recording. Without a secure context there is no microphone: the button opens a file picker with `capture`, which records on phones, and its tooltip says so.
- Stopping dictation never sends. The send button stays enabled while dictating, even with an empty composer: it stops the recording, sets `sendAfterDictation`, and `DictationSend` sends once dictation ends with text and no speech error. There is no auto-send setting; old saves may still carry `stt.autoSend`, which the schema accepts and ignores.
- `Waveform.tsx`: the scrolling bar waveform beside the stop button. Server engines read the recorder's analyser (`recordingLevel()`); browser dictation opens its own capture on fine pointers only, because a second capture can stop Android recognition, and shows an idle pulse otherwise.
- `ChatVoice.tsx`: send-after-dictation, auto-play of finished replies (keyed by thread, so switching chats does not trigger it), the "Transcribing…" line, and speech errors under the composer.
- `AudioAttachmentAdapter` (`runtime/attachments.ts`) transcribes attached audio files with the dictation engine, or the first ready server engine when dictation runs in the browser, and sends the text in a `<transcript>` block. The original is stored like other uploads, except in temporary chats.
- Shortcuts: `S` on a focused message reads it or stops; Alt+Shift+V reads the last answer.

## Server

`POST /api/speech/transcribe` (multipart `file`, optional `language`, `engine`, `purpose=file`, `temporary=1`): 25 MB cap, audio checked by type or magic bytes, transcribed in memory. `POST /api/speech/synthesize` (`{ text ≤ 4096, engine?, voice?, model? }`): the response type comes from magic bytes, never from the provider, so the server only ever serves audio. At most six speech requests per account run at once. Upstream errors keep only the provider's short message; 401/403 become a 400 so the UI shows a key problem.

`GET /api/speech` reports each engine as ready or not with a reason; `GET /api/speech/options` loads voice and model lists from the provider (cached one hour per key and address, built-in list on failure). Admin routes are under `/api/admin/speech`.

## Recordings and retention

With `retentionHours` 0, the default, no audio or transcript is written anywhere: the app holds the upload in memory for the request, and the worker decodes it from memory. Read-aloud audio is never stored on the server; the browser keeps each piece as a blob URL until it has played.

With retention on, dictated recordings (not attached files, never temporary chats) are stored in `speech_recordings`, audio and transcript encrypted with `OKAYCHAT_SECRET`. A purge runs at start and every 10 minutes (`startRecordingPurge`), and saving retention 0 deletes all of them at once. Users see the policy and can delete their own under Settings → Voice; admins can delete all. Recordings do not count against the user's storage quota, since the admin chose to keep them. They are deleted with the account.

## Speech worker (`speech/`)

A Python container with faster-whisper and Piper (`speech/server.py`, hashed lock `speech/requirements.txt`). The HTTP server imports only the standard library. Each engine runs in a child process that starts on the first request and exits after `SPEECH_IDLE_MINUTES` (default 5) without one, because Python does not reliably return freed memory to the system. Measured on a 4-core host: about 37–58 MB for the idle worker, about 570–670 MB with Whisper `base` and Piper both loaded, Piper at 0.2 s for a warm sentence, Whisper `base` at 1–5 s for a short recording on CPU. The TTS process keeps the three most recently used voices loaded.

- One transcription and one synthesis run at a time; others wait up to two minutes.
- Models download from Hugging Face on first use into the `okaychat-speech` volume (`Systran/faster-whisper-*`, `rhasspy/piper-voices`), so the worker's network is not internal. It holds no app data or secrets.
- Bearer token: the app generates `OKAYCHAT_SPEECH_TOKEN_FILE` into the `okaychat-speech-token` volume (0640, group 10100 set by `docker-entrypoint.sh`), and the worker reads it until it appears. Dev uses `data/speech-token` and `scripts/dev-speech.sh`.
- Limits: 25 MB per recording, the admin's maximum length (checked after decoding), 5000 characters per synthesis.
- Hardening in compose: read-only root, `/tmp` tmpfs, no capabilities, `no-new-privileges`, uid 10100, 2 GB and 2 CPUs.
- PyAV is pinned below 19: version 19 dropped the `metadata_errors` argument faster-whisper 1.2.1 passes, which breaks every decode.

Regenerate the lock (x86-64 wheels only):

```sh
docker run --rm -v "$PWD/speech":/s -w /tmp python:3.12-slim-bookworm sh -c 'pip install -q uv==0.13.1 &&
  cp /s/requirements.in . && uv pip compile requirements.in --python-platform x86_64-manylinux_2_28 --python-version 3.12 \
  --generate-hashes --only-binary :all: --exclude-newer <yyyy-mm-dd> --no-header -o /s/requirements.txt'
```

and put the header line back on top of `requirements.txt`.

## Tests

- `src/server/speech.test.ts`: request shapes for every cloud engine against fakes (including a minimal WebSocket server for Realtime), settings validation, keys and sharing, retention and purge, limits, attached-file fallback, list parsing.
- `src/web/speech/text.test.ts`: Markdown cleanup and splitting.
- `test/integration/speech.sh`: the real worker container: auth, Piper in two languages, a Piper → Whisper round trip, limits, read-only root, and that memory returns to baseline after the idle timeout.

## Compared with Open WebUI and LibreChat

Covered: every Open WebUI STT engine (local Whisper, OpenAI-compatible, browser, Deepgram, Azure, Mistral) and TTS engine (browser, OpenAI-compatible, OpenAI Realtime, ElevenLabs, Azure, Mistral, plus local neural voices in place of Transformers/Kokoro.js), sentence/paragraph/whole splitting, auto-send, auto-playback, playback speed, per-user voice, audio-file transcription, the admin Whisper model, VAD, and language. From LibreChat: silence-based auto-stop, Groq and ElevenLabs STT, style instructions, and an address check for self-hosted engines. Beyond both: recordings are not stored by default (Open WebUI keeps every upload and TTS file without cleanup), a retention policy with encryption and purge, and engines that free their memory when idle.

Not covered yet: voice calls (continuous conversation with barge-in, and Realtime speech-to-speech).
