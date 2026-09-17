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

/**
 * "Instagram API with Instagram Login" (Business Login for Instagram) — a
 * SECOND, PARALLEL Meta login product, not a variant of the Facebook-login
 * flow above. It has its own app credential (an "Instagram App ID/Secret",
 * distinct from FACEBOOK_APP_ID — see the "API setup with Instagram login"
 * tab under this app's Instagram API use case), its own authorize/token
 * hosts, and its own API host (`graph.instagram.com`, not
 * `graph.facebook.com`). Rides the SAME version pin, confirmed against this
 * app's own generated authorize link and its "API integration helper" curl
 * sample (both `.../v25.0/...`) on 2026-09-17.
 *
 * Backs the "instagram_business" provider in oauth.ts — see that file for
 * why this exists as a second connection rather than extending "instagram".
 */
const META_INSTAGRAM_GRAPH_HOST = "https://graph.instagram.com";

/** `https://graph.instagram.com/<version>/<path>` — the Instagram-login API host. */
export function metaInstagramGraphUrl(path: string): string {
  return `${META_INSTAGRAM_GRAPH_HOST}/${META_GRAPH_VERSION}/${path.replace(/^\/+/, "")}`;
}

/** Business Login for Instagram — the authorize dialog (www.instagram.com, not www.facebook.com). */
export const INSTAGRAM_BUSINESS_LOGIN_AUTH_URL = "https://www.instagram.com/oauth/authorize";

/** Step 1 token exchange (short-lived) — api.instagram.com, POST form-encoded, NOT graph.instagram.com. */
export const INSTAGRAM_BUSINESS_LOGIN_TOKEN_URL = "https://api.instagram.com/oauth/access_token";

/** Step 2 — short-lived → 60-day long-lived (`grant_type=ig_exchange_token`). Versioned, unlike step 1. */
export const INSTAGRAM_BUSINESS_LONG_LIVED_URL = metaInstagramGraphUrl("access_token");

/** Long-lived token refresh (`grant_type=ig_refresh_token`) — needs only the current token, no app secret. */
export const INSTAGRAM_BUSINESS_REFRESH_URL = metaInstagramGraphUrl("refresh_access_token");
