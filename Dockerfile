# ─────────────────────────────────────────────────────────────────────────────
# Karos CMO — multi-stage Dockerfile for Next.js standalone + Cloud Run
#
# Stage layout:
#   base    → shared Alpine + libc6-compat layer
#   deps    → npm ci (all deps, needed for the build)
#   builder → next build with NEXT_PUBLIC_* vars baked into the bundle
#   runner  → minimal production image (~150 MB) from .next/standalone
#
# Build (local):
#   docker build -t karos-cmo:latest \
#     --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_APP_ID=... \
#     .
#
# NEXT_PUBLIC_FIREBASE_* are public Firebase Web SDK config, but every
# environment value — public or secret — lives in Secret Manager / cloudbuild
# substitutions now, never committed to git. cloudbuild.yaml passes these six
# as --build-arg, read from Secret Manager at build time.
#
# Run locally:
#   docker run -p 3000:3000 \
#     --env-file .env.local \
#     karos-cmo:latest
# ─────────────────────────────────────────────────────────────────────────────

# ── base ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
# libc6-compat: required by some native modules that firebase-admin may pull in
# on Alpine (glibc shim for musl).
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ── deps ──────────────────────────────────────────────────────────────────────
FROM base AS deps
# Copy manifests first so Docker layer-caches node_modules across source changes.
COPY package.json package-lock.json ./
# Install ALL dependencies (including devDeps) — TypeScript + Tailwind needed at build time.
RUN npm ci

# ── builder ───────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_FIREBASE_* are read by `next build` at build time and inlined
# into the client bundle — Next.js only picks up ENV, not build-time ARGs
# directly, so each one is declared as an ARG and re-exposed as ENV.
# Server-only secrets are injected at Cloud Run deploy time — never baked in.
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY
ENV NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID
ENV NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ENV NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ENV NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID

# Opt out of Next.js telemetry during build.
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── runner ────────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user — Cloud Run and container best-practice.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# .next/standalone is the self-contained server emitted by output:"standalone".
# It includes a minimal node_modules trace (only what's actually imported).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

# Static client assets must be copied separately — standalone does not include them.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Public directory (favicons, SVGs, robots.txt, etc.)
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

# Cloud Run injects PORT at runtime. The Next.js standalone server.js reads
# process.env.PORT automatically, so no wrapper script is needed.
# HOSTNAME must be 0.0.0.0 so the server accepts connections from outside the container.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]
