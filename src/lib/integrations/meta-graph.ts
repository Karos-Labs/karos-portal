/**
 * Meta Graph API — THE one place the API version is pinned.
 *
 * Every Facebook / Instagram call the portal makes (OAuth dialog + token
 * exchange in `oauth.ts`, publishing in `publishers.ts`, insights and
 * comments in `analytics-providers.ts`, the profile-name lookup in the OAuth
 * callback route) builds its URL through this module, so a version bump is a
 * one-line change here and `meta-graph.test.ts` fails the build if a literal
 * `graph.facebook.com/vNN.N` creeps back into `src/`.
 *
 * Why v25.0 (2026-09): v20.0 — the previous hard-coded pin — is available until
 * 2026-09-24 only. v25.0 (released 2026-02-18) is supported until 2028-07-29.
 * The bump also moves the insights metric set with it: `impressions` is gone
 * for IG media created after 2024-07-02 (`views` replaced it) and the Page
 * post metric `post_impressions` is obsolete above v25 (`post_media_view`
 * replaces it) — see the two fetchers in `analytics-providers.ts`.
 *
 * Client-safe: no secrets, no I/O, no `server-only` — so tests can import it.
 */

/** Pinned Graph API version, `vMAJOR.MINOR`. Bump here and nowhere else. */
export const META_GRAPH_VERSION = "v25.0";

const META_GRAPH_HOST = "https://graph.facebook.com";
const META_WWW_HOST = "https://www.facebook.com";

/**
 * `https://graph.facebook.com/<version>/<path>`. `path` is everything after
 * the version segment, WITHOUT a leading slash, and may carry a query string
 * (e.g. `me/accounts?access_token=…`). Dynamic path segments are encoded by
 * the caller, exactly as before the version was centralised.
 */
export function metaGraphUrl(path: string): string {
  return `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/${path.replace(/^\/+/, "")}`;
}

/** Facebook Login dialog — the OAuth `authUrl` for both facebook and instagram. */
export const META_OAUTH_DIALOG_URL = `${META_WWW_HOST}/${META_GRAPH_VERSION}/dialog/oauth`;

/** Code → token exchange (short-lived and `fb_exchange_token` long-lived alike). */
export const META_OAUTH_TOKEN_URL = metaGraphUrl("oauth/access_token");
