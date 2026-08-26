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
 * The credential chain is `gcs-media.ts`'s exactly (FIREBASE_SERVICE_ACCOUNT_KEY
 * → split FIREBASE_* vars → ADC), because the same service account this portal
 * already runs as is the one that gets the IAM grant on the workspace bucket —
 * one principal to grant, not two.
 *
 * Unconfigured (`AGENT_ENGINE_WORKSPACE_BUCKET` unset) is a real, supported
 * state: every caller checks `isWorkspaceWriterConfigured()` and skips, so a
 * deployment that has not been granted bucket access loses only the knowledge
 * sync, never a request.
 */

let storage: Storage | undefined;

function getStorageClient(): Storage {
  if (storage) return storage;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) {
    const credentials = JSON.parse(raw);
    storage = new Storage({ credentials, projectId: credentials.project_id });
    return storage;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    storage = new Storage({ credentials: { client_email: clientEmail, private_key: privateKey }, projectId });
    return storage;
  }
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
