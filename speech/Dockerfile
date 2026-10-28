# syntax=docker/dockerfile:1

# Local speech worker for okaychat: faster-whisper (speech to text) and Piper (text to speech) on the CPU.
# Models download on first use into /models. See docs/implementation/speech.md.
FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70

# Hashed lock for every direct and transitive package; wheels only, so nothing compiles here.
COPY requirements.txt /opt/speech/requirements.txt
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r /opt/speech/requirements.txt \
 && find /usr/local/lib/python3.12 -name "__pycache__" -prune -exec rm -rf {} +

RUN groupadd -g 10100 speech && useradd -u 10100 -g 10100 -M -d /models -s /usr/sbin/nologin speech \
 && mkdir -p /models && chown speech:speech /models
COPY --chmod=644 server.py /opt/speech/server.py

USER speech
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 SPEECH_PORT=8080 SPEECH_MODELS=/models
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4).status == 200 else 1)"
CMD ["python", "/opt/speech/server.py"]
