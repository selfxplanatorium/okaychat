#!/bin/sh
# Dev only: build and start the code sandbox on 127.0.0.1:8790 with the same hardening as compose.
# Needs OKAYCHAT_SANDBOX_TOKEN in .env. The container itself can reach the internet (a published port does not
# work on an internal network), but run code cannot: every run has its own network namespace with only loopback.
set -e
cd "$(dirname "$0")/.."
TOKEN=$(sed -n 's/^OKAYCHAT_SANDBOX_TOKEN=//p' .env)
[ ${#TOKEN} -ge 32 ] || { echo "Set OKAYCHAT_SANDBOX_TOKEN (32+ characters) in .env" >&2; exit 1; }
docker build -q -t okaychat-sandbox:dev sandbox >/dev/null
docker rm -f okaychat-dev-sandbox >/dev/null 2>&1 || true
exec docker run -d --name okaychat-dev-sandbox --restart unless-stopped -p 127.0.0.1:8790:8080 \
  -e SANDBOX_TOKEN="$TOKEN" -e SANDBOX_IDLE_MINUTES="${SANDBOX_IDLE_MINUTES:-30}" -v okaychat-dev-sandbox:/work \
  --init --read-only --tmpfs /tmp:size=64m,mode=1777 \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --security-opt no-new-privileges:true --security-opt seccomp="$PWD/sandbox/seccomp.json" --security-opt apparmor=unconfined \
  --pids-limit 512 --memory 2g --cpus 2 \
  okaychat-sandbox:dev
