import "server-only";

/**
 * The ONE place this portal mints a Google-signed ID token for an
 * IAM-protected Cloud Run service.
 *
 * WHY IT EXISTS (SCRUM-330 / AU47). That ticket said `iamIdToken()` fails
 * open: on any metadata-server error it returned `undefined`, the request went
 * out with no `Authorization` header, and - because the callee does not check
 * the header yet - a portal that had never minted a token would look perfectly
 * healthy. The fix landed on `agent-engine/client.ts`.
 *
 * IT LANDED ON ONE OF THREE. There were three copies of this function, and the
 * fixed one's own docstring names one of the other two as the pattern it
 * copied: "mirroring src/lib/agent-service/client.ts's own IAM-ID-token
 * pattern exactly". So `agent-service/client.ts` and
 * `agent-engine/middleware-http.ts` both still returned `undefined` on a
 * failed mint, and no test held the rule across them. Fixing them separately
 * would have written the same fail-closed logic a second and third time, which
 * is how there came to be three copies in the first place.
 *
 * FAILING CLOSED IS THE WHOLE POINT. A missing credential must be a different
 * thing from a credential that is legitimately not required:
 *
 *   - audience unset  -> `undefined`, and the request goes out unauthenticated
 *     ON PURPOSE. That is local development, where there is no IAM in front and
 *     no token to mint.
 *   - audience set, mint failed -> THROW. The caller decides what that means
 *     for its own path; what it may not do is send the request anyway.
 *
 * THE ERROR IS THE CALLER'S. Each service already has (or now has) its own
 * error type, matched by name in places like `intel/agent-onboarding.ts`, so
 * this takes a factory rather than owning a type of its own. It also keeps the
 * client-facing message the caller's business: agent-service surfaces
 * `e.message` straight to a CLIENT_USER, so its reason string must not be the
 * one written for a log line.
 */

const METADATA_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/** How long before expiry a cached token is considered stale. Google mints these with a 1h life. */
const CACHE_TTL_MS = 55 * 60 * 1000;
const CACHE_SKEW_MS = 60_000;
/** The metadata server is on-host; anything slower than this is a fault, not latency. */
const MINT_TIMEOUT_MS = 5000;

/**
 * Keyed by AUDIENCE rather than one slot per module, which is also what makes
 * one cache correct for three callers: the three mint against three different
 * audiences and a shared single-slot cache would have thrashed between them.
 */
const cache = new Map<string, { token: string; expiresAt: number }>();

/** Test seam: module-level state would otherwise leak between cases. */
export function resetIdTokenCacheForTests(): void {
  cache.clear();
}

export interface MintIdTokenOptions {
  /**
   * The protected service's own URL. Unset (or empty) means there is no IAM in
   * front of it, so there is nothing to mint - see the header note.
   */
  audience: string | undefined;
  /** Names the service in the server-side log line. */
  service: string;
  /**
   * Builds the error thrown when a token was required and could not be minted.
   * `reason` is short and describes the metadata-server outcome; a caller whose
   * message reaches a client should NOT interpolate it.
   */
  credentialError: (reason: string) => Error;
}

/**
 * A token for `audience`, or `undefined` when none is required.
 *
 * Throws `credentialError(reason)` for every other outcome.
 */
export async function mintIdToken({
  audience,
  service,
  credentialError,
}: MintIdTokenOptions): Promise<string | undefined> {
  if (!audience) return undefined;

  const now = Date.now();
  const hit = cache.get(audience);
  if (hit && hit.expiresAt > now + CACHE_SKEW_MS) return hit.token;

  const fail = (reason: string): never => {
    // The reason is logged HERE, once, for every caller - so a caller whose own
    // message has to stay client-safe still leaves an operator something to
    // read. This is the line to grep for when answering the question the
    // ticket asks: is this happening in prod right now.
    console.error(`[gcp-id-token] ${service}: could not mint an ID token: ${reason}`);
    throw credentialError(reason);
  };

  let res: Response;
  try {
    res = await fetch(`${METADATA_URL}?audience=${encodeURIComponent(audience)}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
  } catch (e) {
    // Includes the AbortSignal timeout. Off a metadata-server-bearing host this
    // is simply always true, which is exactly when failing closed matters.
    return fail(`metadata server unreachable (${e instanceof Error ? e.message : String(e)})`);
  }

  if (!res.ok) return fail(`metadata server returned ${res.status}`);
  const token = (await res.text().catch(() => "")).trim();
  if (!token) return fail("metadata server returned an empty token");

  cache.set(audience, { token, expiresAt: now + CACHE_TTL_MS });
  return token;
}
