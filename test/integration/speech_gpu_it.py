"""GPU speech worker checks: CUDA is actually used for a transcription, and the idle
child exits so its CUDA context and VRAM are released."""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

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


def health():
    status, _, body = call("GET", "/health", token=None)
    return json.loads(body) if status == 200 else {}


def child_processes():
    """Spawned engine children inside the container (the parent is not one)."""
    script = (
        "import os\n"
        "n = 0\n"
        "for p in os.listdir('/proc'):\n"
        "  if not p.isdigit(): continue\n"
        "  try:\n"
        "    data = open(f'/proc/{p}/cmdline', 'rb').read()\n"
        "  except OSError:\n"
        "    continue\n"
        "  n += b'multiprocessing.spawn' in data\n"
        "print(n)"
    )
    out = subprocess.run(["docker", "exec", CONTAINER, "python", "-c", script], capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


for _ in range(75):
    try:
        if call("GET", "/health", token=None)[0] == 200:
            break
    except OSError:
        pass
    time.sleep(0.2)

h = health()
print(f"  health: device={h.get('device')} compute={h.get('computeType')} gpu={h.get('gpuName')} cuda={h.get('cudaVersion')}", flush=True)
check(
    "CUDA is the configured device",
    h.get("requestedDevice") == "cuda" and h.get("device") == "cuda" and h.get("cudaAvailable") is True,
    json.dumps(h),
)
check("no CPU fallback at start", h.get("degraded") is False and h.get("reason") is None, json.dumps(h))
check("CUDA compute type", h.get("computeType") in ("float16", "int8_float16"), str(h.get("computeType")))
check("GPU name is reported", isinstance(h.get("gpuName"), str) and len(h["gpuName"]) > 0, str(h.get("gpuName")))
check("idle worker has no model", h.get("stt") is False and h.get("model") is None, json.dumps(h))
children = child_processes()
check("no engine child at start", children == 0, str(children))

status, ctype, wav = call("POST", "/speak?voice=en_US-lessac-medium", b"Please remind me to buy fresh bread tomorrow morning.")
check("piper produced test audio", status == 200 and ctype == "audio/wav" and wav[:4] == b"RIFF", f"{status} {len(wav)}")
status, _, body = call("POST", "/transcribe?model=base&language=en", wav)
text = json.loads(body).get("text", "") if status == 200 else body.decode()
check("cuda transcribes", status == 200 and "bread" in text.lower() and "tomorrow" in text.lower(), text)

h = health()
check("child reports CUDA after inference", h.get("device") == "cuda" and h.get("degraded") is False and h.get("model") == "base", json.dumps(h))
children = child_processes()
check("engine child is running", children >= 1, str(children))

time.sleep(40)
h = health()
after = child_processes()
check("engine child exits when idle", h.get("stt") is False and after == 0, f"stt={h.get('stt')} children={after}")
check("idle health releases the model", h.get("model") is None, json.dumps(h))

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all GPU speech worker checks passed'}")
sys.exit(1 if failures else 0)
