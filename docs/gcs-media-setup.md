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

## 3. IAM — the app's existing Firebase service account needs bucket access

The portal signs upload/read URLs with the SAME service account already
configured for Firebase Admin (`FIREBASE_SERVICE_ACCOUNT_KEY` or the discrete
`FIREBASE_PROJECT_ID`/`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` vars) —
no new key to manage. Grant it object read/write on the new bucket:

```sh
gcloud storage buckets add-iam-policy-binding gs://<BUCKET_NAME> \
  --member="serviceAccount:<FIREBASE_CLIENT_EMAIL>" \
  --role="roles/storage.objectAdmin"
```

If the app runs on Cloud Run/GCE with **Application Default Credentials**
(no private key at all — see `src/lib/gcs-media.ts`'s ADC fallback), signed
URLs are minted via the IAM `signBlob` API instead of a local private key.
That requires the runtime service account to be able to sign as itself:

```sh
gcloud iam service-accounts add-iam-policy-binding <RUNTIME_SERVICE_ACCOUNT_EMAIL> \
  --member="serviceAccount:<RUNTIME_SERVICE_ACCOUNT_EMAIL>" \
  --role="roles/iam.serviceAccountTokenCreator"
```

## 4. Env vars

Set in `.env.local` (dev) and the Cloud Run service's env/secrets (prod) —
see `.env.example`:

```
GCS_MEDIA_BUCKET=<BUCKET_NAME>
```

No other new vars — signing reuses the existing `FIREBASE_SERVICE_ACCOUNT_KEY`
(or discrete `FIREBASE_*` vars) already required for Firebase Admin.

## 5. Local CLI use (`scripts/upload-local-clips.ts`)

Uploads directly via the service account (no signed URL needed — the script
already holds full credentials), so only step 1, 3, and 4 above are required
for CLI-only use; CORS (step 2) is only needed for the browser dropzone.
