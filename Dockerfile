# syntax=docker/dockerfile:1

# Two images from one build: `app` (the default, last stage) and `browser`, the worker that runs Chromium and
# Scrapling away from the app's data and secrets. docker-compose.yml builds both. See docs/implementation/browser-worker.md.

# ---- build: compile server, worker, and web bundle ----
FROM node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && node scripts/browser-modules.mjs /worker

# ---- browser worker ----
FROM node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS browser

# Python for Scrapling (web_fetch fallback for blocked or JavaScript-heavy pages); iptables for the egress firewall.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates tini iptables \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/scrapling \
 && /opt/scrapling/bin/pip install --no-cache-dir "scrapling[ai]==0.5" \
 && find /opt/scrapling -name "__pycache__" -prune -exec rm -rf {} +
ENV PATH="/opt/scrapling/bin:${PATH}"

# One Chromium for everything: Playwright's Node renderer and Scrapling's Python Playwright use the same
# revision from /opt/pw. Build with --build-arg SCRAPLING_BROWSER=false to skip Scrapling's stealth-browser
# fallback; documents and previews still need this Chromium.
ARG SCRAPLING_BROWSER=true
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw \
    OKAYCHAT_SCRAPLING_BROWSER=${SCRAPLING_BROWSER}
RUN scrapling install && rm -rf /var/lib/apt/lists/* /root/.cache

# The worker's users; docker/browser-entrypoint.sh starts each process as one of them.
# jobs: the job API; scrape: Scrapling; egress: the proxy; slotN: one per render slot (up to 8, BROWSER_MAX_JOBS).
RUN for spec in 10001:jobs 10002:scrape 10003:egress 10011:slot10011 10012:slot10012 10013:slot10013 10014:slot10014 \
      10015:slot10015 10016:slot10016 10017:slot10017 10018:slot10018; do \
      uid=${spec%%:*}; name=${spec#*:}; \
      groupadd -g "$uid" "$name" && useradd -u "$uid" -g "$uid" -M -d "/tmp/$name" -s /usr/sbin/nologin "$name"; \
    done

WORKDIR /worker
COPY --from=build /worker/node_modules ./node_modules
COPY --from=build /app/dist/browser ./dist/browser
COPY --from=build /app/dist/server/public-fetch.js ./dist/server/public-fetch.js
COPY --from=build /app/dist/shared/artifact-frame.js ./dist/shared/artifact-frame.js
RUN echo '{"type":"module"}' > package.json
COPY --chmod=755 docker/browser-entrypoint.sh docker/browser-firewall.sh /usr/local/bin/

ENV NODE_ENV=production \
    BROWSER_PORT=8080 \
    NODE_NO_WARNINGS=1
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The entrypoint is PID 1 while it installs the firewall, then execs tini with CAP_NET_ADMIN already dropped.
ENTRYPOINT ["browser-entrypoint.sh"]

# ---- app (default) ----
FROM node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS app

# Python and uv for stdio MCP servers run with uvx.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates tini git \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/uv \
 && /opt/uv/bin/pip install --no-cache-dir "uv==0.13.1" \
 && find /opt/uv -name "__pycache__" -prune -exec rm -rf {} +
ENV PATH="/opt/uv/bin:${PATH}"

# Codex CLI for image generation with each user's own ChatGPT plan. Build with --build-arg CODEX_CLI=false to skip.
ARG CODEX_CLI=true
RUN if [ "$CODEX_CLI" = "true" ]; then npm install -g @openai/codex@0.163.0 && npm cache clean --force; fi

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production \
    PORT=8787 \
    OKAYCHAT_DATA_DIR=/data \
    NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
