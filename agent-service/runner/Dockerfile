# karos-agent-runner — one container per job. The agents repo is baked in at
# build time at a pinned ref; override per deployment by rebuilding with a
# different AGENTS_REPO_REF (per-job agent_version can select any ref already
# present in the baked clone).
#
# Build (from agent-service/):
#   docker build -f runner/Dockerfile \
#     --secret id=github_token,env=GITHUB_TOKEN \
#     --build-arg AGENTS_REPO_REF=<sha-or-ref> \
#     -t karos-agent-runner:latest .
FROM node:24-bookworm

ARG AGENTS_REPO_URL=https://github.com/karoslabs/karos-agents.git
ARG AGENTS_REPO_REF=main

RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 python3-pip ffmpeg imagemagick tesseract-ocr ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python deps the karos-agents engines call via Bash (IG engine + research connectors)
RUN pip3 install --no-cache-dir --break-system-packages \
      httpx ddgs pyyaml pillow pytesseract youtube-transcript-api yt-dlp

# Bake the agents repo at the pinned ref (full clone so agent_version overrides
# can check out other refs without network access)
RUN --mount=type=secret,id=github_token \
    sh -c 'TOKEN="$(cat /run/secrets/github_token 2>/dev/null || true)"; \
      REPO_URL="$AGENTS_REPO_URL"; \
      if [ -n "$TOKEN" ]; then REPO_URL="$(echo "$AGENTS_REPO_URL" | sed "s#https://#https://x-access-token:${TOKEN}@#")"; fi; \
      git clone "$REPO_URL" /opt/karos-agents && \
      git -C /opt/karos-agents checkout --detach "$AGENTS_REPO_REF" && \
      git -C /opt/karos-agents remote remove origin'

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY runner/src ./runner/src
COPY tools ./tools
COPY test ./test
RUN npx tsc -p tsconfig.json && npm prune --omit=dev && npm cache clean --force

# Non-root; /work is the throwaway job workspace
RUN useradd -m -u 10001 agent && mkdir -p /work && chown -R agent:agent /work /opt/karos-agents /app
USER agent
ENV HOME=/home/agent \
    AGENTS_REPO_DIR=/opt/karos-agents \
    WORK_DIR=/work \
    NODE_USE_ENV_PROXY=1

CMD ["node", "dist/runner/src/main.js"]
