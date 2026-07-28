#!/usr/bin/env bash
#
# One-time (idempotent) GCP + GitHub provisioning for the prep environment.
# Re-runnable: every resource is created only if absent, every secret only if
# missing. Implements the runbook in DEPLOY_ENVIRONMENTS.md end to end. Run
# this on a machine with `gcloud` installed and authenticated as a user with
# Owner/Editor on both projects (and Billing Account User if PREP_PROJECT_ID
# doesn't exist yet).
#
# Usage:
#   PREP_PROJECT_ID=karoscmo-prep PROD_PROJECT_ID=karoscmo \
#   BILLING_ACCOUNT_ID=XXXXXX-XXXXXX-XXXXXX \
#     ./deploy/bootstrap-prep-gcp.sh
#
# Requires: gcloud (authenticated), gh (optional — only used to print/apply
# the GitHub repo variables at the end).
set -euo pipefail

# ── Config (override via env) ────────────────────────────────────────────────
PREP_PROJECT_ID="${PREP_PROJECT_ID:?set PREP_PROJECT_ID, e.g. karoscmo-prep}"
PROD_PROJECT_ID="${PROD_PROJECT_ID:?set PROD_PROJECT_ID — your existing production GCP project id}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-karos-cmo}"                              # Artifact Registry repo name
GITHUB_REPO="${GITHUB_REPO:-karoslabs/karosCMO}"
WIF_POOL="${WIF_POOL:-github}"
DEPLOYER_SA_NAME="${DEPLOYER_SA_NAME:-github-actions-deployer}"
# Only used if PREP_PROJECT_ID doesn't exist yet — leave unset to skip creation
# (i.e. you already created the project yourself).
BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID:-}"

say() { printf '\n\033[1;32m▸ %s\033[0m\n' "$*"; }
have() { gcloud "$@" >/dev/null 2>&1; }
secret_put() { # project name value
  local proj="$1" name="$2" value="$3"
  if have secrets describe "$name" --project "$proj"; then
    echo "  secret $name already exists in $proj — leaving value unchanged"
  else
    printf '%s' "$value" | gcloud secrets create "$name" --project "$proj" --data-file=- --replication-policy=automatic
    echo "  created secret $name in $proj"
  fi
}
secret_put_prompt() { # project name prompt-text
  local proj="$1" name="$2" prompt="$3"
  if have secrets describe "$name" --project "$proj"; then
    echo "  secret $name already exists in $proj — leaving value unchanged"
    return
  fi
  read -rsp "  $prompt: " value; echo
  secret_put "$proj" "$name" "$value"
}

# ── 1. Prep project ──────────────────────────────────────────────────────────
say "Prep project ($PREP_PROJECT_ID)"
if have projects describe "$PREP_PROJECT_ID"; then
  echo "  already exists"
else
  if [ -z "$BILLING_ACCOUNT_ID" ]; then
    echo "  does not exist and BILLING_ACCOUNT_ID is unset — create it yourself:" >&2
    echo "    gcloud projects create $PREP_PROJECT_ID --name=\"Karos CMO (prep)\"" >&2
    echo "    gcloud billing projects link $PREP_PROJECT_ID --billing-account=<ID>" >&2
    exit 1
  fi
  gcloud projects create "$PREP_PROJECT_ID" --name="Karos CMO (prep)"
  gcloud billing projects link "$PREP_PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"
fi

say "Enabling APIs"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com \
  --project="$PREP_PROJECT_ID"

say "Artifact Registry repo ($REPO)"
have artifacts repositories describe "$REPO" --location="$REGION" --project="$PREP_PROJECT_ID" \
  || gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" --project="$PREP_PROJECT_ID"

# ── 2. Cloud Build SA rights on prep (mirrors cloudbuild.yaml's header) ────
say "Cloud Build service-account bindings (prep)"
PREP_PROJECT_NUMBER=$(gcloud projects describe "$PREP_PROJECT_ID" --format='value(projectNumber)')
PREP_CB_SA="${PREP_PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PREP_PROJECT_ID" \
  --member="serviceAccount:${PREP_CB_SA}" --role="roles/run.admin" --condition=None -q >/dev/null
gcloud iam service-accounts add-iam-policy-binding \
  "${PREP_PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --project="$PREP_PROJECT_ID" \
  --member="serviceAccount:${PREP_CB_SA}" --role="roles/iam.serviceAccountUser" -q >/dev/null
gcloud projects add-iam-policy-binding "$PREP_PROJECT_ID" \
  --member="serviceAccount:${PREP_CB_SA}" --role="roles/secretmanager.secretAccessor" --condition=None -q >/dev/null

# ── 3. Prep secrets ──────────────────────────────────────────────────────────
say "Prep secrets (same names as cloudbuild.yaml's --set-secrets list)"
secret_put_prompt "$PREP_PROJECT_ID" KAROS_STAFF_KEY "KAROS_STAFF_KEY (any random string; own value for prep)"
secret_put_prompt "$PREP_PROJECT_ID" ANTHROPIC_API_KEY "ANTHROPIC_API_KEY (sk-ant-…; can be the same key as prod, or a separate one for cost isolation)"
secret_put_prompt "$PREP_PROJECT_ID" RESEND_API_KEY "RESEND_API_KEY — USE A SEPARATE KEY with NO verified sending domain, so prep test sends can never reach a real client inbox"
secret_put_prompt "$PREP_PROJECT_ID" FIREFLIES_API_KEY "FIREFLIES_API_KEY (blank/dummy is fine if prep won't ingest transcripts)"
secret_put_prompt "$PREP_PROJECT_ID" FIREFLIES_WEBHOOK_SECRET "FIREFLIES_WEBHOOK_SECRET (own random value for prep)"
secret_put "$PREP_PROJECT_ID" CRON_SECRET "$(openssl rand -hex 32)"
secret_put "$PREP_PROJECT_ID" agent-service-tokens "$(openssl rand -hex 32)"
secret_put "$PREP_PROJECT_ID" agent-webhook-secret "$(openssl rand -hex 32)"

say "Firebase secrets — MUST be identical to production (same shared Firebase project)"
if have secrets describe FIREBASE_SERVICE_ACCOUNT_KEY --project="$PREP_PROJECT_ID"; then
  echo "  FIREBASE_SERVICE_ACCOUNT_KEY already exists in prep — leaving unchanged"
elif have secrets describe FIREBASE_SERVICE_ACCOUNT_KEY --project="$PROD_PROJECT_ID"; then
  gcloud secrets versions access latest --secret=FIREBASE_SERVICE_ACCOUNT_KEY --project="$PROD_PROJECT_ID" \
    | gcloud secrets create FIREBASE_SERVICE_ACCOUNT_KEY --project="$PREP_PROJECT_ID" --data-file=- --replication-policy=automatic
  echo "  copied FIREBASE_SERVICE_ACCOUNT_KEY from prod"
else
  read -rsp "  Path to the Firebase service-account JSON file (downloaded from Firebase console): " SA_PATH; echo
  gcloud secrets create FIREBASE_SERVICE_ACCOUNT_KEY --project="$PREP_PROJECT_ID" --data-file="$SA_PATH" --replication-policy=automatic
fi

if have secrets describe TOKEN_ENCRYPTION_KEY --project="$PREP_PROJECT_ID"; then
  echo "  TOKEN_ENCRYPTION_KEY already exists in prep — leaving unchanged"
elif have secrets describe TOKEN_ENCRYPTION_KEY --project="$PROD_PROJECT_ID"; then
  gcloud secrets versions access latest --secret=TOKEN_ENCRYPTION_KEY --project="$PROD_PROJECT_ID" \
    | gcloud secrets create TOKEN_ENCRYPTION_KEY --project="$PREP_PROJECT_ID" --data-file=- --replication-policy=automatic
  echo "  copied TOKEN_ENCRYPTION_KEY from prod — required, decrypts shared Firestore token fields"
else
  echo "  WARNING: TOKEN_ENCRYPTION_KEY not found in prod either — generating one now and putting" >&2
  echo "  it in BOTH projects so they start in sync. If prod later gets its own without updating" >&2
  echo "  prep (or vice versa), encrypted LinkedIn-seat tokens become undecryptable." >&2
  KEY="$(openssl rand -hex 32)"
  secret_put "$PREP_PROJECT_ID" TOKEN_ENCRYPTION_KEY "$KEY"
  secret_put "$PROD_PROJECT_ID" TOKEN_ENCRYPTION_KEY "$KEY"
fi

# ── 4. Cross-project Artifact Registry read (needed for promote-production) ─
say "Granting production's Cloud Build SA read access to prep's Artifact Registry"
PROD_PROJECT_NUMBER=$(gcloud projects describe "$PROD_PROJECT_ID" --format='value(projectNumber)')
gcloud artifacts repositories add-iam-policy-binding "$REPO" \
  --project="$PREP_PROJECT_ID" --location="$REGION" \
  --member="serviceAccount:${PROD_PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.reader" -q >/dev/null

# ── 5. Workload Identity Federation (GitHub Actions → GCP, no key files) ────
say "Workload Identity Federation pool"
have iam workload-identity-pools describe "$WIF_POOL" --project="$PREP_PROJECT_ID" --location=global \
  || gcloud iam workload-identity-pools create "$WIF_POOL" \
       --project="$PREP_PROJECT_ID" --location=global --display-name="GitHub Actions"

have iam workload-identity-pools providers describe github \
  --project="$PREP_PROJECT_ID" --location=global --workload-identity-pool="$WIF_POOL" \
  || gcloud iam workload-identity-pools providers create-oidc github \
       --project="$PREP_PROJECT_ID" --location=global --workload-identity-pool="$WIF_POOL" \
       --display-name="GitHub" \
       --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
       --attribute-condition="assertion.repository=='${GITHUB_REPO}'" \
       --issuer-uri="https://token.actions.githubusercontent.com"

WIF_POOL_RESOURCE=$(gcloud iam workload-identity-pools describe "$WIF_POOL" \
  --project="$PREP_PROJECT_ID" --location=global --format="value(name)")
WIF_PROVIDER_RESOURCE=$(gcloud iam workload-identity-pools providers describe github \
  --project="$PREP_PROJECT_ID" --location=global --workload-identity-pool="$WIF_POOL" --format="value(name)")

say "Deployer service account"
DEPLOYER_SA="${DEPLOYER_SA_NAME}@${PREP_PROJECT_ID}.iam.gserviceaccount.com"
have iam service-accounts describe "$DEPLOYER_SA" --project="$PREP_PROJECT_ID" \
  || gcloud iam service-accounts create "$DEPLOYER_SA_NAME" \
       --project="$PREP_PROJECT_ID" --display-name="GitHub Actions deployer"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" \
  --project="$PREP_PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${WIF_POOL_RESOURCE#*/}/attribute.repository/${GITHUB_REPO}" -q >/dev/null

gcloud projects add-iam-policy-binding "$PREP_PROJECT_ID" \
  --member="serviceAccount:${DEPLOYER_SA}" --role="roles/cloudbuild.builds.editor" --condition=None -q >/dev/null
gcloud projects add-iam-policy-binding "$PROD_PROJECT_ID" \
  --member="serviceAccount:${DEPLOYER_SA}" --role="roles/cloudbuild.builds.editor" --condition=None -q >/dev/null

# ── 6. GitHub repo variables ─────────────────────────────────────────────────
say "GitHub repository variables"
cat <<EOF
Run these (requires: gh auth login), or apply them yourself in
Settings → Secrets and variables → Actions → Variables:

  gh variable set GCP_WIF_PROVIDER --repo $GITHUB_REPO --body "$WIF_PROVIDER_RESOURCE"
  gh variable set GCP_DEPLOYER_SA --repo $GITHUB_REPO --body "$DEPLOYER_SA"
  gh variable set PREP_PROJECT_ID --repo $GITHUB_REPO --body "$PREP_PROJECT_ID"
  gh variable set PROD_PROJECT_ID --repo $GITHUB_REPO --body "$PROD_PROJECT_ID"
  gh variable set PREP_REGION --repo $GITHUB_REPO --body "$REGION"
  gh variable set PREP_AGENT_SERVICE_URL --repo $GITHUB_REPO --body ""
  gh variable set PREP_EMAIL_FROM --repo $GITHUB_REPO --body "Karos CMO Prep <onboarding@resend.dev>"
  gh variable set PREP_ADMIN_EMAIL --repo $GITHUB_REPO --body "hello@karoslabs.com"

Still needed manually (not knowable until things exist / are chosen by you):
  PREP_APP_URL             — run the first prep deploy, then read the Cloud Run URL it prints
  PROD_APP_URL             — your existing production URL
  PROD_AGENT_SERVICE_URL   — your existing agent-service URL, if any
  PROD_EMAIL_FROM          — e.g. "Karos CMO <donotreply@karoslabs.com>"

Firebase console (one-time, shared project):
  - Authentication → Settings → Authorized domains → add prep's Cloud Run domain
  - If NEXT_PUBLIC_FIREBASE_API_KEY has HTTP-referrer restrictions (Google Cloud
    Console → Credentials), add prep's domain there too

Done. Push to main and watch "Deploy to Prep" in the Actions tab.
EOF
