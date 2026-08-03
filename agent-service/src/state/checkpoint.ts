import type { CheckpointFileEntry, JobCheckpoint } from "../types.js";

/**
 * Appends one uploaded file to a job's checkpoint. A checkpoint belongs to a
 * single attempt — the first file of a NEW attempt's save replaces whatever
 * an earlier (now-superseded) attempt saved, rather than merging with it.
 */
export function appendCheckpointFile(
  existing: JobCheckpoint | undefined,
  attempt: number,
  file: CheckpointFileEntry,
): JobCheckpoint {
  const stale = existing?.attempt !== attempt;
  const priorFiles = stale ? [] : existing?.files ?? [];
  const priorBytes = stale ? 0 : existing?.bytes ?? 0;
  return {
    attempt,
    files: [...priorFiles, file],
    bytes: priorBytes + file.bytes,
  };
}
