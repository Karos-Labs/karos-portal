# GCS bucket setup — bulk media upload pipeline

One-time infrastructure for the "Bulk Upload Assets" dropzone
(`src/components/bulk-upload-clips.tsx`), the `/api/assets/bulk-upload` route,
and `scripts/upload-local-clips.ts`. This bucket is separate from Firebase
Storage (`NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`), which only holds small
logos/avatars/resumes — large pre-generated video (podcast clips, etc.) lives
here instead, partitioned per client:

```
gs://<GCS_MEDIA_BUCKET>/clients/<clientId>/podcast-clips/<timestamp>-<filename>
```

Replace `<PROJECT_ID>`, `<BUCKET_NAME>`, and `<APP_ORIGIN>` (e.g.
`https://app.karoslabs.com` and/or `http://localhost:3000` for local dev)
below before running.

## 1. Create the bucket

```sh
gcloud config set project <PROJECT_ID>

gcloud storage buckets create gs://<BUCKET_NAME> \
  --location=us-central1 \
  --uniform-bucket-level-access \
  --default-storage-class=STANDARD
```

## 2. CORS — required for the browser's direct signed-URL PUT

The staff dropzone uploads bytes straight from the browser to GCS via a
signed URL; without CORS the browser blocks the cross-origin `PUT`.

```sh
cat > /tmp/gcs-media-cors.json <<'EOF'
[
  {
    "origin": ["<APP_ORIGIN>", "http://localhost:3000"],
    "method": ["PUT", "GET"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
EOF

gcloud storage buckets update gs://<BUCKET_NAME> --cors-file=/tmp/gcs-media-cors.json
```

## 3. IAM — the Cloud Run runtime service account needs bucket access

**Post-SCRUM-373:** `src/lib/gcs-media.ts` builds its Storage client from
Application Default Credentials ONLY. It no longer reads
`FIREBASE_SERVICE_ACCOUNT_KEY` or the discrete `FIREBASE_*` vars — granting
those has no effect on this bucket. Grant the environment's actual Cloud Run
runtime service account (`_RUNTIME_SERVICE_ACCOUNT` in cloudbuild.yaml /
cloudbuild.promote.yaml) object read/write, scoped to this bucket:

```sh
gcloud storage buckets add-iam-policy-binding gs://<BUCKET_NAME> \
  --member="serviceAccount:<RUNTIME_SERVICE_ACCOUNT_EMAIL>" \
  --role="roles/storage.objectAdmin"
```

Because ADC on Cloud Run has no local private key, V4 signed URLs are minted
via the IAM `signBlob` API instead (google-auth-library's `GoogleAuth.sign()`
falls through to it whenever the resolved client isn't holding a JWT key —
see `node_modules/google-auth-library/build/src/auth/googleauth.js`). That
call is authenticated as the runtime SA itself, so the SA needs permission to
sign as itself:

```sh
gcloud iam service-accounts add-iam-policy-binding <RUNTIME_SERVICE_ACCOUNT_EMAIL> \
  --member="serviceAccount:<RUNTIME_SERVICE_ACCOUNT_EMAIL>" \
  --role="roles/iam.serviceAccountTokenCreator"
```

Locally (no `_RUNTIME_SERVICE_ACCOUNT` / no Cloud Run), `gcloud auth
application-default login` covers ADC, and `scripts/upload-local-clips.ts`
still uses whatever credential `FIREBASE_SERVICE_ACCOUNT_KEY` or your gcloud
login provides — that script is unaffected by this ticket.

## 4. Env vars

Set in `.env.local` (dev) and the Cloud Run service's env/secrets (prod) —
see `.env.example`:

```
GCS_MEDIA_BUCKET=<BUCKET_NAME>
```

No other new vars for `gcs-media.ts` itself — it authenticates via ADC (the
Cloud Run runtime service account in prod/prep, or your local `gcloud auth
application-default login`), not via `FIREBASE_SERVICE_ACCOUNT_KEY`. That var
is still required elsewhere for Firebase Admin (Firestore/Auth) and for the
`scripts/upload-local-clips.ts` CLI path below — it just no longer does
anything for this module.

## 5. Local CLI use (`scripts/upload-local-clips.ts`)

Uploads directly via the service account (no signed URL needed — the script
already holds full credentials), so only step 1, 3, and 4 above are required
for CLI-only use; CORS (step 2) is only needed for the browser dropzone.
