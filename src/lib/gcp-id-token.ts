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
 * How many times a TRANSPORT failure is retried before it is called a failure.
 *
 * The metadata server is on-host and normally answers in single-digit
 * milliseconds, so a 5s timeout is not "slow", it is a blip — a cold instance,
 * a momentarily wedged socket. On 2026-09-20 two such blips 13 seconds apart
 * (`the operation was aborted due to timeout`, the only two in 24 hours) ended
 * a Regenerate for a client whose two agents both went on to finish and land
 * `approved`. One attempt turned a blip into a run failure.
 *
 * Only the transport is retried. A metadata server that ANSWERS — 403, 404, an
 * empty body — has stated a fact about this deployment's identity, and asking
 * it three times will not change it.
 */
const MINT_ATTEMPTS = 3;
/** Between attempts. Short: a caller is waiting, and this is an on-host hop. */
const MINT_RETRY_DELAY_MS = 300;

/**
 * Marks a credential error whose cause was the transport, not the
 * configuration.
 *
 * A caller that must distinguish "this deployment cannot mint tokens" from
 * "the metadata server blinked" reads this rather than the message string.
 * `intel/agent-onboarding.ts` is the one that has to: its 70-minute poll loop
 * treats every other failure as weather and retries, and fast-failed here on
 * the reasoning that a credential failure is a misconfiguration — which is
 * true of every outcome except this one.
 */
export interface TransientCredentialFailure {
  transient?: boolean;
}

/** True when this error is a credential failure the caller may retry. */
export function isTransientCredentialError(e: unknown): boolean {
  return e instanceof Error && (e as Error & TransientCredentialFailure).transient === true;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

  const fail = (reason: string, transient = false): never => {
    // The reason is logged HERE, once, for every caller - so a caller whose own
    // message has to stay client-safe still leaves an operator something to
    // read. This is the line to grep for when answering the question the
    // ticket asks: is this happening in prod right now.
    console.error(`[gcp-id-token] ${service}: could not mint an ID token: ${reason}`);
    const error = credentialError(reason);
    if (transient) Object.assign(error, { transient: true } satisfies TransientCredentialFailure);
    throw error;
  };

  let lastTransport = "";
  for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${METADATA_URL}?audience=${encodeURIComponent(audience)}`, {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
    } catch (e) {
      // Includes the AbortSignal timeout. Off a metadata-server-bearing host
      // this is simply always true, which is exactly when failing closed
      // matters — but failing closed is about the REQUEST going out without a
      // token, not about giving up on the first blip.
      lastTransport = `metadata server unreachable (${e instanceof Error ? e.message : String(e)})`;
      if (attempt < MINT_ATTEMPTS) {
        await delay(MINT_RETRY_DELAY_MS);
        continue;
      }
      return fail(`${lastTransport} after ${MINT_ATTEMPTS} attempts`, true);
    }

    // 5xx is the server saying it is having a bad time, which is the same kind
    // of fact as a timeout. Every other status is an answer about identity.
    if (res.status >= 500) {
      lastTransport = `metadata server returned ${res.status}`;
      if (attempt < MINT_ATTEMPTS) {
        await delay(MINT_RETRY_DELAY_MS);
        continue;
      }
      return fail(`${lastTransport} after ${MINT_ATTEMPTS} attempts`, true);
    }

    if (!res.ok) return fail(`metadata server returned ${res.status}`);
    const token = (await res.text().catch(() => "")).trim();
    if (!token) return fail("metadata server returned an empty token");

    cache.set(audience, { token, expiresAt: Date.now() + CACHE_TTL_MS });
    return token;
  }

  // Unreachable: every path through the loop returns or throws.
  return fail(lastTransport || "metadata server unreachable", true);
}
