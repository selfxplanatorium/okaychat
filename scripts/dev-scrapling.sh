#!/bin/sh
# Dev only: run Scrapling from the okaychat image so the host needs no Python. Build it first: docker build -t okaychat:latest .
exec docker run -i --rm -e PLAYWRIGHT_BROWSERS_PATH=/opt/pw okaychat:latest scrapling "$@"
