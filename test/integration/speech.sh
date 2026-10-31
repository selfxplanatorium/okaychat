#!/bin/sh
# Integration test for the speech worker (speech/) in its real container, with the compose hardening:
# token from a read-only file, read-only root, no capabilities. Isolated from any deployment: image tag
# okaychat-speech:$IT_TAG, container okaychat-it-speech on 127.0.0.1:18793. Downloaded models stay in the volume
# okaychat-it-speech-models between runs (pass --clean to remove it). See docs/implementation/speech.md.
#
# Usage: test/integration/speech.sh [--no-build] [--clean]
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
IT_TAG=${IT_TAG:-it}
SHARE=$(mktemp -d "${TMPDIR:-/tmp}/okaychat-it-speech.XXXXXX")
cleanup() {
  docker rm -f okaychat-it-speech >/dev/null 2>&1 || true
  [ "$CLEAN" = 1 ] && docker volume rm okaychat-it-speech-models >/dev/null 2>&1 || true
  rm -rf "$SHARE"
}
trap cleanup EXIT
head -c 32 /dev/urandom | base64 | tr -d '/+=\n' > "$SHARE/token"
chmod 0644 "$SHARE/token"
# Pure device-resolution and fallback tests: no GPU, models, or downloads needed.
python3 -m unittest discover -s speech -p 'test_*.py'
[ "$BUILD" = 1 ] && docker build -q -t "okaychat-speech:$IT_TAG" speech >/dev/null
docker rm -f okaychat-it-speech >/dev/null 2>&1 || true
docker run -d --name okaychat-it-speech -p 127.0.0.1:18793:8080 \
  -e SPEECH_TOKEN_FILE=/run/okaychat-speech/token -e SPEECH_IDLE_MINUTES=0.25 \
  -e SPEECH_DEVICE=cpu -e SPEECH_COMPUTE_TYPE= \
  -v "$SHARE/token":/run/okaychat-speech/token:ro -v okaychat-it-speech-models:/models \
  --init --read-only --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 256 --memory 2g --cpus 2 \
  "okaychat-speech:$IT_TAG" >/dev/null
python3 -I test/integration/speech_it.py http://127.0.0.1:18793 "$(cat "$SHARE/token")" okaychat-it-speech
