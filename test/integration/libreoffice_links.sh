#!/bin/sh
# LibreOffice external references, run by test/integration/run.sh. Each variant converts the fixtures in a throwaway
# container that, unlike a run, HAS a network route to a recording receiver, so the result shows what LibreOffice
# itself attempts:
#   control  - image defaults removed, link updates and recalculation set to "always": proves the documents fetch.
#   defaults - the image as shipped.
#   override - the image as shipped plus a user profile that asks for "always": proves the defaults are locked.
#   jailed   - the control's settings, but inside a bubblewrap network namespace as runs get it: proves the
#              network stops the same fetch on its own.
# The receiver counts requests per path. Prints "<variant> converted: <pdfs> | fetched: <paths>" lines.
# Usage: libreoffice_links.sh <image> <docker network> <receiver ip:port> <receiver container>
set -eu
IMAGE=$1 NETWORK=$2 RECEIVER=$3 FIXTURE=$4
DIR=$(cd "$(dirname "$0")" && pwd)
ALWAYS='<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema">
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>false</value></prop></item>
</oor:items>'
hits() { docker exec "$FIXTURE" python3 -c 'import json, urllib.request; print(" ".join(sorted(set(p for p in json.load(urllib.request.urlopen("http://127.0.0.1:8000/hits"))["paths"]))) or "none")'; }
reset() { docker exec "$FIXTURE" python3 -c 'import urllib.request; urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8000/reset", data=b"", method="POST"))' >/dev/null; }
SECCOMP="$DIR/../../sandbox/seccomp.json"
for variant in control defaults override jailed; do
  reset
  docker run --rm --network "$NETWORK" -v "$DIR/fixtures:/fixtures:ro" -e RECEIVER="$RECEIVER" -e VARIANT="$variant" -e ALWAYS="$ALWAYS" \
    --security-opt seccomp="$SECCOMP" --security-opt apparmor=unconfined --entrypoint sh "$IMAGE" -c '
    set -e
    cd /tmp
    for f in linked-writer.fodt linked-calc.fods; do sed "s#RECEIVER#$RECEIVER#g" /fixtures/$f.in > $f; done
    profile=
    if [ "$VARIANT" = control ] || [ "$VARIANT" = jailed ]; then rm /usr/lib/libreoffice/share/registry/okaychat.xcd; fi
    if [ "$VARIANT" != defaults ]; then mkdir -p /tmp/p/user && printf "%s" "$ALWAYS" > /tmp/p/user/registrymodifications.xcu; profile="-env:UserInstallation=file:///tmp/p"; fi
    jail=
    if [ "$VARIANT" = jailed ]; then
      chown -R 20000:20000 /tmp
      jail="setpriv --reuid=20000 --regid=20000 --clear-groups bwrap --unshare-user --unshare-net --ro-bind / / --dev /dev --ro-bind /proc /proc --bind /tmp /tmp --setenv HOME /tmp --"
    fi
    for f in linked-writer.fodt linked-calc.fods; do timeout 90 $jail soffice $profile --headless --convert-to pdf --outdir /tmp/out /tmp/$f >/dev/null 2>&1 || true; done
    ls /tmp/out | tr "\n" " "' > /tmp/okaychat-lo-out.$$ 2>&1 || true
  echo "$variant converted: $(cat /tmp/okaychat-lo-out.$$)| fetched: $(hits)"
  rm -f /tmp/okaychat-lo-out.$$
done
