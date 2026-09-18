import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/followers/sync` — SCRUM-495, the writer that never existed.
 *
 * `recordClientFollowerSnapshot` had no caller anywhere in this repo, so
 * `clientFollowerSnapshots` was empty for every client on every platform: the
 * performance half of the learning loop contributed nothing and the audience
 * KPI had never rendered for anybody. Everything downstream of the write was
 * already built and tested; this is the only missing piece, so this file tests
 * exactly it — what gets written, what deliberately does NOT, and what happens
 * to a dead connection.
 *
 * The three fetchers are mocked. Their own shapes are pinned by
 * `instagram-insights.test.ts` and by the providers' own suites; what is under
 * test here is the sweep.
 */

const {
  cronGuardMock,
  listClientsMock,
  listIntegrationsMock,
  recordMock,
  markReauthMock,
  twitterMock,
  instagramMock,
  linkedinMock,
  freshMock,
} = vi.hoisted(() => ({
  cronGuardMock: vi.fn(),
  listClientsMock: vi.fn(),
  listIntegrationsMock: vi.fn(),
  recordMock: vi.fn(),
  markReauthMock: vi.fn(),
  twitterMock: vi.fn(),
  instagramMock: vi.fn(),
  linkedinMock: vi.fn(),
  freshMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/cron-auth", () => ({ requireCronSecret: cronGuardMock }));
vi.mock("@/lib/data", () => ({
  listClients: listClientsMock,
  listClientIntegrations: listIntegrationsMock,
  recordClientFollowerSnapshot: recordMock,
  markIntegrationForReauth: markReauthMock,
}));
vi.mock("@/lib/integrations/analytics-providers", () => ({
  fetchTwitterFollowerGrowth: twitterMock,
  fetchLinkedInOrgFollowers: linkedinMock,
}));
vi.mock("@/lib/integrations/instagram-insights", () => ({ fetchInstagramFollowerCount: instagramMock }));
vi.mock("@/lib/integrations/token-refresh", () => ({
  runWithFreshCredentials: freshMock,
  integrationMayBeRevivable: () => false,
}));

import { GET, followerCaptureDay } from "@/app/api/followers/sync/route";
import { TokenExpiredError } from "@/lib/integrations/publishers";
import type { ClientIntegration } from "@/lib/types";

const req = {} as Parameters<typeof GET>[0];

function integration(platform: string, credentials: Record<string, string>): ClientIntegration {
  return {
    id: `c1_${platform}`,
    clientId: "c1",
    platform,
    credentials,
    method: "oauth",
    status: "active",
    connectedBy: "u",
    connectedAt: 1,
  } as ClientIntegration;
}

async function body(res: unknown): Promise<Record<string, unknown>> {
  return (await (res as { json: () => Promise<Record<string, unknown>> }).json()) as Record<string, unknown>;
}

beforeEach(() => {
  cronGuardMock.mockReset().mockReturnValue(undefined);
  listClientsMock.mockReset().mockResolvedValue([{ id: "c1", name: "Acme" }]);
  listIntegrationsMock.mockReset().mockResolvedValue([]);
  recordMock.mockReset().mockResolvedValue(undefined);
  markReauthMock.mockReset().mockResolvedValue(undefined);
  twitterMock.mockReset();
  instagramMock.mockReset();
  linkedinMock.mockReset();
  // The real helper refreshes the token and re-runs on a 401; here it just
  // hands the integration straight through, so a case that wants an expiry
  // throws from the FETCHER and the route's own handling is what is tested.
  freshMock.mockReset().mockImplementation(async (i: ClientIntegration, run: (i: ClientIntegration) => Promise<unknown>) => run(i));
});

describe("the cron fence", () => {
  it("refuses without the cron secret, and reads nothing", async () => {
    const denial = { status: 401 };
    cronGuardMock.mockReturnValue(denial);

    expect(await GET(req)).toBe(denial);
    expect(listClientsMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("followerCaptureDay — the whole of the idempotence claim", () => {
  it("floors to the UTC day, so two runs on one day address one row", () => {
    const morning = Date.UTC(2026, 8, 17, 6, 31, 12);
    const evening = Date.UTC(2026, 8, 17, 23, 59, 59);
    expect(followerCaptureDay(morning)).toBe(Date.UTC(2026, 8, 17));
    expect(followerCaptureDay(morning)).toBe(followerCaptureDay(evening));
    // ...and a different day is a different row, or there is no series at all.
    expect(followerCaptureDay(Date.UTC(2026, 8, 18, 1))).not.toBe(followerCaptureDay(morning));
  });
});

describe("what gets written", () => {
  it("writes X's follower count under its own channel", async () => {
    listIntegrationsMock.mockResolvedValue([integration("twitter", { accessToken: "t" })]);
    twitterMock.mockResolvedValue({ followersCount: 4210, followingCount: 12, tweetCount: 90 });

    const res = await body(await GET(req));

    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0]![0]).toMatchObject({ clientId: "c1", platform: "twitter", count: 4210 });
    expect(recordMock.mock.calls[0]![0].capturedAt).toBe(res.capturedAt);
    expect(res.recordsWritten).toBe(1);
  });

  it("files the LinkedIn COMPANY PAGE's followers under `linkedin`, not under the integration that read them", async () => {
    // `linkedin_community` is a second developer app against the same page, not
    // a second channel a client has. A growth chart that listed
    // "linkedin_community" beside "twitter" would be naming our plumbing at a
    // client.
    listIntegrationsMock.mockResolvedValue([
      integration("linkedin_community", { accessToken: "t", organizationId: "urn:li:organization:42" }),
    ]);
    linkedinMock.mockResolvedValue({ organizationUrn: "urn:li:organization:42", followerCount: 880 });

    await GET(req);

    expect(recordMock.mock.calls[0]![0]).toMatchObject({ platform: "linkedin", count: 880 });
    expect(linkedinMock).toHaveBeenCalledWith("t", "urn:li:organization:42");
  });

  it("writes Instagram only when the business account id is on the integration", async () => {
    listIntegrationsMock.mockResolvedValue([
      integration("instagram", { accessToken: "t", pageId: "ig-9" }),
      // The same platform with no id: the OAuth path stores none, and this cron
      // deliberately does not re-walk `me/accounts` to find one — that resolver
      // lives in `publishInstagram` and a second copy is how the two drift.
      integration("instagram", { accessToken: "t" }),
    ]);
    instagramMock.mockResolvedValue(1500);

    const res = await body(await GET(req));

    expect(instagramMock).toHaveBeenCalledTimes(1);
    expect(instagramMock).toHaveBeenCalledWith("t", "ig-9");
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(res.unavailable).toBe(1);
  });
});

describe("what is deliberately NOT written", () => {
  it("writes nothing for a platform with no follower source, and says so by name", async () => {
    listIntegrationsMock.mockResolvedValue([
      integration("reddit", { accessToken: "t" }),
      integration("tiktok", { accessToken: "t" }),
      integration("linkedin", { accessToken: "t" }),
    ]);

    const res = await body(await GET(req));

    // Not even attempted: an absent platform is not an error and must not show
    // up as a measurement gap either.
    expect(recordMock).not.toHaveBeenCalled();
    expect(res.unavailable).toBe(0);
    expect(res.results).toEqual([]);
  });

  it("records a count of zero rather than treating it as missing", async () => {
    // A real new account has zero followers. Skipping it would put a hole in
    // the series exactly where the growth starts.
    listIntegrationsMock.mockResolvedValue([integration("twitter", { accessToken: "t" })]);
    twitterMock.mockResolvedValue({ followersCount: 0, followingCount: 0, tweetCount: 0 });

    await GET(req);

    expect(recordMock.mock.calls[0]![0]).toMatchObject({ count: 0 });
  });
});

describe("a connection that cannot be read", () => {
  it("flags an expired token for reconnect and keeps sweeping the other platforms", async () => {
    listIntegrationsMock.mockResolvedValue([
      integration("twitter", { accessToken: "t" }),
      integration("instagram", { accessToken: "t", pageId: "ig-9" }),
    ]);
    twitterMock.mockRejectedValue(new TokenExpiredError("twitter", 401));
    instagramMock.mockResolvedValue(1500);

    const res = await body(await GET(req));

    expect(markReauthMock).toHaveBeenCalledWith("c1", "twitter");
    expect(res.integrationsExpired).toBe(1);
    // The point of the per-integration try/catch: one dead channel costs the
    // others nothing.
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0]![0]).toMatchObject({ platform: "instagram", count: 1500 });
  });

  it("does not flag a reconnect for an ordinary error, and writes nothing for it", async () => {
    // A 500 from X is X's problem, not the client's. Asking them to reconnect a
    // working connection is worse than reporting the gap.
    listIntegrationsMock.mockResolvedValue([integration("twitter", { accessToken: "t" })]);
    twitterMock.mockRejectedValue(new Error("Twitter follower fetch failed: 503"));

    const res = await body(await GET(req));

    expect(markReauthMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(res.results).toEqual([
      { clientId: "c1", platform: "twitter", action: "skipped", detail: "Twitter follower fetch failed: 503" },
    ]);
  });

  it("one client's failure never ends the sweep", async () => {
    listClientsMock.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    listIntegrationsMock.mockImplementation(async (clientId: string) => {
      if (clientId === "c1") throw new Error("firestore unavailable");
      return [integration("twitter", { accessToken: "t" })];
    });
    twitterMock.mockResolvedValue({ followersCount: 7, followingCount: 0, tweetCount: 0 });

    const res = await body(await GET(req));

    expect(res.recordsWritten).toBe(1);
    expect(res.results).toContainEqual(
      expect.objectContaining({ clientId: "c1", action: "skipped", detail: expect.stringContaining("client sweep failed") }),
    );
  });
});
