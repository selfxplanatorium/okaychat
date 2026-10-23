#!/bin/sh
# The server runs Chromium, Scrapling, and stdio MCP servers, so it must not run as root.
# Volumes created by older images are root-owned; hand them to the node user before dropping privileges.
set -e
if [ "$(id -u)" = "0" ]; then
  find "${OKAYCHAT_DATA_DIR:-/data}" ! -user node -exec chown -h node:node {} +
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
