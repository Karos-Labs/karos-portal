#!/usr/bin/env bash
#
# One-time (idempotent) BigQuery BI-telemetry provisioning for a single GCP
# project. Re-runnable: every resource is created only if absent. Run once
# per environment — see DEPLOY_ENVIRONMENTS.md for the two project ids.
# Run this on a machine with `gcloud`/`bq` installed and authenticated as a
# user with BigQuery Admin + Project IAM Admin on the target project.
#
# Usage:
#   PROJECT_ID=karoscmo-prep ./deploy/bootstrap-bi-telemetry-gcp.sh
#   PROJECT_ID=karoscmo      ./deploy/bootstrap-bi-telemetry-gcp.sh
#
# Phase 1: enables BigQuery/Trace/Monitoring, creates the bi_telemetry
# dataset + its three tables, and grants the Cloud Run runtime service
# account write access.
# Phase 2: creates a second dataset (bi_logs_export) and a Cloud Logging →
# BigQuery sink that exports this project's karos-cmo Cloud Run logs into it,
# granting the sink's own writer identity access (NOT the runtime SA — sinks
# write as their own service agent).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID, e.g. karoscmo-prep or karoscmo}"
LOCATION="${LOCATION:-US}"                 # BigQuery dataset location (multi-region)
DATASET_ID="${DATASET_ID:-bi_telemetry}"
LOGS_DATASET_ID="${LOGS_DATASET_ID:-bi_logs_export}"
SINK_NAME="${SINK_NAME:-karos-cmo-bi-log-sink}"
# Cloud Run service name the sink's filter scopes to — avoids exporting every
# GCP audit/platform log in the project by default. Override or broaden the
# filter yourself (edit LOG_FILTER below) if you want project-wide logs.
SERVICE_NAME="${SERVICE_NAME:-karos-cmo}"
LOG_FILTER="${LOG_FILTER:-resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE_NAME}\"}"
# The Cloud Run runtime service account cloudbuild.yaml deploys the service
# as — override if your project uses a dedicated (non-default) runtime SA.
RUNTIME_SA="${RUNTIME_SA:-}"

say() { printf '\n\033[1;32m▸ %s\033[0m\n' "$*"; }
have_dataset() { bq show --project_id="$PROJECT_ID" "${PROJECT_ID}:${1}" >/dev/null 2>&1; }
have_table() { bq show --project_id="$PROJECT_ID" "${PROJECT_ID}:${DATASET_ID}.${1}" >/dev/null 2>&1; }
have_sink() { gcloud logging sinks describe "$SINK_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; }

say "Enabling APIs ($PROJECT_ID)"
gcloud services enable \
  bigquery.googleapis.com cloudtrace.googleapis.com monitoring.googleapis.com \
  --project="$PROJECT_ID"

say "BigQuery dataset ($DATASET_ID)"
if have_dataset "$DATASET_ID"; then
  echo "  already exists"
else
  bq mk --dataset --project_id="$PROJECT_ID" --location="$LOCATION" \
    --description="Karos CMO BI telemetry (agent runs, user actions, credit usage)" \
    "${PROJECT_ID}:${DATASET_ID}"
fi

say "Table: agent_runs_bi"
if have_table agent_runs_bi; then
  echo "  already exists"
else
  bq mk --table --project_id="$PROJECT_ID" \
    --time_partitioning_field=timestamp --time_partitioning_type=DAY \
    --clustering_fields=clientId \
    "${PROJECT_ID}:${DATASET_ID}.agent_runs_bi" \
    runId:STRING,clientId:STRING,agentId:STRING,model:STRING,inputTokens:INTEGER,outputTokens:INTEGER,costUsd:FLOAT,durationMs:INTEGER,status:STRING,errorDetails:STRING,timestamp:TIMESTAMP
fi

say "Table: user_actions_bi"
if have_table user_actions_bi; then
  echo "  already exists"
else
  bq mk --table --project_id="$PROJECT_ID" \
    --time_partitioning_field=timestamp --time_partitioning_type=DAY \
    --clustering_fields=clientId \
    "${PROJECT_ID}:${DATASET_ID}.user_actions_bi" \
    timestamp:TIMESTAMP,clientId:STRING,userId:STRING,eventName:STRING,surface:STRING,targetId:STRING,metadataJson:STRING
fi

say "Table: credit_usage_bi"
if have_table credit_usage_bi; then
  echo "  already exists"
else
  bq mk --table --project_id="$PROJECT_ID" \
    --time_partitioning_field=timestamp --time_partitioning_type=DAY \
    --clustering_fields=clientId \
    "${PROJECT_ID}:${DATASET_ID}.credit_usage_bi" \
    timestamp:TIMESTAMP,clientId:STRING,amount:FLOAT,balanceAfter:FLOAT,reason:STRING,source:STRING
fi

say "Granting the Cloud Run runtime service account write access"
if [ -z "$RUNTIME_SA" ]; then
  PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
  RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
  echo "  RUNTIME_SA not set — defaulting to the compute default SA: $RUNTIME_SA"
  echo "  (override with RUNTIME_SA=... if karos-cmo deploys with a dedicated runtime SA)"
fi
# Project-level, not dataset-scoped: `bq add-iam-policy-binding` on a dataset
# uses BigQuery's newer IAM Conditions-aware policy API, which 400s with
# "This feature requires allowlisting" on projects Google hasn't allowlisted
# for it. Project-level roles/bigquery.dataEditor (same pattern
# bootstrap-prep-gcp.sh already uses for run.admin/secretmanager.secretAccessor)
# sidesteps that entirely — broader than the single dataset, but no allowlist
# request needed.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/bigquery.dataEditor" --condition=None -q >/dev/null

# ── Phase 2: Cloud Logging → BigQuery sink ──────────────────────────────────
say "BigQuery dataset ($LOGS_DATASET_ID) — log export, kept separate from $DATASET_ID"
if have_dataset "$LOGS_DATASET_ID"; then
  echo "  already exists"
else
  bq mk --dataset --project_id="$PROJECT_ID" --location="$LOCATION" \
    --description="Karos CMO structured log export (Cloud Logging sink destination)" \
    "${PROJECT_ID}:${LOGS_DATASET_ID}"
fi

say "Cloud Logging sink ($SINK_NAME)"
if have_sink; then
  echo "  already exists — leaving filter/destination unchanged (edit/delete manually to change)"
else
  gcloud logging sinks create "$SINK_NAME" \
    "bigquery.googleapis.com/projects/${PROJECT_ID}/datasets/${LOGS_DATASET_ID}" \
    --project="$PROJECT_ID" \
    --use-partitioned-tables \
    --log-filter="$LOG_FILTER"
fi

say "Granting the sink's writer identity BigQuery access"
WRITER_IDENTITY=$(gcloud logging sinks describe "$SINK_NAME" --project="$PROJECT_ID" --format='value(writerIdentity)')
# Same allowlist issue as above — project-level grant instead of dataset-scoped.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="$WRITER_IDENTITY" --role="roles/bigquery.dataEditor" --condition=None -q >/dev/null

cat <<EOF

Done. Next steps for $PROJECT_ID:
  1. Set GOOGLE_CLOUD_PROJECT=$PROJECT_ID (already wired into cloudbuild.yaml's
     --set-env-vars via Cloud Build's built-in \$PROJECT_ID — nothing to do if
     deploying through the existing pipeline).
  2. Deploy karosCMO; exercise a login, an asset approval, and a credit charge.
  3. Verify BI rows landed:
       bq query --project_id=$PROJECT_ID --use_legacy_sql=false \\
         'SELECT * FROM ${DATASET_ID}.user_actions_bi ORDER BY timestamp DESC LIMIT 10'
  4. Verify the log sink is exporting (allow ~10 min after first deploy for
     tables to appear):
       bq ls --project_id=$PROJECT_ID $LOGS_DATASET_ID
EOF
