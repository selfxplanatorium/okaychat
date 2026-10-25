#!/bin/sh
# Browser worker entrypoint. Starts as root only to install the firewall and create each user's scratch directory,
# then drops CAP_NET_ADMIN and CAP_CHOWN for good and runs unprivileged processes, each as its own user:
#   jobs     (10001)  - the job API on :8080 (dist/browser/index.js, role dispatch). No browser; holds the token.
#   slotN    (10011+) - one render slot each (role render, loopback). One job, a fresh Chromium, then exit.
#   scrape   (10002)  - the fetch server (role fetch, loopback) with Scrapling and its browser as children.
#   egress   (10003)  - the egress proxy (dist/browser/egress.js), the only process allowed out.
# Slots, the fetch server, and the proxy are restarted when they exit; if the job API exits, so does the container.
# If the firewall cannot be installed and checked, nothing starts. See docs/implementation/browser-worker.md.
set -eu

export JOBS_UID=10001 SCRAPE_UID=10002 EGRESS_UID=10003
export JOB_PORT="${BROWSER_PORT:-8080}" EGRESS_PORT=3128 FETCH_PORT=8093
SLOTS=${BROWSER_MAX_JOBS:-2}
[ "$SLOTS" -ge 1 ] && [ "$SLOTS" -le 8 ] || { echo "browser worker: BROWSER_MAX_JOBS must be 1 to 8" >&2; exit 1; }
SLOT_UIDS="" SLOT_PORTS="" SLOT_URLS=""
n=1
while [ "$n" -le "$SLOTS" ]; do
  SLOT_UIDS="$SLOT_UIDS $((10010 + n))"
  SLOT_PORTS="$SLOT_PORTS $((8100 + n))"
  SLOT_URLS="${SLOT_URLS:+$SLOT_URLS,}http://127.0.0.1:$((8100 + n))"
  n=$((n + 1))
done
export SLOT_UIDS SLOT_PORTS

refused() {  # refused <uid> <host> <port>: the connection must fail at once (firewall reject), not connect or hang
  setpriv --reuid="$1" --regid="$1" --clear-groups node -e '
    const s = require("net").connect(Number(process.argv[2]), process.argv[1]);
    s.setTimeout(2000, () => process.exit(1));
    s.on("connect", () => process.exit(1));
    s.on("error", (e) => process.exit(e.code === "ECONNREFUSED" ? 0 : 1));' "$2" "$3"
}

if [ "${1:-}" != "--supervise" ]; then
  [ "$(id -u)" = "0" ] || { echo "browser worker: the entrypoint must start as root to install its firewall" >&2; exit 1; }
  /usr/local/bin/browser-firewall.sh
  # Check the rules took effect for every user before anything runs. 192.0.2.1 is a documentation address, so a
  # broken rule sends at most a packet nowhere; the loopback check stays inside the container.
  for uid in $JOBS_UID $SCRAPE_UID $SLOT_UIDS 0; do
    refused "$uid" 192.0.2.1 80 || { echo "browser worker: uid $uid is not blocked from the network; refusing to start" >&2; exit 1; }
  done
  refused "$EGRESS_UID" 127.0.0.1 "$JOB_PORT" || { echo "browser worker: the proxy user can reach loopback; refusing to start" >&2; exit 1; }
  for user in jobs scrape egress $(for u in $SLOT_UIDS; do echo "slot$u"; done); do
    mkdir -p "/tmp/$user"
    chmod 700 "/tmp/$user"
  done
  chown "$JOBS_UID:$JOBS_UID" /tmp/jobs
  chown "$SCRAPE_UID:$SCRAPE_UID" /tmp/scrape
  chown "$EGRESS_UID:$EGRESS_UID" /tmp/egress
  for u in $SLOT_UIDS; do chown "$u:$u" "/tmp/slot$u"; done
  # From here on nothing in the container can change the firewall or file ownership again. tini takes over as PID 1
  # (it reaps the processes below) already without those capabilities. Dropping them needs CAP_SETPCAP, which the
  # supervisor keeps so it can clear the bounding set of every process it starts.
  exec setpriv --bounding-set=-net_admin,-chown --inh-caps=-all -- tini -- "$0" --supervise
fi

# NET_ADMIN is bit 12, CHOWN bit 0. If either survived, the drop above did not happen: refuse to run anything.
bounding=$(awk '/^CapBnd:/ { print $2 }' /proc/self/status)
if [ $(( 0x$bounding & 0x1001 )) -ne 0 ]; then
  echo "browser worker: could not drop CAP_NET_ADMIN/CAP_CHOWN (the container needs cap_add SETPCAP); refusing to start" >&2
  exit 1
fi

drop() {
  uid=$1
  shift
  exec setpriv --reuid="$uid" --regid="$uid" --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- "$@"
}

(while :; do
  (drop "$EGRESS_UID" env HOME=/tmp/egress TMPDIR=/tmp/egress node /worker/dist/browser/egress.js) || true
  sleep 1
done) &

(while :; do
  (drop "$SCRAPE_UID" env HOME=/tmp/scrape TMPDIR=/tmp/scrape BROWSER_ROLE=fetch BROWSER_HOST=127.0.0.1 BROWSER_PORT="$FETCH_PORT" \
    BROWSER_EGRESS_PROXY="http://127.0.0.1:$EGRESS_PORT" BROWSER_EGRESS_ENFORCED=1 node /worker/dist/browser/index.js) || true
  sleep 1
done) &

set -- $SLOT_PORTS
for u in $SLOT_UIDS; do
  port=$1
  shift
  (while :; do
    # A slot's scratch never outlives its job: emptied before every start.
    find "/tmp/slot$u" -mindepth 1 -delete 2>/dev/null || true
    (drop "$u" env HOME="/tmp/slot$u" TMPDIR="/tmp/slot$u" BROWSER_ROLE=render BROWSER_HOST=127.0.0.1 BROWSER_PORT="$port" \
      BROWSER_MAX_JOBS=1 BROWSER_EXIT_AFTER_JOB=1 BROWSER_EGRESS_PROXY="http://127.0.0.1:$EGRESS_PORT" BROWSER_EGRESS_ENFORCED=1 \
      node /worker/dist/browser/index.js) || true
    sleep 0.2
  done) &
done

drop "$JOBS_UID" env HOME=/tmp/jobs TMPDIR=/tmp/jobs BROWSER_ROLE=dispatch BROWSER_PORT="$JOB_PORT" BROWSER_SLOTS="$SLOT_URLS" \
  BROWSER_FETCH_URL="http://127.0.0.1:$FETCH_PORT" BROWSER_EGRESS_ENFORCED=1 node /worker/dist/browser/index.js
