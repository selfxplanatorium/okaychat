#!/bin/sh
# Dev only: build and start the hardened browser worker container on 127.0.0.1:8792, as compose runs it
# (firewall, separate users, read-only root). `npm run dev` already starts a local worker without the firewall;
# use this one to test the real egress rules, then set OKAYCHAT_BROWSER_URL=http://127.0.0.1:8792 in .env
# and restart `npm run dev`. It mounts only a copy of the app's worker token file, which `npm run dev:server` creates.
set -e
cd "$(dirname "$0")/.."
DATA=$(sed -n 's/^OKAYCHAT_DATA_DIR=//p' .env 2>/dev/null)
TOKEN_FILE="$(cd "${DATA:-./data}" && pwd)/browser-token"
[ -s "$TOKEN_FILE" ] || { echo "Start npm run dev:server once so it creates $TOKEN_FILE" >&2; exit 1; }
# The worker's job API runs as uid 10001, which cannot read the app's 0640 file, so mount a readable copy.
COPY_DIR="${TMPDIR:-/tmp}/okaychat-dev-browser-token"
mkdir -p "$COPY_DIR" && chmod 700 "$COPY_DIR"
install -m 0644 "$TOKEN_FILE" "$COPY_DIR/token"
docker build -q --target browser -t okaychat-browser:dev . >/dev/null
docker rm -f okaychat-dev-browser >/dev/null 2>&1 || true
exec docker run -d --name okaychat-dev-browser --restart unless-stopped -p 127.0.0.1:8792:8080 \
  -e BROWSER_TOKEN_FILE=/run/okaychat-browser/token -v "$COPY_DIR/token":/run/okaychat-browser/token:ro \
  --read-only --tmpfs /tmp:size=512m,mode=1777 \
  --cap-drop ALL --cap-add NET_ADMIN --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add SETPCAP \
  --security-opt no-new-privileges:true --pids-limit 512 --memory 1536m --cpus 2 \
  okaychat-browser:dev
