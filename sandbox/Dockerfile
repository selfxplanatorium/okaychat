# syntax=docker/dockerfile:1

# Code sandbox for okaychat's run_code tool. See docs/research/code-sandbox.md.
# Everything a run can use comes from this image: the root filesystem is read-only and runs have no network.

# ---- inner.bpf: the seccomp filter bubblewrap applies to every run, generated with libseccomp ----
FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70 AS seccomp
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev libseccomp-dev \
 && rm -rf /var/lib/apt/lists/*
COPY seccomp/inner.c /src/inner.c
RUN gcc -O2 -Wall -Werror -o /src/inner /src/inner.c -lseccomp && /src/inner /src/inner.bpf

# ---- runtime ----
FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70

# Debian packages only, no third-party downloads. Groups: isolation, shell basics, media, PDF, Office (LibreOffice
# without its GUI or Java), OCR, images and diagrams, archives, metadata, fonts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap \
      util-linux procps curl ca-certificates jq sqlite3 git zip unzip file ripgrep tree bc fd-find \
      ffmpeg \
      poppler-utils qpdf ghostscript \
      pandoc libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-ita \
      librsvg2-bin graphviz \
      xz-utils zstd bzip2 7zip libarchive-tools \
      libimage-exiftool-perl \
      fontconfig fonts-dejavu-core fonts-liberation fonts-liberation2 fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && ln -s /usr/bin/7zz /usr/local/bin/7z \
 && fc-cache -f

# Hashed lock for every direct and transitive package; wheels only, so nothing compiles here.
COPY requirements.txt /opt/sandbox/requirements.txt
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r /opt/sandbox/requirements.txt \
 && find /usr/local/lib/python3.12 -name "__pycache__" -prune -exec rm -rf {} +

# LibreOffice defaults every profile inherits: no macros, no link updates, no untrusted referer links.
COPY libreoffice/okaychat.xcd /usr/lib/libreoffice/share/registry/okaychat.xcd
# Profiles live in the run's private /tmp: a fresh one per soffice call through the wrapper on PATH, and the
# default for /usr/bin/soffice too.
COPY --chmod=755 libreoffice/soffice /usr/local/bin/soffice
RUN ln -s soffice /usr/local/bin/libreoffice \
 && sed -i 's#^UserInstallation=.*#UserInstallation=file:///tmp/libreoffice-profile#' /usr/lib/libreoffice/program/bootstraprc
# The jail's view of /usr/bin and /usr/sbin, so host AppArmor profiles that attach by path do not match run code.
COPY exec-view.py /tmp/exec-view.py
RUN python3 /tmp/exec-view.py && rm /tmp/exec-view.py
COPY --from=seccomp /src/inner.bpf /opt/sandbox/inner.bpf
COPY TOOLS.md /opt/sandbox/TOOLS.md
COPY runner.py /opt/sandbox/runner.py

ENV SANDBOX_ROOT=/work \
    SANDBOX_PORT=8080 \
    PYTHONDONTWRITEBYTECODE=1
VOLUME /work
EXPOSE 8080

# Unhealthy also when run isolation could not be set up, so the cause shows in `docker ps`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)"

# The runner stays root to create workspaces and start each run as its workspace user inside bubblewrap.
# Run code never keeps root or any capability.
CMD ["python3", "-I", "/opt/sandbox/runner.py"]
