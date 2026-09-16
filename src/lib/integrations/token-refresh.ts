import "server-only";

import type { ClientIntegration } from "@/lib/types";
import { OAUTH_CONFIGS } from "@/lib/integrations/oauth";
import { TokenExpiredError } from "@/lib/integrations/publishers";
import { integrationNeedsReconnect } from "@/lib/integration-status";
import {
  getClientIntegration,
  markIntegrationExpired,
  updateClientIntegrationCredentials,
} from "@/lib/data";
import { logStructured } from "@/lib/telemetry/structured-log";

/**
 * OAuth token refresh for connectors (CN1, 2026-09).
 *
 * Until now the callback stored `accessToken` + `refreshToken` and nothing ever
 * used the second one: X tokens die after 2 hours, Google's after ~1 hour,
 * Reddit's after 1 hour, TikTok's after 24 hours, so every one of those channels
 * was "connected" for a single cron tick and then 401'd into `expired`, and the
 * client was asked to reconnect a channel whose refresh token had been sitting
 * in Firestore the whole time.
 *
 * Three pieces, in dependency order:
 *
 *   1. `refreshIntegrationCredentials` — the per-provider exchange. Pure with
 *      respect to Firestore: it takes credentials in and hands the rotated
 *      ones back (or `unsupported` for LinkedIn, which only grants programmatic
 *      refresh to approved partners — the client re-consents there, and this
 *      module does not invent a LinkedIn refresh).
 *   2. `getFreshIntegrationCredentials` — the policy. Refreshes ahead of expiry
 *      (5 minutes for short-lived providers, 7 days for Meta's long-lived
 *      exchange, or whenever a short-lived provider has no `expiresAt` on
 *      record), persists through `updateClientIntegrationCredentials`, and on a
 *      refresh the provider REJECTS marks the integration expired and throws a
 *      `TokenRefreshError`.
 *   3. `runWithFreshCredentials` — what the three consumers (publish cron,
 *      analytics sync, Publish Now) call: fresh credentials before the platform
 *      call, and on a 401 one forced refresh and one retry before the caller
 *      marks the channel dead.
 *
 * `expiresAt` rides INSIDE `credentials` as a decimal string of epoch millis.
 * The credentials map is `Record<string, string>` and every value in it is
 * encrypted on its own by `encryptCredentials`, so a string is the only shape
 * that goes through the cipher unchanged — and keeping it in the map means the
 * allowlist sanitizer (`sanitizeIntegrations`) never ships it to the browser
 * without someone opting it in. Read it with `credentialExpiresAt`, never
 * `Number(credentials.expiresAt)` at a call site.
 *
 * NO TOKEN IS EVER LOGGED HERE. The structured log lines carry the client id,
 * the platform, an outcome code and an epoch — nothing from a provider body.
 */

/* ── Policy ─────────────────────────────────────────────────────────── */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Short-lived providers refresh once the token is this close to expiry. */
export const REFRESH_AHEAD_MS = 5 * MINUTE_MS;
/** Meta's long-lived token is re-exchanged once it is this close to expiry. */
export const META_REFRESH_AHEAD_MS = 7 * DAY_MS;

type RefreshPolicy =
  /** grant_type=refresh_token against the provider's token endpoint. */
  | { kind: "refresh-token"; defaultLifetimeMs: number }
  /** Meta: exchange the still-valid long-lived token for a new one. */
  | { kind: "long-lived-exchange"; defaultLifetimeMs: number }
  /** No programmatic refresh; the client re-consents. */
  | { kind: "unsupported" };

/**
 * `defaultLifetimeMs` is used ONLY when a provider omits `expires_in` from a
 * refresh response, so the stored `expiresAt` never goes missing after a
 * refresh (missing would mean "refresh on every call" for a short-lived
 * provider — and X rotates its refresh token on every use, so that loop would
 * burn a rotation per publish). The values are the providers' documented
 * lifetimes; a token that in fact dies sooner still recovers through the
 * forced-refresh-on-401 path.
 */
const POLICIES: Record<string, RefreshPolicy> = {
  twitter: { kind: "refresh-token", defaultLifetimeMs: 2 * HOUR_MS },
  tiktok: { kind: "refresh-token", defaultLifetimeMs: DAY_MS },
  reddit: { kind: "refresh-token", defaultLifetimeMs: HOUR_MS },
  youtube: { kind: "refresh-token", defaultLifetimeMs: HOUR_MS },
  google_search_console: { kind: "refresh-token", defaultLifetimeMs: HOUR_MS },
  google_analytics: { kind: "refresh-token", defaultLifetimeMs: HOUR_MS },
  google_business_profile: { kind: "refresh-token", defaultLifetimeMs: HOUR_MS },
  facebook: { kind: "long-lived-exchange", defaultLifetimeMs: 60 * DAY_MS },
  instagram: { kind: "long-lived-exchange", defaultLifetimeMs: 60 * DAY_MS },
  linkedin: { kind: "unsupported" },
  linkedin_community: { kind: "unsupported" },
};

/** Same descriptive User-Agent the callback sends — Reddit rejects generic ones. */
const REDDIT_USER_AGENT = "karoscmo:agent-connectors:v1 (by /u/karoslabs)";

const TOKEN_ENDPOINT_TIMEOUT_MS = 15_000;

/* ── Pure helpers ───────────────────────────────────────────────────── */

/**
 * `expires_in` (seconds, as providers send it — X and Google as a number,
 * some as a numeric string) → absolute epoch millis, or null when absent or
 * unusable. Shared with the OAuth callback so both writers of `expiresAt`
 * agree on the arithmetic.
 */
export function expiresAtFromExpiresIn(expiresIn: unknown, now: number): number | null {
  const seconds = typeof expiresIn === "string" ? Number(expiresIn) : expiresIn;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return now + Math.floor(seconds * 1000);
}

/** The stored `expiresAt` as epoch millis, or null when absent or malformed. */
export function credentialExpiresAt(
  credentials: Record<string, string> | undefined,
): number | null {
  const raw = credentials?.expiresAt;
  if (raw === undefined || raw === "") return null;
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** True when the provider has a refresh path this module implements. */
export function isRefreshablePlatform(platform: string): boolean {
  const policy = POLICIES[platform];
  return !!policy && policy.kind !== "unsupported";
}

/**
 * Whether the stored credentials are due for a refresh at `now`:
 *   - short-lived providers: a refresh token is on record AND (`expiresAt` is
 *     missing OR within REFRESH_AHEAD_MS);
 *   - Meta: an access token is on record AND `expiresAt` is within
 *     META_REFRESH_AHEAD_MS. A Meta token with no `expiresAt` (connected before
 *     this module existed) is left alone until the client reconnects — the
 *     forced path still covers it if it 401s;
 *   - LinkedIn and anything without a policy: never.
 * Without a refresh token there is nothing to refresh with — a pasted
 * access-only token keeps working exactly as it did before this module.
 */
export function needsRefresh(
  integration: Pick<ClientIntegration, "platform" | "credentials">,
  now: number = Date.now(),
): boolean {
  const policy = POLICIES[integration.platform];
  if (!policy || policy.kind === "unsupported") return false;
  const credentials = integration.credentials ?? {};
  const expiresAt = credentialExpiresAt(credentials);
  if (policy.kind === "long-lived-exchange") {
    if (!credentials.accessToken) return false;
    return expiresAt !== null && expiresAt - now <= META_REFRESH_AHEAD_MS;
  }
  if (!credentials.refreshToken) return false;
  return expiresAt === null || expiresAt - now <= REFRESH_AHEAD_MS;
}

/* ── Errors ─────────────────────────────────────────────────────────── */

export type TokenRefreshFailure =
  /** LinkedIn: no programmatic refresh; the client re-consents. */
  | "unsupported"
  /** Nothing stored to refresh with. */
  | "no_refresh_token"
  /** This app's OAuth client id/secret env vars are unset. */
  | "not_configured"
  /** The provider answered 4xx or without an access token: the stored set is dead. */
  | "rejected"
  /** Network failure or 5xx at the token endpoint: try again later. */
  | "unavailable";

const PERMANENT_FAILURES: ReadonlySet<TokenRefreshFailure> = new Set([
  "unsupported",
  "no_refresh_token",
  "rejected",
]);

/**
 * Typed refresh failure. `permanent` says whether the stored token set is known
 * dead — those are the cases `getFreshIntegrationCredentials` has already
 * marked expired before throwing. A transient failure (`unavailable`,
 * `not_configured`) leaves the integration's status alone: an X outage or a
 * missing env var must not force every client to reconnect.
 *
 * The message carries the platform, the code and at most an HTTP status or the
 * provider's short `error` code — never a body, never a token.
 */
export class TokenRefreshError extends Error {
  readonly platform: string;
  readonly code: TokenRefreshFailure;
  readonly permanent: boolean;

  constructor(platform: string, code: TokenRefreshFailure, detail?: string) {
    super(`${platform} token refresh failed (${code})${detail ? `: ${detail}` : ""}`);
    this.name = "TokenRefreshError";
    this.platform = platform;
    this.code = code;
    this.permanent = PERMANENT_FAILURES.has(code);
  }
}

/**
 * The one predicate the consumers use where they used to write
 * `e instanceof TokenExpiredError`: a platform 401/403, or a refresh the
 * provider rejected. Both mean the channel needs reconnecting.
 */
export function isIntegrationDeadError(e: unknown): boolean {
  return e instanceof TokenExpiredError || (e instanceof TokenRefreshError && e.permanent);
}

/* ── Provider exchanges ─────────────────────────────────────────────── */

export type RefreshOutcome =
  | { outcome: "refreshed"; credentials: Record<string, string> }
  | { outcome: "unsupported" };

type TokenEndpointResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: unknown;
};

/** A provider's short `error` code (e.g. `invalid_grant`), and nothing longer. */
function shortErrorCode(data: Record<string, unknown>): string | null {
  const code = data.error;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : null;
}

/**
 * The OAuth 2 error codes (RFC 6749 §5.2) that say THIS client's stored grant is
 * dead. They are the only answers that may mark a channel expired.
 *
 * Everything else a token endpoint returns is a property of OUR app credentials
 * or OUR request rate, not of one client's token: X and Reddit answer 429 when
 * we are rate-limited, Google 403s `rate_limit_exceeded` against the
 * refresh-token quota and 401s `invalid_client` when this app's client secret is
 * stale, and a proxy or interstitial can hand back a non-JSON 200. Calling any
 * of those a dead token would mark EVERY Google or X integration expired in a
 * single cron tick — one rotated GOOGLE_CLIENT_SECRET and the whole fleet is
 * skipped by `integrationIsUsable` until a human reconnects each channel, which
 * could not work either, since the authorization_code exchange uses that same
 * bad secret. They are `unavailable`: the next tick tries again.
 */
const CREDENTIAL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_request",
  "unauthorized_client",
  "invalid_scope",
]);

async function tokenRequest(
  platform: string,
  url: string,
  init: RequestInit,
): Promise<TokenEndpointResponse> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TOKEN_ENDPOINT_TIMEOUT_MS) });
  } catch (e) {
    throw new TokenRefreshError(platform, "unavailable", e instanceof Error ? e.name : "fetch failed");
  }
  // null = the body was not JSON at all, so there is no refusal here to read.
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await res.json();
    if (parsed !== null && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON body: classified below, never as a dead token.
  }
  const accessToken = data && typeof data.access_token === "string" ? data.access_token : "";
  if (res.ok && accessToken) {
    return {
      access_token: accessToken,
      refresh_token: data && typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expires_in: data?.expires_in,
    };
  }
  const code = data ? shortErrorCode(data) : null;
  // Permanent ONLY for a refusal of this grant: a recognized OAuth error code,
  // or a bare 400 — the status a token endpoint reserves for a bad grant — whose
  // JSON body named no code we know. TikTok answers some refusals with HTTP 200
  // and an `error` field, which the code check catches on its own.
  const refusedThisGrant =
    (code !== null && CREDENTIAL_REFUSAL_CODES.has(code)) ||
    (res.status === 400 && code === null && data !== null);
  const detail = `HTTP ${res.status}${code ? ` ${code}` : data ? "" : " non-JSON"}`;
  throw new TokenRefreshError(platform, refusedThisGrant ? "rejected" : "unavailable", detail);
}

function withExpiry(
  credentials: Record<string, string>,
  expiresIn: unknown,
  now: number,
  defaultLifetimeMs: number,
): Record<string, string> {
  const at = expiresAtFromExpiresIn(expiresIn, now) ?? now + defaultLifetimeMs;
  return { ...credentials, expiresAt: String(at) };
}

/**
 * Exchange the stored refresh token (or, for Meta, the still-valid long-lived
 * token) for a new access token. Returns ONLY the keys that changed, so the
 * caller merges them over the stored map:
 *   - X and TikTok rotate the refresh token on every use → `refreshToken` is
 *     included and the old one is dead the moment this returns;
 *   - Google and Reddit keep the original refresh token → not included;
 *   - Meta has no refresh token at all → `accessToken` + `expiresAt` only.
 * Throws `TokenRefreshError`; never touches Firestore.
 */
export async function refreshIntegrationCredentials(
  integration: Pick<ClientIntegration, "platform" | "credentials">,
  opts: { now?: number } = {},
): Promise<RefreshOutcome> {
  const { platform } = integration;
  const policy = POLICIES[platform];
  const config = OAUTH_CONFIGS[platform];
  if (!policy || policy.kind === "unsupported" || !config) return { outcome: "unsupported" };

  const appClientId = process.env[config.envClientId];
  const appClientSecret = process.env[config.envClientSecret];
  if (!appClientId || !appClientSecret) {
    throw new TokenRefreshError(
      platform,
      "not_configured",
      `${config.envClientId} / ${config.envClientSecret} unset`,
    );
  }
  const now = opts.now ?? Date.now();
  const credentials = integration.credentials ?? {};

  if (policy.kind === "long-lived-exchange") {
    const current = credentials.accessToken;
    if (!current) throw new TokenRefreshError(platform, "no_refresh_token");
    // Same call the callback makes for its step 2, fed the current long-lived
    // token instead of a short-lived one: Meta answers with a fresh 60-day token.
    const url = new URL(config.tokenUrl);
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", appClientId);
    url.searchParams.set("client_secret", appClientSecret);
    url.searchParams.set("fb_exchange_token", current);
    const data = await tokenRequest(platform, url.toString(), { method: "GET" });
    return {
      outcome: "refreshed",
      credentials: withExpiry({ accessToken: data.access_token }, data.expires_in, now, policy.defaultLifetimeMs),
    };
  }

  const refreshToken = credentials.refreshToken;
  if (!refreshToken) throw new TokenRefreshError(platform, "no_refresh_token");

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (platform === "twitter" || platform === "reddit") {
    // Confidential client: app credentials travel as HTTP Basic, exactly as in
    // the callback's authorization_code exchange for these two.
    headers.Authorization = `Basic ${Buffer.from(`${appClientId}:${appClientSecret}`).toString("base64")}`;
    if (platform === "reddit") headers["User-Agent"] = REDDIT_USER_AGENT;
  } else if (platform === "tiktok") {
    body.set("client_key", appClientId);
    body.set("client_secret", appClientSecret);
    headers["Cache-Control"] = "no-cache";
  } else {
    // The four Google products share one OAuth client; client_id/secret in the form.
    body.set("client_id", appClientId);
    body.set("client_secret", appClientSecret);
  }
  const data = await tokenRequest(platform, config.tokenUrl, { method: "POST", headers, body });

  const next: Record<string, string> = { accessToken: data.access_token };
  if (data.refresh_token) next.refreshToken = data.refresh_token;
  return {
    outcome: "refreshed",
    credentials: withExpiry(next, data.expires_in, now, policy.defaultLifetimeMs),
  };
}

/* ── Freshness with persistence ─────────────────────────────────────── */

type IntegrationRef = Pick<
  ClientIntegration,
  "clientId" | "platform" | "credentials" | "updatedAt" | "status"
>;

/**
 * Process-local memory of refreshes, keyed by integration doc id, for two
 * races this module would otherwise create itself:
 *
 *   - `inFlight`: the publish cron publishes a client's due posts concurrently
 *     (Promise.allSettled), so two posts on one X integration would both see
 *     "expires in 3 minutes" and both POST the same refresh token. X and TikTok
 *     invalidate a refresh token the moment it is used — the second call would
 *     be REJECTED and mark the channel expired one line after the first call
 *     renewed it. Concurrent callers share one promise instead.
 *   - `refreshed`: the cron reads every integration once, up front, so the
 *     second post's in-memory copy still carries the pre-refresh tokens after
 *     the first post refreshed them. Newer credentials this process has
 *     persisted are laid over any copy read before them (`refreshedAt` later
 *     than the copy's `updatedAt`); a copy read AFTER the refresh, or a
 *     reconnect, carries a later `updatedAt` and wins.
 *
 * Cross-process races (publish cron and analytics sync on separate instances)
 * are handled at the point of rejection: see `performRefresh`.
 *
 * `refreshed` holds PLAINTEXT tokens, so it is not allowed to become a growing
 * pile of every client this revision has ever published for: entries expire
 * after REFRESHED_TTL_MS (its whole job is to bridge one cron tick's single
 * up-front read) and the map is swept on every write, and disconnecting a
 * channel drops its entry through `forgetRefreshedCredentials` so "disconnect"
 * means the tokens are gone from this process too.
 */
const inFlight = new Map<string, Promise<Record<string, string>>>();
const refreshed = new Map<string, { credentials: Record<string, string>; refreshedAt: number }>();

/** How long a refreshed set stays in memory. One cron tick, not one revision. */
const REFRESHED_TTL_MS = 10 * MINUTE_MS;

/** Tests only: forget every in-process refresh. */
export function resetTokenRefreshStateForTests(): void {
  inFlight.clear();
  refreshed.clear();
}

function docKey(integration: Pick<ClientIntegration, "clientId" | "platform">): string {
  return `${integration.clientId}_${integration.platform}`;
}

/** Remember a refreshed set, and drop every entry whose TTL has run out. */
function rememberRefreshed(key: string, credentials: Record<string, string>, now: number): void {
  for (const [k, entry] of refreshed) {
    if (now - entry.refreshedAt >= REFRESHED_TTL_MS) refreshed.delete(k);
  }
  refreshed.set(key, { credentials, refreshedAt: now });
}

/**
 * Drop this process's decrypted copy of one integration's tokens. Called when
 * the channel is disconnected: the Firestore doc is gone, and the plaintext
 * must not outlive it in a long-running instance.
 */
export function forgetRefreshedCredentials(clientId: string, platform: string): void {
  const key = `${clientId}_${platform}`;
  refreshed.delete(key);
  inFlight.delete(key);
}

/**
 * The newest credentials this process knows for an integration, and whether they
 * came from a refresh IT performed. The second half matters for the dead-token
 * re-test below: the caller's copy of the row still says `expired` after a
 * successful revival (the flag was cleared in Firestore, not in the array the
 * cron read up front), so without it every later post on that channel would
 * force another exchange — and X and TikTok burn a rotation each time.
 */
function newestKnownCredentials(
  integration: IntegrationRef,
  now: number,
): { credentials: Record<string, string>; refreshedHere: boolean } {
  const stored = integration.credentials ?? {};
  const key = docKey(integration);
  const recent = refreshed.get(key);
  if (!recent) return { credentials: stored, refreshedHere: false };
  if (now - recent.refreshedAt >= REFRESHED_TTL_MS) {
    refreshed.delete(key);
    return { credentials: stored, refreshedHere: false };
  }
  if (recent.refreshedAt > (integration.updatedAt ?? 0)) {
    return { credentials: { ...stored, ...recent.credentials }, refreshedHere: true };
  }
  return { credentials: stored, refreshedHere: false };
}

/**
 * True when an integration already flagged `expired` / `reauthenticate` is worth
 * one more try: the platform has a refresh path and a refresh token is on
 * record. The flag was set by a 401 on the ACCESS token, which says nothing
 * about the refresh token sitting beside it — and before CN1 every short-lived
 * channel earned that flag on its first cron tick, so honouring it blindly means
 * the fix reaches none of the connections it was written for.
 *
 * The consumers widen their `integrationIsUsable` gate by this predicate, and
 * `getFreshIntegrationCredentials` forces the refresh so the retry is real. A
 * success clears the flag (`updateClientIntegrationCredentials`); a refusal
 * re-marks it, so a genuinely dead channel costs one request per tick.
 */
export function integrationMayBeRevivable(
  integration: Pick<ClientIntegration, "platform" | "credentials" | "status">,
): boolean {
  if (!integrationNeedsReconnect(integration)) return false;
  return isRefreshablePlatform(integration.platform) && !!integration.credentials?.refreshToken;
}

/**
 * The credentials to call the platform with, refreshed first when
 * `needsRefresh` says so, when the integration carries a dead-token flag we are
 * re-testing (`integrationMayBeRevivable`), or always with `force` — after a 401
 * the token looked fine on paper and was not. Persists a successful refresh and
 * clears the dead-token markers via `updateClientIntegrationCredentials`.
 *
 * Throws `TokenRefreshError`. When `permanent`, the integration has ALREADY
 * been marked expired here; the caller's own mark is idempotent.
 */
export async function getFreshIntegrationCredentials(
  integration: IntegrationRef,
  opts: { force?: boolean; now?: number } = {},
): Promise<Record<string, string>> {
  const now = opts.now ?? Date.now();
  const { credentials: current, refreshedHere } = newestKnownCredentials(integration, now);
  const due =
    opts.force === true ||
    needsRefresh({ platform: integration.platform, credentials: current }, now) ||
    (!refreshedHere && integrationMayBeRevivable({ ...integration, credentials: current }));
  if (!due) {
    return current;
  }
  const key = docKey(integration);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const task = performRefresh(integration, current, now, opts.force === true).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

/**
 * Providers that invalidate a refresh token the moment it is used. A rejection
 * from one of these is ambiguous: either the grant really is dead, or another
 * process (the analytics sync against the publish cron, two cron ticks, two
 * Cloud Run instances) spent the same refresh token a few hundred milliseconds
 * ago and we are the loser of that race, holding a channel whose token was just
 * renewed.
 */
const ROTATING_REFRESH_PLATFORMS: ReadonlySet<string> = new Set(["twitter", "tiktok"]);

/**
 * Re-read delays, in milliseconds, while the winner's Firestore write lands.
 * A single read with no backoff is what made this dangerous: a loser reading
 * inside that ~100-500 ms window sees the OLD token, concludes the grant is
 * dead and marks a HEALTHY channel expired — after which every consumer's
 * `integrationIsUsable` gate skips it, so it never gets another refresh attempt
 * and publishing silently stops until a human reconnects.
 */
const ADOPTION_RETRY_DELAYS_MS = [400, 900];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The credentials another process rotated while we were being refused, or null
 * when nothing moved and the grant really is dead.
 *
 * The signal is a stored TOKEN that differs from the one we just spent, not a
 * moved `updatedAt` — an auto-publish toggle bumps `updatedAt` without touching
 * a token, and adopting on that would hand the caller back the same dead set.
 * For a rotating provider the read is retried across ADOPTION_RETRY_DELAYS_MS so
 * a rejection that arrives before the winner's write does not kill the channel;
 * for the others a rejection is a real revocation and one read is the answer.
 */
async function adoptCredentialsRotatedElsewhere(
  integration: IntegrationRef,
  current: Record<string, string>,
): Promise<Record<string, string> | null> {
  const { clientId, platform } = integration;
  const delays = ROTATING_REFRESH_PLATFORMS.has(platform) ? ADOPTION_RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt++) {
    const stored = await getClientIntegration(clientId, platform).catch(() => null);
    const storedCredentials = stored?.credentials;
    if (
      storedCredentials?.accessToken &&
      (storedCredentials.accessToken !== current.accessToken ||
        (!!storedCredentials.refreshToken &&
          storedCredentials.refreshToken !== current.refreshToken))
    ) {
      return storedCredentials;
    }
    if (attempt >= delays.length) return null;
    await sleep(delays[attempt]);
  }
}

async function performRefresh(
  integration: IntegrationRef,
  current: Record<string, string>,
  now: number,
  forced: boolean,
): Promise<Record<string, string>> {
  const { clientId, platform } = integration;
  const key = docKey(integration);
  const logFields = { operation: "token-refresh", clientId, platform, forced };

  let result: RefreshOutcome;
  try {
    result = await refreshIntegrationCredentials({ platform, credentials: current }, { now });
  } catch (e) {
    if (!(e instanceof TokenRefreshError)) throw e;
    if (e.permanent) {
      const adopted = await adoptCredentialsRotatedElsewhere(integration, current);
      if (adopted) {
        rememberRefreshed(key, adopted, now);
        logStructured("INFO", "token refresh: adopted credentials rotated by another process", {
          ...logFields,
          code: e.code,
        });
        return adopted;
      }
      await markIntegrationExpired(clientId, platform).catch(() => {});
    }
    logStructured("WARNING", "token refresh failed", { ...logFields, code: e.code, permanent: e.permanent });
    throw e;
  }

  if (result.outcome === "unsupported") {
    // Only reachable when forced: `needsRefresh` never elects an unsupported
    // provider. The token 401'd and there is no refresh to try — the client
    // re-consents.
    const error = new TokenRefreshError(platform, "unsupported", "re-consent required");
    await markIntegrationExpired(clientId, platform).catch(() => {});
    logStructured("WARNING", "token refresh failed", { ...logFields, code: error.code, permanent: true });
    throw error;
  }

  const merged = { ...current, ...result.credentials };
  try {
    await updateClientIntegrationCredentials(clientId, platform, result.credentials);
  } catch (e) {
    // The provider has already rotated (X/TikTok: the OLD refresh token is dead
    // now), so the fresh set is the only working one. Use it for this call and
    // say so loudly; if the write really failed the channel needs a reconnect
    // once this process forgets it.
    logStructured("ERROR", "token refresh: refreshed but could not persist", {
      ...logFields,
      error: e instanceof Error ? e.message : "unknown",
    });
  }
  rememberRefreshed(key, merged, now);
  logStructured("INFO", "token refreshed", {
    ...logFields,
    expiresAt: credentialExpiresAt(merged),
    rotatedRefreshToken: result.credentials.refreshToken !== undefined,
  });
  return merged;
}

/**
 * Run one platform call with fresh credentials: refresh ahead of expiry, and
 * on a `TokenExpiredError` force ONE refresh and retry ONCE. A second 401
 * propagates as the original `TokenExpiredError`; so does a forced refresh the
 * provider REFUSED, because the caller's existing branch (mark expired, report
 * "expired") is the right answer and the integration is already marked.
 *
 * A forced refresh that merely could not be ATTEMPTED — the token endpoint 503s,
 * a bad deploy left TWITTER_CLIENT_SECRET unset — propagates as its own
 * non-permanent `TokenRefreshError` instead. Rethrowing the platform's 401 there
 * would tell every consumer to mark a channel dead whose refresh token is
 * perfectly good and whose next tick would have recovered it, which is the same
 * split the pre-call path already respects.
 *
 * A refresh failure BEFORE the first call propagates as `TokenRefreshError`
 * so the caller can tell a dead token set (`permanent`, mark expired) from a
 * token endpoint that is merely down (retry next tick).
 */
export async function runWithFreshCredentials<T>(
  integration: ClientIntegration,
  run: (integration: ClientIntegration) => Promise<T>,
  opts: { now?: number } = {},
): Promise<T> {
  const credentials = await getFreshIntegrationCredentials(integration, opts);
  const fresh: ClientIntegration = { ...integration, credentials };
  try {
    return await run(fresh);
  } catch (e) {
    if (!(e instanceof TokenExpiredError)) throw e;
    let forced: Record<string, string>;
    try {
      forced = await getFreshIntegrationCredentials(fresh, { ...opts, force: true });
    } catch (refreshError) {
      if (refreshError instanceof TokenRefreshError && refreshError.permanent) throw e;
      throw refreshError;
    }
    return await run({ ...fresh, credentials: forced });
  }
}
