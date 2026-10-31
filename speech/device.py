"""Choose the faster-whisper device and compute type for the speech worker.

The HTTP parent imports only the standard library. Probing CUDA runs in a short-lived
child process, so no CUDA context is ever created or retained by the long-running worker.
The result is cached: the environment is read once, and a restart re-probes.

See docs/implementation/speech.md ("GPU acceleration").
"""

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass

DEVICES = ("auto", "cpu", "cuda")
COMPUTE_TYPES = ("int8", "int8_float32", "int8_float16", "int8_bfloat16", "float16", "float32", "bfloat16")
CPU_COMPUTE = "int8"
DEFAULT_CUDA_COMPUTE = "float16"
FALLBACK_CUDA_COMPUTE = "int8_float16"
PROBE_TIMEOUT = 20
SMI_TIMEOUT = 5

# Runs in a child interpreter and exits, so CUDA initialisation here never leaks a
# context into the speech server. Only the last stdout line is JSON.
_PROBE_SCRIPT = r"""
import ctypes
import json

out = {"count": 0, "gpu": None, "cuda": None, "error": None}
try:
    import ctranslate2
    out["count"] = int(ctranslate2.get_cuda_device_count())
except Exception as exc:
    out["error"] = f"{type(exc).__name__}: {exc}"
try:
    cuda = ctypes.CDLL("libcuda.so.1")
    if cuda.cuInit(0) == 0:
        count = ctypes.c_int()
        if cuda.cuDeviceGetCount(ctypes.byref(count)) == 0 and count.value > 0:
            out["count"] = max(out["count"], int(count.value))
            device = ctypes.c_int()
            if cuda.cuDeviceGet(ctypes.byref(device), 0) == 0:
                name = ctypes.create_string_buffer(256)
                if cuda.cuDeviceGetName(name, 256, device) == 0:
                    out["gpu"] = name.value.decode("utf-8", "replace")
except Exception:
    pass
try:
    # The CUDA runtime version, not the driver's maximum supported version that
    # nvidia-smi prints. Absent when only the driver library is installed.
    runtime = ctypes.CDLL("libcudart.so.12")
    version = ctypes.c_int()
    if runtime.cudaRuntimeGetVersion(ctypes.byref(version)) == 0:
        out["cuda"] = f"{version.value // 1000}.{(version.value % 1000) // 10}"
except Exception:
    pass
print(json.dumps(out))
"""


@dataclass(frozen=True)
class Probe:
    """What a cheap probe found. `count` is the number of usable CUDA devices."""

    count: int = 0
    gpu_name: str | None = None
    cuda_version: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class DevicePlan:
    """The device and compute type a transcription should try first."""

    requested: str
    device: str
    compute_type: str
    gpu_name: str | None = None
    cuda_version: str | None = None
    cuda_available: bool | None = None
    degraded: bool = False
    reason: str | None = None


_cache: dict[tuple[str, str], DevicePlan] = {}


def reset_device_cache() -> None:
    """Forget the cached probe. Tests use this; a real worker restarts instead."""
    _cache.clear()


def _smi_probe() -> Probe | None:
    """NVIDIA's tool sees a device even when ctranslate2 cannot load CUDA."""
    executable = shutil.which("nvidia-smi")
    if not executable:
        return None
    try:
        result = subprocess.run(
            [executable, "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=SMI_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    names = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not names:
        return None
    return Probe(count=len(names), gpu_name=names[0])


def _proc_gpu_name() -> str | None:
    root = "/proc/driver/nvidia/gpus"
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return None
    for entry in entries:
        try:
            with open(os.path.join(root, entry, "information"), encoding="utf-8") as file:
                for line in file:
                    if line.startswith("Model:"):
                        return line.split(":", 1)[1].strip() or None
        except OSError:
            continue
    return None


def probe_cuda(timeout: float = PROBE_TIMEOUT) -> Probe:
    """Cheap, cached-by-caller check of the CUDA devices visible to this container."""
    try:
        result = subprocess.run(
            [sys.executable, "-c", _PROBE_SCRIPT],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        smi = _smi_probe()
        if smi:
            return smi
        return Probe(error=f"the device probe failed: {type(exc).__name__}")
    if result.returncode != 0:
        smi = _smi_probe()
        if smi:
            return smi
        return Probe(error=f"the device probe exited with status {result.returncode}")
    try:
        data = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        smi = _smi_probe()
        if smi:
            return smi
        return Probe(error="the device probe returned no result")
    count = int(data.get("count") or 0)
    cuda = data.get("cuda")
    gpu = data.get("gpu")
    if count <= 0:
        smi = _smi_probe()
        if smi:
            # A GPU exists but this image cannot use it. Keep the name for the
            # diagnostics, and explain that ctranslate2 saw nothing usable.
            return Probe(count=0, gpu_name=smi.gpu_name, cuda_version=cuda, error=data.get("error") or "ctranslate2 found no usable CUDA device")
        return Probe(count=0, gpu_name=gpu, cuda_version=cuda, error=data.get("error"))
    return Probe(count=count, gpu_name=gpu or _proc_gpu_name(), cuda_version=cuda, error=data.get("error"))


def _note(notes: list[str]) -> str | None:
    return " ".join(notes) if notes else None


def _resolve(requested_raw: str, compute_raw: str, probe) -> DevicePlan:
    notes: list[str] = []
    requested = requested_raw if requested_raw in DEVICES else "auto"
    if requested_raw != requested:
        notes.append(f"SPEECH_DEVICE={requested_raw!r} is not cpu, cuda, or auto; using auto.")
    compute = compute_raw if compute_raw in COMPUTE_TYPES else None
    if compute_raw and compute is None:
        notes.append(f"SPEECH_COMPUTE_TYPE={compute_raw!r} is not a known compute type; using the default.")

    if requested == "cpu":
        return DevicePlan(requested="cpu", device="cpu", compute_type=compute or CPU_COMPUTE, reason=_note(notes))

    try:
        result = probe()
    except Exception as exc:
        result = Probe(error=f"{type(exc).__name__}: {exc}")
    if result.count <= 0:
        reason = _note(notes)
        if requested == "cuda":
            detail = result.error or "no NVIDIA GPU is visible to the speech container"
            reason = (
                f"CUDA was requested, but {detail}. "
                "Start the speech worker with the NVIDIA container runtime, or set SPEECH_DEVICE=cpu."
            )
            if notes:
                reason = f"{_note(notes)} {reason}"
        elif result.gpu_name and result.error:
            # Auto stays quiet on CPU when no GPU is visible, but a visible GPU this image cannot use is worth reporting.
            reason = _note([*notes, result.error])
        return DevicePlan(
            requested=requested,
            device="cpu",
            compute_type=compute or CPU_COMPUTE,
            gpu_name=result.gpu_name,
            cuda_version=result.cuda_version,
            cuda_available=False,
            degraded=requested == "cuda",
            reason=reason,
        )

    return DevicePlan(
        requested=requested,
        device="cuda",
        compute_type=compute or DEFAULT_CUDA_COMPUTE,
        gpu_name=result.gpu_name,
        cuda_version=result.cuda_version,
        cuda_available=True,
        reason=_note(notes),
    )


def resolve_device(env=None, probe=None) -> DevicePlan:
    """Resolve SPEECH_DEVICE / SPEECH_COMPUTE_TYPE once.

    `probe` is injectable for tests; it must return a Probe. The cache keeps health
    checks and child starts from running the probe again.
    """
    values = os.environ if env is None else env
    requested_raw = (values.get("SPEECH_DEVICE") or "auto").strip().lower()
    compute_raw = (values.get("SPEECH_COMPUTE_TYPE") or "").strip().lower()
    key = (requested_raw, compute_raw)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    plan = _resolve(requested_raw, compute_raw, probe or probe_cuda)
    _cache[key] = plan
    return plan
