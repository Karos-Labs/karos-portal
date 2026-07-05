import type { Readable } from "node:stream";

export interface StoredArtifact {
  /** URL the platform can fetch the artifact from */
  url: string;
  storagePath: string;
}

export interface ArtifactStore {
  /** Persist one artifact file for a job; relPath is workspace-relative. */
  put(
    jobId: string,
    relPath: string,
    data: Readable | Buffer,
    contentType: string | undefined,
  ): Promise<StoredArtifact>;
  /** Append raw NDJSON transcript lines (called repeatedly during a run). */
  appendTranscript(jobId: string, ndjsonChunk: string): Promise<void>;
  /** Seal the transcript and return a fetchable URL (or undefined if empty). */
  finalizeTranscript(jobId: string): Promise<string | undefined>;
  /** Open a stored artifact for serving (local store); GCS returns signed URLs instead. */
  open?(jobId: string, storagePath: string): Promise<Readable>;
}
