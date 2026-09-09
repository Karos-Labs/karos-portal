# Deploy environments — prep & production

Two independent GCP projects, one shared Firebase project, isolated Firestore data.

|                          | **prep**                                   | **production**                     |
|--------------------------|---------------------------------------------|-------------------------------------|
| GCP project              | separate (e.g. `karoscmo-prep`)             | existing project (e.g. `karoscmo`)  |
| Cloud Run service        | own, in its own project                     | own, in its own project             |
| Artifact Registry        | own repo                                    | own repo                            |
| Secret Manager           | own secrets (same *names*, own *values*)    | own secrets                         |
| Firebase project (Auth)  | **same as production** — `karoscmo`         | same                                |
| Firestore database       | own named database (`prep`)                 | project default (`(default)`)       |
| GCS media bucket         | own bucket                                  | own bucket                          |
| Agent service            | own deployment (own Redis/VPC/proxy/runner) | own deployment                      |
| Deploy trigger           | automatic, on every push to `main`          | **manual only** — a person runs it  |

Only Firebase Auth is shared (same project, same login users). Everything that holds
data — Firestore, GCS media, agent-service's Redis/artifacts — is a separate instance per
environment, selected via `FIRESTORE_DATABASE_ID` / `GCS_MEDIA_BUCKET` / `AGENT_SERVICE_URL`
substitutions in `cloudbuild.yaml` (see `src/lib/firebase/admin.ts` and `firebase.json` for
the Firestore named-database wiring). A bad prep deploy, a leaked prep secret, a runaway
prep agent job, or prep test data can't touch production's compute, secrets, or client data.

## What's still shared, and what that means

Because Firestore/Auth are shared, prep is not a sandbox with fake data — it's a second
frontend on top of the *real* clients/jobs/assets. Anything prep does that reaches outside
the app (send an email, publish a scheduled post, spend agent credits) is a real action
against a real client. The deploy config in this repo defaults prep to **not** be able to
do those things automatically:

- **`AGENT_SERVICE_URL` is left empty for prep**, so no agent-service job can be submitted
  from prep and no agent run is billed twice. The mechanism, by name, because this bullet
  previously justified itself with a component (`src/components/managed-products.tsx`) that
  was deleted in `fbecbbf` — leaving nothing a reader could check:
  `isAgentServiceConfigured()` in `src/lib/agent-service/client.ts` is true only when
  `AGENT_SERVICE_URL` *and* `AGENT_SERVICE_TOKEN` are both set, and it is the first
  statement of all three submit cores — `submitManagedJob` (`src/lib/jobs/submit-managed.ts`),
  `submitCustomAgentJob` (`src/lib/jobs/submit-custom.ts`) and `submitCustomAgentRun`
  (`src/lib/agent-service/run-custom-agent.ts`) — each returning "Agent service is not
  configured" before a job row exists or anything is charged. The backstop is structural
  rather than a fourth copy of that check: `config()` in the same client module throws on an
  empty URL, so `submitAgentServiceJob` (and every other call to the service) cannot reach
  the network from prep even if a future caller forgets to ask. In the UI the same predicate
  now *disables* the run control rather than hiding a surface — `serviceConfigured` in
  `src/components/custom-agents.tsx`.
- **⚠️ That guard covers agent-service runs, and nothing else.** A content-generation task
  started in prep does not stop when the agent service is absent: `runTaskExecution`
  (`src/lib/execution-engine.ts`) gates both dispatch paths on `isAgentServiceConfigured()`
  and falls through both to an in-process `generateText` on prep's own
  `ANTHROPIC_API_KEY`, writing the artifact into the shared Firestore. If a client session
  started it, `chargeClientModelCall` (`src/lib/actions/task-actions.ts`) has already taken
  the real client's credits — it runs BEFORE the execution is queued, so the charge lands
  even when the run itself does not. The intel/SEO-GEO pipeline
  and the copilot never route through the agent service either. Empty `AGENT_SERVICE_URL`
  buys you "no duplicate agent runs", not "prep cannot spend AI money or touch a real
  client".
- **No Cloud Scheduler job should point at prep's `/api/publish`, `/api/analytics/sync`,
  `/api/*/reconcile`, etc.** Only wire Cloud Scheduler to production. Prep's `CRON_SECRET`
  exists so those routes don't 503, but nothing should ever call them there — don't create
  a scheduler job against the prep URL.
- **Firebase Auth users are shared.** The same login works on both `PREP_APP_URL` and
  `PROD_APP_URL`. There is no separate prep signup.
- **OAuth app credentials (LinkedIn/Twitter/Google/TikTok) are shared** — same client
  id/secret in both environments' Secret Manager, by choice (simpler than registering
  separate provider apps). Only add prep's callback domain to a provider's redirect-URI
  allow-list if you actually plan to exercise that connect flow from prep.
- **`TOKEN_ENCRYPTION_KEY` must be the *same value* in both environments** regardless of the
  above — it's project-wide (not per-database), and if prep ever encrypted a token with a
  different key, cross-environment decryption would break. Copy this one value verbatim.
- **Use a separate, unverified Resend API key for prep's `RESEND_API_KEY`.** A Resend key
  with no verified sending domain can only deliver to the account owner's own verified
  addresses — so if a prep test run does hit `sendEmail()`, it physically cannot reach a
  real inbox outside your own team.
- **`/api/daily-digest` is the one cron that mails clients directly**, so it deserves the
  same warning twice over: no scheduler job against the prep URL, and prep's own client
  records should have **Daily email** switched off. It is opt-in per client and off by
  default, so a freshly seeded prep client cannot send anything; a Firestore import from
  production carries the flag along with everything else, which is the case to watch.
  Envelope is `EMAIL_FROM` (`PROD_EMAIL_FROM` / `PREP_EMAIL_FROM`), the same `hello@`
  address the rest of the product sends from. `GET /api/daily-digest?dryRun=1` reports
  what would go out without sending or marking anything — see `agent-service/DEPLOY.md`
  §6 for the schedule (hourly, gated per client on their own timezone).
- **No Cloud Scheduler job should point at prep's `/api/publish`, `/api/analytics/sync`,
  `/api/*/reconcile`, etc.** Only wire Cloud Scheduler to production.
- Firebase-project-level config (`FIREBASE_SERVICE_ACCOUNT_KEY`, `NEXT_PUBLIC_FIREBASE_*`)
  is identical in both environments, since it's the same Firebase project — Firestore IAM
  permissions on that service account apply project-wide, across every named database, so
  no extra grant was needed to let it reach the new `prep` database.

Since prep's Firestore data is now its own empty database, prep starts with **no clients**
— seed test clients there directly (or via a Firestore export/import from production if you
want realistic fixtures) before exercising agent runs, publishing, or credits flows.

---

## One-time setup

`deploy/bootstrap-prep-gcp.sh` runs everything below in one idempotent pass (same pattern as
`agent-service/deploy/bootstrap-gcp.sh`) — on a machine with `gcloud` authenticated:

```bash
PREP_PROJECT_ID=karoscmo-prep PROD_PROJECT_ID=karoscmo \
BILLING_ACCOUNT_ID=XXXXXX-XXXXXX-XXXXXX \
  ./deploy/bootstrap-prep-gcp.sh
```

It prompts (hidden input) for the handful of real secret values it can't generate itself,
skips anything that already exists, and prints the `gh variable set` commands you still need
to run at the end. The steps below are the same thing spelled out manually, if you'd rather
run them one at a time or the script hits something environment-specific.

Run once, in order. `$PROD_PROJECT_ID` is your existing project (the one `cloudbuild.yaml`
already deploys to today). Pick a `$PREP_PROJECT_ID` (e.g. `karoscmo-prep`).

### 1. Create the prep project

```bash
gcloud projects create $PREP_PROJECT_ID --name="Karos CMO (prep)"
gcloud billing projects link $PREP_PROJECT_ID --billing-account=<YOUR_BILLING_ACCOUNT_ID>

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project=$PREP_PROJECT_ID
```

### 2. Artifact Registry repo (prep)

```bash
gcloud artifacts repositories create karos-cmo \
  --repository-format=docker --location=us-central1 --project=$PREP_PROJECT_ID
```

### 3. Grant prep's Cloud Build service account deploy rights

Same three bindings the original `cloudbuild.yaml` header already documents for
production — repeat them for prep:

```bash
PREP_PROJECT_NUMBER=$(gcloud projects describe $PREP_PROJECT_ID --format='value(projectNumber)')

gcloud projects add-iam-policy-binding $PREP_PROJECT_ID \
  --member="serviceAccount:${PREP_PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/run.admin"

gcloud iam service-accounts add-iam-policy-binding \
  "${PREP_PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --member="serviceAccount:${PREP_PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser" --project=$PREP_PROJECT_ID

gcloud projects add-iam-policy-binding $PREP_PROJECT_ID \
  --member="serviceAccount:${PREP_PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```


#### Prep runs as a dedicated runtime SA (AU58 / SCRUM-357)

`deploy-prep.yml` passes `_RUNTIME_SERVICE_ACCOUNT`, so the prep service runs
as `karos-cmo-prep@karoscmo-prep.iam.gserviceaccount.com` rather than the
project's shared default compute SA. The runtime grants on that SA (logging,
BigQuery, Pub/Sub publish, `agent-engine-prep` invoker, and per-secret
accessor) are applied separately.

The `roles/iam.serviceAccountUser` binding above is scoped to the OLD
`${PREP_PROJECT_NUMBER}-compute@developer.gserviceaccount.com` and does NOT
cover the new SA. Cloud Build cannot deploy a service as an identity it
cannot `actAs`, so without this the deploy fails with
`PERMISSION_DENIED: ... iam.serviceaccounts.actAs`:

```bash
# Grant BOTH: newer Cloud Build generations run the build as the Compute Engine
# default SA, not the Cloud Build SA. The AU58 deploy failed on exactly this --
# gcloud reported it was "authenticated as
# 680337539054-compute@developer.gserviceaccount.com". bootstrap-prep-gcp.sh
# already grants both, for the same reason.
for SA in "${PREP_PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
          "${PREP_PROJECT_NUMBER}-compute@developer.gserviceaccount.com"; do
  gcloud iam service-accounts add-iam-policy-binding \
    "karos-cmo-prep@${PREP_PROJECT_ID}.iam.gserviceaccount.com" \
    --member="serviceAccount:${SA}" \
    --role="roles/iam.serviceAccountUser" --project=$PREP_PROJECT_ID
done
```

Deliberately NOT carried over from the default compute SA: `run.admin`,
`artifactregistry.writer`, project-wide `secretmanager.secretAccessor`,
project-wide `storage.objectViewer`. `run.admin` is the one that mattered --
it let the portal's own identity modify or delete any Cloud Run service in
the project, `agent-engine-prep` included. The portal deploys nothing; that
was Cloud Build's role set inherited by accident.

### 4. Prep secrets

Same secret *names* as production (`cloudbuild.yaml`'s `--set-secrets` list), own values:

```bash
echo -n "sk_..."           | gcloud secrets create KAROS_STAFF_KEY --data-file=- --project=$PREP_PROJECT_ID
echo -n "sk-ant-..."       | gcloud secrets create ANTHROPIC_API_KEY --data-file=- --project=$PREP_PROJECT_ID
echo -n "re_..."           | gcloud secrets create RESEND_API_KEY --data-file=- --project=$PREP_PROJECT_ID   # separate, unverified-domain key — see warning above
echo -n "..."              | gcloud secrets create FIREFLIES_API_KEY --data-file=- --project=$PREP_PROJECT_ID
echo -n "..."              | gcloud secrets create FIREFLIES_WEBHOOK_SECRET --data-file=- --project=$PREP_PROJECT_ID
echo -n "<own value>"      | gcloud secrets create CRON_SECRET --data-file=- --project=$PREP_PROJECT_ID       # do not wire a scheduler to it — see warning above
echo -n "dev-token"        | gcloud secrets create agent-service-tokens --data-file=- --project=$PREP_PROJECT_ID
echo -n "dev-webhook-secret" | gcloud secrets create agent-webhook-secret --data-file=- --project=$PREP_PROJECT_ID

# SAME value as production — copy it, don't regenerate:
cat serviceAccount.json    | gcloud secrets create FIREBASE_SERVICE_ACCOUNT_KEY --data-file=- --project=$PREP_PROJECT_ID
gcloud secrets versions access latest --secret=TOKEN_ENCRYPTION_KEY --project=$PROD_PROJECT_ID \
  | gcloud secrets create TOKEN_ENCRYPTION_KEY --data-file=- --project=$PREP_PROJECT_ID
```

(If `TOKEN_ENCRYPTION_KEY` isn't in Secret Manager yet in production, pull it from wherever
it's currently stored — the requirement is just that both projects end up with the exact
same bytes.)

### 5. Cross-project read access, for promotion later

Production's Cloud Build service account needs to be able to `docker pull` from *prep's*
Artifact Registry when promoting:

```bash
PROD_PROJECT_NUMBER=$(gcloud projects describe $PROD_PROJECT_ID --format='value(projectNumber)')

gcloud artifacts repositories add-iam-policy-binding karos-cmo \
  --project=$PREP_PROJECT_ID --location=us-central1 \
  --member="serviceAccount:${PROD_PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"
```

### 6. Workload Identity Federation (GitHub Actions → GCP, no key files)

Create the pool once (in the prep project — it just needs to live somewhere; it grants
roles cross-project):

```bash
gcloud iam workload-identity-pools create github \
  --project=$PREP_PROJECT_ID --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --project=$PREP_PROJECT_ID --location=global --workload-identity-pool=github \
  --display-name="GitHub" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='karoslabs/karosCMO'" \
  --issuer-uri="https://token.actions.githubusercontent.com"

WIF_POOL_ID=$(gcloud iam workload-identity-pools describe github \
  --project=$PREP_PROJECT_ID --location=global --format="value(name)")
```

Create the deployer service account and let GitHub Actions impersonate it:

```bash
gcloud iam service-accounts create github-actions-deployer \
  --project=$PREP_PROJECT_ID --display-name="GitHub Actions deployer"

DEPLOYER_SA="github-actions-deployer@${PREP_PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts add-iam-policy-binding $DEPLOYER_SA \
  --project=$PREP_PROJECT_ID \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${WIF_POOL_ID}/attribute.repository/karoslabs/karosCMO"
```

Grant it exactly what it needs — submit builds in both projects (the actual build/deploy
permissions live on each project's *own* Cloud Build SA, already granted above):

```bash
gcloud projects add-iam-policy-binding $PREP_PROJECT_ID \
  --member="serviceAccount:${DEPLOYER_SA}" --role="roles/cloudbuild.builds.editor"

gcloud projects add-iam-policy-binding $PROD_PROJECT_ID \
  --member="serviceAccount:${DEPLOYER_SA}" --role="roles/cloudbuild.builds.editor"
```

Get the WIF provider's full resource name (you'll need it for a GitHub variable):

```bash
gcloud iam workload-identity-pools providers describe github \
  --project=$PREP_PROJECT_ID --location=global --workload-identity-pool=github \
  --format="value(name)"
# → projects/<number>/locations/global/workloadIdentityPools/github/providers/github
```

### 7. GitHub repo configuration

Set these as **repository variables** (Settings → Secrets and variables → Actions →
Variables, or `gh variable set NAME --body value`) — none of these are secret values, which
is the point of using WIF:

```bash
gh variable set GCP_WIF_PROVIDER --body "projects/<number>/locations/global/workloadIdentityPools/github/providers/github"
gh variable set GCP_DEPLOYER_SA --body "github-actions-deployer@$PREP_PROJECT_ID.iam.gserviceaccount.com"
gh variable set PREP_PROJECT_ID --body "$PREP_PROJECT_ID"
gh variable set PROD_PROJECT_ID --body "$PROD_PROJECT_ID"
gh variable set PREP_APP_URL --body "https://<prep-cloud-run-url>"
gh variable set PROD_APP_URL --body "https://<prod-cloud-run-url-or-custom-domain>"
gh variable set PREP_AGENT_SERVICE_URL --body ""
gh variable set PROD_AGENT_SERVICE_URL --body "<existing prod agent service URL, if any>"
gh variable set PREP_EMAIL_FROM --body "Karos Labs Prep <onboarding@resend.dev>"
gh variable set PROD_EMAIL_FROM --body "Karos Labs <donotreply@karoslabs.com>"
gh variable set PREP_ADMIN_EMAIL --body "hello@karoslabs.com"
gh variable set PROD_ADMIN_EMAIL --body "hello@karoslabs.com"
```

`PREP_APP_URL` won't be known until the first prep deploy finishes (Cloud Run assigns the
URL) — run the first `deploy-prep` build manually once to learn it, then set the variable
and let subsequent pushes use it.

Optional but recommended: add a **required reviewer** on the `production` GitHub
Environment (Settings → Environments → production → Deployment protection rules) as a
second manual gate on top of "someone has to click Run workflow" — belt-and-suspenders on
the manual-only promotion.

### 8. Firebase-side checklist (shared project — do these once)

- **Authorized domains**: Firebase console → Authentication → Settings → Authorized
  domains → add the prep Cloud Run URL's domain, or login will fail there.
- **API key restrictions**: if `NEXT_PUBLIC_FIREBASE_API_KEY` has HTTP-referrer
  restrictions in Google Cloud Console → APIs & Services → Credentials, add the prep
  domain to the allow-list too.
- **firestore.rules**: nothing to do — one shared Firestore, deploy rules once as today.
- **Social OAuth "Connect" flows** (LinkedIn/Twitter/Google/etc.): each provider's app
  console has its own redirect-URI allow-list, keyed by `APP_URL`. Only add
  prep's callback URL there if you actually plan to exercise those connect flows from prep.

---

## Cutting production over from Cloud Run's native CD

If `karos-cmo` in the production project (`karoscmo`) was set up via Cloud Run's own
**"Continuously deploy from a repository"** feature (Cloud Run console → service → the
"Continuous Deployment" / Deploy tab shows a connected GitHub repo), that is a *second*,
independent auto-deploy path — it watches push-to-main directly, same as prep's GitHub
Actions workflow, but with no approval gate at all. As long as it's connected, every push to
`main` deploys to production immediately, regardless of `promote-production.yml` — the two
paths don't know about each other.

**No second Workload Identity pool is needed in `karoscmo`.** The single WIF pool lives in
`karoscmo-prep`; the deployer service account is granted `roles/cloudbuild.builds.editor` on
*both* projects (see step 6 above / `deploy/bootstrap-prep-gcp.sh`), which is all
`promote-production.yml` needs to submit a build in `karoscmo`.

1. **Disconnect the native CD** (GCP Console is the reliable path — it's Cloud
   Run-managed, so editing the underlying trigger directly can get fought by Cloud Run's own
   state): Cloud Run → `karos-cmo` service → **Continuous Deployment** tab → **Disconnect
   repository** / delete the setup. To confirm it's really gone:

   ```bash
   gcloud builds triggers list --project=karoscmo \
     --format="table(id,name,github.push.branch,filename,disabled)"
   ```

   Look for one filtering on `main` that references this service; it should no longer be
   listed (or show `disabled: True`) once disconnected.

2. **Confirm the cross-project grants exist** (idempotent — safe to re-run):

   ```bash
   # Deployer SA can submit builds in prod:
   gcloud projects add-iam-policy-binding karoscmo \
     --member="serviceAccount:github-actions-deployer@karoscmo-prep.iam.gserviceaccount.com" \
     --role="roles/cloudbuild.builds.editor"

   # Prod's own Cloud Build SA can pull from prep's Artifact Registry (needed by
   # cloudbuild.promote.yaml's pull-from-prep step) — requires prep's AR repo to
   # already exist, i.e. after billing is linked and deploy/bootstrap-prep-gcp.sh
   # (or its Artifact Registry step) has actually run:
   PROD_PROJECT_NUMBER=$(gcloud projects describe karoscmo --format='value(projectNumber)')
   gcloud artifacts repositories add-iam-policy-binding karos-cmo \
     --project=karoscmo-prep --location=us-central1 \
     --member="serviceAccount:${PROD_PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
     --role="roles/artifactregistry.reader"
   ```

   The standard bindings on production's own Cloud Build service account
   (`roles/run.admin`, `roles/iam.serviceAccountUser`, `roles/secretmanager.secretAccessor` —
   the original cloudbuild.yaml header's steps 3–4) should already exist from whenever
   production was first set up; nothing new needed there.

3. From this point, `main` never auto-touches production. The only way production changes is
   someone running **Promote to Production** with a commit SHA that's already live in prep.

## Day to day

1. Push to `main` → `quality` job runs (lint/type-check/test) → on success, `deploy-prep.yml`
   builds and deploys to the prep Cloud Run service. Nothing reaches production.
2. Poke around at `PREP_APP_URL`, confirm the change looks right.
3. GitHub → Actions → **Promote to Production** → Run workflow → enter the commit SHA you
   just verified in prep → it copies that exact image into production's registry and
   deploys it. No rebuild, no drift between what you tested and what ships.

### Rollback

Re-run **Promote to Production** with an earlier commit SHA that's still tagged in prep's
Artifact Registry — Cloud Run keeps prior revisions too, so `gcloud run services
update-traffic karos-cmo --project=$PROD_PROJECT_ID --to-revisions=<prev-revision>=100` also
works for an instant rollback without going through the pipeline at all.
