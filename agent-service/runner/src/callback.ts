import { readFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { Agent } from "undici";
import type { JobSpec, JobUsage, RunnerCompleteBody } from "../../src/types.js";
import { fetchIdToken } from "../../src/gcp-identity.js";

export interface CheckpointManifest {
  attempt?: number;
  files: Array<{ path: string; bytes: number }>;
}

/**
 * These calls are few and far between over a job's lifetime — a step ping
 * here, a completion report 20+ minutes later — long enough for Cloud Run's
 * load balancer to silently close an idle backend connection that undici's
 * default pool still considers reusable. Reusing a connection the far end
 * already closed fails instantly as a generic, cause-swallowing "TypeError:
 * fetch failed" (confirmed live: a fresh execution's first call succeeds
 * every time; a call minutes into a run does not) — which is exactly what
 * worker.ts's dead-lettered "job container exited without reporting"
 * fallback traces back to, since main.ts only logs err.stack, not err.cause.
 * A dedicated dispatcher with keep-alive effectively disabled costs one
 * extra TLS handshake per call — free, given how infrequent these are.
 */
// Typed `any`: Node's global fetch() types its `dispatcher` option against the
// `undici-types` copy vendored into @types/node, a structurally-identical but
// nominally distinct package from this standalone `undici` dependency — a
// real Agent instance works fine at runtime (fetch duck-types the dispatcher
// interface) but TypeScript sees two different `Dispatcher` types.
export const internalApiDispatcher: any = new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });

/**
 * HTTP client for the service's /internal endpoints. App-level auth is the
 * single-purpose per-job runner token (the only credential in the sandbox).
 * When RUNNER_IAM_AUDIENCE is set (Cloud Run), it also attaches a Google ID
 * token so the request clears the api's IAM edge — "IAM + bearer".
 */
export class ServiceCallback {
  private readonly iamAudience = process.env.RUNNER_IAM_AUDIENCE;

  constructor(private readonly spec: JobSpec) {}

  private url(suffix: string): string {
    return `${this.spec.callbackBaseUrl}/internal/jobs/${this.spec.jobId}/${suffix}`;
  }

  private async headers(extra?: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = { "x-runner-token": this.spec.runnerToken, ...extra };
    if (this.iamAudience) {
      const idToken = await fetchIdToken(this.iamAudience);
      if (idToken) headers.authorization = `Bearer ${idToken}`;
    }
    return headers;
  }

  async appendTranscript(lines: string): Promise<void> {
    await fetch(this.url("transcript"), {
      method: "POST",
      headers: await this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ lines }),
      signal: AbortSignal.timeout(30_000),
      dispatcher: internalApiDispatcher,
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
      headers: await this.headers(),
      body: form,
      signal: AbortSignal.timeout(120_000),
      dispatcher: internalApiDispatcher,
    });
    if (!response.ok) {
      throw new Error(`artifact upload failed (${response.status}) for ${params.relPath}`);
    }
  }

  async uploadCheckpointFile(params: { absPath: string; relPath: string; attempt: number }): Promise<void> {
    const data = await readFile(params.absPath);
    const form = new FormData();
    form.set("path", params.relPath);
    form.set("attempt", String(params.attempt));
    form.set("file", new Blob([new Uint8Array(data)]), path.basename(params.relPath));
    const response = await fetch(this.url("checkpoint"), {
      method: "POST",
      headers: await this.headers(),
      body: form,
      signal: AbortSignal.timeout(120_000),
      dispatcher: internalApiDispatcher,
    });
    if (!response.ok) {
      throw new Error(`checkpoint upload failed (${response.status}) for ${params.relPath}`);
    }
  }

  /**
   * Dynamic Agent Studio only: a best-effort live-progress ping. Unlike
   * `complete()`, there is no retry — a dropped ping just means the Portal's
   * step indicator is one beat stale until the next ping or the job's own
   * completion callback, which is an acceptable loss for a cosmetic
   * indicator and not worth the complexity of a durable retry.
   */
  async reportStepProgress(event: {
    stepId: string;
    stepName?: string;
    status: "running" | "done" | "failed";
  }): Promise<void> {
    try {
      await fetch(this.url("step-progress"), {
        method: "POST",
        headers: await this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ step_id: event.stepId, step_name: event.stepName, status: event.status }),
        signal: AbortSignal.timeout(10_000),
        dispatcher: internalApiDispatcher,
      });
    } catch {
      // Best-effort — see doc comment above.
    }
  }

  async fetchCheckpointManifest(): Promise<CheckpointManifest> {
    const response = await fetch(this.url("checkpoint"), {
      method: "GET",
      headers: await this.headers(),
      signal: AbortSignal.timeout(30_000),
      dispatcher: internalApiDispatcher,
    });
    if (!response.ok) return { files: [] };
    return (await response.json()) as CheckpointManifest;
  }

  async downloadCheckpointFile(relPath: string, destAbsPath: string): Promise<void> {
    const response = await fetch(`${this.url("checkpoint/download")}?path=${encodeURIComponent(relPath)}`, {
      method: "GET",
      headers: await this.headers(),
      signal: AbortSignal.timeout(60_000),
      dispatcher: internalApiDispatcher,
    });
    if (!response.ok || !response.body) {
      throw new Error(`checkpoint download failed (${response.status}) for ${relPath}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      createWriteStream(destAbsPath),
    );
  }

  /**
   * The last thing every job does — report done/failed/cancelled back to the
   * service. Retried with backoff because there's no second chance: unlike
   * appendTranscript (loss is tolerable) or the checkpoint calls (a retry
   * attempt can re-upload), a `complete` that never lands leaves the job
   * stuck exactly as this fixes — the container exits, the service never
   * hears back, and the real outcome (including a real error message) is
   * lost behind worker.ts's generic "job container exited without reporting"
   * fallback. A 4xx is a bad request retries can't fix (bad token, bad job
   * id) — everything else (network failure, timeout, 5xx) is worth retrying.
   */
  async complete(body: RunnerCompleteBody): Promise<void> {
    const backoffMs = [1_000, 2_000, 4_000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetch(this.url("complete"), {
          method: "POST",
          headers: await this.headers({ "content-type": "application/json" }),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
          dispatcher: internalApiDispatcher,
        });
      } catch (err) {
        lastErr = err;
      }
      if (response) {
        if (response.ok) return;
        // A 4xx (other than 429) is a bad request retrying can't fix — bad
        // token, bad job id — so it throws immediately instead of joining
        // the retry loop below.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new Error(`complete callback rejected (${response.status})`);
        }
        lastErr = new Error(`complete callback failed (${response.status})`);
      }
      if (attempt < backoffMs.length) await sleep(backoffMs[attempt]!);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { JobUsage };
