import type { JobSpec } from "../../src/types.js";
import type { JobSpecRef } from "../../src/exec/executor.js";
import { fetchIdToken } from "../../src/gcp-identity.js";
import { internalApiDispatcher } from "./callback.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves a JOB_SPEC_REF_B64 pointer (jobId + callback URL + runner token
 * only — see exec/executor.ts's buildSpecEnv) into the full JobSpec by
 * calling the service's own GET /internal/jobs/:id/spec, the same
 * runner-token-authed channel used for every other runner→api call.
 *
 * Retried with backoff like ServiceCallback.complete(): this runs BEFORE
 * ServiceCallback even exists (there's no spec yet to build it from), so a
 * transient network hiccup here has no second chance from anywhere else —
 * unlike complete()'s failure mode, an unhandled failure here means the
 * container never even reaches the code that would eventually report back,
 * landing the job in worker.ts's silent "job container exited without
 * reporting" dead-letter fallback instead of a real error. A 4xx (bad token,
 * bad job id) won't be fixed by retrying; everything else is.
 */
export async function fetchJobSpec(ref: JobSpecRef): Promise<JobSpec> {
  const backoffMs = [1_000, 2_000, 4_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    try {
      const headers: Record<string, string> = { "x-runner-token": ref.runnerToken };
      const iamAudience = process.env.RUNNER_IAM_AUDIENCE;
      if (iamAudience) {
        const idToken = await fetchIdToken(iamAudience);
        if (idToken) headers.authorization = `Bearer ${idToken}`;
      }
      const res = await fetch(`${ref.callbackBaseUrl}/internal/jobs/${ref.jobId}/spec`, {
        headers,
        signal: AbortSignal.timeout(30_000),
        dispatcher: internalApiDispatcher,
      });
      if (res.ok) return (await res.json()) as JobSpec;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`failed to fetch job spec (${res.status})`);
      }
      lastErr = new Error(`failed to fetch job spec (${res.status})`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < backoffMs.length) await sleep(backoffMs[attempt]!);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
