import type { ArtifactStore } from "../storage/artifact-store.js";
import type { JobsStore } from "../state/jobs-store.js";
import type { JobRecord } from "../types.js";
import { enqueueWebhook, type WebhooksQueue } from "../queue/webhooks.js";

/**
 * Terminal-state bookkeeping shared by the worker and the API's
 * cancel-while-queued path: seal the transcript (if any) and queue the
 * signed webhook for durable delivery.
 */
export async function finalizeJob(
  deps: { store: JobsStore; artifactStore: ArtifactStore; webhooksQueue: WebhooksQueue },
  record: JobRecord,
): Promise<void> {
  const transcriptUrl = await deps.artifactStore.finalizeTranscript(record.id).catch(() => undefined);
  if (transcriptUrl) {
    await deps.store.update(record.id, (r) => ({ ...r, transcriptUrl }));
  }
  // The job is terminal — no further attempt will ever restore this
  // checkpoint, so there's nothing left for it to do but take up storage.
  if (record.checkpoint) {
    await deps.artifactStore.deleteCheckpoint(record.id).catch(() => undefined);
    await deps.store.update(record.id, (r) => {
      const { checkpoint: _checkpoint, ...rest } = r;
      return rest as JobRecord;
    });
  }
  await enqueueWebhook(deps.webhooksQueue, record.id);
}
