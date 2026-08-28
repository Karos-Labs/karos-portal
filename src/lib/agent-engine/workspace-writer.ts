import "server-only";

import { Storage } from "@google-cloud/storage";

/**
 * Write access to the AGENT-ENGINE workspace bucket — the GCS layout the
 * engine's own tools read (`clients/<slug>/{client,strategy,intel,ledger,
 * memory,topics,knowledge}/...`). Deliberately a THIRD storage seam, not a
 * reuse of the other two: `storage.ts` writes to the Firebase bucket
 * (logos/avatars) and `gcs-media.ts` to the media bucket (client video), and
 * pointing either of them at the engine's workspace would make "which bucket
 * does this write land in" a function of call-site history instead of module
 * identity.
 *
 * The credential chain mirrors `gcs-media.ts`'s POST-SCRUM-373 client: Application
 * Default Credentials only. The same runtime service account this portal already
 * runs as is the one that gets the IAM grant on the workspace bucket — one
 * principal to grant, not two.
 *
 * Before SCRUM-373 this deliberately copied gcs-media.ts's OLD chain
 * (FIREBASE_SERVICE_ACCOUNT_KEY → split FIREBASE_* vars → ADC) on the same
 * reasoning — "one principal to grant". That reasoning was broken: it meant
 * this write path, same as gcs-media.ts, actually authenticated as
 * `firebase-adminsdk-fbsvc@karoscmo` (present in both environments) whenever
 * that key was set, never as the runtime SA a bucket grant targets. This is a
 * THIRD storage seam and was not touched by gcs-media.ts's fix on its own —
 * fixing only gcs-media.ts while this file still branched on
 * FIREBASE_SERVICE_ACCOUNT_KEY would have left `firebase-adminsdk-fbsvc@` live
 * for storage in prep via this path (it is called from
 * agent-engine/knowledge-sync.ts and the reconcile route, and
 * .github/workflows/deploy-prep.yml sets AGENT_ENGINE_WORKSPACE_BUCKET to a
 * real bucket by default), contradicting the "no longer used for storage in
 * either environment" acceptance bar. Signing is not a concern here — this
 * module never calls `getSignedUrl`, only `.save()` — so ADC alone is
 * sufficient with no signBlob/serviceAccountTokenCreator grant needed.
 *
 * Unconfigured (`AGENT_ENGINE_WORKSPACE_BUCKET` unset) is a real, supported
 * state: every caller checks `isWorkspaceWriterConfigured()` and skips, so a
 * deployment that has not been granted bucket access loses only the knowledge
 * sync, never a request.
 */

let storage: Storage | undefined;

function getStorageClient(): Storage {
  if (storage) return storage;
  // Application Default Credentials ONLY — see the module header (SCRUM-373).
  storage = new Storage();
  return storage;
}

export function isWorkspaceWriterConfigured(): boolean {
  return Boolean(process.env.AGENT_ENGINE_WORKSPACE_BUCKET);
}

/**
 * Write one JSON document into the engine workspace, overwriting what is
 * there — the sync is a full-replacement mirror, never an append, so a doc
 * deleted on this side disappears on the next tick rather than lingering.
 */
export async function writeWorkspaceJson(objectPath: string, value: unknown): Promise<void> {
  const bucketName = process.env.AGENT_ENGINE_WORKSPACE_BUCKET;
  if (!bucketName) throw new Error("AGENT_ENGINE_WORKSPACE_BUCKET is not set");
  const bucket = getStorageClient().bucket(bucketName);
  await bucket.file(objectPath).save(JSON.stringify(value, null, 2), {
    contentType: "application/json",
    resumable: false,
  });
}
