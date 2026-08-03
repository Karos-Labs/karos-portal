import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, appendFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ArtifactStore, StoredArtifact } from "./artifact-store.js";

/**
 * Filesystem-backed store for local/dev. Artifacts are served back through
 * the service's authenticated GET /v1/jobs/:id/artifacts route.
 */
export class LocalArtifactStore implements ArtifactStore {
  constructor(
    private readonly baseDir: string,
    private readonly publicBaseUrl: string,
  ) {}

  private safeJoin(...segments: string[]): string {
    const joined = path.normalize(path.join(this.baseDir, ...segments));
    const base = path.resolve(this.baseDir);
    if (!path.resolve(joined).startsWith(base + path.sep)) {
      throw new Error(`Path escapes artifact store: ${segments.join("/")}`);
    }
    return joined;
  }

  private artifactDiskPath(jobId: string, relPath: string): string {
    return this.safeJoin("artifacts", jobId, relPath);
  }

  private transcriptDiskPath(jobId: string): string {
    return this.safeJoin("transcripts", `${jobId}.jsonl`);
  }

  async put(
    jobId: string,
    relPath: string,
    data: Readable | Buffer,
    _contentType: string | undefined,
  ): Promise<StoredArtifact> {
    const diskPath = this.artifactDiskPath(jobId, relPath);
    await mkdir(path.dirname(diskPath), { recursive: true });
    if (Buffer.isBuffer(data)) {
      await pipeline(Readable.from(data), createWriteStream(diskPath));
    } else {
      await pipeline(data, createWriteStream(diskPath));
    }
    return {
      url: `${this.publicBaseUrl}/v1/jobs/${jobId}/artifacts/${encodeURI(relPath)}`,
      storagePath: relPath,
    };
  }

  async deleteCheckpoint(jobId: string): Promise<void> {
    await rm(this.artifactDiskPath(jobId, "_checkpoint"), { recursive: true, force: true }).catch(() => undefined);
  }

  async appendTranscript(jobId: string, ndjsonChunk: string): Promise<void> {
    const diskPath = this.transcriptDiskPath(jobId);
    await mkdir(path.dirname(diskPath), { recursive: true });
    await appendFile(diskPath, ndjsonChunk.endsWith("\n") ? ndjsonChunk : `${ndjsonChunk}\n`);
  }

  async finalizeTranscript(jobId: string): Promise<string | undefined> {
    try {
      await stat(this.transcriptDiskPath(jobId));
    } catch {
      return undefined;
    }
    return `${this.publicBaseUrl}/v1/jobs/${jobId}/transcript`;
  }

  async open(jobId: string, storagePath: string): Promise<Readable> {
    return createReadStream(this.artifactDiskPath(jobId, storagePath));
  }

  async openTranscript(jobId: string): Promise<Readable> {
    return createReadStream(this.transcriptDiskPath(jobId));
  }
}
