# syntax=docker/dockerfile:1

# Local speech worker for okaychat: faster-whisper (speech to text) and Piper (text to speech).
# Models download on first use into /models. The CPU image is the default; INSTALL_CUDA=1 adds
# only the cuBLAS and cuDNN 9 runtime wheels ctranslate2 4.x loads for CUDA 12. See docs/implementation/speech.md.
FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
ARG INSTALL_CUDA=0

# Hashed lock for every direct and transitive package; wheels only, so nothing compiles here.
COPY requirements.txt requirements-cuda.txt /opt/speech/
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r /opt/speech/requirements.txt \
 && if [ "$INSTALL_CUDA" = "1" ]; then \
      pip install --no-cache-dir --require-hashes --only-binary=:all: -r /opt/speech/requirements-cuda.txt; \
    fi \
 && find /usr/local/lib/python3.12 -name "__pycache__" -prune -exec rm -rf {} +

RUN groupadd -g 10100 speech && useradd -u 10100 -g 10100 -M -d /models -s /usr/sbin/nologin speech \
  && mkdir -p /models && chown speech:speech /models
COPY --chmod=644 server.py device.py /opt/speech/

USER speech
# ctranslate2 dlopens these by name; the directories are absent in the CPU image, which is harmless.
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 SPEECH_PORT=8080 SPEECH_MODELS=/models \
    LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4).status == 200 else 1)"
CMD ["python", "/opt/speech/server.py"]
