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
for path in publish cleanup-logs scheduler "agent-service/reconcile" "credits/reconcile"; do
  gcloud scheduler jobs create http ${path//\//-} \
    --schedule="*/10 * * * *" --uri="<platform-url>/api/$path" \
    --http-method=GET --headers="Authorization=Bearer $(gcloud secrets versions access latest --secret CRON_SECRET)"
done
```

(`publish` every 5 min, `cleanup-logs` daily, `scheduler` every ~15 min, both
`reconcile`s every ~10 min — adjust schedules to taste.)

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

## Rolling a new agents-repo version

Re-run step 3 with a new `_AGENTS_REF`. The runner image rebakes the repo at
that ref; every job records the exact SHA it ran. Per-job override is the
`agent_version` field on the job request.

## Known residual (track before heavy untrusted-content use)

`ANTHROPIC_API_KEY` is present in the runner container so the SDK can call the
API; a prompt-injected agent could read it via its own Bash tools. Mitigations
in place: minimal env allow-list (the per-job runner token is stripped), no
`curl`/`wget`/network Bash tools allow-listed, and the egress proxy. The full
fix is proxy-side key injection (job containers hold no key; the proxy adds the
`x-api-key` header for `api.anthropic.com`) — a follow-up requiring an
auth-injecting proxy in place of tinyproxy.
