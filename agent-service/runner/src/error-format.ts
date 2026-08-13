/**
 * undici's "fetch failed" TypeError wraps the actual reason (ECONNREFUSED,
 * ENOTFOUND, a TLS failure, a proxy-tunnel rejection, ...) on `err.cause` —
 * every runner log site so far has logged only `err.message`/`err.stack`,
 * which never includes it, leaving nothing but the generic "fetch failed"
 * behind for every network failure regardless of its real cause.
 */
export function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.stack ?? err.message];
  let cause = (err as Error & { cause?: unknown }).cause;
  let depth = 0;
  while (cause !== undefined && depth < 5) {
    if (cause instanceof Error) {
      parts.push(`caused by: ${cause.stack ?? cause.message}`);
      cause = (cause as Error & { cause?: unknown }).cause;
    } else {
      parts.push(`caused by: ${JSON.stringify(cause)}`);
      break;
    }
    depth++;
  }
  return parts.join("\n");
}
