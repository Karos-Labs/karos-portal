# Deploying the agent service to production (Cloud Run)

Ordered runbook. The service runs as two Cloud Run **services** (api + worker)
plus one Cloud Run **Job** (the per-job runner), with Memorystore (Redis), a
GCS artifacts bucket, and a locked-down egress proxy. Auth to the api is
**IAM + app token** ("IAM + bearer").

Prereqges: `gcloud` authenticated as project owner/editor; the platform already
deploys to Cloud Run (`../cloudbuild.yaml`).

## 1. Provision infrastructure (once)

```bash
cd agent-service
PROJECT_ID=<your-project> REGION=us-central1 \
  PLATFORM_SA=<platform-runtime-sa>@<project>.iam.gserviceaccount.com \
  ./deploy/bootstrap-gcp.sh
```

Creates: Artifact Registry repo, Serverless VPC connector, Memorystore, the
artifacts bucket, the two service accounts, all Secret Manager entries
(generating `agent-service-tokens` + `agent-webhook-secret`, prompting for the
Anthropic key and a GitHub token), IAM bindings, and the tinyproxy egress VM.
It prints the values you need for steps 3–4.

You must also create a **`CRON_SECRET`** secret (used by the publish, cleanup,
and reconcile crons — Vercel crons don't fire on Cloud Run):

```bash
printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create CRON_SECRET --data-file=-
```

## 2. Share the two cross-boundary secrets with the platform

The platform reads the **same** `agent-service-tokens` and `agent-webhook-secret`
values — the root `cloudbuild.yaml` already mounts them as `AGENT_SERVICE_TOKEN`
and `AGENT_WEBHOOK_SECRET`. Grant the platform's Cloud Build + runtime SAs
`roles/secretmanager.secretAccessor` on both (bootstrap does this for the agent
SAs; do the platform SAs too).

## 3. Build + deploy the agent service

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions _REGION=us-central1,_REPO=karos,_AGENTS_REF=<sha-or-main>,_VPC_CONNECTOR=agent-vpc
```

First pass deploys the api; grab its URL, then re-run with the URL wired so the
worker can call back and the runner gets its IAM audience + proxy:

```bash
API_URL=$(gcloud run services describe agent-service-api --region us-central1 --format='value(status.url)')
PROXY_IP=$(gcloud compute instances describe agent-egress-proxy --zone us-central1-a --format='value(networkInterfaces[0].networkIP)')
gcloud builds submit --config cloudbuild.yaml --substitutions \
  _REGION=us-central1,_REPO=karos,_AGENTS_REF=<sha-or-main>,_VPC_CONNECTOR=agent-vpc,_INTERNAL_API_URL=$API_URL,_JOB_HTTP_PROXY=http://$PROXY_IP:8888
```

Then confirm the IAM invoker bindings on the api (bootstrap prints these if the
api didn't exist yet on its first run):

```bash
gcloud run services add-iam-policy-binding agent-service-api --region us-central1 \
  --member serviceAccount:agent-runner-sa@$PROJECT_ID.iam.gserviceaccount.com --role roles/run.invoker
gcloud run services add-iam-policy-binding agent-service-api --region us-central1 \
  --member serviceAccount:<platform-runtime-sa> --role roles/run.invoker
```

## 4. Lock down egress (the sandbox network boundary)

By default a VPC allows all egress. Add a firewall that lets the runner reach
**only** the proxy, so the `HTTPS_PROXY` isn't merely honor-based:

```bash
# Deny all egress from the runner's connector range, then allow just the proxy.
gcloud compute firewall-rules create agent-deny-egress \
  --network default --direction EGRESS --action DENY --rules all \
  --destination-ranges 0.0.0.0/0 --priority 1000 --target-tags agent-runner
gcloud compute firewall-rules create agent-allow-proxy-egress \
  --network default --direction EGRESS --action ALLOW --rules tcp:8888 \
  --destination-ranges <PROXY_IP>/32 --priority 900 --target-tags agent-runner
```

(Tagging Cloud Run VPC-connector traffic is connector-range based; review for
your VPC. The proxy itself needs normal egress to reach the allow-listed
domains — it is the single controlled hole.)

## 5. Wire + deploy the platform

Set on the platform's Cloud Run deploy (root `cloudbuild.yaml` substitutions):

```
_AGENT_SERVICE_URL = <API_URL>     # also becomes AGENT_SERVICE_AUDIENCE
_APP_URL           = <platform public URL>
```

Deploy the platform. Setting `AGENT_SERVICE_URL` is the **go-live switch** —
the Managed products UI appears once it's present.

## 6. Schedule the crons (Cloud Scheduler)

```bash
for path in publish cleanup-logs scheduler "agent-service/reconcile" "credits/reconcile" intel-report-schedule analytics/sync; do
  gcloud scheduler jobs create http ${path//\//-} \
    --schedule="*/10 * * * *" --uri="<platform-url>/api/$path" \
    --http-method=GET --headers="Authorization=Bearer $(gcloud secrets versions access latest --secret CRON_SECRET)"
done

# Runway autopilot — weekly all-clients top-up so every active client keeps a
# rolling 14-day runway of posts. Deficit-based + idempotent, so a weekly
# cadence is enough (running it more often is harmless).
gcloud scheduler jobs create http runway \
  --schedule="0 8 * * 1" --uri="<platform-url>/api/runway" \
  --http-method=GET --headers="Authorization=Bearer $(gcloud secrets versions access latest --secret CRON_SECRET)"
```

(`publish` every 5 min, `cleanup-logs` daily, `scheduler` every ~15 min, both
`reconcile`s every ~10 min, `analytics/sync` daily, `runway` weekly (Mon 08:00)
— adjust schedules to taste.)

**Runway autopilot env flags** (set on the platform Cloud Run service):
- `RUNWAY_AUTOGEN_ENABLED=1` — master switch. Unset ⇒ the cron only *measures*
  and reports deficits (no jobs fired). Deploy it off first, hit
  `GET /api/runway?dryRun=1` to review the plan, then flip it on.
- `RUNWAY_MAX_JOBS_PER_CLIENT` — hard cap on top-up jobs dispatched per client
  per run (default 2). Bounds agency-side agent-service spend; runway top-ups go
  through the staff/agency path and never charge client credits.

Only `active`, onboarded clients are topped up; `social` and `newsletter_issue`
families auto-fire (no required brief), while `blog_article` deficits are
reported but left to the Task Map / manual flow (a blog needs a real topic).

`intel-report-schedule` drives the admin-configurable recurring Intel Report +
SEO/GEO regeneration (Schedule button on each client's dashboard). Ticking
every 10 min is fine — it only actually runs the pipeline for a client once
its own admin-set `intelScheduleNextRunAt` (monthly-or-slower) has passed.

`credits/reconcile` is the credit-loss safety net: client users are charged
upfront and the work runs deferred, so an instance recycle mid-run leaves the
execution stuck and the charge unrefunded. The sweep releases work stuck past
30 min and refunds its charge idempotently (deterministic
`refund_<chargeEntryId>` ledger doc) — safe to run as often as you like.

## 7. Smoke test

```bash
# From a machine that can mint an ID token for the api (or temporarily via console):
curl -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences=$API_URL)" \
     -H "X-Karos-Service-Token: $(gcloud secrets versions access latest --secret agent-service-tokens)" \
     $API_URL/healthz
```

Then run one job per task type from the platform UI (Clients → Agents → Managed
products) and confirm artifacts arrive as review-ready assets.

## X agent live reads (`XAI_API_KEY`)

The X agent's reactive lanes (news reaction, quote, reply) read X live via
`api.x.ai` (already on the research egress group). The worker passes
`XAI_API_KEY` into job sandboxes when set. Create the secret BEFORE deploying a
revision that references it (step 3 fails otherwise):

```bash
printf '%s' '<the xAI key>' | gcloud secrets create xai-api-key --data-file=-
gcloud secrets add-iam-policy-binding xai-api-key \
  --member serviceAccount:agent-service-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor
```

Undo: remove `XAI_API_KEY=xai-api-key:latest` from the worker's `--set-secrets`
and redeploy (or `gcloud secrets delete xai-api-key`). Without the key the X
agent still runs; its reactive lanes fall back to WebSearch.

## Reddit agent discovery (`REDDIT_RSS_USER`, `REDDIT_RSS_FEED_TOKEN`)

**The Reddit agent needs no secret to run.** Its discovery is Reddit's keyless
RSS, which is exactly what the lab's good 2026-07-08 run used: that run had no
`REDDIT_*` variable set at all, and the engine's only required variable is
`CLAUDE_API_KEY`. Do not treat these as missing prerequisites.

They are an OPTIONAL rate-limit helper. Keyless RSS is fine for a single
on-demand scan; a *daily* cadence scanning several subreddits in a burst hits
HTTP 429, and the lab engine warns about that itself in daily mode. The fix is
the account-scoped RSS pair — the `user=` and `feed=` params from
<https://www.reddit.com/prefs/feeds> for whichever Reddit account you like.
Neither is an API app or a posting credential; there is no posting code path in
this portal and there will not be one.

The worker already forwards `REDDIT_RSS_USER`, `REDDIT_RSS_FEED_TOKEN` and
`REDDIT_ACCOUNT` into each runner execution when they are set, and the lab's
Python engine reads them by name. They are deliberately **not** in the worker's
`--set-secrets` line, because `--set-secrets` fails on a secret that does not
exist — so listing them pre-emptively would break every deploy for a token that
may never be needed.

Add them only if a real run actually rate-limits:

```bash
printf '%s' '<the user= value>' | gcloud secrets create reddit-rss-user --data-file=-
printf '%s' '<the feed= value>' | gcloud secrets create reddit-rss-feed-token --data-file=-
for s in reddit-rss-user reddit-rss-feed-token; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member serviceAccount:agent-service-sa@$PROJECT_ID.iam.gserviceaccount.com \
    --role roles/secretmanager.secretAccessor
done
```

Then append `,REDDIT_RSS_USER=reddit-rss-user:latest,REDDIT_RSS_FEED_TOKEN=reddit-rss-feed-token:latest`
to the worker's `--set-secrets` in `cloudbuild.yaml` **in the same change** —
that line is declarative, so anything not listed is dropped from the service on
the next deploy. Undo: remove both entries and redeploy.

**Separately: the rate limit is not the IP block.** Reddit also blocks datacenter
egress for keyless reads. The lab's good run worked from a residential IP, and
even there `WebFetch` of reddit.com was blocked. So the RSS pair may be
necessary without being sufficient from Cloud Run — and it is equally possible
neither is needed. Find out with one real run before provisioning anything: if
discovery works, do nothing; if it 429s, add the pair; if reads are refused
outright, the pair will not help and the options are a residential proxy or
`SCRAPECREATORS_API_KEY` (`api.scrapecreators.com` is already in
`config/egress-allowlist.json`). The canonical instructions require a degraded
run to declare it in `internal/RUN.md` rather than present a thread it could not
read.

Do NOT reach for the Karos sheet entry labelled "Reddit" — per the 2026-07-07
dev note in the lab repo's
`clients/karoslabs/internal/reddit-agent/AGENT-MEMORY.md`, that entry is actually
`OPENAI_API_KEY` and is pending a relabel.
