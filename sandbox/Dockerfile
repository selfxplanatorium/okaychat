# syntax=docker/dockerfile:1

# Code sandbox for okaychat's run_code tool. See docs/research/code-sandbox.md.
# Packages come only from this image: the root filesystem is read-only at runtime.
FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      util-linux procps curl ca-certificates jq sqlite3 git zip unzip file ripgrep \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /opt/sandbox/requirements.txt
RUN pip install --no-cache-dir -r /opt/sandbox/requirements.txt \
 && find /usr/local/lib/python3.12 -name "__pycache__" -prune -exec rm -rf {} +

COPY runner.py /opt/sandbox/runner.py

ENV SANDBOX_ROOT=/work \
    SANDBOX_PORT=8080 \
    PYTHONDONTWRITEBYTECODE=1
VOLUME /work
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)"

# The runner stays root to switch each run to its workspace user. Run code never keeps root.
CMD ["python3", "-I", "/opt/sandbox/runner.py"]
