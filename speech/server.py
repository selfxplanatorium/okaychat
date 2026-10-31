#!/usr/bin/env python3
"""okaychat speech worker: local speech to text (faster-whisper) and text to speech (Piper) for the app.

See docs/implementation/speech.md. Rules:
- Audio and text live only in memory for the length of one request. Nothing a user sends is written to disk;
  the only files are downloaded models under SPEECH_MODELS.
- The HTTP server imports only the standard library. Each engine runs in its own child process, started on
  the first request and stopped after SPEECH_IDLE_MINUTES without one, so an idle worker holds no model or
  library memory at all. Python does not reliably return freed memory to the system; exiting does. On a GPU
  the child also owns the CUDA context, so exiting returns its VRAM.
- One transcription and one synthesis run at a time each; later requests wait for a slot or time out.
- Every request needs the app's bearer token. The worker holds no app secrets or data.
"""

import hmac
import json
import multiprocessing as mp
import os
import re
import threading
import time
import urllib.request
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from device import CPU_COMPUTE, DEFAULT_CUDA_COMPUTE, FALLBACK_CUDA_COMPUTE, DevicePlan, resolve_device

TOKEN_FILE = os.environ.get("SPEECH_TOKEN_FILE", "")
TOKEN = os.environ.pop("SPEECH_TOKEN", "")
PORT = int(os.environ.get("SPEECH_PORT", "8080"))
MODELS = os.environ.get("SPEECH_MODELS", "/models")
IDLE_MINUTES = float(os.environ.get("SPEECH_IDLE_MINUTES", "5"))
THREADS = int(os.environ.get("SPEECH_THREADS", "0")) or os.cpu_count() or 2
MAX_AUDIO = 25 * 1024 * 1024
MAX_TEXT = 5000
SLOT_WAIT = 120
# A cold transcription may first download a large model.
CALL_TIMEOUT = {"stt": 15 * 60, "tts": 5 * 60}

os.environ.setdefault("HF_HOME", os.path.join(MODELS, "hf"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

# faster-whisper model names (Systran CTranslate2 conversions on Hugging Face), smallest first.
WHISPER_MODELS = ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "distil-small.en", "medium", "medium.en",
                  "distil-medium.en", "large-v3-turbo", "distil-large-v3", "large-v3"]
PIPER_REPO = "rhasspy/piper-voices"
VOICE_RE = re.compile(r"^[a-z]{2,3}_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)$")
LANG_RE = re.compile(r"^[a-z]{2,3}$")


class Failure(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


# ---- engine processes: everything below runs in a child and may import heavy libraries ----

def voice_files(voice: str) -> tuple[str, str]:
    lang, name, quality = voice.split("-", 2)
    base = f"{lang.split('_')[0]}/{lang}/{name}/{quality}/{voice}.onnx"
    return base, base + ".json"


def duration(seconds: float) -> str:
    return f"{seconds:.0f} seconds" if seconds < 120 else f"{seconds / 60:.0f} minutes"


class SttEngine:
    """faster-whisper in the child process, with a CUDA attempt and a safe CPU fallback.

    The model cache key is (name, device, compute_type): a CPU model is never reused for
    CUDA, and switching models replaces the single cached model so an idle child exits
    with nothing pinned. Health reports the actual load result, not the startup probe.
    """

    def __init__(self, plan: DevicePlan | None = None, loader=None, log=None):
        plan = plan or DevicePlan(requested="cpu", device="cpu", compute_type=CPU_COMPUTE, cuda_available=False)
        self.plan = plan
        self.device = plan.device
        self.compute = plan.compute_type
        self.degraded = bool(plan.degraded)
        self.reason = plan.reason
        self.model = None
        self.model_name = None
        self.key = None
        self.loader = loader or self.load_whisper
        self.log = log or (lambda message: print(message, flush=True))
        self.fallback_logged = False

    @staticmethod
    def load_whisper(name: str, device: str, compute: str):
        from faster_whisper import WhisperModel

        return WhisperModel(name, device=device, compute_type=compute, cpu_threads=THREADS, download_root=os.path.join(MODELS, "whisper"))

    def candidates(self) -> list[tuple[str, str]]:
        if self.device == "cuda":
            primary = self.compute or DEFAULT_CUDA_COMPUTE
            tries = [("cuda", primary)]
            # Some GPUs or CUDA builds lack float16; int8_float16 is the next CUDA step.
            if primary == DEFAULT_CUDA_COMPUTE:
                tries.append(("cuda", FALLBACK_CUDA_COMPUTE))
            tries.append(("cpu", CPU_COMPUTE))
            return tries
        primary = self.compute or CPU_COMPUTE
        return [("cpu", primary)] + ([("cpu", CPU_COMPUTE)] if primary != CPU_COMPUTE else [])

    def mark_fallback(self, error: Exception):
        self.degraded = True
        detail = f"{type(error).__name__}: {error}".strip()
        self.reason = f"CUDA could not run Whisper, so it is using the CPU: {detail}"[:280]
        if not self.fallback_logged:
            self.log(f"stt CUDA unavailable; using CPU: {detail}")
            self.fallback_logged = True

    def load(self, name: str):
        if self.model is not None and self.key == (name, self.device, self.compute):
            return self.model
        # Only one model stays loaded, so a switch releases the old one before the new
        # one can allocate (important on a GPU) and a failed load cannot report it.
        self.model, self.model_name, self.key = None, None, None
        cuda_error = None
        last = None
        for device, compute in self.candidates():
            try:
                model = self.loader(name, device, compute)
            except Exception as error:
                last = error
                if device == "cuda":
                    cuda_error = error
                    continue
                if compute != CPU_COMPUTE:
                    continue
                if cuda_error is not None:
                    self.mark_fallback(cuda_error)
                    self.device, self.compute = "cpu", compute
                raise
            self.model = model
            self.model_name = name
            self.key = (name, device, compute)
            self.device, self.compute = device, compute
            if device == "cuda":
                self.degraded = False
                self.reason = None
            elif cuda_error is not None:
                self.mark_fallback(cuda_error)
            return model
        if cuda_error is not None:
            self.mark_fallback(cuda_error)
            self.device, self.compute = "cpu", CPU_COMPUTE
        if last is not None:
            raise last
        raise RuntimeError("No compute device could load Whisper.")

    def status(self) -> dict:
        return {
            "device": self.device,
            "computeType": self.compute,
            "model": self.model_name if self.model is not None else None,
            "degraded": self.degraded,
            "reason": self.reason,
        }

    def infer(self, samples, name: str, language: str | None, q: dict) -> dict:
        segments, info = self.load(name).transcribe(
            samples,
            language=language,
            vad_filter=q.get("vad", "1") == "1",
            beam_size=max(1, min(int(q.get("beam", "1")), 5)),
            condition_on_previous_text=False,
        )
        # faster-whisper returns a lazy generator: computation errors can surface here,
        # after the model loaded successfully, so the CPU retry wraps this whole call.
        text = " ".join(s.text.strip() for s in segments).strip()
        return {"text": text, "language": info.language}

    def run_with_fallback(self, samples, name: str, language: str | None, q: dict) -> dict:
        try:
            return self.infer(samples, name, language, q)
        except Failure:
            raise
        except Exception as error:
            if self.device != "cuda":
                raise
            self.mark_fallback(error)
            self.device, self.compute = "cpu", CPU_COMPUTE
            self.model, self.model_name, self.key = None, None, None
            return self.infer(samples, name, language, q)

    def transcribe(self, audio: bytes, q: dict) -> dict:
        import io

        from faster_whisper.audio import decode_audio

        name = q.get("model", "base")
        if name not in WHISPER_MODELS:
            raise Failure(400, f"Unknown Whisper model {name}.")
        language = q.get("language") or None
        if language and not LANG_RE.match(language):
            raise Failure(400, "language must be an ISO 639-1 code.")
        max_seconds = min(float(q.get("max_seconds", "900")), 3600)
        try:
            samples = decode_audio(io.BytesIO(audio), sampling_rate=16000)
        except Exception:
            raise Failure(400, "The audio could not be decoded.")
        seconds = len(samples) / 16000
        if seconds > max_seconds:
            raise Failure(413, f"The recording is {duration(seconds)} long; the limit is {duration(max_seconds)}.")
        result = self.run_with_fallback(samples, name, language, q)
        result["duration"] = round(seconds, 2)
        result["_status"] = self.status()
        return result

    def preload(self, name: str):
        from faster_whisper.utils import download_model

        download_model(name, cache_dir=os.path.join(MODELS, "whisper"))


class TtsEngine:
    # A few voices stay loaded (about 60 MB each for medium quality), so users with different voices do not
    # reload each other's models on every reply.
    MAX_VOICES = 3

    def __init__(self):
        self.voices: dict = {}

    def load(self, voice: str):
        from piper import PiperVoice

        model = self.voices.pop(voice, None)
        if model is None:
            path, config = self.download(voice)
            model = PiperVoice.load(path, config_path=config)
            while len(self.voices) >= self.MAX_VOICES:
                self.voices.pop(next(iter(self.voices)))
        self.voices[voice] = model  # Most recently used last.
        return model

    def download(self, voice: str) -> tuple[str, str]:
        from huggingface_hub import hf_hub_download

        onnx, config = voice_files(voice)
        cache = os.path.join(MODELS, "piper")
        try:
            return hf_hub_download(PIPER_REPO, onnx, cache_dir=cache), hf_hub_download(PIPER_REPO, config, cache_dir=cache)
        except Exception:
            raise Failure(404, f"The Piper voice {voice} could not be downloaded.")

    def speak(self, text: str, q: dict) -> bytes:
        import io
        import wave

        from piper import SynthesisConfig

        voice = q.get("voice", "en_US-lessac-medium")
        if not VOICE_RE.match(voice):
            raise Failure(400, "Unknown Piper voice.")
        speed = min(max(float(q.get("speed", "1")), 0.5), 2.0)
        model = self.load(voice)
        out = io.BytesIO()
        with wave.open(out, "wb") as wav:
            model.synthesize_wav(text, wav, syn_config=SynthesisConfig(length_scale=1 / speed))
        return out.getvalue()

    def preload(self, voice: str):
        self.download(voice)


def engine_main(kind: str, conn, plan: dict | None = None):
    """Child process: answers (op, args) messages with ("ok", value) or ("err", status, message)."""
    if kind == "stt":
        engine = SttEngine(DevicePlan(**plan)) if plan else SttEngine()
    else:
        engine = TtsEngine()
    while True:
        try:
            op, args = conn.recv()
        except (EOFError, KeyboardInterrupt):
            return
        try:
            conn.send(("ok", getattr(engine, op)(*args)))
        except Failure as e:
            conn.send(("err", e.status, str(e), engine.status() if kind == "stt" else None))
        except Exception as e:
            print(f"{kind} {op} failed: {type(e).__name__}", flush=True)
            conn.send(("err", 500, "The speech worker failed.", engine.status() if kind == "stt" else None))


# ---- HTTP server: standard library only ----

class Engine:
    """Runs one engine kind in a child process that exists only while it is in use."""

    def __init__(self, kind: str):
        self.kind = kind
        self.lock = threading.Lock()
        self.proc = None
        self.conn = None
        self.used = 0.0
        self.label = "speech recognition" if kind == "stt" else "speech"
        # The last status a child reported. It survives an idle exit so health can
        # explain a fallback, but model/running are always read from the live child.
        self.report = None

    def call(self, op: str, *args, wait: float = SLOT_WAIT):
        if not self.lock.acquire(timeout=wait):
            raise Failure(503, f"The local {self.label} engine is busy. Try again in a moment.")
        try:
            if self.proc is None or not self.proc.is_alive():
                parent, child = mp.Pipe()
                plan = asdict(resolve_device()) if self.kind == "stt" else None
                self.report = None
                self.proc = mp.get_context("spawn").Process(target=engine_main, args=(self.kind, child, plan), daemon=True)
                self.proc.start()
                child.close()
                self.conn = parent
            self.conn.send((op, args))
            if not self.conn.poll(CALL_TIMEOUT[self.kind]):
                self.stop()
                raise Failure(504, f"The local {self.label} engine timed out.")
            reply = self.conn.recv()
            # Publish the diagnostic even when both CUDA and the CPU retry fail.
            if self.kind == "stt":
                if reply[0] == "err":
                    self.report = reply[3]
                elif isinstance(reply[1], dict):
                    status = reply[1].pop("_status", None)
                    if isinstance(status, dict):
                        self.report = status
        except (EOFError, BrokenPipeError, OSError):
            self.stop()
            raise Failure(500, f"The local {self.label} engine stopped unexpectedly.")
        finally:
            self.used = time.time()
            self.lock.release()
        if reply[0] == "err":
            raise Failure(reply[1], reply[2])
        return reply[1]

    def stop(self):
        if self.proc is not None:
            self.proc.kill()
            self.proc.join(5)
        self.proc, self.conn = None, None

    def running(self) -> bool:
        return self.proc is not None and self.proc.is_alive()

    def stop_if_idle(self):
        if self.proc is None or not self.lock.acquire(blocking=False):
            return
        try:
            if time.time() - self.used > IDLE_MINUTES * 60:
                self.stop()
        finally:
            self.lock.release()


stt = Engine("stt")
tts = Engine("tts")
voices_cache: dict | None = None


def speech_health() -> dict:
    """Cheap health with the device a child actually used, not the startup probe alone."""
    plan = resolve_device()
    running = stt.running()
    report = stt.report
    device, compute_type = plan.device, plan.compute_type
    degraded, reason = plan.degraded, plan.reason
    model = None
    if report:
        device = report.get("device") or device
        compute_type = report.get("computeType") or compute_type
        degraded = bool(report.get("degraded"))
        reason = report.get("reason") or (plan.reason if not degraded else None)
        # A model exists only while its child does; the idle exit releases its VRAM.
        model = report.get("model") if running else None
    return {
        "ok": True,
        "stt": running,
        "tts": tts.running(),
        "requestedDevice": plan.requested,
        "device": device,
        "computeType": compute_type,
        "gpuName": plan.gpu_name,
        "cudaVersion": plan.cuda_version,
        "cudaAvailable": plan.cuda_available,
        "degraded": degraded,
        "reason": reason,
        "model": model,
    }


def piper_voices() -> list[dict]:
    """The published voice catalog, fetched once per process. Voices download when first used."""
    global voices_cache
    if voices_cache is None:
        req = urllib.request.Request(f"https://huggingface.co/{PIPER_REPO}/resolve/main/voices.json", headers={"User-Agent": "okaychat-speech"})
        with urllib.request.urlopen(req, timeout=20) as res:
            voices_cache = json.load(res)
    return [
        {"id": key, "name": f"{v['name'].replace('_', ' ').title()} ({v['language']['name_english']}, {v['language']['country_english']}, {v['quality']})", "language": v["language"]["code"]}
        for key, v in sorted(voices_cache.items())
        if VOICE_RE.match(key)
    ]


def cached_whisper() -> list[str]:
    root = os.path.join(MODELS, "whisper")
    names = os.listdir(root) if os.path.isdir(root) else []
    return [m for m in WHISPER_MODELS if any(n.endswith(f"faster-whisper-{m}") for n in names)]


def current_token() -> str:
    """The app writes the token file on its first start, which may come after ours, so it is read until found."""
    global TOKEN
    if len(TOKEN) < 32 and TOKEN_FILE:
        try:
            with open(TOKEN_FILE) as f:
                TOKEN = f.read().strip()
        except OSError:
            pass
    return TOKEN


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "okaychat-speech"

    def log_message(self, fmt, *args):
        # Paths and query strings only carry model names; bodies are never logged.
        pass

    def send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def json(self, status: int, value):
        self.send(status, json.dumps(value).encode(), "application/json")

    def authorized(self) -> bool:
        token = current_token()
        header = self.headers.get("Authorization", "")
        return len(token) >= 32 and hmac.compare_digest(header.encode(), f"Bearer {token}".encode())

    def body(self, limit: int) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise Failure(400, "Empty request body.")
        if length > limit:
            raise Failure(413, f"The request is larger than {limit // (1024 * 1024)} MB.")
        return self.rfile.read(length)

    def route(self, method: str):
        url = urlsplit(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/health":
            return self.json(200, speech_health())
        if not self.authorized():
            return self.json(401, {"error": "Unauthorized"})
        if method == "POST" and url.path == "/transcribe":
            return self.json(200, stt.call("transcribe", self.body(MAX_AUDIO), q))
        if method == "POST" and url.path == "/speak":
            text = self.body(MAX_TEXT * 4).decode("utf-8", "replace").strip()
            if not text or len(text) > MAX_TEXT:
                raise Failure(400, f"Text must be 1 to {MAX_TEXT} characters.")
            return self.send(200, tts.call("speak", text, q), "audio/wav")
        if method == "GET" and url.path == "/models":
            return self.json(200, {"models": WHISPER_MODELS, "downloaded": cached_whisper()})
        if method == "GET" and url.path == "/voices":
            try:
                return self.json(200, {"voices": piper_voices()})
            except Exception:
                raise Failure(502, "The Piper voice list could not be loaded.")
        if method == "POST" and url.path == "/preload":
            kind, name = q.get("kind"), q.get("name", "")
            if not ((kind == "stt" and name in WHISPER_MODELS) or (kind == "tts" and VOICE_RE.match(name))):
                raise Failure(400, "Unknown model.")
            engine = stt if kind == "stt" else tts
            threading.Thread(target=lambda: self.quiet(engine, name), daemon=True).start()
            return self.json(202, {"ok": True})
        return self.json(404, {"error": "Not found"})

    @staticmethod
    def quiet(engine: Engine, name: str):
        try:
            engine.call("preload", name, wait=CALL_TIMEOUT[engine.kind])
        except Failure as e:
            print(f"preload {engine.kind} {name} failed: {e}", flush=True)

    def handle_method(self, method: str):
        try:
            self.route(method)
        except Failure as e:
            self.json(e.status, {"error": str(e)})
        except Exception as e:
            print(f"{method} {urlsplit(self.path).path} failed: {type(e).__name__}", flush=True)
            self.json(500, {"error": "The speech worker failed."})

    def do_GET(self):
        self.handle_method("GET")

    def do_POST(self):
        self.handle_method("POST")


def reaper():
    while True:
        time.sleep(15)
        stt.stop_if_idle()
        tts.stop_if_idle()


if __name__ == "__main__":
    if len(TOKEN) < 32 and not TOKEN_FILE:
        raise SystemExit("Set SPEECH_TOKEN (32+ characters) or SPEECH_TOKEN_FILE")
    os.makedirs(MODELS, exist_ok=True)
    plan = resolve_device()
    threading.Thread(target=reaper, daemon=True).start()
    print(
        f"speech worker on :{PORT}, {THREADS} threads, whisper on {plan.device}/{plan.compute_type}, "
        f"engines stop after {IDLE_MINUTES:g} idle minutes",
        flush=True,
    )
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
