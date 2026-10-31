"""Unit tests for device resolution and the CUDA -> CPU fallback (no GPU or model files).

Run from the repository root: python3 -m unittest discover -s speech -p 'test_*.py'
"""

import os
import unittest
from unittest.mock import patch

import device
from device import DevicePlan, Probe, reset_device_cache, resolve_device
from server import Engine, Failure, SttEngine, engine_main


def clean_env(**values):
    env = {key: value for key, value in os.environ.items() if key not in ("SPEECH_DEVICE", "SPEECH_COMPUTE_TYPE")}
    env.update({key: value for key, value in values.items() if value is not None})
    return env


class ResolveDeviceTests(unittest.TestCase):
    def setUp(self):
        reset_device_cache()

    def tearDown(self):
        reset_device_cache()

    def test_cpu_override_skips_the_probe(self):
        def probe():
            raise AssertionError("SPEECH_DEVICE=cpu must not probe CUDA")

        plan = resolve_device(clean_env(SPEECH_DEVICE="cpu"), probe=probe)
        self.assertEqual(plan.requested, "cpu")
        self.assertEqual(plan.device, "cpu")
        self.assertEqual(plan.compute_type, "int8")
        self.assertFalse(plan.degraded)

    def test_auto_uses_cuda_when_the_probe_finds_a_device(self):
        plan = resolve_device(
            clean_env(),
            probe=lambda: Probe(count=1, gpu_name="NVIDIA RTX 4090", cuda_version="12.4"),
        )
        self.assertEqual(plan.requested, "auto")
        self.assertEqual(plan.device, "cuda")
        self.assertEqual(plan.compute_type, "float16")
        self.assertEqual(plan.gpu_name, "NVIDIA RTX 4090")
        self.assertEqual(plan.cuda_version, "12.4")
        self.assertTrue(plan.cuda_available)
        self.assertFalse(plan.degraded)

    def test_auto_without_a_gpu_stays_quiet_on_cpu(self):
        plan = resolve_device(clean_env(), probe=lambda: Probe(count=0))
        self.assertEqual(plan.device, "cpu")
        self.assertEqual(plan.compute_type, "int8")
        self.assertFalse(plan.degraded)
        self.assertIsNone(plan.reason)
        self.assertFalse(plan.cuda_available)

    def test_forced_cuda_without_a_gpu_explains_the_fallback(self):
        plan = resolve_device(clean_env(SPEECH_DEVICE="cuda"), probe=lambda: Probe(count=0))
        self.assertEqual(plan.requested, "cuda")
        self.assertEqual(plan.device, "cpu")
        self.assertTrue(plan.degraded)
        self.assertIn("CUDA was requested", plan.reason)
        self.assertIn("SPEECH_DEVICE=cpu", plan.reason)

    def test_a_failing_probe_does_not_break_resolution(self):
        plan = resolve_device(clean_env(SPEECH_DEVICE="cuda"), probe=lambda: (_ for _ in ()).throw(OSError("no driver")))
        self.assertEqual(plan.device, "cpu")
        self.assertTrue(plan.degraded)
        self.assertIn("no driver", plan.reason)

    def test_invalid_environment_values_fall_back_to_auto_defaults(self):
        plan = resolve_device(clean_env(SPEECH_DEVICE="gpu", SPEECH_COMPUTE_TYPE="banana"), probe=lambda: Probe(count=0))
        self.assertEqual(plan.requested, "auto")
        self.assertEqual(plan.device, "cpu")
        self.assertEqual(plan.compute_type, "int8")
        self.assertIn("SPEECH_DEVICE", plan.reason)
        self.assertIn("SPEECH_COMPUTE_TYPE", plan.reason)

    def test_compute_override_is_honored_for_the_attempted_device(self):
        cuda = resolve_device(
            clean_env(SPEECH_COMPUTE_TYPE="int8_float16"),
            probe=lambda: Probe(count=1, gpu_name="GPU"),
        )
        self.assertEqual(cuda.device, "cuda")
        self.assertEqual(cuda.compute_type, "int8_float16")
        reset_device_cache()
        cpu = resolve_device(clean_env(SPEECH_DEVICE="cpu", SPEECH_COMPUTE_TYPE="float32"), probe=None)
        self.assertEqual(cpu.device, "cpu")
        self.assertEqual(cpu.compute_type, "float32")

    def test_resolution_is_cached(self):
        calls = []

        def probe():
            calls.append(1)
            return Probe(count=1, gpu_name="GPU")

        first = resolve_device(clean_env(), probe=probe)
        second = resolve_device(clean_env(), probe=probe)
        self.assertIs(first, second)
        self.assertEqual(len(calls), 1)


class FakeModel:
    def __init__(self, device, fail_on_iteration=False):
        self.device = device
        self.fail_on_iteration = fail_on_iteration

    def transcribe(self, samples, **kwargs):
        class Info:
            language = "en"

        def segments():
            if self.fail_on_iteration:
                raise RuntimeError("CUDA out of memory")
            text = " hello "
            yield type("Segment", (), {"text": text})()

        return segments(), Info()


class FakeLoader:
    def __init__(self, failures=()):
        self.failures = set(failures)
        self.calls = []

    def __call__(self, name, device, compute):
        self.calls.append((name, device, compute))
        if (device, compute) in self.failures:
            raise RuntimeError(f"{compute} is not supported on {device}")
        return FakeModel(device)


CUDA_PLAN = DevicePlan(
    requested="auto",
    device="cuda",
    compute_type="float16",
    gpu_name="Test GPU",
    cuda_version="12.4",
    cuda_available=True,
)


class SttFallbackTests(unittest.TestCase):
    def test_float16_falls_back_to_int8_float16_on_cuda(self):
        loader = FakeLoader({("cuda", "float16")})
        engine = SttEngine(CUDA_PLAN, loader=loader, log=lambda message: None)
        engine.load("base")
        self.assertEqual(loader.calls, [("base", "cuda", "float16"), ("base", "cuda", "int8_float16")])
        self.assertEqual(engine.key, ("base", "cuda", "int8_float16"))
        self.assertFalse(engine.degraded)

    def test_cuda_failure_falls_back_to_cpu_int8_and_logs_once(self):
        loader = FakeLoader({("cuda", "float16"), ("cuda", "int8_float16")})
        logs = []
        engine = SttEngine(CUDA_PLAN, loader=loader, log=logs.append)
        engine.load("base")
        self.assertEqual(loader.calls[-1], ("base", "cpu", "int8"))
        self.assertEqual(engine.key, ("base", "cpu", "int8"))
        self.assertTrue(engine.degraded)
        self.assertIn("CUDA could not run Whisper", engine.reason)
        self.assertEqual(engine.status()["device"], "cpu")
        engine.load("small")
        self.assertEqual(len(logs), 1)

    def test_compute_override_limits_the_cuda_candidates(self):
        plan = DevicePlan(requested="auto", device="cuda", compute_type="int8_float16", cuda_available=True)
        loader = FakeLoader({("cuda", "int8_float16")})
        engine = SttEngine(plan, loader=loader, log=lambda message: None)
        engine.load("base")
        self.assertEqual(loader.calls, [("base", "cuda", "int8_float16"), ("base", "cpu", "int8")])
        self.assertTrue(engine.degraded)

    def test_cpu_compute_override_falls_back_to_int8(self):
        plan = DevicePlan(requested="cpu", device="cpu", compute_type="float32", cuda_available=False)
        loader = FakeLoader({("cpu", "float32")})
        engine = SttEngine(plan, loader=loader, log=lambda message: None)
        engine.load("base")
        self.assertEqual(loader.calls, [("base", "cpu", "float32"), ("base", "cpu", "int8")])
        self.assertEqual(engine.key, ("base", "cpu", "int8"))

    def test_the_model_cache_is_keyed_by_name_device_and_compute(self):
        loader = FakeLoader()
        engine = SttEngine(CUDA_PLAN, loader=loader, log=lambda message: None)
        first = engine.load("base")
        self.assertIs(engine.load("base"), first)
        self.assertEqual(len(loader.calls), 1)
        engine.load("small")
        self.assertEqual(loader.calls[-1], ("small", "cuda", "float16"))

    def test_inference_failure_retries_on_cpu(self):
        engine = SttEngine(CUDA_PLAN, loader=lambda name, device, compute: FakeModel(device, fail_on_iteration=device == "cuda"), log=lambda message: None)
        result = engine.run_with_fallback([0.0], "base", None, {"vad": "0", "beam": "1"})
        self.assertEqual(result["text"], "hello")
        self.assertEqual(engine.device, "cpu")
        self.assertTrue(engine.degraded)
        self.assertEqual(engine.key, ("base", "cpu", "int8"))


class StatusFailureTests(unittest.TestCase):
    def test_failed_cpu_retry_reaches_parent_health(self):
        class Pipe:
            def __init__(self):
                self.reply = None

            def recv(self):
                if self.reply is None:
                    return ("load", ("base",))
                raise EOFError

            def send(self, reply):
                self.reply = reply

            def poll(self, timeout):
                return True

        pipe = Pipe()
        with patch.object(SttEngine, "load_whisper", side_effect=RuntimeError("load failed")):
            engine_main("stt", pipe, CUDA_PLAN.__dict__)
        self.assertEqual(pipe.reply[:3], ("err", 500, "The speech worker failed."))
        self.assertEqual(pipe.reply[3]["device"], "cpu")
        self.assertTrue(pipe.reply[3]["degraded"])
        self.assertIsNone(pipe.reply[3]["model"])

        # Consume the same wire reply in the parent without starting a process.
        pipe.recv = lambda: pipe.reply
        pipe.send = lambda value: None
        parent = Engine("stt")
        parent.proc = type("Process", (), {"is_alive": lambda self: True})()
        parent.conn = pipe
        with self.assertRaises(Failure):
            parent.call("load", "base")
        self.assertEqual(parent.report, pipe.reply[3])


if __name__ == "__main__":
    unittest.main()
