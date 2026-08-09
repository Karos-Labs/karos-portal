import type { RunnerCompleteBody } from "../../src/types.js";
import type { ServiceCallback } from "./callback.js";

/**
 * callback.complete() already retries transient failures; this is the
 * backstop for when it still can't land (a sustained service outage). Without
 * it, that final rejection propagates out of main()'s try/finally as an
 * unhandled rejection and kills the container before the exit code even gets
 * set deliberately — the exact "job container exited without reporting" this
 * whole change exists to stop reproducing. There's nothing left to do here
 * but log for Cloud Logging and let the caller's process.exit run anyway.
 */
export async function reportComplete(callback: ServiceCallback, report: RunnerCompleteBody): Promise<void> {
  try {
    await callback.complete(report);
  } catch (err) {
    console.error(
      "failed to report completion to service after retries:",
      err instanceof Error ? err.message : err,
    );
  }
}
