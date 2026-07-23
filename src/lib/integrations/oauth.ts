import "server-only";

import { createHmac, randomBytes, createHash, timingSafeEqual } from "crypto";

/**
 * HMAC key for the OAuth `state` token. Falls back to a dev-only constant, but
 * refuses that fallback in production: a public signing key would let an attacker
 * forge a `state` for an arbitrary clientId and connect social credentials onto
 * another client's account. Evaluated lazily (per sign/verify) so importing this
 * module never crashes unrelated routes — only an actual OAuth flow trips the guard.
 */
function getStateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("OAUTH_STATE_SECRET must be set in production");
  }
  return "dev-oauth-secret-change-in-prod";
}

const APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

/* ── URL helpers ─────────────────────────────────────────────────────── */

export function buildCallbackUrl(provider: string): string {
  return `${APP_URL}/api/auth/social/${provider}/callback`;
}

export function getAppOrigin(): string {
  return APP_URL;
}

/* ── State signing ───────────────────────────────────────────────────── */

function sign(data: string): string {
  return createHmac("sha256", getStateSecret()).update(data).digest("hex");
}

export function signOAuthState(payload: {
  clientId: string;
  uid: string;
  provider: string;
  /** Employee-advocacy flows carry the target seat so the callback attaches tokens to it. */
  seatId?: string;
  /** Where the callback should send the browser back to. Defaults to client settings. */
  returnTo?: "onboarding" | "settings";
}): string {
  const nonce = randomBytes(16).toString("hex");
  const data = Buffer.from(
    JSON.stringify({ ...payload, nonce, ts: Date.now() }),
  ).toString("base64url");
  return `${data}.${sign(data)}`;
}

export function verifyOAuthState(state: string): {
  clientId: string;
  uid: string;
  provider: string;
  seatId?: string;
  returnTo?: "onboarding" | "settings";
  ts: number;
} | null {
  const dot = state.lastIndexOf(".");
  if (dot === -1) return null;
  const data = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  // HMAC-SHA256 digest('hex') is always 64 lowercase hex chars — reject anything
  // else up front (timingSafeEqual throws on a length mismatch, and Buffer.from
  // silently truncates invalid hex, so both must be ruled out before comparing).
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(sign(data), "hex"))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64url").toString()) as {
      clientId: string;
      uid: string;
      provider: string;
      seatId?: string;
      returnTo?: "onboarding" | "settings";
      ts: number;
    };
    if (Date.now() - parsed.ts > 10 * 60 * 1000) return null; // 10-minute TTL
    return parsed;
  } catch {
    return null;
  }
}

/** Callback URL for the LinkedIn employee-advocacy OAuth flow (distinct path). */
export function buildEmployeeCallbackUrl(): string {
  return `${APP_URL}/api/integrations/linkedin/employee/callback`;
}

/* ── PKCE (Twitter OAuth 2.0) ────────────────────────────────────────── */

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/* ── Per-platform OAuth configuration ───────────────────────────────── */

export interface OAuthPlatformConfig {
  /** Env var names for this app's OAuth credentials (not the user's tokens) */
  envClientId: string;
  envClientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Twitter requires PKCE */
  usePkce?: boolean;
  /** Facebook/Instagram need a second call to get a long-lived token */
  requiresLongLivedExchange?: boolean;
  /** Additional params appended to the authorization URL */
  extraAuthParams?: Record<string, string>;
  /**
   * Query-param name for the app's client id on the authorize URL. Defaults to
   * the OAuth-standard "client_id"; TikTok is the odd one out and calls it
   * "client_key" (on both the authorize URL and the token request body).
   */
  clientIdParam?: string;
  /**
   * Separator joining the requested scopes. Defaults to a space (OAuth 2.0
   * standard); TikTok requires a comma-separated list.
   */
  scopeSeparator?: string;
  /**
   * Additional read/insights scopes that the platform will only grant once a
   * SEPARATE product/partner application has been approved (LinkedIn's
   * Community Management API / Marketing Developer Platform, Meta's Advanced
   * Access via App Review, TikTok's Research API). Requesting these before
   * approval doesn't just fail quietly — the platform rejects the WHOLE
   * authorize request, breaking the base scopes that already work today. Kept
   * out of `scopes` for that reason and only merged in once `envApprovalFlag`
   * is set — flip it the day the platform confirms the product is live on
   * this app, nothing else changes.
   */
  extendedScopes?: string[];
  /** Env var (value "1") gating `extendedScopes` — see above. */
  envApprovalFlag?: string;
}

/**
 * The scopes to actually request for a provider: base `scopes` plus
 * `extendedScopes` IF its approval flag is set. Use this everywhere an
 * authorize URL is built instead of reading `config.scopes` directly.
 */
export function getRequestedScopes(provider: string): string[] {
  const cfg = OAUTH_CONFIGS[provider];
  if (!cfg) return [];
  const approved = !!(cfg.envApprovalFlag && process.env[cfg.envApprovalFlag] === "1");
  return approved && cfg.extendedScopes ? [...cfg.scopes, ...cfg.extendedScopes] : cfg.scopes;
}

/**
 * Admin-extensible: add new entries here to support more platforms.
 * Each key matches the corresponding PlatformConfig.id in platforms.ts.
 */
export const OAUTH_CONFIGS: Record<string, OAuthPlatformConfig> = {
  linkedin: {
    // Sign In with LinkedIn + Share on LinkedIn — the "primary" app. LinkedIn
    // does not allow the Community Management API product on the SAME app as
    // these base products, so org-level scopes live on a wholly separate app
    // (see "linkedin_community" below) rather than as extendedScopes here —
    // requesting them from this app would 400 the entire auth request.
    envClientId: "LINKEDIN_CLIENT_ID",
    envClientSecret: "LINKEDIN_CLIENT_SECRET",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["w_member_social", "openid", "profile", "email"],
  },
  linkedin_community: {
    // Community Management API — company-page followers/demographics + org
    // post analytics. MUST be a separate LinkedIn Developer app (separate
    // client id/secret) with only this product added; LinkedIn rejects an app
    // that mixes this with Sign In/Share. Env vars existing at all is the real
    // gate here — you can't provision this app before LinkedIn approves the
    // product for it, so there's no extra approval flag to flip afterward
    // (contrast with Meta/TikTok's extendedScopes, which share one app).
    envClientId: "LINKEDIN_COMMUNITY_CLIENT_ID",
    envClientSecret: "LINKEDIN_COMMUNITY_CLIENT_SECRET",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["r_organization_social", "r_organization_admin"],
  },
  facebook: {
    envClientId: "FACEBOOK_APP_ID",
    envClientSecret: "FACEBOOK_APP_SECRET",
    authUrl: "https://www.facebook.com/v20.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v20.0/oauth/access_token",
    scopes: ["pages_manage_posts", "pages_read_engagement", "publish_video"],
    requiresLongLivedExchange: true,
    // Comments/mentions read (pages_read_user_content) and page-list discovery
    // (pages_show_list) are Advanced Access permissions — Meta's App Review
    // (business verification + use-case screencast) must approve them first,
    // same all-or-nothing risk as LinkedIn above.
    extendedScopes: ["pages_read_user_content", "pages_show_list", "read_insights"],
    envApprovalFlag: "META_ADVANCED_ACCESS_APPROVED",
  },
  instagram: {
    // Instagram business publishing uses Meta's Graph API (same app credentials as Facebook)
    envClientId: "FACEBOOK_APP_ID",
    envClientSecret: "FACEBOOK_APP_SECRET",
    authUrl: "https://www.facebook.com/v20.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v20.0/oauth/access_token",
    scopes: [
      "instagram_content_publish",
      // Audience demographics + comments-read for OWN posts are already covered by
      // these two — no extra scope/approval needed; see fetchInstagramAudience /
      // fetchInstagramComments in analytics-providers.ts.
      "instagram_manage_insights",
      "pages_read_engagement",
      "pages_manage_posts",
    ],
    requiresLongLivedExchange: true,
    // Mentions/tags read needs the same Advanced Access grant as Facebook above.
    extendedScopes: ["pages_read_user_content"],
    envApprovalFlag: "META_ADVANCED_ACCESS_APPROVED",
  },
  twitter: {
    envClientId: "TWITTER_CLIENT_ID",
    envClientSecret: "TWITTER_CLIENT_SECRET",
    authUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    // Follower counts (user.fields=public_metrics) and own mentions
    // (/2/users/:id/mentions) both work under these existing scopes — no scope
    // change needed, just new endpoint calls (see fetchTwitterFollowerGrowth /
    // fetchTwitterMentions). What DOES gate them is the X Developer account's
    // paid API tier (Basic/Pro) — a billing decision, not a scope grant.
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    usePkce: true,
  },
  youtube: {
    envClientId: "GOOGLE_CLIENT_ID",
    envClientSecret: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube",
      // Channel Analytics (watch time / audience retention) — ungated read
      // scopes, no separate product approval required, just Google's normal
      // OAuth consent screen (already applies to youtube.upload above).
      "https://www.googleapis.com/auth/yt-analytics.readonly",
      "https://www.googleapis.com/auth/youtube.readonly",
    ],
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  tiktok: {
    // TikTok Login Kit v2. Note the quirks handled via clientIdParam/scopeSeparator:
    // the app credential is passed as `client_key` (not `client_id`) and scopes are
    // comma-separated. PKCE is mandatory. video.publish/upload back the Content
    // Posting API used by publishToTikTok().
    envClientId: "TIKTOK_CLIENT_KEY",
    envClientSecret: "TIKTOK_CLIENT_SECRET",
    authUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    // video.list is a standard Login Kit scope (own-video metadata/stats) — no
    // extra approval, unlike comment moderation or the Research API below.
    scopes: ["user.info.basic", "video.upload", "video.publish", "video.list"],
    usePkce: true,
    clientIdParam: "client_key",
    scopeSeparator: ",",
    // Comment reads and audience data require TikTok's separate Research API /
    // Content Posting API v2 elevated-access application. Verify the exact
    // scope name in the Developer Portal at approval time — TikTok has renamed
    // these before.
    extendedScopes: ["research.data.basic"],
    envApprovalFlag: "TIKTOK_RESEARCH_API_APPROVED",
  },
  reddit: {
    envClientId: "REDDIT_CLIENT_ID",
    envClientSecret: "REDDIT_CLIENT_SECRET",
    authUrl: "https://www.reddit.com/api/v1/authorize",
    tokenUrl: "https://www.reddit.com/api/v1/access_token",
    // "identity" -> /api/v1/me (karma, account age); "history" -> own post/comment
    // history (for the removal-rate / voice check); "read" -> browsing threads.
    // No separate approval needed for these at low volume, but Reddit's 2023 API
    // terms require a paid Data API license for meaningful commercial volume —
    // a business/legal call, not an engineering one.
    scopes: ["identity", "history", "read"],
    extraAuthParams: { duration: "permanent" },
  },
  google_search_console: {
    // Shares the app's Google Cloud OAuth client with youtube — same
    // GOOGLE_CLIENT_ID/SECRET, different scope/product. Requires the Search
    // Console API enabled on that GCP project AND the connecting Google account
    // added as a user on the client's Search Console property (or the property
    // verified under this app) — an operational step per client, not a code change.
    envClientId: "GOOGLE_CLIENT_ID",
    envClientSecret: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  google_analytics: {
    // Same shared Google app; GA4 Data API scope. The client's GA4 property must
    // separately grant this account "Viewer" access in GA4 Admin — per-client,
    // not global.
    envClientId: "GOOGLE_CLIENT_ID",
    envClientSecret: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  google_business_profile: {
    // Same shared Google app; Business Profile scope. UNLIKE the two above,
    // Google gates the Business Profile APIs behind a manual "Business Profile
    // API access request" form — the scope alone returns 403 PERMISSION_DENIED
    // until Google approves that request for this project. See
    // google-business-profile.ts for the resulting inert-until-approved client.
    envClientId: "GOOGLE_CLIENT_ID",
    envClientSecret: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/business.manage"],
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  google_unified: {
    // "Connect All Google Services" — one consent screen requesting the union
    // of youtube + google_search_console + google_analytics +
    // google_business_profile scopes, so a client who wants everything doesn't
    // click through four separate popups. Same GOOGLE_CLIENT_ID/SECRET app;
    // this is a UI/flow convenience, not a fifth real platform — the callback
    // fans the resulting token pair out into the four real ClientIntegration
    // docs (see GOOGLE_UNIFIED_SUB_PLATFORM_IDS in platforms.ts) so every
    // existing per-service reader (analytics-providers.ts, google-analytics.ts,
    // etc.) keeps working unchanged, unaware anything unified happened.
    // openid/userinfo.email are ADDITIONAL here only, purely so the callback
    // can show "you@client.com" as the connected account label.
    envClientId: "GOOGLE_CLIENT_ID",
    envClientSecret: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/webmasters.readonly",
      "https://www.googleapis.com/auth/analytics.readonly",
      "https://www.googleapis.com/auth/business.manage",
    ],
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
};

/** Returns platform IDs that have their OAuth env vars configured. */
export function getOAuthEnabledPlatforms(): string[] {
  return Object.keys(OAUTH_CONFIGS).filter((id) => {
    const cfg = OAUTH_CONFIGS[id];
    return !!(process.env[cfg.envClientId] && process.env[cfg.envClientSecret]);
  });
}

export function isOAuthEnabled(provider: string): boolean {
  const cfg = OAUTH_CONFIGS[provider];
  if (!cfg) return false;
  return !!(process.env[cfg.envClientId] && process.env[cfg.envClientSecret]);
}
