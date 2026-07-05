import { Storage } from "@google-cloud/storage";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ArtifactStore, StoredArtifact } from "./artifact-store.js";

const SIGNED_URL_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * GCS-backed store. Transcripts spool to local disk during the run (GCS has
 * no append) and upload on finalize; artifact URLs are V4 signed links.
 */
export class GcsArtifactStore implements ArtifactStore {
  private readonly storage = new Storage();

  constructor(
    private readonly bucketName: string,
    private readonly spoolDir: string,
  ) {}

  private objectPath(jobId: string, relPath: string): string {
    return `artifacts/${jobId}/${relPath}`;
  }

  private transcriptSpoolPath(jobId: string): string {
    return path.join(this.spoolDir, "transcripts", `${jobId}.jsonl`);
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

  async appendTranscript(jobId: string, ndjsonChunk: string): Promise<void> {
    const spool = this.transcriptSpoolPath(jobId);
    await mkdir(path.dirname(spool), { recursive: true });
    await appendFile(spool, ndjsonChunk.endsWith("\n") ? ndjsonChunk : `${ndjsonChunk}\n`);
  }

  async finalizeTranscript(jobId: string): Promise<string | undefined> {
    const spool = this.transcriptSpoolPath(jobId);
    try {
      await stat(spool);
    } catch {
      return undefined;
    }
    const object = this.storage.bucket(this.bucketName).file(`transcripts/${jobId}.jsonl`);
    await pipeline(
      createReadStream(spool),
      object.createWriteStream({ resumable: false, metadata: { contentType: "application/x-ndjson" } }),
    );
    const [url] = await object.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + SIGNED_URL_TTL_MS,
    });
    return url;
  }
}
