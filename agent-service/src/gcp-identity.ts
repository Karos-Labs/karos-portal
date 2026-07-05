/**
 * Fetches a Google-signed OIDC ID token from the GCE/Cloud Run metadata server
 * for a given audience (the target Cloud Run service URL). Used to call an
 * IAM-protected ("--no-allow-unauthenticated") sibling service. Returns
 * undefined off-GCP (no metadata server) so local dev degrades cleanly.
 *
 * No dependency on google-auth-library — the metadata endpoint is always
 * present on Cloud Run and the token is a plain JWT string.
 */
const METADATA_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

interface CachedToken {
  audience: string;
  token: string;
  expiresAt: number;
}
let cache: CachedToken | null = null;

export async function fetchIdToken(audience: string): Promise<string | undefined> {
  const now = Date.now();
  if (cache && cache.audience === audience && cache.expiresAt > now + 60_000) {
    return cache.token;
  }
  try {
    const res = await fetch(`${METADATA_URL}?audience=${encodeURIComponent(audience)}&format=full`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const token = (await res.text()).trim();
    if (!token) return undefined;
    // ID tokens live ~1h; refresh a little early.
    cache = { audience, token, expiresAt: now + 55 * 60 * 1000 };
    return token;
  } catch {
    return undefined;
  }
}
