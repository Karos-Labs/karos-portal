import { vi, describe, expect, it, beforeEach, afterEach } from "vitest";

/**
 * CN1 — OAuth token refresh for connectors.
 *
 * The defect these cover is not "the refresh call is malformed": it is that
 * there was NO refresh call. A refresh token was captured at the callback and
 * never spent, so an X connection (2 h), a Google one (~1 h) or a Reddit one
 * (1 h) was live for a single cron tick and then told the client to reconnect.
 *
 * So the assertions are about the wire and the clock: WHICH request each
 * provider gets (X and Reddit authenticate the app with HTTP Basic, TikTok
 * calls its client id `client_key`, Meta re-exchanges a still-valid long-lived
 * token over GET), WHETHER the rotated refresh token is carried back out (X and
 * TikTok rotate; using the old one again is an instant `invalid_grant`), and
 * WHEN a refresh happens at all. LinkedIn's case asserts the absence of a
 * request — programmatic refresh there is for approved partners only, and a
 * plausible-looking invented call would 400 every client's connection.
 */

vi.mock("server-only", () => ({}));

const { getClientIntegrationMock, markIntegrationExpiredMock, updateCredentialsMock, logMock } =
  vi.hoisted(() => ({
    getClientIntegrationMock: vi.fn(),
    markIntegrationExpiredMock: vi.fn(),
    updateCredentialsMock: vi.fn(),
    logMock: vi.fn(),
  }));

vi.mock("@/lib/data", () => ({
  getClientIntegration: getClientIntegrationMock,
  markIntegrationExpired: markIntegrationExpiredMock,
  updateClientIntegrationCredentials: updateCredentialsMock,
}));
vi.mock("@/lib/telemetry/structured-log", () => ({ logStructured: logMock }));

import type { ClientIntegration } from "@/lib/types";
import { TokenExpiredError } from "../publishers";
import {
  REFRESH_AHEAD_MS,
  TokenRefreshError,
  credentialExpiresAt,
  expiresAtFromExpiresIn,
  getFreshIntegrationCredentials,
  isIntegrationDeadError,
  isRefreshablePlatform,
  needsRefresh,
  refreshIntegrationCredentials,
  resetTokenRefreshStateForTests,
  runWithFreshCredentials,
} from "../token-refresh";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let fetchMock: ReturnType<typeof vi.fn>;

/** A token-endpoint 200. */
function tokenResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}
/** A token-endpoint refusal (`invalid_grant` is what a spent/revoked token gets). */
function refusal(status = 400, error = "invalid_grant") {
  return { ok: false, status, json: async () => ({ error }) };
}

function integration(over: Partial<ClientIntegration> & { platform: string }): ClientIntegration {
  return {
    id: `c1_${over.platform}`,
    clientId: "c1",
    method: "oauth",
    connectedBy: "u1",
    connectedAt: NOW - DAY,
    updatedAt: NOW - DAY,
    credentials: {},
    ...over,
  } as ClientIntegration;
}

/** The single fetch the module made, as (url, init). */
function lastCall(): [string, RequestInit] {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return fetchMock.mock.calls[0] as [string, RequestInit];
}

function formBody(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body));
}

beforeEach(() => {
  resetTokenRefreshStateForTests();
  getClientIntegrationMock.mockReset().mockResolvedValue(null);
  markIntegrationExpiredMock.mockReset().mockResolvedValue(undefined);
  updateCredentialsMock.mockReset().mockResolvedValue(undefined);
  logMock.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TWITTER_CLIENT_ID", "x-app-id");
  vi.stubEnv("TWITTER_CLIENT_SECRET", "x-app-secret");
  vi.stubEnv("TIKTOK_CLIENT_KEY", "tt-key");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "tt-secret");
  vi.stubEnv("GOOGLE_CLIENT_ID", "g-app-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "g-app-secret");
  vi.stubEnv("REDDIT_CLIENT_ID", "r-app-id");
  vi.stubEnv("REDDIT_CLIENT_SECRET", "r-app-secret");
  vi.stubEnv("FACEBOOK_APP_ID", "fb-app-id");
  vi.stubEnv("FACEBOOK_APP_SECRET", "fb-app-secret");
  vi.stubEnv("LINKEDIN_CLIENT_ID", "li-app-id");
  vi.stubEnv("LINKEDIN_CLIENT_SECRET", "li-app-secret");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetTokenRefreshStateForTests();
});

/* ── Per-provider exchanges ─────────────────────────────────────────── */

describe("refreshIntegrationCredentials — per provider", () => {
  it("X: HTTP Basic app auth, grant_type=refresh_token, and the ROTATED refresh token comes back", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: "x-new", refresh_token: "x-rotated", expires_in: 7200 }),
    );

    const result = await refreshIntegrationCredentials(
      { platform: "twitter", credentials: { accessToken: "x-old", refreshToken: "x-refresh" } },
      { now: NOW },
    );

    const [url, init] = lastCall();
    expect(url).toBe("https://api.twitter.com/2/oauth2/token");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("x-app-id:x-app-secret").toString("base64")}`,
    );
    const body = formBody(init);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("x-refresh");
    expect(result).toEqual({
      outcome: "refreshed",
      credentials: {
        accessToken: "x-new",
        refreshToken: "x-rotated",
        expiresAt: String(NOW + 2 * HOUR),
      },
    });
  });

  it("TikTok: client_key/client_secret in the form (not Basic), and it rotates too", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: "tt-new", refresh_token: "tt-rotated", expires_in: 86400 }),
    );

    const result = await refreshIntegrationCredentials(
      { platform: "tiktok", credentials: { accessToken: "tt-old", refreshToken: "tt-refresh" } },
      { now: NOW },
    );

    const [url, init] = lastCall();
    expect(url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    const body = formBody(init);
    expect(body.get("client_key")).toBe("tt-key");
    expect(body.get("client_secret")).toBe("tt-secret");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("tt-refresh");
    expect(result).toEqual({
      outcome: "refreshed",
      credentials: {
        accessToken: "tt-new",
        refreshToken: "tt-rotated",
        expiresAt: String(NOW + DAY),
      },
    });
  });

  it.each([
    ["youtube", "g-yt"],
    ["google_search_console", "g-gsc"],
    ["google_analytics", "g-ga"],
    ["google_business_profile", "g-gbp"],
  ])(
    "%s: client_id/client_secret in the form, and the refresh token is NOT rotated",
    async (platform, token) => {
      // Google keeps the original refresh token and sends no new one — carrying
      // a `refreshToken: undefined` back out would overwrite the stored one
      // with nothing.
      fetchMock.mockResolvedValue(tokenResponse({ access_token: token, expires_in: 3599 }));

      const result = await refreshIntegrationCredentials(
        { platform, credentials: { accessToken: "g-old", refreshToken: "g-refresh" } },
        { now: NOW },
      );

      const [url, init] = lastCall();
      expect(url).toBe("https://oauth2.googleapis.com/token");
      const body = formBody(init);
      expect(body.get("client_id")).toBe("g-app-id");
      expect(body.get("client_secret")).toBe("g-app-secret");
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("g-refresh");
      expect(result).toEqual({
        outcome: "refreshed",
        credentials: { accessToken: token, expiresAt: String(NOW + 3599 * 1000) },
      });
    },
  );

  it("Reddit: HTTP Basic app auth plus the descriptive User-Agent Reddit demands", async () => {
    fetchMock.mockResolvedValue(tokenResponse({ access_token: "r-new", expires_in: 3600 }));

    const result = await refreshIntegrationCredentials(
      { platform: "reddit", credentials: { accessToken: "r-old", refreshToken: "r-refresh" } },
      { now: NOW },
    );

    const [url, init] = lastCall();
    expect(url).toBe("https://www.reddit.com/api/v1/access_token");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("r-app-id:r-app-secret").toString("base64")}`,
    );
    expect(headers["User-Agent"]).toMatch(/karoscmo/);
    expect(formBody(init).get("refresh_token")).toBe("r-refresh");
    expect(result).toEqual({
      outcome: "refreshed",
      credentials: { accessToken: "r-new", expiresAt: String(NOW + HOUR) },
    });
  });

  it.each(["facebook", "instagram"])(
    "%s: GETs graph oauth/access_token with fb_exchange_token and the CURRENT long-lived token",
    async (platform) => {
      fetchMock.mockResolvedValue(
        tokenResponse({ access_token: "meta-new", expires_in: 5_183_944 }),
      );

      const result = await refreshIntegrationCredentials(
        { platform, credentials: { accessToken: "meta-current", pageId: "page_1" } },
        { now: NOW },
      );

      const [rawUrl, init] = lastCall();
      const url = new URL(rawUrl);
      expect(init.method).toBe("GET");
      expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v20.0/oauth/access_token");
      expect(url.searchParams.get("grant_type")).toBe("fb_exchange_token");
      expect(url.searchParams.get("client_id")).toBe("fb-app-id");
      expect(url.searchParams.get("client_secret")).toBe("fb-app-secret");
      expect(url.searchParams.get("fb_exchange_token")).toBe("meta-current");
      // Only what changed: `pageId` is the caller's to keep.
      expect(result).toEqual({
        outcome: "refreshed",
        credentials: {
          accessToken: "meta-new",
          expiresAt: String(NOW + 5_183_944 * 1000),
        },
      });
    },
  );

  it.each(["linkedin", "linkedin_community"])(
    "%s: reports unsupported and sends NOTHING — re-consent is the only path",
    async (platform) => {
      const result = await refreshIntegrationCredentials(
        { platform, credentials: { accessToken: "li-old", refreshToken: "li-refresh" } },
        { now: NOW },
      );

      expect(result).toEqual({ outcome: "unsupported" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(isRefreshablePlatform(platform)).toBe(false);
    },
  );

  it("falls back to the provider's documented lifetime when expires_in is missing", async () => {
    fetchMock.mockResolvedValue(tokenResponse({ access_token: "x-new", refresh_token: "x-rot" }));

    const result = await refreshIntegrationCredentials(
      { platform: "twitter", credentials: { refreshToken: "x-refresh" } },
      { now: NOW },
    );

    // Never absent: for a short-lived provider a missing expiry means "refresh
    // on every call", and X kills the previous refresh token on every use.
    expect(result).toMatchObject({ credentials: { expiresAt: String(NOW + 2 * HOUR) } });
  });

  it("refuses to call anything when this app's OAuth credentials are unset", async () => {
    vi.stubEnv("TWITTER_CLIENT_ID", "");
    vi.stubEnv("TWITTER_CLIENT_SECRET", "");

    const error = await refreshIntegrationCredentials(
      { platform: "twitter", credentials: { refreshToken: "x-refresh" } },
      { now: NOW },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TokenRefreshError);
    expect((error as TokenRefreshError).code).toBe("not_configured");
    // Not the client's problem: a missing env var must not read as a dead token.
    expect((error as TokenRefreshError).permanent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a 400 as a dead token set and a 503 as try-again", async () => {
    fetchMock.mockResolvedValueOnce(refusal(400, "invalid_grant"));
    const rejected = await refreshIntegrationCredentials(
      { platform: "reddit", credentials: { refreshToken: "r-refresh" } },
      { now: NOW },
    ).catch((e: unknown) => e as TokenRefreshError);
    expect(rejected).toBeInstanceOf(TokenRefreshError);
    expect((rejected as TokenRefreshError).code).toBe("rejected");
    expect((rejected as TokenRefreshError).permanent).toBe(true);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    const down = await refreshIntegrationCredentials(
      { platform: "reddit", credentials: { refreshToken: "r-refresh" } },
      { now: NOW },
    ).catch((e: unknown) => e as TokenRefreshError);
    expect((down as TokenRefreshError).code).toBe("unavailable");
    expect((down as TokenRefreshError).permanent).toBe(false);
  });
});

/* ── When a refresh happens ─────────────────────────────────────────── */

describe("the five-minute rule", () => {
  it("leaves a token with more than five minutes on it alone", async () => {
    const creds = {
      accessToken: "x-old",
      refreshToken: "x-refresh",
      expiresAt: String(NOW + 10 * MINUTE),
    };
    expect(needsRefresh({ platform: "twitter", credentials: creds }, NOW)).toBe(false);

    const out = await getFreshIntegrationCredentials(
      integration({ platform: "twitter", credentials: creds }),
      { now: NOW },
    );

    expect(out).toEqual(creds);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateCredentialsMock).not.toHaveBeenCalled();
  });

  it("refreshes a token inside the five-minute window", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: "x-new", refresh_token: "x-rotated", expires_in: 7200 }),
    );
    const creds = {
      accessToken: "x-old",
      refreshToken: "x-refresh",
      expiresAt: String(NOW + 4 * MINUTE),
    };
    expect(needsRefresh({ platform: "twitter", credentials: creds }, NOW)).toBe(true);

    const out = await getFreshIntegrationCredentials(
      integration({ platform: "twitter", credentials: creds }),
      { now: NOW },
    );

    expect(out.accessToken).toBe("x-new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats the boundary itself as due", () => {
    const creds = { refreshToken: "x-refresh", expiresAt: String(NOW + REFRESH_AHEAD_MS) };
    expect(needsRefresh({ platform: "twitter", credentials: creds }, NOW)).toBe(true);
  });

  it("refreshes a short-lived provider that has no expiry on record at all", async () => {
    // Everything connected before CN1: a refresh token was stored, its lifetime
    // was not. Assuming it is still good is how the cron used to 401.
    fetchMock.mockResolvedValue(tokenResponse({ access_token: "r-new", expires_in: 3600 }));
    const creds = { accessToken: "r-old", refreshToken: "r-refresh" };
    expect(needsRefresh({ platform: "reddit", credentials: creds }, NOW)).toBe(true);

    const out = await getFreshIntegrationCredentials(
      integration({ platform: "reddit", credentials: creds }),
      { now: NOW },
    );

    expect(out.accessToken).toBe("r-new");
    expect(credentialExpiresAt(out)).toBe(NOW + HOUR);
  });

  it("never refreshes what it cannot refresh: no refresh token, or LinkedIn", () => {
    expect(
      needsRefresh({ platform: "twitter", credentials: { accessToken: "pasted-by-hand" } }, NOW),
    ).toBe(false);
    expect(
      needsRefresh(
        { platform: "linkedin", credentials: { accessToken: "li", refreshToken: "li-r" } },
        NOW,
      ),
    ).toBe(false);
  });

  it("gives Meta seven days of warning instead of five minutes", () => {
    const base = { accessToken: "meta-current" };
    expect(
      needsRefresh(
        { platform: "facebook", credentials: { ...base, expiresAt: String(NOW + 30 * DAY) } },
        NOW,
      ),
    ).toBe(false);
    expect(
      needsRefresh(
        { platform: "facebook", credentials: { ...base, expiresAt: String(NOW + 3 * DAY) } },
        NOW,
      ),
    ).toBe(true);
  });
});

/* ── Persistence and failure handling ───────────────────────────────── */

describe("getFreshIntegrationCredentials", () => {
  it("persists only the rotated keys and hands the caller the merged set", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: "x-new", refresh_token: "x-rotated", expires_in: 7200 }),
    );

    const out = await getFreshIntegrationCredentials(
      integration({
        platform: "twitter",
        credentials: { accessToken: "x-old", refreshToken: "x-refresh", userId: "17" },
      }),
      { now: NOW },
    );

    expect(updateCredentialsMock).toHaveBeenCalledWith("c1", "twitter", {
      accessToken: "x-new",
      refreshToken: "x-rotated",
      expiresAt: String(NOW + 2 * HOUR),
    });
    // A field the refresh knows nothing about survives on the way out too.
    expect(out).toEqual({
      accessToken: "x-new",
      refreshToken: "x-rotated",
      expiresAt: String(NOW + 2 * HOUR),
      userId: "17",
    });
  });

  it("marks the integration expired and throws a permanent error when the provider refuses", async () => {
    fetchMock.mockResolvedValue(refusal());

    const error = await getFreshIntegrationCredentials(
      integration({ platform: "reddit", credentials: { refreshToken: "r-refresh" } }),
      { now: NOW },
    ).catch((e: unknown) => e as TokenRefreshError);

    expect(error).toBeInstanceOf(TokenRefreshError);
    expect(isIntegrationDeadError(error)).toBe(true);
    expect(markIntegrationExpiredMock).toHaveBeenCalledWith("c1", "reddit");
    expect(updateCredentialsMock).not.toHaveBeenCalled();
  });

  it("leaves the integration alone when the token endpoint is merely down", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    const error = await getFreshIntegrationCredentials(
      integration({ platform: "reddit", credentials: { refreshToken: "r-refresh" } }),
      { now: NOW },
    ).catch((e: unknown) => e as TokenRefreshError);

    expect((error as TokenRefreshError).code).toBe("unavailable");
    expect(isIntegrationDeadError(error)).toBe(false);
    expect(markIntegrationExpiredMock).not.toHaveBeenCalled();
  });

  it("adopts the credentials another process rotated instead of killing the channel", async () => {
    // The publish cron and the analytics sync run in separate instances. If the
    // sync spends the X refresh token first, this process's own POST comes back
    // invalid_grant — which is indistinguishable from a revoked connection
    // unless we look at what is actually stored now.
    fetchMock.mockResolvedValue(refusal());
    getClientIntegrationMock.mockResolvedValue({
      id: "c1_twitter",
      clientId: "c1",
      platform: "twitter",
      credentials: { accessToken: "x-from-other-process", refreshToken: "x-rotated-elsewhere" },
      updatedAt: NOW,
    });

    const out = await getFreshIntegrationCredentials(
      integration({ platform: "twitter", credentials: { accessToken: "x-old", refreshToken: "x-refresh" } }),
      { now: NOW },
    );

    expect(out.accessToken).toBe("x-from-other-process");
    expect(markIntegrationExpiredMock).not.toHaveBeenCalled();
  });

  it("spends a rotating refresh token once, however many callers ask at once", async () => {
    // The publish cron runs a client's due posts concurrently. Two POSTs of the
    // same X refresh token means the second gets invalid_grant and the channel
    // is marked dead one line after the first call renewed it.
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: "x-new", refresh_token: "x-rotated", expires_in: 7200 }),
    );
    const row = integration({
      platform: "twitter",
      credentials: { accessToken: "x-old", refreshToken: "x-refresh" },
    });

    const [a, b] = await Promise.all([
      getFreshIntegrationCredentials(row, { now: NOW }),
      getFreshIntegrationCredentials(row, { now: NOW }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe("x-new");
    expect(b.accessToken).toBe("x-new");
  });

  it("lays this process's newer credentials over a copy read before the refresh", async () => {
    // The cron reads every integration once, up front; the second post's copy
    // still holds the pre-refresh tokens.
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: "x-new", refresh_token: "x-rotated", expires_in: 7200 }),
    );
    const stale = integration({
      platform: "twitter",
      credentials: { accessToken: "x-old", refreshToken: "x-refresh" },
      updatedAt: NOW - DAY,
    });

    await getFreshIntegrationCredentials(stale, { now: NOW });
    const second = await getFreshIntegrationCredentials(stale, { now: NOW + MINUTE });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.accessToken).toBe("x-new");
  });

  it("never puts a token in a log line", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: "x-new", refresh_token: "x-rotated", expires_in: 7200 }),
    );

    await getFreshIntegrationCredentials(
      integration({
        platform: "twitter",
        credentials: { accessToken: "x-old", refreshToken: "x-refresh" },
      }),
      { now: NOW },
    );
    fetchMock.mockResolvedValue(refusal());
    await getFreshIntegrationCredentials(
      integration({ platform: "reddit", credentials: { refreshToken: "r-refresh" } }),
      { now: NOW },
    ).catch(() => {});

    expect(logMock).toHaveBeenCalled();
    const logged = JSON.stringify(logMock.mock.calls);
    for (const secret of ["x-new", "x-rotated", "x-old", "x-refresh", "r-refresh"]) {
      expect(logged).not.toContain(secret);
    }
  });
});

/* ── 401 → forced refresh → one retry ───────────────────────────────── */

describe("runWithFreshCredentials", () => {
  it("forces a refresh and retries once when the platform 401s on a token that looked fine", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: "x-new", refresh_token: "x-rotated", expires_in: 7200 }),
    );
    const row = integration({
      platform: "twitter",
      // Half an hour left: nothing would have refreshed this on schedule.
      credentials: {
        accessToken: "x-old",
        refreshToken: "x-refresh",
        expiresAt: String(NOW + 30 * MINUTE),
      },
    });
    const seen: string[] = [];
    const run = vi.fn(async (i: ClientIntegration) => {
      seen.push(i.credentials.accessToken);
      if (seen.length === 1) throw new TokenExpiredError("twitter", 401);
      return "posted";
    });

    const out = await runWithFreshCredentials(row, run, { now: NOW });

    expect(out).toBe("posted");
    expect(seen).toEqual(["x-old", "x-new"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markIntegrationExpiredMock).not.toHaveBeenCalled();
  });

  it("retries exactly once — a second 401 is the caller's to handle", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: "x-new", refresh_token: "x-rotated", expires_in: 7200 }),
    );
    const run = vi.fn(async () => {
      throw new TokenExpiredError("twitter", 401);
    });

    const error = await runWithFreshCredentials(
      integration({
        platform: "twitter",
        credentials: {
          accessToken: "x-old",
          refreshToken: "x-refresh",
          expiresAt: String(NOW + 30 * MINUTE),
        },
      }),
      run,
      { now: NOW },
    ).catch((e: unknown) => e);

    expect(run).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(TokenExpiredError);
    expect(isIntegrationDeadError(error)).toBe(true);
  });

  it("reports the platform's own 401 when the forced refresh is refused as well", async () => {
    fetchMock.mockResolvedValue(refusal());
    const run = vi.fn(async () => {
      throw new TokenExpiredError("reddit", 401);
    });

    const error = await runWithFreshCredentials(
      integration({
        platform: "reddit",
        credentials: {
          accessToken: "r-old",
          refreshToken: "r-refresh",
          expiresAt: String(NOW + HOUR),
        },
      }),
      run,
      { now: NOW },
    ).catch((e: unknown) => e);

    expect(run).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(TokenExpiredError);
    expect(markIntegrationExpiredMock).toHaveBeenCalledWith("c1", "reddit");
  });

  it("forces LinkedIn nowhere: the 401 stands and the client re-consents", async () => {
    const run = vi.fn(async () => {
      throw new TokenExpiredError("linkedin", 401);
    });

    const error = await runWithFreshCredentials(
      integration({
        platform: "linkedin",
        credentials: { accessToken: "li-old", expiresAt: String(NOW + 30 * DAY) },
      }),
      run,
      { now: NOW },
    ).catch((e: unknown) => e);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(TokenExpiredError);
    expect(markIntegrationExpiredMock).toHaveBeenCalledWith("c1", "linkedin");
  });

  it("passes a non-auth failure straight through without spending a refresh token", async () => {
    const run = vi.fn(async () => {
      throw new Error("instagram: media container still processing");
    });

    await expect(
      runWithFreshCredentials(
        integration({
          platform: "twitter",
          credentials: {
            accessToken: "x-old",
            refreshToken: "x-refresh",
            expiresAt: String(NOW + HOUR),
          },
        }),
        run,
        { now: NOW },
      ),
    ).rejects.toThrow(/media container/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markIntegrationExpiredMock).not.toHaveBeenCalled();
  });
});

/* ── The stored value itself ────────────────────────────────────────── */

describe("expiresAt", () => {
  it("turns the provider's seconds into absolute millis, and rejects what it cannot use", () => {
    expect(expiresAtFromExpiresIn(7200, NOW)).toBe(NOW + 2 * HOUR);
    expect(expiresAtFromExpiresIn("3599", NOW)).toBe(NOW + 3599 * 1000);
    expect(expiresAtFromExpiresIn(undefined, NOW)).toBeNull();
    expect(expiresAtFromExpiresIn("soon", NOW)).toBeNull();
    expect(expiresAtFromExpiresIn(0, NOW)).toBeNull();
    expect(expiresAtFromExpiresIn(-60, NOW)).toBeNull();
  });

  it("reads back a stored string, and treats a malformed one as absent", () => {
    expect(credentialExpiresAt({ expiresAt: String(NOW) })).toBe(NOW);
    expect(credentialExpiresAt({})).toBeNull();
    expect(credentialExpiresAt({ expiresAt: "" })).toBeNull();
    expect(credentialExpiresAt({ expiresAt: "never" })).toBeNull();
    expect(credentialExpiresAt(undefined)).toBeNull();
  });
});
