#!/bin/sh
# Dev only: build and start the speech worker (Piper, Whisper) on 127.0.0.1:8793 with the same hardening as compose.
# Mounts a readable copy of the app's speech token, which `npm run dev:server` creates when OKAYCHAT_SPEECH_URL is set.
# Uses the NVIDIA GPU and a CUDA image when Docker exposes an NVIDIA runtime and device, unless SPEECH_DEVICE=cpu.
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

DEVICE=${SPEECH_DEVICE:-auto}
GPU=0
if [ "$DEVICE" != "cpu" ] \
  && docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"' \
  && command -v nvidia-smi >/dev/null 2>&1 \
  && nvidia-smi -L 2>/dev/null | grep -q '^GPU '; then
  GPU=1
fi
if [ "$DEVICE" = "cpu" ]; then
  echo "SPEECH_DEVICE=cpu: using the CPU image."
elif [ "$GPU" = 1 ]; then
  echo "NVIDIA GPU detected: building the CUDA image."
else
  echo "No NVIDIA GPU runtime detected: using the CPU image."
fi

BUILD_ARGS=""
RUN_GPU=""
MEMORY=2g
if [ "$GPU" = 1 ]; then
  BUILD_ARGS="--build-arg INSTALL_CUDA=1"
  RUN_GPU="--gpus all"
  MEMORY=4g
fi

# shellcheck disable=SC2086
docker build -q $BUILD_ARGS -t okaychat-speech:dev speech >/dev/null
docker rm -f okaychat-dev-speech >/dev/null 2>&1 || true
# shellcheck disable=SC2086
docker run -d --name okaychat-dev-speech --restart unless-stopped -p 127.0.0.1:8793:8080 $RUN_GPU \
  -e SPEECH_TOKEN_FILE=/run/okaychat-speech/token -e SPEECH_IDLE_MINUTES="${SPEECH_IDLE_MINUTES:-5}" \
  -e SPEECH_DEVICE="$DEVICE" -e SPEECH_COMPUTE_TYPE="${SPEECH_COMPUTE_TYPE:-}" \
  -v "$COPY_DIR/token":/run/okaychat-speech/token:ro -v okaychat-dev-speech:/models \
  --init --read-only --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 256 --memory "$MEMORY" --cpus 2 \
  okaychat-speech:dev >/dev/null

# Print the device the worker actually reports, which may be CPU after a CUDA fallback.
HEALTH=""
i=0
while [ "$i" -lt 30 ]; do
  HEALTH=$(node -e 'fetch("http://127.0.0.1:8793/health").then(r=>r.ok?r.json():Promise.reject(new Error())).then(h=>{const p=[h.device||"?",h.computeType||"?",h.gpuName||""];if(h.degraded)p.push("degraded");if(h.reason)p.push(h.reason);console.log(p.filter(Boolean).join(" · "))}).catch(()=>process.exit(1))' 2>/dev/null) && break
  i=$((i + 1))
  sleep 1
done
echo "speech worker on 127.0.0.1:8793: ${HEALTH:-health unavailable} (requested SPEECH_DEVICE=$DEVICE)"
