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

A Python container with faster-whisper and Piper (`speech/server.py`, hashed lock `speech/requirements.txt`). The HTTP server imports only the standard library. Each engine runs in a child process that starts on the first request and exits after `SPEECH_IDLE_MINUTES` (default 5) without one, because Python does not reliably return freed memory to the system. On a GPU the child also owns the CUDA context, so its exit releases the VRAM. Measured on a 4-core host: about 37–58 MB for the idle worker, about 570–670 MB with Whisper `base` and Piper both loaded, Piper at 0.2 s for a warm sentence, Whisper `base` at 1–5 s for a short recording on CPU. The TTS process keeps the three most recently used voices loaded. `speech/device.py` chooses CUDA or CPU; see below.

- One transcription and one synthesis run at a time; others wait up to two minutes.
- Models download from Hugging Face on first use into the `okaychat-speech` volume (`Systran/faster-whisper-*`, `rhasspy/piper-voices`), so the worker's network is not internal. It holds no app data or secrets.
- Bearer token: the app generates `OKAYCHAT_SPEECH_TOKEN_FILE` into the `okaychat-speech-token` volume (0640, group 10100 set by `docker-entrypoint.sh`), and the worker reads it until it appears. Dev uses `data/speech-token` and `scripts/dev-speech.sh`.
- Limits: 25 MB per recording, the admin's maximum length (checked after decoding), 5000 characters per synthesis.
- Hardening in compose: read-only root, `/tmp` tmpfs, no capabilities, `no-new-privileges`, uid 10100, 2 GB and 2 CPUs (4 GB with the GPU override).
- PyAV is pinned below 19: version 19 dropped the `metadata_errors` argument faster-whisper 1.2.1 passes, which breaks every decode.

## GPU acceleration

Whisper can use an NVIDIA GPU when the host exposes one. The CPU image and the plain `docker-compose.yml` are unchanged, so existing installs keep running on the CPU.

Requirements: an NVIDIA driver on the host and the NVIDIA Container Toolkit (Docker runtime `nvidia`). The GPU image is x86-64 only, like the speech lock.

```sh
# Build and start the GPU override.
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d

# Or in dev, with an isolated container:
scripts/dev-speech.sh
```

`docker-compose.gpu.yml` builds with `INSTALL_CUDA=1`, reserves all NVIDIA GPUs (`driver: nvidia`, `capabilities: [gpu]`), raises the memory limit to 4 GB, and passes the device variables below. `INSTALL_CUDA=1` adds only the pinned cuBLAS and cuDNN 9 runtime wheels (`speech/requirements-cuda.txt`) that the existing ctranslate2 4.x build dlopens for CUDA 12; the base image stays `python:3.12-slim-bookworm`. Their libraries are put on `LD_LIBRARY_PATH` before ctranslate2 is imported.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPEECH_DEVICE` | `auto` | `auto` uses CUDA when a device is visible, `cuda` requires it, `cpu` never probes CUDA |
| `SPEECH_COMPUTE_TYPE` | `float16` on CUDA, `int8` on CPU | ctranslate2 compute type for the attempted device |

Detection is cheap and cached for the process lifetime: `speech/device.py` runs ctranslate2's CUDA device count in a short-lived child interpreter (with `nvidia-smi` as a fallback), so the long-running HTTP parent never holds a CUDA context and no model is loaded for `/health` or `/preload`. `gpuName` comes from the CUDA driver; `cudaVersion` is the CUDA runtime version when `libcudart` is present, not the driver's maximum supported version, so it can be `null`.

faster-whisper loads the model on the first transcription, never during a health check. On CUDA the worker tries `float16`, then `int8_float16` when the GPU cannot use `float16`, then CPU `int8`. `SPEECH_COMPUTE_TYPE` replaces the first CUDA attempt but never removes the CPU fallback. A CUDA load or inference failure (the generator is consumed inside the same try) logs once, moves that child to CPU `int8`, and keeps serving. `/health` then reports `device: "cpu"`, `degraded: true`, the reason, and the model that actually loaded; Admin → Voice shows the note. The model cache key is `(model, device, compute_type)`, so a CPU model is never reused for CUDA.

An explicit `SPEECH_DEVICE=cuda` without a visible GPU still starts and serves on CPU, with the reason in `/health`. With `auto`, a CPU-only host is reported as CPU without a warning. The idle exit is what frees GPU memory: the child process ends after `SPEECH_IDLE_MINUTES`, releasing its CUDA context and VRAM, and health then reports `model: null` while keeping the last fallback diagnostic. Expect roughly 0.5–1 GB of VRAM for `base` and several GB for `large-v3` while a child is transcribing; the CUDA wheels add about 1.3 GB to the GPU image.

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
- `speech/test_device.py`: pure device-resolution and fallback tests (`python3 -m unittest discover -s speech -p 'test_*.py'`), run by `test/integration/speech.sh`.
- `test/integration/speech.sh`: the real CPU worker container: auth, forced CPU health, Piper in two languages, a Piper → Whisper round trip, limits, read-only root, and that memory returns to baseline after the idle timeout.
- `test/integration/speech-gpu.sh`: the CUDA container. Skips with exit 0 when there is no Docker/NVIDIA runtime, and otherwise asserts a real CUDA transcription plus the idle child exit that releases VRAM. Uses its own container and volume names.

## Compared with Open WebUI and LibreChat

Covered: every Open WebUI STT engine (local Whisper, OpenAI-compatible, browser, Deepgram, Azure, Mistral) and TTS engine (browser, OpenAI-compatible, OpenAI Realtime, ElevenLabs, Azure, Mistral, plus local neural voices in place of Transformers/Kokoro.js), sentence/paragraph/whole splitting, auto-send, auto-playback, playback speed, per-user voice, audio-file transcription, the admin Whisper model, VAD, and language. From LibreChat: silence-based auto-stop, Groq and ElevenLabs STT, style instructions, and an address check for self-hosted engines. Beyond both: recordings are not stored by default (Open WebUI keeps every upload and TTS file without cleanup), a retention policy with encryption and purge, and engines that free their memory when idle.

Not covered yet: voice calls (continuous conversation with barge-in, and Realtime speech-to-speech).
