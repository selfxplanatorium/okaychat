#!/bin/sh
# The server runs stdio MCP servers and the Codex CLI, so it must not run as root.
# Volumes created by older images are root-owned; hand them to the node user before dropping privileges.
# The browser worker token lives in its own small volume, shared read-only with the worker. The directory is
# setgid to gid 10001, the worker's job API user, so the 0640 token file is readable there by that user only, not by
# the worker's browser, Scrapling, or proxy users. The speech worker token works the same way with gid 10100.
set -e
if [ "$(id -u)" = "0" ]; then
  find "${OKAYCHAT_DATA_DIR:-/data}" ! -user node -exec chown -h node:node {} +
  if [ -n "${OKAYCHAT_BROWSER_TOKEN_FILE:-}" ]; then
    token_dir=$(dirname "$OKAYCHAT_BROWSER_TOKEN_FILE")
    mkdir -p "$token_dir"
    chown -R node:10001 "$token_dir"
    chmod 2750 "$token_dir"
    [ -f "$OKAYCHAT_BROWSER_TOKEN_FILE" ] && chmod 0640 "$OKAYCHAT_BROWSER_TOKEN_FILE"
  fi
  if [ -n "${OKAYCHAT_SPEECH_TOKEN_FILE:-}" ]; then
    token_dir=$(dirname "$OKAYCHAT_SPEECH_TOKEN_FILE")
    mkdir -p "$token_dir"
    chown -R node:10100 "$token_dir"
    chmod 2750 "$token_dir"
    [ -f "$OKAYCHAT_SPEECH_TOKEN_FILE" ] && chmod 0640 "$OKAYCHAT_SPEECH_TOKEN_FILE"
  fi
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
