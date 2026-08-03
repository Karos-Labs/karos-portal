const TRANSIENT_PATTERN = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|50\d|overloaded|rate.?limit/i;

/** For a thrown exception (workspace prep, a network fetch, an SDK crash before any result message). */
export function isTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERN.test(message);
}

/**
 * A "result" message with an error subtype is NOT automatically worth
 * retrying — the whole job re-runs from scratch on a transient verdict (see
 * queue/worker.ts), so a permanent failure (bad credentials, exhausted
 * credit balance, a structured-output schema the model can never satisfy)
 * must not burn a second attempt reproducing the exact same outcome.
 * error_max_structured_output_retries is a validation loop, not a blip — a
 * retry sees the same schema and the same model, so it never self-heals.
 * error_during_execution is a grab bag; only its actual error text (the same
 * signal isTransientError uses for thrown exceptions) tells transient apart
 * from permanent.
 */
export function isTransientResultError(subtype: string, errors: string[] | undefined): boolean {
  if (subtype === "error_max_structured_output_retries") return false;
  return (errors ?? []).some((e) => TRANSIENT_PATTERN.test(e));
}
