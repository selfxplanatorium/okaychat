#!/bin/sh
# GPU integration test for the speech worker (speech/) in its real CUDA container.
# Only runs where Docker exposes an NVIDIA GPU through the NVIDIA container runtime;
# otherwise it prints SKIP and exits 0. Isolated from any deployment and from the CPU
# suite: image okaychat-speech-gpu:$IT_TAG, container okaychat-it-speech-gpu on
# 127.0.0.1:18794, volume okaychat-it-speech-gpu-models. See docs/implementation/speech.md.
#
# Usage: test/integration/speech-gpu.sh [--no-build] [--clean]
set -eu
cd "$(dirname "$0")/../.."
BUILD=1 CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --clean) CLEAN=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: Docker is not available; the GPU speech worker test needs a Docker daemon."
  exit 0
fi
if ! docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'; then
  echo "SKIP: Docker has no NVIDIA runtime; install the NVIDIA Container Toolkit to test GPU acceleration."
  exit 0
fi
if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi -L 2>/dev/null | grep -q '^GPU '; then
  echo "SKIP: no NVIDIA GPU is visible on this host."
  exit 0
fi

IT_TAG=${IT_TAG:-it}
SHARE=$(mktemp -d "${TMPDIR:-/tmp}/okaychat-it-speech-gpu.XXXXXX")
cleanup() {
  docker rm -f okaychat-it-speech-gpu >/dev/null 2>&1 || true
  [ "$CLEAN" = 1 ] && docker volume rm okaychat-it-speech-gpu-models >/dev/null 2>&1 || true
  rm -rf "$SHARE"
}
trap cleanup EXIT
head -c 32 /dev/urandom | base64 | tr -d '/+=\n' > "$SHARE/token"
chmod 0644 "$SHARE/token"
# Pure device-resolution and fallback tests: no GPU, models, or downloads needed.
python3 -m unittest discover -s speech -p 'test_*.py'
if [ "$BUILD" = 1 ]; then
  docker build -q --build-arg INSTALL_CUDA=1 -t "okaychat-speech-gpu:$IT_TAG" speech >/dev/null
fi
docker rm -f okaychat-it-speech-gpu >/dev/null 2>&1 || true
docker run -d --name okaychat-it-speech-gpu -p 127.0.0.1:18794:8080 --gpus all \
  -e SPEECH_TOKEN_FILE=/run/okaychat-speech/token -e SPEECH_IDLE_MINUTES=0.25 \
  -e SPEECH_DEVICE=cuda -e SPEECH_COMPUTE_TYPE= \
  -v "$SHARE/token":/run/okaychat-speech/token:ro -v okaychat-it-speech-gpu-models:/models \
  --init --read-only --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 256 --memory 4g --cpus 2 \
  "okaychat-speech-gpu:$IT_TAG" >/dev/null
python3 -I test/integration/speech_gpu_it.py http://127.0.0.1:18794 "$(cat "$SHARE/token")" okaychat-it-speech-gpu
