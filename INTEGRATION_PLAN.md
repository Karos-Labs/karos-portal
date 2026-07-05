# Agent Service Integration Plan

**Status: approved as recommended (2026-07-05); coexistence with native engines confirmed.
Added requirement: per-job context files (§4b).**

Wires the `karos-agents` repo (Claude Code skills lab) into karosCMO through a standalone
agent-execution service. The service wraps the Claude Agent SDK; the platform talks to it only
via HTTP + signed webhooks. Discovery ran against `karos-agents@2ce5aa1` and the current
karosCMO `main` (`ac8eca7`).

---

## 1. What discovery found

### karos-agents (the source of truth for agent behavior)

- **It is a Claude Code workspace, not an SDK app.** No `package.json`/`pyproject` at root; no
  `.claude/` directory at all. `CLAUDE.md` (repo root) sets the operating rules: the
  adapter rule (legacy Supabase/pg_cron instructions in skills map to local files per
  `docs/INTEGRATION-CONTRACT.md`), the mandatory Client Knowledge Rule (read
  `clients/<slug>/README.md` + `profile/` before any client work), output conventions, and
  brand rules.
- **Skills live in three places, none of them `.claude/skills/`:**
  - `products/<family>/.../SKILL.md` — the first-party product skills (6 families:
    social, seo-geo, landing-page, onboarding, rebrand, amazon; ~60 first-party SKILL.md).
  - `clients/<slug>/skills/<agent>/` — per-client emitted generator sub-skills.
  - `skills/vendors/<pack>/` — 13 pinned vendor packs (~200 SKILL.md), hashes in
    `skills-lock.json` + `skills/vendors/UPSTREAMS.md`.
- **`clients/` contains real, highly sensitive client data by design** (7 clients: signed
  contract pricing, contacts, regulatory identifiers, unreleased business data). The repo's own
  contract commits run ledgers (`clients/<slug>/outputs/_ledger/*.jsonl`) as test evidence.
- **Deliverables are written to `clients/<slug>/outputs/<agent-folder>/<YYYY-MM-DD>-<run>/`**
  split `internal/` vs `client/` (only `client/` is client-visible) — not to a top-level
  `outputs/` dir.
- **Engines are mixed Node (.mjs, stdlib-only) + Python** (research-connectors: `httpx`;
  IG engine: `ddgs, pyyaml, pillow, pytesseract, youtube-transcript-api, yt-dlp`; system bins
  `ffmpeg, imagemagick, tesseract` for media-heavy paths).
- **External domains** skills genuinely call: ~50 distinct hosts (full derived list goes in
  `agent-service/config/egress-allowlist.json`). Core: `api.anthropic.com`,
  `api.perplexity.ai`, `api.x.ai`, `api.apify.com`, `api.scrapecreators.com`, `reddit.com`
  (RSS; blocks datacenter IPs), `hn.algolia.com`, image tiers (wikimedia, openverse, pexels,
  unsplash, flickr, duckduckgo), Google APIs (fonts, maps, GSC, CrUX), `api.resend.com`,
  `api.github.com`. **Caveat:** audit/onboarding-class skills WebFetch *arbitrary client
  websites* — a fully static allowlist is impossible for those task types.
- Known broken-as-authored bits are catalogued in `docs/PORTABILITY-NOTES.md` (dead Supabase
  URLs in newsletter/reddit skills, a nonexistent `scripts/recalc.py` in 7 amazon skills,
  one SKILL.md with a hardcoded foreign absolute path).

### karosCMO (the platform)

- Next.js 16 App Router, Firestore via Admin SDK only (`src/lib/data.ts`), server actions in
  `src/lib/actions/` (17 domain files — CLAUDE.md's "actions.ts" is stale), deploying to
  **Cloud Run** (Dockerfile + `cloudbuild.yaml`, Secret Manager `--set-secrets`).
- **No queue exists.** All background work is `next/server after()` + Firestore status docs +
  4s UI polling (`src/components/auto-refresh.tsx`). Code explicitly acknowledges the time
  budget (`src/lib/execution-engine.ts` caps batches at 5).
- **Work items:** `jobs` collection (agent runs; status `queued|running|review|approved|
  delivered|failed`, `events[]` timeline) and `clientTasks` (proactive task board).
  Deliverables land in `assets` docs; binaries in Firebase Cloud Storage via
  `src/lib/storage.ts`; usage/cost in `usageLogs` + `analyticsSnapshot` via
  `src/services/logger.ts`.
- **Two agent-execution systems already exist:** the in-app engine (`src/lib/agents/run.ts`)
  and an Anthropic Managed Agents API integration (`src/lib/anthropic/managed-agents.ts`,
  UI-polled, no persistence). The new service is a third; long-term it can absorb the second.
- Existing inbound webhook (`/api/ingest/fireflies`) and cron routes are **fail-open** when
  their secret env is unset. The new webhook receiver will be fail-closed.

### Claude Agent SDK (TypeScript, `@anthropic-ai/claude-agent-sdk`) — verified facts

- `permissionMode: 'dontAsk'` **exists**: anything not in `allowedTools` is denied without
  ever prompting; `canUseTool` is never called. Matches the spec exactly.
- `settingSources: ['project']` is required for filesystem skills + CLAUDE.md to load from
  `cwd`; skills are discovered **only** from `.claude/skills/` under `cwd`.
- Usage: per-result `modelUsage` (tokens + `costUSD` estimate) and `total_cost_usd`
  (client-side estimate — we record raw tokens as authoritative).
- Cancellation via `query.interrupt()`; transcript = iterate the message stream and persist.

---

## 2. Contradictions with the prompt's assumptions (explicit, per instructions)

1. **"Skills live in `.claude/skills/`" — false.** No `.claude/` dir exists. *Resolution:* at
   job-workspace prep the runner generates a transient `.claude/skills/` of **symlinks** into
   `products/`, `clients/<slug>/skills/`, and the needed vendor packs (scoped per task type).
   Skills load from the filesystem exactly as authored; nothing is rewritten, flattened, or
   committed to the agents repo.
2. **"Client data must never be committed into the agents repo" — it already is, by design.**
   We can't and shouldn't change the lab repo. *Resolution:* (a) the job-runner image is
   private (Artifact Registry) and treated as confidential; (b) workspace prep **prunes
   `clients/` to the job's target client only** (and always removes `clients/_cso/`), so a job
   for client A can never read client B's contracts. This is a deliberate deviation from "run
   the repo exactly as-is" — flagged for approval below.
3. **"Agents write deliverables to an `outputs/` directory" — not how these skills work.**
   They write to `clients/<slug>/outputs/<agent>/<date>-<run>/{internal,client}/` plus ledger
   JSONL. *Resolution:* the artifact collector snapshots the workspace pre-run and collects
   all new/changed files under `clients/<slug>/outputs/` (plus a top-level `outputs/` if a
   skill uses one), tagging each artifact `client_facing: true|false` from the path.
4. **"Reuse the platform's existing queue tech" — there is none.** BullMQ is introduced
   (justification §3).
5. **Static egress allowlist is impossible for some skills** (they fetch arbitrary client
   sites). *Resolution:* v1 task types are chosen so their domain groups are finite; the
   allowlist is config with per-task-type groups; audit-class task types are deferred and
   documented as requiring a policy decision.
6. **Direction check (from project memory):** karosCMO has been porting lab engines *natively
   into* `src/lib` (content-engine, newsletter). This integration runs lab products
   *externally* instead — both paths will exist for IG content and newsletters. Not a blocker,
   but you should confirm this is intended coexistence rather than a replacement.

---

## 3. Decisions (and why)

| Decision | Choice | Why |
|---|---|---|
| Language/SDK | TypeScript, `@anthropic-ai/claude-agent-sdk` | The agents repo targets no SDK (it's a workspace); the platform is TS; first-party engines are Node. Python lives *inside* the job image for engine scripts, invoked by the agent via Bash. |
| Service location | `agent-service/` top-level dir in karosCMO, own `package.json`, deployed as a **separate Cloud Run service** | One repo = shared CI, atomic platform+service changes; separate build keeps the platform image clean. Matches the prompt's default. |
| HTTP framework | Fastify | Built-in AJV JSON-schema validation (the per-task-type schema requirement), tiny, standard. Not added to the platform — platform code stays framework-free. |
| Queue | **BullMQ + Redis** (Memorystore in prod, container in dev) | No incumbent to reuse. Worker-pull fits long sandboxed jobs; retry/backoff/DLQ built in; trivial `docker compose` story. Cloud Tasks was considered and rejected: push-based fits poorly with per-job containers, and local emulation is weak. |
| Job isolation | One container per job behind a `JobExecutor` interface: `DockerExecutor` (dev, `docker run`) and `CloudRunJobExecutor` (prod, Cloud Run Jobs API — one execution per job, gVisor-sandboxed, pinned image) | Cloud Run services can't spawn Docker; Cloud Run Jobs give per-job container isolation natively. |
| Artifact store | Service-owned GCS bucket (`AGENT_ARTIFACTS_BUCKET`), V4 signed URLs in the webhook manifest; the platform re-hosts into its own Firebase Storage on receipt via existing `src/lib/storage.ts` | Keeps the service credential-free w.r.t. platform systems, and the platform in control of what clients ultimately see. |
| Log/transcript store | Same GCS bucket, `transcripts/<client_id>/<job_id>.jsonl` (full message stream incl. tool calls) + `jobs/<job_id>/meta.json` (SHA, model, usage, timings) | Auditable per client, no third datastore. Job state machine lives in Redis (AOF persistence). |
| Egress control | Per-job-container proxy enforcement: job containers run on an internal network with **no direct egress**; an allowlisting proxy (tinyproxy) is the only route out (`HTTP(S)_PROXY` env). Compose enforces this hard in dev; prod uses VPC egress + firewall so job containers can only reach the proxy + `api.anthropic.com`. Allowlist = `config/egress-allowlist.json` (domain groups per task type), config not code | Domain-level filtering needs a proxy; network-level enforcement (not just env-var honor) is what makes it real. |
| Platform job record | Reuse the existing `jobs` collection + `JobStatusBadge`/`AutoRefresh` conventions; add an `external` field (service job id, artifact manifest, usage, agents repo SHA) | Status enums already match (`queued/running/review/failed`); zero new UI framework. |

## 4. Task type → agent capability mapping (v1)

Model: `sonnet` default (per-task-type override). All types get `allowedTools` base:
`Skill, Read, Glob, Grep, Write, Edit, TodoWrite` + per-type additions. Always
`permissionMode: 'dontAsk'`, `settingSources: ['project']`, `cwd = job workspace`.

| Platform task type | Product / entry skill | Extra allowed tools | Egress group | Timeout |
|---|---|---|---|---|
| `social_post` | `karos-instagram-tiktok-content-agent` (`products/social/instagram-tiktok-agent`) + client's emitted sub-skills | `Bash(python3 *)`, `Bash(node *)`, `Bash(git add:*)`, `Bash(git commit:*)`, WebSearch, WebFetch, Task | research + image-sourcing + social APIs | 20 min |
| `newsletter_issue` | `karos-newsletter-agent` (`products/social/newsletter-agent`) | `Bash(node *)`, `Bash(git ...)`, WebSearch, WebFetch | research + fonts | 15 min |
| `blog_article` | `karos-blog-agent` (`products/social/blog-agent`) | `Bash(node *)`, `Bash(git ...)`, WebSearch, WebFetch, Task | research | 15 min |
| `landing_page` | `landing-builder` (`products/landing-page/landing-builder`) + taste vendor packs | `Bash(node *)`, `Bash(npm install/build)`, `Bash(git ...)`, WebFetch | fonts + npm registry | 30 min |

`git add/commit` is allowed (CLAUDE.md mandates committing; commits stay local to the
throwaway workspace — push is never allowed). Vendor packs symlinked per type: taste-skill +
brand-toolkit for `landing_page`/`social_post`; last30days for research-backed types.
Deferred (need egress policy or heavy media): `seo_audit`, `rebrand`, `intel_report`,
`reel`, amazon family.

### 4b. Per-job context files (added requirement)

Jobs can carry input files (images, text/markdown, PDFs, spreadsheets) supplied at submit
time. Shape on `POST /v1/jobs`:

```jsonc
"context_files": [
  { "name": "brand-shoot-01.jpg", "url": "https://…signed-or-token-url…",
    "description": "product photo to feature", "content_type": "image/jpeg" }
]
```

- The **runner harness** (trusted, prep phase — before the agent starts) downloads each file
  into `client_context/files/<sanitized-name>` in the job workspace and lists them (name +
  description) in the job prompt. The agent reads them with its normal `Read` tool; they are
  treated as **untrusted content**, same as web content.
- Limits enforced at the API: ≤ 20 files, ≤ 20 MB/file, ≤ 100 MB total; filenames sanitized
  (no path separators/traversal); URLs must be https. Files are recorded in the job manifest
  (name, sha256, size) for audit.
- **Platform side:** `submitManagedJobAction` accepts existing `contextItems` ids and/or
  fresh uploads; uploads go through the existing `src/lib/storage.ts` path first, then their
  durable token URLs are passed as `context_files`. The agent service never receives platform
  credentials — only fetchable URLs.

**Job prompt template** (per type, in service config): names the entry skill, the client slug,
points at `client_context/` for the brief + platform-side context, restates the adapter rule
(deliverables = files on disk; ledger appends; no external DB), and the run-folder naming
convention. Client mapping: platform `Client` doc gets an optional `agentsRepoSlug` field; a
client without one still runs — `client_context/` becomes the sole context and the runner
creates a minimal `clients/<slug>/` scaffold in the workspace (README pointing to
`client_context/`), satisfying the Client Knowledge Rule without touching the lab repo.

## 5. Job lifecycle

```
platform action ──POST /v1/jobs──▶ agent-service API ──enqueue──▶ BullMQ ──▶ worker
                                                                              │ spawns
                       ┌──────────────────────────────────────────────────────┘
                       ▼
   job container (pinned image, no platform creds, proxy-only egress)
     1. copy baked repo (/opt/karos-agents @ pinned SHA) → /work/repo
     2. prune clients/* except target slug; rm clients/_cso
     3. generate .claude/skills/ symlink shim for the task type
     4. write client_context/ (brief.md + platform context docs) + prompt
     5. query({ cwd, settingSources:['project'], allowedTools, permissionMode:'dontAsk',
               model, maxTurns }) — stream → transcript.jsonl
     6. collect artifacts (diff of clients/<slug>/outputs/ + outputs/), upload to GCS
     7. report to service (internal callback, HMAC) → service updates Redis state
                       │
                       ▼
   service POSTs signed webhook → platform /api/agent-service/webhook
     verify HMAC+timestamp (fail-closed) → update jobs doc → re-host client-facing
     artifacts as assets → logUsage (tokens per model, agents repo SHA on job record)
```

States: `queued → running → uploading → done | failed | cancelled | dead_letter`.
One automatic retry on transient failures (process crash, 5xx from Anthropic, timeout at
first attempt); non-transient (schema/skill errors, deny-loop) → `dead_letter` with full
transcript retained. Cancel = `query.interrupt()` + container kill; webhook still fires with
`cancelled`. Timeout default 15 min, per-task-type override (table above).

**Webhook signing:** `X-Karos-Timestamp` + `X-Karos-Signature: v1=hex(hmac_sha256(secret,
"<ts>.<raw_body>"))`; receiver rejects skew > 5 min and non-constant-time mismatches; secret
from env both sides, rotatable (comma-separated accepted-secrets list on the receiver).

## 6. Security model

- Anthropic API key exists **only** in the agent-service/job-runner environment (Secret
  Manager), never in the platform, never logged (transcript writer redacts env-shaped strings).
- Jobs receive **zero platform credentials**; the only inbound path to the platform is the
  signed webhook. The GCS upload credential is scoped to `objectCreate` on the artifacts
  bucket only, and lives in the runner harness env — the agent's tool surface can't read env.
- Platform → service auth: `Authorization: Bearer <AGENT_SERVICE_TOKEN>` from env, rotatable.
- All web content and client files the agent reads are untrusted; tool allowlist + `dontAsk`
  + proxy egress are the containment layers.
- Agents-repo ref pinned at image build (`ARG AGENTS_REPO_REF`), recorded per job; per-deploy
  override via `AGENTS_REPO_REF` env (runner fetches + checks out that ref at start if it
  differs from the baked one).

## 7. File manifest

### New — `agent-service/`
| File | Purpose |
|---|---|
| `package.json`, `tsconfig.json`, `.env.example` | Service scaffolding |
| `src/index.ts` | Fastify bootstrap, auth hook, `/healthz` |
| `src/api/jobs.ts` | `POST /v1/jobs`, `GET /v1/jobs/:id`, `POST /v1/jobs/:id/cancel` |
| `src/schemas/social_post.json`, `newsletter_issue.json`, `blog_article.json`, `landing_page.json` | Per-task-type request schemas |
| `src/config/task-types.ts` | Entry skill, allowed tools, timeout, egress group, model, prompt template per type |
| `config/egress-allowlist.json` | Domain groups (config, not code) |
| `src/queue/{connection,queue,worker}.ts` | BullMQ setup, retry/DLQ policy |
| `src/exec/{executor,docker-executor,cloudrun-executor}.ts` | Per-job container spawn |
| `src/state/jobs.ts` | Redis job state machine |
| `src/webhooks/{sign,deliver}.ts` | HMAC signing + delivery with retry |
| `src/storage/gcs.ts` | Artifact/transcript upload, signed URLs |
| `runner/src/main.ts` (+ `workspace.ts`, `skills-shim.ts`, `context-files.ts`, `artifacts.ts`, `transcript.ts`) | In-container harness around `query()` |
| `runner/Dockerfile` | node:22 + python3 + ffmpeg/imagemagick/tesseract + agents repo baked at `AGENTS_REPO_REF` |
| `Dockerfile`, `cloudbuild.yaml` | Service image + deploy |
| `docker-compose.yml` | api + worker + redis + tinyproxy + mock-webhook, internal no-egress network |
| `tools/mock-webhook.ts` | Local webhook receiver |
| `test/{schemas,webhook-signing,state-machine}.test.ts` | Unit tests (vitest, matching platform) |
| `test/e2e/<task_type>.e2e.test.ts` | One real-run e2e per type, behind `AGENT_E2E=1` |

### Platform — new
| File | Purpose |
|---|---|
| `src/lib/agent-service/client.ts` | Thin typed HTTP client (submit/status/cancel) |
| `src/lib/agent-service/types.ts` | Job request/manifest/webhook payload types |
| `src/lib/actions/external-job-actions.ts` | `submitManagedJobAction` — creates `jobs` doc, calls service, maps platform forms → schemas |
| `src/app/api/agent-service/webhook/route.ts` | Fail-closed HMAC receiver: job status, asset re-host, usage log |
| `docs/agent-integration.md` | Architecture, add-a-task-type, deploy-a-ref, read transcripts, security model |

### Platform — modified
| File | Change |
|---|---|
| `src/lib/types.ts` | `Job.external?` (serviceJobId, taskType, artifact manifest, usage, agentsRepoSha); `Client.agentsRepoSlug?` |
| `src/lib/data.ts` | Job lookup by `external.serviceJobId` |
| `src/app/(app)/jobs/[id]/page.tsx` | Artifact manifest + token-cost display (existing conventions) |
| `src/app/(app)/clients/[id]/…` (client detail tabs) | "Run managed product" form for the 4 task types, reusing existing form/Badge/AutoRefresh components |
| `.env.example` | `AGENT_SERVICE_URL`, `AGENT_SERVICE_TOKEN`, `AGENT_WEBHOOK_SECRET` |
| `Makefile`/`package.json` scripts | `demo-job` (compose up + sample `social_post` brief end-to-end) |

## 8. Build order (each step = one commit)

1. Service scaffold: Fastify + schemas + Redis state + `/healthz` + unit tests.
2. Queue + Docker executor + runner harness (workspace prep, shim, `query()`, transcript).
3. Artifact collection + GCS + signed webhooks + mock receiver + `demo-job`.
4. Sandboxing: runner Dockerfile, compose no-egress network + proxy, Cloud Run Jobs executor,
   `cloudbuild.yaml`.
5. Platform: client module + action + webhook receiver + UI states.
6. E2E per task type (env-flagged) + `docs/agent-integration.md`.

## 9. Approvals (resolved 2026-07-05)

1. Pruning other clients from each job workspace — **approved**.
2. BullMQ + Redis (Memorystore) + Cloud Run Jobs executor — **approved**.
3. Service-owned GCS artifacts bucket + platform re-host — **approved**.
4. v1 task types `social_post`, `newsletter_issue`, `blog_article`, `landing_page` — **approved**.
5. Coexistence with native engines + Managed Agents integration — **confirmed intended**.
6. Added requirement: per-job context files (§4b) — **requested by Yair**.
