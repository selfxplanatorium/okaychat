#!/bin/sh
# Dev only: build and start the speech worker (Piper, Whisper) on 127.0.0.1:8793 with the same hardening as compose.
# Mounts a readable copy of the app's speech token, which `npm run dev:server` creates when OKAYCHAT_SPEECH_URL is set.
# Then set OKAYCHAT_SPEECH_URL=http://127.0.0.1:8793 in .env and restart `npm run dev`.
set -e
cd "$(dirname "$0")/.."
DATA=$(sed -n 's/^OKAYCHAT_DATA_DIR=//p' .env 2>/dev/null)
TOKEN_FILE="$(cd "${DATA:-./data}" && pwd)/speech-token"
if [ ! -s "$TOKEN_FILE" ]; then
  # Same format the app writes; the app reads it on its next start.
  mkdir -p "$(dirname "$TOKEN_FILE")"
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url')+'\n')" > "$TOKEN_FILE"
  chmod 0640 "$TOKEN_FILE"
fi
# The worker runs as uid 10100, which cannot read the app's 0640 file, so mount a readable copy.
COPY_DIR="${TMPDIR:-/tmp}/okaychat-dev-speech-token"
mkdir -p "$COPY_DIR" && chmod 700 "$COPY_DIR"
install -m 0644 "$TOKEN_FILE" "$COPY_DIR/token"
docker build -q -t okaychat-speech:dev speech >/dev/null
docker rm -f okaychat-dev-speech >/dev/null 2>&1 || true
exec docker run -d --name okaychat-dev-speech --restart unless-stopped -p 127.0.0.1:8793:8080 \
  -e SPEECH_TOKEN_FILE=/run/okaychat-speech/token -e SPEECH_IDLE_MINUTES="${SPEECH_IDLE_MINUTES:-5}" \
  -v "$COPY_DIR/token":/run/okaychat-speech/token:ro -v okaychat-dev-speech:/models \
  --init --read-only --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 256 --memory 2g --cpus 2 \
  okaychat-speech:dev
