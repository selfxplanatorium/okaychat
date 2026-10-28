#!/bin/sh
# Focused real-app-module -> real-runner test. Own container, tmpfs workspace, random token/port;
# does not touch the running dev sandbox, its workspaces, or any real account/database.
set -eu
cd "$(dirname "$0")/../.."
case "${1:-}" in
  '') docker build -q -t "okaychat-sandbox:${IT_TAG:-it}" sandbox >/dev/null ;;
  --no-build) ;;
  *) echo 'usage: test/integration/cross-chat.sh [--no-build]' >&2; exit 2 ;;
esac
name="okaychat-it-isolation-$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
OKAYCHAT_IT_SANDBOX_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
export OKAYCHAT_IT_SANDBOX_TOKEN
docker run -d --name "$name" -p 127.0.0.1::8080 -e SANDBOX_TOKEN="$OKAYCHAT_IT_SANDBOX_TOKEN" \
  --init --read-only --tmpfs /work:size=128m,mode=755 --tmpfs /tmp:size=64m,mode=1777 \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --security-opt no-new-privileges:true --security-opt seccomp="$PWD/sandbox/seccomp.json" --security-opt apparmor=unconfined \
  --pids-limit 512 --memory 2g --cpus 2 "okaychat-sandbox:${IT_TAG:-it}" >/dev/null
port=$(docker port "$name" 8080/tcp | sed 's/.*://')
export OKAYCHAT_IT_SANDBOX_URL="http://127.0.0.1:$port"
export OKAYCHAT_IT_SANDBOX_CONTAINER="$name"
node --input-type=module -e '
for (let attempt = 0; attempt < 50; attempt++) {
  try {
    const r = await fetch(`${process.env.OKAYCHAT_IT_SANDBOX_URL}/health`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) throw new Error(`runner health HTTP ${r.status}: ${await r.text()}`);
    process.exit(0);
  } catch (error) {
    if (attempt === 49) throw error;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}'
node --test --import tsx src/server/sandbox-isolation.itest.ts
