#!/bin/sh
# Dev only: run Scrapling from the okaychat image so the host needs no Python. Build it first: docker build -t okaychat:latest .
# Host networking lets it reach the egress proxy that okaychat starts on 127.0.0.1.
exec docker run -i --rm --network host -e PLAYWRIGHT_BROWSERS_PATH=/opt/pw okaychat:latest scrapling "$@"
