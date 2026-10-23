# syntax=docker/dockerfile:1

# ---- build: compile server and web bundle ----
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# Python for Scrapling (web_fetch fallback for blocked or JS-heavy pages) and for stdio MCP servers run with uvx.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates tini git \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/scrapling \
 && /opt/scrapling/bin/pip install --no-cache-dir "scrapling[ai]==0.5" "uv==0.13.1" \
 && find /opt/scrapling -name "__pycache__" -prune -exec rm -rf {} +
ENV PATH="/opt/scrapling/bin:${PATH}"

# Headless Chromium lets Scrapling read pages that need JavaScript or sit behind Cloudflare.
# Adds several hundred MB. Build with --build-arg SCRAPLING_BROWSER=false for a smaller image.
ARG SCRAPLING_BROWSER=true
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw \
    OKAYCHAT_SCRAPLING_BROWSER=${SCRAPLING_BROWSER}
RUN if [ "$SCRAPLING_BROWSER" = "true" ]; then \
      scrapling install && rm -rf /var/lib/apt/lists/* /root/.cache; \
    fi

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
