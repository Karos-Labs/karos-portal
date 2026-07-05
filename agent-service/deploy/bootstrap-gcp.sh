#!/usr/bin/env bash
#
# One-time (idempotent) GCP provisioning for the Karos agent service.
# Re-runnable: every resource is created only if absent. Prints the wiring
# values you plug into the platform at the end. Nothing here deploys code —
# that's `gcloud builds submit --config cloudbuild.yaml` (see DEPLOY.md).
#
# Usage:
#   PROJECT_ID=karos-prod REGION=us-central1 ./deploy/bootstrap-gcp.sh
#
# Requires: gcloud (authenticated, project owner/editor), openssl.
set -euo pipefail

# ── Config (override via env) ────────────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-karos}"                                  # Artifact Registry repo
NETWORK="${NETWORK:-default}"
CONNECTOR="${CONNECTOR:-agent-vpc}"                    # Serverless VPC Access connector
CONNECTOR_RANGE="${CONNECTOR_RANGE:-10.8.0.0/28}"
REDIS_INSTANCE="${REDIS_INSTANCE:-agent-redis}"
BUCKET="${BUCKET:-${PROJECT_ID}-agent-artifacts}"
PROXY_VM="${PROXY_VM:-agent-egress-proxy}"
PROXY_ZONE="${PROXY_ZONE:-${REGION}-a}"
SERVICE_SA="agent-service-sa@${PROJECT_ID}.iam.gserviceaccount.com"
RUNNER_SA="agent-runner-sa@${PROJECT_ID}.iam.gserviceaccount.com"
# The platform's Cloud Run runtime service account (it calls the agent api).
PLATFORM_SA="${PLATFORM_SA:-}"                          # e.g. karos-web@PROJECT.iam.gserviceaccount.com
API_SERVICE="${API_SERVICE:-agent-service-api}"

say() { printf '\n\033[1;32m▸ %s\033[0m\n' "$*"; }
have() { gcloud "$@" >/dev/null 2>&1; }
secret_put() { # name value
  if have secrets describe "$1" --project "$PROJECT_ID"; then
    echo "  secret $1 exists — leaving value unchanged"
  else
    printf '%s' "$2" | gcloud secrets create "$1" --project "$PROJECT_ID" --data-file=- --replication-policy=automatic
    echo "  created secret $1"
  fi
}

gcloud config set project "$PROJECT_ID" >/dev/null

say "Enabling APIs"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com \
  redis.googleapis.com vpcaccess.googleapis.com compute.googleapis.com \
  artifactregistry.googleapis.com --project "$PROJECT_ID"

say "Artifact Registry ($REPO)"
have artifacts repositories describe "$REPO" --location "$REGION" \
  || gcloud artifacts repositories create "$REPO" --repository-format=docker --location "$REGION"

say "Serverless VPC connector ($CONNECTOR) — lets Cloud Run reach Memorystore + the proxy"
have compute networks vpc-access connectors describe "$CONNECTOR" --region "$REGION" \
  || gcloud compute networks vpc-access connectors create "$CONNECTOR" \
       --region "$REGION" --network "$NETWORK" --range "$CONNECTOR_RANGE"

say "Memorystore Redis ($REDIS_INSTANCE)"
have redis instances describe "$REDIS_INSTANCE" --region "$REGION" \
  || gcloud redis instances create "$REDIS_INSTANCE" \
       --size=1 --region "$REGION" --network "$NETWORK" --tier=basic --redis-version=redis_7_0
REDIS_HOST=$(gcloud redis instances describe "$REDIS_INSTANCE" --region "$REGION" --format='value(host)')
REDIS_PORT=$(gcloud redis instances describe "$REDIS_INSTANCE" --region "$REGION" --format='value(port)')

say "Artifacts bucket (gs://$BUCKET)"
have storage buckets describe "gs://$BUCKET" \
  || gcloud storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access

say "Service accounts"
have iam service-accounts describe "$SERVICE_SA" \
  || gcloud iam service-accounts create agent-service-sa --display-name "Agent service (api+worker)"
have iam service-accounts describe "$RUNNER_SA" \
  || gcloud iam service-accounts create agent-runner-sa --display-name "Agent runner job"

say "Secrets (generated where possible; you'll be prompted for the two external keys)"
secret_put agent-service-tokens "$(openssl rand -hex 32)"
secret_put agent-webhook-secret "$(openssl rand -hex 32)"
secret_put agent-redis-url "redis://${REDIS_HOST}:${REDIS_PORT}"
secret_put agent-artifacts-bucket "$BUCKET"
if ! have secrets describe anthropic-api-key --project "$PROJECT_ID"; then
  read -rsp "  Anthropic API key (sk-ant-…): " ANTHROPIC_KEY; echo
  secret_put anthropic-api-key "$ANTHROPIC_KEY"
fi
if ! have secrets describe github-token --project "$PROJECT_ID"; then
  read -rsp "  GitHub token with read access to karoslabs/karos-agents: " GH_TOKEN; echo
  secret_put github-token "$GH_TOKEN"
fi

say "IAM bindings"
# Both runtimes read their secrets.
for SA in "$SERVICE_SA" "$RUNNER_SA"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor --condition=None -q >/dev/null
done
# Artifact + transcript writes.
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member "serviceAccount:$SERVICE_SA" --role roles/storage.objectAdmin -q >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member "serviceAccount:$RUNNER_SA" --role roles/storage.objectAdmin -q >/dev/null
# Worker launches runner Cloud Run Job executions, acting as the runner SA.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:$SERVICE_SA" --role roles/run.developer --condition=None -q >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$RUNNER_SA" \
  --member "serviceAccount:$SERVICE_SA" --role roles/iam.serviceAccountUser -q >/dev/null
# IAM auth: runner (job) calls the api's /internal past the IAM edge.
gcloud run services add-iam-policy-binding "$API_SERVICE" --region "$REGION" \
  --member "serviceAccount:$RUNNER_SA" --role roles/run.invoker -q >/dev/null 2>&1 \
  || echo "  (api service not deployed yet — re-run this binding, or add it in DEPLOY.md step 3)"
if [ -n "$PLATFORM_SA" ]; then
  gcloud run services add-iam-policy-binding "$API_SERVICE" --region "$REGION" \
    --member "serviceAccount:$PLATFORM_SA" --role roles/run.invoker -q >/dev/null 2>&1 \
    || echo "  (bind PLATFORM_SA→run.invoker on $API_SERVICE after the api is deployed)"
else
  echo "  PLATFORM_SA unset — after deploy, grant the platform's runtime SA roles/run.invoker on $API_SERVICE"
fi

say "Egress proxy VM ($PROXY_VM) — the only route out of the job sandbox"
if ! have compute instances describe "$PROXY_VM" --zone "$PROXY_ZONE"; then
  gcloud compute instances create "$PROXY_VM" \
    --zone "$PROXY_ZONE" --machine-type e2-micro --network "$NETWORK" --no-address \
    --metadata-from-file=startup-script="$(dirname "$0")/proxy-startup.sh",tinyproxy-conf="$(dirname "$0")/../config/tinyproxy.conf",proxy-filter="$(dirname "$0")/../config/proxy-filter.txt"
  echo "  created; tinyproxy comes up on :8888 (internal IP only)"
fi
PROXY_IP=$(gcloud compute instances describe "$PROXY_VM" --zone "$PROXY_ZONE" --format='value(networkInterfaces[0].networkIP)')
# Allow the VPC connector range to reach the proxy.
have compute firewall-rules describe agent-allow-proxy \
  || gcloud compute firewall-rules create agent-allow-proxy \
       --network "$NETWORK" --direction INGRESS --action ALLOW --rules tcp:8888 --source-ranges "$CONNECTOR_RANGE"

cat <<EOF

$(say "Done. Wire the platform (Cloud Run env) with:")
  AGENT_SERVICE_URL       = https://<api-service-url>            # after the api deploys
  AGENT_SERVICE_AUDIENCE  = https://<api-service-url>            # same URL — turns on IAM ID tokens
  AGENT_SERVICE_TOKEN     = (secret agent-service-tokens)        # --set-secrets
  AGENT_WEBHOOK_SECRET    = (secret agent-webhook-secret)        # --set-secrets, shared with the service
  NEXT_PUBLIC_APP_URL     = https://<platform-url>               # webhook callback base

Deploy substitutions for cloudbuild.yaml:
  _REGION=$REGION _REPO=$REPO
  Proxy for the runner job:  HTTPS_PROXY=http://${PROXY_IP}:8888
  VPC connector:             $CONNECTOR   (attach to worker + runner job, egress=all-traffic)
  Redis URL secret:          agent-redis-url  (redis://${REDIS_HOST}:${REDIS_PORT})

Next: DEPLOY.md step 3 (build+deploy), then step 4 (lock down egress firewall).
EOF
