# Parlante avatar engine (CPU). Weights are NOT baked in: they are downloaded with checksums
# into the /models volume on first start (docker-compose mounts it).
FROM python:3.13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY parlante_engine ./parlante_engine
COPY scripts ./scripts

# Same uid as the `node` user of the api / worker images (1000): both sides create files in the
# shared /data/avatar-engine volume and must be able to read and write each other's directories.
RUN useradd --create-home --uid 1000 engine \
    && mkdir -p /data/avatar-engine /models \
    && chown -R engine:engine /data/avatar-engine /models /app
USER engine

# Inside the container the server must listen on all interfaces so that the worker can reach it
# over the compose network; a non-loopback bind REQUIRES AVATAR_ENGINE_TOKEN (the server refuses
# to start without it). Nothing is published to the host by docker-compose.
ENV AVATAR_ENGINE_HOST=0.0.0.0 \
    AVATAR_ENGINE_PORT=8090 \
    AVATAR_ENGINE_WORK_DIR=/data/avatar-engine \
    AVATAR_ENGINE_MODELS_DIR=/models \
    PYTHONUNBUFFERED=1
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4).status == 200 else 1)"

CMD ["sh", "-c", "python scripts/download_models.py ${AVATAR_ENGINE_DOWNLOAD_ARGS:-} && exec python -m parlante_engine"]
