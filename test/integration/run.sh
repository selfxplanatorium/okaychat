#!/bin/sh
# Integration tests against the real containers. Everything is isolated from any real deployment:
#   - compose project okaychat-it (its own containers, networks 10.231.1-3.0/24, and volumes okaychat-it_*),
#   - image tags okaychat*:$IT_TAG (default "it"), never :latest,
#   - app on 127.0.0.1:$IT_APP_PORT (default 18787), standalone dev-topology containers on 18790 and 18792,
#   - generated secrets in a temporary env file instead of the repository's .env.
# Cleanup removes only what this script created (the okaychat-it project with its own volumes, and the
# okaychat-it-* containers and volumes). See docs/implementation/code-sandbox.md and docs/implementation/browser-worker.md.
#
# Usage: test/integration/run.sh [--no-build] [--keep]
set -eu
cd "$(dirname "$0")/../.."

BUILD=1 KEEP=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done

IT_TAG=${IT_TAG:-it}
IT_APP_PORT=${IT_APP_PORT:-18787}
PROJECT=okaychat-it
SHARE=$(mktemp -d "${TMPDIR:-/tmp}/okaychat-it.XXXXXX")
chmod 755 "$SHARE"
random() { head -c 32 /dev/urandom | base64 | tr -d '/+=\n'; }
cat > "$SHARE/it.env" <<EOF
IT_TAG=$IT_TAG
IT_APP_PORT=$IT_APP_PORT
IT_SHARE=$SHARE
OKAYCHAT_SECRET=$(random)
OKAYCHAT_SANDBOX_TOKEN=$(random)
OKAYCHAT_ALLOW_SIGNUP=false
EOF
compose() { docker compose -p "$PROJECT" --env-file "$SHARE/it.env" -f docker-compose.yml -f test/integration/compose.it.yml "$@"; }
FAILED=0
step() { echo; echo "=== $*"; }
check() { if "$@"; then echo "PASS $*"; else echo "FAIL $*"; FAILED=$((FAILED + 1)); fi; }

cleanup() {
  [ "$KEEP" = 1 ] && { echo "kept: project $PROJECT, share $SHARE"; return; }
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f okaychat-it-failclosed okaychat-it-dev-sandbox okaychat-it-dev-browser okaychat-it-browser-no-net_admin okaychat-it-browser-no-setpcap okaychat-it-lo-fixture >/dev/null 2>&1 || true
  docker volume rm okaychat-it-dev-sandbox okaychat-it-failclosed >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "$BUILD" = 1 ]; then
  step "build images (tag $IT_TAG)"
  for spec in "okaychat:$IT_TAG --target app ." "okaychat-browser:$IT_TAG --target browser ." "okaychat-sandbox:$IT_TAG sandbox"; do
    set -- $spec
    start=$(date +%s)
    docker build -q -t "$@" >/dev/null
    echo "built $1 in $(( $(date +%s) - start )) s"
  done
fi

step "start the compose deployment"
compose up -d --wait --wait-timeout 180
compose ps --format '{{.Service}} {{.Status}}'

step "fixtures: RAR 4 and RAR 5 samples from libarchive's test suite (BSD-2-Clause)"
for pair in "rar4.rar test_read_format_rar.rar.uu" "rar5.rar test_read_format_rar5_stored.rar.uu"; do
  set -- $pair
  curl -fsSL "https://raw.githubusercontent.com/libarchive/libarchive/v3.7.9/libarchive/test/$2" -o "$SHARE/$2" \
    && python3 -c 'import binascii,sys
lines=open(sys.argv[1]).read().splitlines()
start=next(i for i,l in enumerate(lines) if l.startswith("begin "))
out=b"".join(binascii.a2b_uu(l) for l in lines[start+1:] if l and l!="end" and l!="`")
open(sys.argv[2],"wb").write(out)' "$SHARE/$2" "$SHARE/$1" || echo "could not fetch $2; RAR checks will be skipped"
done

step "sandbox: positive control from the container's own namespace (outside any run)"
check compose exec -T sandbox python3 -c 'import socket; socket.create_connection(("10.231.2.50", 9000), timeout=3).close()'

ip_of() { docker inspect -f "{{(index .NetworkSettings.Networks \"${PROJECT}_$2\").IPAddress}}" "$(compose ps -q "$1")"; }
NET_TARGETS=$(cat <<EOF
{"fixture sandbox net": ["10.231.2.50", 9000], "fixture browser net": ["10.231.1.50", 9000], "fixture default net": ["10.231.3.50", 9000],
 "runner loopback": ["127.0.0.1", 8080], "runner by ip": ["$(ip_of sandbox sandbox)", 8080], "app": ["$(ip_of okaychat sandbox)", 8787],
 "searxng": ["$(ip_of searxng default)", 8080], "browser worker": ["$(ip_of browser browser)", 8080], "host gateway": ["10.231.2.1", 22],
 "docker bridge host": ["172.17.0.1", 22], "metadata": ["169.254.169.254", 80]}
EOF
)

step "sandbox suite"
check compose exec -T -e NET_TARGETS="$NET_TARGETS" tester python3 -u /tests/sandbox_it.py

step "sandbox: host AppArmor profiles do not attach to run code (exec view)"
if [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = Y ]; then
  # A run holds gs and qpdf open on FIFOs; the host shows each process's AppArmor label.
  compose exec -T -e SANDBOX_URL=http://sandbox:8080 tester python3 -c '
import sys; sys.argv = ["x"]; sys.path.insert(0, "/tests"); import sandbox_it as t
t.run(t.ws("apparmor"), "mkfifo /tmp/fa /tmp/fb; gs -q -dNOPAUSE -sDEVICE=nullpage /tmp/fa & qpdf --check /tmp/fb & sleep 8; kill %1 %2", timeout=20)' &
  sleep 4
  for pattern in "^gs -q -dNOPAUSE -sDEVICE=nullpage /tmp/fa" "^qpdf --check /tmp/fb"; do
    pid=$(pgrep -f "$pattern" | head -1)
    label=$(cat /proc/$pid/attr/current 2>/dev/null)
    echo "run process '$pattern': $(readlink /proc/$pid/exe 2>/dev/null || echo '?') label: $label"
    check sh -c "case '$label' in gs*|qpdf*|'') exit 1;; esac"
  done
  wait
  # Control: the same binary at its real /usr/bin path, in the same kind of jail, does get the host profile.
  control=$(docker run --rm --security-opt seccomp="$PWD/sandbox/seccomp.json" --security-opt apparmor=unconfined --entrypoint sh "okaychat-sandbox:$IT_TAG" -c '
    setpriv --reuid=20000 --regid=20000 --clear-groups bwrap --unshare-user --unshare-net --ro-bind / / --dev /dev --ro-bind /proc /proc --tmpfs /srv -- \
      sh -c "echo %PDF-1.4 > /srv/x.pdf; qpdf --check /srv/x.pdf 2>&1 | head -1"')
  echo "control (no exec view): $control"
  if ls /etc/apparmor.d/qpdf >/dev/null 2>&1; then check sh -c "echo '$control' | grep -q 'Permission denied'"; fi
  # bwrap itself depends on the host's bwrap profile when unprivileged user namespaces are restricted.
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
    copy=$(docker run --rm --security-opt seccomp="$PWD/sandbox/seccomp.json" --security-opt apparmor=unconfined --tmpfs /x:exec --entrypoint sh "okaychat-sandbox:$IT_TAG" -c '
      cp /usr/bin/bwrap /x/bwrap; setpriv --reuid=20000 --regid=20000 --clear-groups /x/bwrap --unshare-user --unshare-net --ro-bind / / --dev /dev -- true 2>&1; echo rc=$?')
    echo "bwrap copied to another path on this userns-restricted host: $copy"
    check sh -c "echo '$copy' | grep -q 'rc=1'"
  fi
else
  echo "SKIP: AppArmor is not enabled on this host"
fi

step "sandbox: LibreOffice external references against a recording receiver"
lo=$(test/integration/libreoffice_links.sh "okaychat-sandbox:$IT_TAG" "${PROJECT}_sandbox" 10.231.2.50:8000 "$(compose ps -q fixture)")
echo "$lo"
echo "$lo" > "$SHARE/libreoffice-links.txt"
check sh -c "echo '$lo' | grep -q '^control converted: linked-calc.pdf linked-writer.pdf | fetched: /writer-image.png'"
for variant in defaults override jailed; do
  check sh -c "echo '$lo' | grep -q '^$variant converted: linked-calc.pdf linked-writer.pdf | fetched: none'"
done

step "sandbox: fail closed without the seccomp profile (Docker's default profile denies the namespaces)"
docker run -d --name okaychat-it-failclosed -e SANDBOX_TOKEN=failclosed-token-0123456789abcdef0123 -v okaychat-it-failclosed:/work \
  --init --read-only --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges:true "okaychat-sandbox:$IT_TAG" >/dev/null
sleep 8
health=$(docker exec okaychat-it-failclosed python3 -c 'import urllib.request
try: urllib.request.urlopen("http://127.0.0.1:8080/health")
except Exception as e: print(e.code, e.read().decode())')
echo "health: $health"
check test "${health%% *}" = 503
run=$(docker exec okaychat-it-failclosed python3 -c 'import json, urllib.request
r = urllib.request.Request("http://127.0.0.1:8080/workspaces/abcdefabcdefabcdef/run", data=json.dumps({"language": "bash", "code": "touch /work/abcdefabcdefabcdef/RAN"}).encode(), headers={"Authorization": "Bearer failclosed-token-0123456789abcdef0123"})
try: urllib.request.urlopen(r)
except Exception as e: print(e.code, e.read().decode())')
echo "run: $run"
check test "${run%% *}" = 503
check sh -c "! docker exec okaychat-it-failclosed test -e /work/abcdefabcdefabcdef/RAN"
docker logs okaychat-it-failclosed 2>&1 | tail -2

step "browser worker: boundaries per user (firewall, DNS, IPv6, token, other users' processes, capabilities)"
APP_IP=$(ip_of okaychat browser)
OWN_IP=$(ip_of browser browser)
compose exec -T fixture python3 -c 'import urllib.request; urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8000/reset", data=b"", method="POST"))'
check sh -c "docker exec -i $(compose ps -q browser) python3 - 10.231.1.50 $APP_IP $OWN_IP < test/integration/worker_boundaries.py 2>$SHARE/worker-processes.json"
fixture_udp=$(compose exec -T fixture python3 -c 'import json, urllib.request; h = json.load(urllib.request.urlopen("http://127.0.0.1:8000/hits")); print(h["udp"], h["tcp"])')
echo "fixture counters after the worker checks (udp tcp): $fixture_udp"
check test "$fixture_udp" = "0 0"
check compose exec -T tester python3 -c 'import socket; socket.create_connection(("10.231.1.50", 9000), timeout=3).close(); socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"x", ("10.231.1.50", 9999))'
sleep 1
check test "$(compose exec -T fixture python3 -c 'import json, urllib.request; h = json.load(urllib.request.urlopen("http://127.0.0.1:8000/hits")); print(h["udp"], h["tcp"])')" = "1 1"

step "browser worker: egress proxy policy per user (CONNECT through 127.0.0.1:3128)"
connect() {  # connect <uid> <target> -> first status line
  compose exec -T browser setpriv --reuid="$1" --regid="$1" --clear-groups node -e '
    const s = require("net").connect(3128, "127.0.0.1", () => s.write(`CONNECT ${process.argv[1]} HTTP/1.1\r\nHost: ${process.argv[1]}\r\n\r\n`));
    s.setTimeout(10000, () => { console.log("timeout"); process.exit(0); });
    s.once("data", (d) => { console.log(d.toString().split("\r\n")[0].split(" ")[1]); process.exit(0); });
    s.on("error", (e) => { console.log(e.code); process.exit(0); });' "$2"
}
expect_connect() { got=$(connect "$2" "$3"); if [ "$got" = "$1" ]; then echo "PASS uid $2 CONNECT $3 -> $got"; else echo "FAIL uid $2 CONNECT $3 expected $1, got $got"; FAILED=$((FAILED + 1)); fi; }
expect_connect 200 10002 example.com:443
for slot in 10011 10012; do
  expect_connect 200 $slot cdn.jsdelivr.net:443
  expect_connect 403 $slot example.com:443
  expect_connect 403 $slot 10.231.1.50:9000
done
expect_connect ECONNREFUSED 10001 example.com:443   # the job API user has no way out at all
for target in 10.231.1.50:9000 rebind.okaychat.test:9000 127.0.0.1:8080 localhost:8080 "[::1]:8080" "[::ffff:10.231.1.50]:9000" 0x7f000001:8080 \
  2130706433:8080 0177.0.0.1:8080 169.254.169.254:80 okaychat:8787 searxng:8080 "[fe80::1]:80" 0.0.0.0:8080; do
  expect_connect 403 10002 "$target"
done
expect_connect ECONNREFUSED 0 example.com:443   # root may not even reach the proxy

step "browser suite"
check compose exec -T tester python3 -u /tests/browser_it.py

step "browser worker: each render job gets a fresh slot process"
slot_pids() { compose exec -T browser sh -c 'for p in /proc/[0-9]*; do uid=$(awk "/^Uid:/ { print \$2 }" $p/status 2>/dev/null); case "$uid" in 1001[1-8]) grep -q "index.js" $p/cmdline 2>/dev/null && echo ${p#/proc/};; esac; done | sort | tr "\n" " "'; }
before=$(slot_pids)
check compose exec -T tester python3 /tests/browser_it.py offline_pdf
sleep 2
after=$(slot_pids)
echo "slot processes before: $before after: $after"
check test "$before" != "$after"

step "browser worker: crash recovery (kill Chromium, slots, and the proxy, jobs keep working)"
compose exec -T browser sh -c 'for p in /proc/[0-9]*; do [ "${p#/proc/}" = $$ ] && continue; c=$(tr "\0" " " < $p/cmdline 2>/dev/null); case "$c" in *chrome*|*egress.js*) kill -9 ${p#/proc/} 2>/dev/null;; esac; done; true' || true
sleep 3
check compose exec -T tester python3 /tests/browser_it.py offline_pdf health

step "browser worker: fails closed without the capabilities its firewall needs"
for missing in NET_ADMIN SETPCAP; do
  caps=""
  for cap in NET_ADMIN CHOWN SETUID SETGID SETPCAP; do [ "$cap" = "$missing" ] || caps="$caps --cap-add $cap"; done
  name="okaychat-it-browser-no-$(echo $missing | tr A-Z a-z)"
  docker run -d --name "$name" --network "${PROJECT}_browser" -e BROWSER_TOKEN_FILE=/run/okaychat-browser/token --read-only \
    --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL $caps --security-opt no-new-privileges:true "okaychat-browser:$IT_TAG" >/dev/null
  sleep 8
  state=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$name")
  echo "without $missing: $state; $(docker logs "$name" 2>&1 | grep -E 'refusing|could not' | head -1)"
  check test "$state" = "exited 1"
  docker rm -f "$name" >/dev/null
done

step "dev topology: standalone hardened containers on 127.0.0.1, app code on the host"
docker run -d --name okaychat-it-dev-sandbox -p 127.0.0.1:18790:8080 -e SANDBOX_TOKEN="$(sed -n 's/^OKAYCHAT_SANDBOX_TOKEN=//p' "$SHARE/it.env")" \
  -v okaychat-it-dev-sandbox:/work --init --read-only --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE \
  --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges:true \
  --security-opt seccomp="$PWD/sandbox/seccomp.json" --security-opt apparmor=unconfined --pids-limit 512 --memory 2g --cpus 2 "okaychat-sandbox:$IT_TAG" >/dev/null
random > "$SHARE/browser-token"
chmod 644 "$SHARE/browser-token"
docker run -d --name okaychat-it-dev-browser -p 127.0.0.1:18792:8080 -e BROWSER_TOKEN_FILE=/run/okaychat-browser/token \
  -v "$SHARE/browser-token:/run/okaychat-browser/token:ro" --read-only --tmpfs /tmp:size=512m,mode=1777 --cap-drop ALL \
  --cap-add NET_ADMIN --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add SETPCAP --security-opt no-new-privileges:true \
  --pids-limit 512 --memory 1536m --cpus 2 "okaychat-browser:$IT_TAG" >/dev/null
sleep 10
check env OKAYCHAT_IT_SANDBOX_URL=http://127.0.0.1:18790 OKAYCHAT_IT_SANDBOX_TOKEN="$(sed -n 's/^OKAYCHAT_SANDBOX_TOKEN=//p' "$SHARE/it.env")" \
  OKAYCHAT_IT_BROWSER_URL=http://127.0.0.1:18792 OKAYCHAT_IT_BROWSER_TOKEN_FILE="$SHARE/browser-token" \
  node --test --import tsx src/server/sandbox-flow.itest.ts

step "resources (cgroup peak memory since start, current usage)"
for service in okaychat sandbox browser; do
  echo "$service peak $(compose exec -T "$service" cat /sys/fs/cgroup/memory.peak 2>/dev/null | awk '{printf "%.0f MiB", $1/1048576}')"
done
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep okaychat-it || true

echo
echo "results: $SHARE"
[ "$FAILED" = 0 ] && echo "ALL PASSED" || echo "$FAILED FAILED"
[ "$FAILED" = 0 ]
