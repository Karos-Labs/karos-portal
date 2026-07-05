import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JobSpec, JobUsage, RunnerCompleteBody } from "../../src/types.js";

/**
 * HTTP client for the service's /internal endpoints. Authenticated with the
 * single-purpose per-job runner token — the only credential in the sandbox.
 */
export class ServiceCallback {
  constructor(private readonly spec: JobSpec) {}

  private url(suffix: string): string {
    return `${this.spec.callbackBaseUrl}/internal/jobs/${this.spec.jobId}/${suffix}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { "x-runner-token": this.spec.runnerToken, ...extra };
  }

  async appendTranscript(lines: string): Promise<void> {
    await fetch(this.url("transcript"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ lines }),
      signal: AbortSignal.timeout(30_000),
    });
  }

  async uploadArtifact(params: {
    absPath: string;
    relPath: string;
    clientFacing: boolean;
    contentType?: string;
  }): Promise<void> {
    const data = await readFile(params.absPath);
    const form = new FormData();
    form.set("path", params.relPath);
    form.set("client_facing", String(params.clientFacing));
    if (params.contentType) form.set("content_type", params.contentType);
    form.set(
      "file",
      new Blob([new Uint8Array(data)], { type: params.contentType ?? "application/octet-stream" }),
      path.basename(params.relPath),
    );
    const response = await fetch(this.url("artifacts"), {
      method: "POST",
      headers: this.headers(),
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`artifact upload failed (${response.status}) for ${params.relPath}`);
    }
  }

  async complete(body: RunnerCompleteBody): Promise<void> {
    await fetch(this.url("complete"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }
}

export type { JobUsage };
