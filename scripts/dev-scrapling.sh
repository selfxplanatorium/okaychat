#!/bin/sh
# Dev only: run Scrapling from the browser worker image so the host needs no Python. Build it first:
# docker build --target browser -t okaychat-browser:latest .
# Host networking lets it reach the egress proxy that the dev browser worker starts on 127.0.0.1.
exec docker run -i --rm --network host -e PLAYWRIGHT_BROWSERS_PATH=/opt/pw --entrypoint scrapling okaychat-browser:latest "$@"
