import { Storage } from "@google-cloud/storage";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ArtifactStore, StoredArtifact } from "./artifact-store.js";

const SIGNED_URL_TTL_MS = 7 * 24 * 3600 * 1000;
const COMPOSE_BATCH = 32;

/**
 * GCS-backed store. Transcript chunks are written as individual objects
 * (GCS has no append) and composed into one file at finalize — chunks and
 * finalize can run in different processes (API appends, worker finalizes).
 * Artifact URLs are V4 signed links.
 */
export class GcsArtifactStore implements ArtifactStore {
  private readonly storage = new Storage();
  private chunkSeq = 0;

  constructor(
    private readonly bucketName: string,
    _spoolDir: string,
  ) {}

  private objectPath(jobId: string, relPath: string): string {
    return `artifacts/${jobId}/${relPath}`;
  }

  async put(
    jobId: string,
    relPath: string,
    data: Readable | Buffer,
    contentType: string | undefined,
  ): Promise<StoredArtifact> {
    const object = this.storage.bucket(this.bucketName).file(this.objectPath(jobId, relPath));
    const writeStream = object.createWriteStream(
      contentType ? { resumable: false, metadata: { contentType } } : { resumable: false },
    );
    await pipeline(Buffer.isBuffer(data) ? Readable.from(data) : data, writeStream);
    const [url] = await object.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + SIGNED_URL_TTL_MS,
    });
    return { url, storagePath: relPath };
  }

  async deleteCheckpoint(jobId: string): Promise<void> {
    await this.storage
      .bucket(this.bucketName)
      .deleteFiles({ prefix: this.objectPath(jobId, "_checkpoint/") })
      .catch(() => undefined);
  }

  async appendTranscript(jobId: string, ndjsonChunk: string): Promise<void> {
    // Zero-padded millis + per-process counter: lexicographic order ≈ arrival order.
    const seq = `${String(Date.now()).padStart(15, "0")}-${String(this.chunkSeq++).padStart(6, "0")}`;
    const chunk = this.storage.bucket(this.bucketName).file(`transcripts/${jobId}/chunks/${seq}.jsonl`);
    await chunk.save(ndjsonChunk.endsWith("\n") ? ndjsonChunk : `${ndjsonChunk}\n`, {
      resumable: false,
      contentType: "application/x-ndjson",
    });
  }

  async finalizeTranscript(jobId: string): Promise<string | undefined> {
    const bucket = this.storage.bucket(this.bucketName);
    const [chunks] = await bucket.getFiles({ prefix: `transcripts/${jobId}/chunks/` });
    if (chunks.length === 0) return undefined;
    chunks.sort((a, b) => a.name.localeCompare(b.name));

    const final = bucket.file(`transcripts/${jobId}.jsonl`);
    // Iterative compose: fold up to 32 sources at a time into the target.
    let composed = 0;
    while (composed < chunks.length) {
      const batch = chunks.slice(composed, composed + (composed === 0 ? COMPOSE_BATCH : COMPOSE_BATCH - 1));
      const sources = composed === 0 ? batch : [final, ...batch];
      await bucket.combine(sources, final);
      composed += batch.length;
    }
    await Promise.allSettled(chunks.map((c) => c.delete()));

    const [url] = await final.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + SIGNED_URL_TTL_MS,
    });
    return url;
  }
}
