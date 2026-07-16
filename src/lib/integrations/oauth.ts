import "server-only";

import { createHmac, randomBytes, createHash } from "crypto";

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
  // HMAC-SHA256 is always 64 hex chars — reject anything else without timing leak
  if (sig.length !== 64 || sig !== sign(data)) return null;
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
}

/**
 * Admin-extensible: add new entries here to support more platforms.
 * Each key matches the corresponding PlatformConfig.id in platforms.ts.
 */
export const OAUTH_CONFIGS: Record<string, OAuthPlatformConfig> = {
  linkedin: {
    envClientId: "LINKEDIN_CLIENT_ID",
    envClientSecret: "LINKEDIN_CLIENT_SECRET",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["w_member_social", "openid", "profile", "email"],
  },
  facebook: {
    envClientId: "FACEBOOK_APP_ID",
    envClientSecret: "FACEBOOK_APP_SECRET",
    authUrl: "https://www.facebook.com/v20.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v20.0/oauth/access_token",
    scopes: ["pages_manage_posts", "pages_read_engagement", "publish_video"],
    requiresLongLivedExchange: true,
  },
  instagram: {
    // Instagram business publishing uses Meta's Graph API (same app credentials as Facebook)
    envClientId: "FACEBOOK_APP_ID",
    envClientSecret: "FACEBOOK_APP_SECRET",
    authUrl: "https://www.facebook.com/v20.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v20.0/oauth/access_token",
    scopes: [
      "instagram_content_publish",
      "instagram_manage_insights",
      "pages_read_engagement",
      "pages_manage_posts",
    ],
    requiresLongLivedExchange: true,
  },
  twitter: {
    envClientId: "TWITTER_CLIENT_ID",
    envClientSecret: "TWITTER_CLIENT_SECRET",
    authUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
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
    scopes: ["user.info.basic", "video.upload", "video.publish"],
    usePkce: true,
    clientIdParam: "client_key",
    scopeSeparator: ",",
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
