import { mkdir } from "node:fs/promises";
import path from "node:path";
import { snapshotOutputs } from "./artifacts.js";
import type { CheckpointManifest } from "./callback.js";
import { formatError } from "./error-format.js";

/** The slice of ServiceCallback this module needs — narrowed for testability. */
export interface CheckpointCallback {
  uploadCheckpointFile(params: { absPath: string; relPath: string; attempt: number }): Promise<void>;
  fetchCheckpointManifest(): Promise<CheckpointManifest>;
  downloadCheckpointFile(relPath: string, destAbsPath: string): Promise<void>;
}

/**
 * Saves the full current state of the output tree so a retried job can
 * resume instead of redoing finished work. Called only for a transiently-
 * failed attempt that might get a retry (see queue/worker.ts) — a
 * deterministic failure or a successful run has no use for it.
 */
export async function saveCheckpoint(
  callback: CheckpointCallback,
  repoDir: string,
  clientSlug: string,
  attempt: number,
): Promise<void> {
  const snapshot = await snapshotOutputs(repoDir, clientSlug);
  for (const relPath of snapshot.files.keys()) {
    try {
      await callback.uploadCheckpointFile({ absPath: path.join(repoDir, relPath), relPath, attempt });
    } catch (err) {
      // Best-effort: a partial checkpoint (some files saved) is still worth
      // more on the next attempt than none, so one file's failure must not
      // abort the rest.
      console.warn(`checkpoint upload failed for ${relPath}:`, formatError(err));
    }
  }
}

/**
 * Restores a prior attempt's checkpoint (if any) into the freshly prepared
 * workspace, before the skill runs. Returns the number of files restored —
 * callers use this to decide whether to tell the agent it's resuming.
 */
export async function restoreCheckpoint(callback: CheckpointCallback, repoDir: string): Promise<number> {
  const manifest = await callback.fetchCheckpointManifest();
  for (const file of manifest.files) {
    const dest = path.join(repoDir, file.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await callback.downloadCheckpointFile(file.path, dest);
  }
  return manifest.files.length;
}
