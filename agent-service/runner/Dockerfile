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

# Headless Chromium for the karos-agents render engines. render.mjs does
# `import { chromium } from 'playwright'` and screenshots HTML slides to PNG —
# without it, social/newsletter/landing renders ship blank. Baked in because the
# render sandbox can't install it at runtime (no npm/npx tool grant, no registry
# egress). playwright is installed globally so each engine's bare
# `import 'playwright'` resolves without a per-engine install.
# Pin to the engines' dependency (playwright ^1.53.0).
#
# TWO RESOLUTION MECHANISMS, because the engines use two module systems and only
# one of them reads NODE_PATH.
#
#   NODE_PATH covers CommonJS `require('playwright')`. It is a CJS-only legacy
#   mechanism and Node's ESM loader IGNORES IT ENTIRELY — there is no ESM
#   equivalent and none is planned.
#
#   The `/node_modules` SYMLINK covers ESM `import 'playwright'` from a `.mjs`
#   engine. The ESM resolver finds a bare specifier by walking UP from the
#   importing file checking each `node_modules` directory, so a link at the
#   filesystem root is reachable from anywhere — including
#   /opt/karos-agents/products/**/engine/*.mjs, which is where the renderers
#   actually live. Without it those files die on ERR_MODULE_NOT_FOUND, and a
#   renderer that cannot start is indistinguishable from one that rendered
#   nothing: the run ships blank slides rather than failing loudly.
#
# The link must be created here, before `USER agent` below — the root filesystem
# is not writable by the unprivileged user.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
ENV NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g playwright@1.53.0 \
    && ln -s /usr/local/lib/node_modules /node_modules \
    && npx --yes playwright@1.53.0 install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

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
RUN useradd -m -u 10001 agent && mkdir -p /work && chown -R agent:agent /work /opt/karos-agents /app /opt/pw-browsers
USER agent
ENV HOME=/home/agent \
    AGENTS_REPO_DIR=/opt/karos-agents \
    WORK_DIR=/work \
    NODE_USE_ENV_PROXY=1

CMD ["node", "dist/runner/src/main.js"]
