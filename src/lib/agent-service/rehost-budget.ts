/**
 * Wall-clock budgets for the agent-service webhook's artifact re-host phase
 * (`src/app/api/agent-service/webhook/route.ts`).
 *
 * They live here rather than in the route because a `route.ts` may only export
 * the handler and Next's own segment-config fields — anything else fails the
 * generated route type check — and the re-host deadline has to be readable by
 * the test that proves the phase honours it.
 */

/**
 * Per-artifact network CEILINGS. Neither bounds the phase on its own: the route
 * bounds each call by min(its ceiling, what is LEFT of REHOST_DEADLINE_MS). A
 * fixed per-artifact constant would not bound the phase, because an artifact
 * that starts just under the deadline would still run its full fetch + upload
 * past it.
 */
export const ARTIFACT_FETCH_TIMEOUT_MS = 60_000;
export const ARTIFACT_UPLOAD_TIMEOUT_MS = 30_000;

/**
 * Deadline for the webhook's whole pre-claim stretch, measured from the top of
 * the handler — so the signature check, the payload parse, the job lookup, the
 * failure refund and the template lookup all spend from it before the re-host
 * does. Deliberately conservative: the re-host is the only part long enough to
 * matter, and charging it for the rest can only end the phase earlier.
 *
 * A kill during re-host is harmless (nothing is claimed, so the delivery is
 * retried); what is not harmless is claiming with no budget left and dying
 * during the writes that follow. The sum of the two ceilings is the floor that
 * still lets the slowest single artifact finish, and it leaves the rest of the
 * handler's `maxDuration` (declared in the route) for the claim plus those writes.
 *
 * SCOPE — what this actually bounds, given the route re-measures the remainder
 * immediately before each network call:
 *   - the artifact fetch, and the body read with it (an aborted fetch errors the
 *     body stream, so both live inside the fetch's own signal);
 *   - the upload request.
 * NOT the credential fetch inside `uploadBytes` — it is awaited before that
 * signal exists (`src/lib/storage.ts` says so), so a hang there escapes this.
 */
export const REHOST_DEADLINE_MS = ARTIFACT_FETCH_TIMEOUT_MS + ARTIFACT_UPLOAD_TIMEOUT_MS;
