# Agent service integration

How karosCMO runs [karos-agents](https://github.com/karoslabs/karos-agents) lab products
through the standalone agent service in [`agent-service/`](../agent-service/). Companion to
[INTEGRATION_PLAN.md](../INTEGRATION_PLAN.md) (the approved design + discovery record).

## Architecture

```
┌─ karosCMO (Next.js, Cloud Run) ─────────────────────────────────────────┐
│ ManagedJobForm ─▶ submitManagedJobAction ──────────────┐                │
│ jobs/[id] UI ◀── jobs doc (Firestore) ◀── webhook route ◀──────────┐    │
└─────────────────────────────────────────│──────────────│───────────│────┘
                              POST /v1/jobs (bearer)     │   signed webhook (HMAC)
                                          ▼              │           │
┌─ agent-service (Cloud Run / docker compose) ───────────┴───────────│────┐
│ Fastify API ──▶ BullMQ (Redis) ──▶ worker ──▶ JobExecutor          │    │
│   ▲ /internal callbacks (per-job token)         │ one container    │    │
│   │                                             ▼ per job          │    │
│ artifact store (GCS / local) ◀── runner harness ────────────────────────┘
│                                    │ 1 copy baked karos-agents @ pinned ref
│                                    │ 2 prune clients/* except target slug
│                                    │ 3 .claude/skills symlink shim
│                                    │ 4 client_context/ (brief + input files)
│                                    │ 5 SDK query() — permissionMode dontAsk
│                                    │ 6 collect clients/<slug>/outputs diff
│ egress: allowlisting proxy is the ONLY route out of the job network      │
└──────────────────────────────────────────────────────────────────────────┘
```

The platform never imports agent code; the HTTP API and the signed webhook are the whole
contract. Jobs carry **zero** platform credentials — the only way back in is the webhook.

## Job lifecycle

`queued → running → done | failed | cancelled | dead_letter`

- One automatic retry on transient failures (container death, 5xx, timeout); retries
  exhausted → `dead_letter` with the full transcript preserved.
- Timeout defaults to 15 min, per task type in [`src/task-types.ts`](../agent-service/src/task-types.ts)
  (the worker kills the container; the runner also self-interrupts to flush the transcript).
- Cancel: `POST /v1/jobs/:id/cancel` → Redis pub/sub → container SIGTERM → runner
  `query.interrupt()` → partial transcript + artifacts still land. Cancelling a job that is
  still queued finalizes it immediately (webhook included).
- Webhook delivery is durable: a dedicated BullMQ queue retries with exponential backoff
  (10 attempts over ~40 minutes); 4xx responses (bad secret) stop retrying, network/5xx keep
  going. `GET /v1/jobs/:id` remains the polling fallback if delivery is exhausted.
- Platform mapping (webhook receiver): `done → review`, everything else → `failed`. The
  receiver claims each completion atomically (Firestore transaction), so sender retries and
  duplicate deliveries cannot double-create assets or double-count usage.

## How to add a new task type

1. **agent-service** — add the brief schema `src/schemas/task-types/<type>.json`, register it
   in `src/schemas/validate.ts`, and add a `TASK_TYPE_CONFIGS` entry in `src/task-types.ts`:
   entry skill (name + repo-relative dir), extra `skillRoots` (vendor packs), `allowedTools`
   (minimum the skills need — check the SKILL.md body for Bash/engine usage), timeout,
   `maxTurns`, `maxBudgetUsd`, `egressGroups`, and the prompt template.
2. **Egress** — if the skills call new domains, add them to a group in
   `config/egress-allowlist.json` and run `npm run gen:proxy-filter`. If the skill fetches
   *arbitrary* domains (site audits do), stop: that is a policy decision, not a config edit.
3. **Platform** — add the value to `ManagedTaskType` in `src/lib/types.ts`, a label in
   `external-job-actions.ts`, an asset-type mapping in the webhook route, and brief fields in
   `managed-job-form.tsx`.
4. Add the task type to `ALL_BRIEFS` in `agent-service/test/e2e/run-task.e2e.test.ts` and run
   one real job: `AGENT_E2E=1 AGENT_E2E_TASKS=<type> npm run test:e2e`.

## How to deploy a new agents repo version

The runner image bakes a full clone of karos-agents at `AGENTS_REPO_REF` (build arg):

- **Local**: `make runner AGENTS_REPO_REF=<sha-or-branch>` (set `GITHUB_TOKEN` if private).
- **Cloud**: trigger `agent-service/cloudbuild.yaml` with `_AGENTS_REF=<sha>`; it rebuilds the
  runner image and updates the `agent-runner` Cloud Run Job.
- Per-job pinning: pass `agent_version` on `POST /v1/jobs` — the runner checks out that ref
  from the baked clone (it must already exist in the clone; there is no network fetch inside
  the sandbox). Every job records the exact SHA it ran (`agents_repo_sha` in the webhook, the
  job record, and the platform's `job.external.agentsRepoSha`).

## How to read job transcripts

Every SDK message (prompts, tool calls, tool results, the final result with usage) is
streamed as NDJSON during the run, so it survives timeouts and kills:

- **Local**: `agent-service/data (docker volume) → transcripts/<job_id>.jsonl`, or
  `GET /v1/jobs/:id/transcript` (bearer token).
- **Cloud**: `gs://<AGENT_ARTIFACTS_BUCKET>/transcripts/<job_id>.jsonl`; the webhook and job
  record carry a signed `transcript_url`.
- On the platform, the job page (`/jobs/<id>`) shows cost, tokens, model, and the agents repo
  SHA; `usageLogs` has per-model rows (`operation: "managed_job"`) so per-client cost rolls
  into the existing analytics snapshots.

## Security model

- **Isolation**: one container per job (Docker locally, Cloud Run Jobs in prod). The job
  workspace is a throwaway copy of the agents repo **pruned to the target client only** —
  a job for client A can never read client B's contracts, and `clients/_cso/` is always
  removed.
- **Deny-by-default tools**: `permissionMode: "dontAsk"` — anything not in the task type's
  `allowedTools` is denied without prompting (there is no human in the loop). `git push`,
  `curl`, `wget`, `ssh`, `docker`, `gcloud` are explicitly disallowed on top.
- **Egress**: job containers sit on an internal network with no route out; an allowlisting
  proxy (34 domains, `config/egress-allowlist.json`) is the only exit. In Cloud Run, use VPC
  egress + firewall so job containers reach only the proxy and `api.anthropic.com`.
- **Credentials**: `ANTHROPIC_API_KEY` exists only in the agent-service environment. Jobs get
  a single-purpose per-job callback token, valid only for their own `/internal/jobs/:id/*`
  endpoints. Platform → service auth is a rotatable bearer token (`AGENT_SERVICE_TOKENS`
  accepts a comma-separated list; add the new token, roll clients, remove the old).
- **Untrusted input**: web content and client-supplied files are data, never instructions —
  stated in every job prompt; the platform re-hosts client-facing artifacts into its own
  storage rather than serving agent-controlled URLs.
- **Budget**: every job carries `maxTurns` and `maxBudgetUsd` hard caps.

### Webhook verification (what the platform does, step by step)

1. Reject unless `AGENT_WEBHOOK_SECRET` is configured (fail-closed, unlike the legacy
   Fireflies webhook).
2. Read the **raw** body; compute `hmac_sha256(secret, "<x-karos-timestamp>.<rawBody>")`.
3. Constant-time compare against `x-karos-signature: v1=<hex>`; try each comma-separated
   secret (rotation).
4. Reject timestamps older/newer than 5 minutes (replay window).
5. Idempotency: if the mirrored job is already terminal, acknowledge and skip.

## Local dev

```bash
cd agent-service
cp .env.example .env            # set ANTHROPIC_API_KEY to actually run jobs
make runner                     # build job image (GITHUB_TOKEN=... if repo is private)
make up                         # api + worker + redis + egress proxy + mock webhook
make demo-job                   # sample blog_article end to end (DEMO_TASK_TYPE=... to vary)
```

The mock webhook receiver verifies signatures and drops payloads in the shared volume under
`webhooks/`. Unit tests: `npm test` (39 service tests) — plus the platform's
`src/lib/agent-service/__tests__/`. Real runs: `AGENT_E2E=1 npm run test:e2e`.

## Known limits / open policy questions

- **Deferred task types**: site audits, onboarding/intel, rebrand, reel-factory. Blocked on
  either unbounded egress (audits fetch arbitrary client sites) or heavy media deps.
- **The lab repo commits run ledgers**; service job workspaces are throwaway, so `_ledger/`
  appends are captured as (internal) artifacts instead of being pushed back. If the lab wants
  run history back, that's a follow-up (reverse sync or a ledger API).
- **Proxy enforcement in Cloud Run** requires the VPC/firewall setup described above;
  the compose stack enforces it structurally today.
- **ANTHROPIC_API_KEY is visible to the agent's Bash children.** The SDK subprocess needs the
  key in its environment and tool subprocesses inherit it; the runner passes a minimal env
  allowlist (the per-job runner token is stripped), but a prompt-injected agent could still
  read the key and write it into an artifact. The clean fix is proxy-side key injection
  (job containers get no key; the egress proxy adds the Authorization header for
  api.anthropic.com) — recommended next step before running untrusted-content-heavy task
  types at scale.
- **No platform-side reconciliation loop yet**: if webhook delivery exhausts all retries, the
  platform job stays queued/running until someone checks. A small cron that polls
  `getAgentServiceJob` for jobs in-flight longer than their timeout would close this.
