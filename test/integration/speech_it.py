"""Speech worker checks: auth, Piper in two languages, a Piper -> Whisper round trip, limits, and that the
engine processes exit when idle so the worker returns to its small baseline."""
import io
import json
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave

BASE, TOKEN, CONTAINER = sys.argv[1], sys.argv[2], sys.argv[3]
failures = []


def check(name, ok, detail=""):
    print(("PASS" if ok else "FAIL"), name, detail, flush=True)
    if not ok:
        failures.append(name)


def call(method, path, body=None, token=TOKEN, timeout=900):
    req = urllib.request.Request(BASE + path, data=body, method=method, headers={"Authorization": f"Bearer {token}"} if token else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.headers.get("Content-Type"), res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type"), e.read()


def rss_kb():
    """Resident memory of every process in the container, in kB."""
    out = subprocess.run(["docker", "exec", CONTAINER, "python", "-c",
                          "import os\nt=0\nfor p in os.listdir('/proc'):\n if p.isdigit():\n  try:\n   t+=int([l for l in open(f'/proc/{p}/status') if l.startswith('VmRSS')][0].split()[1])\n  except Exception: pass\nprint(t)"],
                         capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


for _ in range(50):
    try:
        if call("GET", "/health", token=None)[0] == 200:
            break
    except OSError:
        pass
    time.sleep(0.2)

status, _, body = call("GET", "/health", token=None)
health = json.loads(body) if status == 200 else {}
check(
    "health without token",
    status == 200 and health.get("ok") is True and health.get("stt") is False and health.get("tts") is False,
    body.decode(),
)
check("voice call capability advertised", health.get("voiceCalls") is True, body.decode())
print(f"  health device: {health.get('device')} / {health.get('computeType')} (requested {health.get('requestedDevice')})", flush=True)
check(
    "forced cpu mode is reported",
    health.get("requestedDevice") == "cpu"
    and health.get("device") == "cpu"
    and health.get("computeType") == "int8"
    and health.get("degraded") is False
    and health.get("model") is None,
    body.decode(),
)
check("speak needs the token", call("POST", "/speak", b"hi", token="x" * 40)[0] == 401)
check("transcribe needs the token", call("POST", "/transcribe", b"hi", token=None)[0] == 401)
idle = rss_kb()
check("idle worker is small", idle < 80_000, f"{idle} kB")

check("call warm requires token", call("POST", "/warm?kind=tts&name=en_US-lessac-medium", token=None)[0] == 401)
check("call warms Piper", call("POST", "/warm?kind=tts&name=en_US-lessac-medium")[0] == 200)
check("call warms Whisper", call("POST", "/warm?kind=stt&name=base")[0] == 200)
status, ctype, en = call("POST", "/speak?voice=en_US-lessac-medium", b"Please remind me to buy fresh bread tomorrow morning.")
check("piper english", status == 200 and ctype == "audio/wav" and en[:4] == b"RIFF" and len(en) > 50_000, f"{status} {len(en)}")
status, _, de = call("POST", "/speak?voice=de_DE-thorsten-medium", "Guten Morgen, wie geht es dir?".encode())
check("piper german", status == 200 and de[:4] == b"RIFF", f"{status} {len(de)}")
start = time.time()
call("POST", "/speak?voice=en_US-lessac-medium", b"A warm second sentence.")
warm = time.time() - start
check("piper warm under a second", warm < 1.0, f"{warm:.2f}s")
check("bad voice rejected", call("POST", "/speak?voice=../../etc", b"x")[0] == 400)
check("empty text rejected", call("POST", "/speak", b" ")[0] == 400)
check("long text rejected", call("POST", "/speak", b"a" * 5001)[0] == 400)

status, _, body = call("POST", "/transcribe?model=base&language=en", en)
text = json.loads(body).get("text", "") if status == 200 else body.decode()
check("whisper round trip", status == 200 and "bread" in text.lower() and "tomorrow" in text.lower(), text)
# The call transport sends raw PCM16, unlike dictation's encoded audio container.
with wave.open(io.BytesIO(en), "rb") as wav:
    rate = wav.getframerate()
    frames = wav.readframes(wav.getnframes())
    samples = struct.unpack(f"<{len(frames) // 2}h", frames)
pcm = b"".join(struct.pack("<h", samples[min(len(samples) - 1, i * rate // 16000)]) for i in range(len(samples) * 16000 // rate))
status, _, body = call("POST", "/transcribe?model=base&language=en&format=pcm16&vad=0", pcm)
text = json.loads(body).get("text", "") if status == 200 else body.decode()
check("call PCM round trip", status == 200 and "bread" in text.lower() and "tomorrow" in text.lower(), text)
status, _, body = call("POST", "/transcribe?model=base", de)
check("whisper detects german", status == 200 and json.loads(body).get("language") == "de", body.decode())
check("garbage audio rejected", call("POST", "/transcribe?model=base", b"not audio at all" * 10)[0] == 400)
check("unknown model rejected", call("POST", "/transcribe?model=huge", en)[0] == 400)
status, _, body = call("POST", "/transcribe?model=base&max_seconds=1", en)
check("length limit enforced", status == 413 and b"limit" in body, body.decode())
try:
    # The worker answers 413 and closes before reading the body, so the client may see the closed socket instead.
    oversized = call("POST", "/transcribe", b"0" * (25 * 1024 * 1024 + 1))[0] == 413
except urllib.error.URLError:
    oversized = True
check("oversized body rejected", oversized and call("GET", "/health", token=None)[0] == 200)

status, _, body = call("GET", "/health", token=None)
health = json.loads(body) if status == 200 else {}
check("engines running after use", health.get("stt") is True and health.get("tts") is True, body.decode())
check(
    "cpu device and model stay visible while running",
    health.get("device") == "cpu" and health.get("computeType") == "int8" and health.get("degraded") is False and health.get("model") == "base",
    body.decode(),
)
busy = rss_kb()
print(f"  memory in use: {busy} kB", flush=True)
time.sleep(40)
status, _, body = call("GET", "/health", token=None)
health = json.loads(body) if status == 200 else {}
after = rss_kb()
check("engines exit when idle", health.get("stt") is False and health.get("tts") is False, body.decode())
check("idle health releases the model", health.get("device") == "cpu" and health.get("model") is None, body.decode())
check("memory returns to baseline", after < 80_000, f"{busy} kB -> {after} kB")

status, _, body = call("GET", "/voices")
check("voice catalog", status == 200 and len(json.loads(body)["voices"]) > 50)
status, _, body = call("GET", "/models")
check("whisper model list", status == 200 and "base" in json.loads(body)["downloaded"], body.decode())
writable = subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", "touch /opt/speech/x 2>/dev/null && echo yes || echo no"], capture_output=True, text=True).stdout.strip()
check("root filesystem is read-only", writable == "no")
user = subprocess.run(["docker", "exec", CONTAINER, "id", "-u"], capture_output=True, text=True).stdout.strip()
check("runs unprivileged", user == "10100", user)

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all speech worker checks passed'}")
sys.exit(1 if failures else 0)
