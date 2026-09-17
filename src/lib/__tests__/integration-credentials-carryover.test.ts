import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A staff save must not silently disable CN1's token refresh.
 *
 * `saveIntegrationAction` rebuilds the credentials map from the PLATFORM_REGISTRY
 * fields the form rendered and then FULL-OVERWRITES the stored map. The OAuth
 * bookkeeping the callback writes is not in that registry: `expiresAt` is
 * declared by no platform at all, and `refreshToken` only by linkedin_community,
 * youtube, tiktok, reddit and the three google_* entries — X, Instagram and
 * LinkedIn declare `accessToken` alone. So editing an account name on an X
 * channel used to throw its refresh token away, and editing a Meta channel used
 * to throw away the `expiresAt` that schedules the long-lived re-exchange, which
 * `needsRefresh` REQUIRES for that policy: the 60-day token then dies with no
 * proactive re-exchange, and the forced refresh at its 401 comes too late.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { upsertMock, listMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(async () => {}),
  listMock: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/lib/data", () => ({
  upsertClientIntegration: upsertMock,
  listClientIntegrations: listMock,
  deleteClientIntegration: vi.fn(async () => {}),
  setIntegrationAutoPublish: vi.fn(async () => {}),
  listAccessTokens: vi.fn(async () => []),
  updateAccessToken: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => null) }));
vi.mock("@/lib/tokens", () => ({ issueAccessToken: vi.fn() }));
vi.mock("@/lib/task-sync", () => ({ autoCompleteTasksOnIntegrationConnect: vi.fn(async () => {}) }));
vi.mock("@/lib/integrations/token-refresh", () => ({ forgetRefreshedCredentials: vi.fn() }));
vi.mock("@/lib/actions/_shared", () => ({
  requireStaff: vi.fn(async () => ({ uid: "u1", role: "KAROS_ADMIN" })),
}));

import { saveIntegrationAction } from "@/lib/actions/integration-actions";

beforeEach(() => {
  upsertMock.mockClear();
  listMock.mockReset().mockResolvedValue([]);
});

function savedCredentials(): Record<string, string> {
  const [payload] = upsertMock.mock.calls[0] as unknown as [{ credentials: Record<string, string> }];
  return payload.credentials;
}

describe("saveIntegrationAction keeps the OAuth bookkeeping no form renders", () => {
  it("carries the refresh token over on a platform whose registry never declares one", async () => {
    listMock.mockResolvedValue([
      {
        platform: "twitter",
        credentials: {
          accessToken: "x-stored",
          refreshToken: "x-refresh",
          expiresAt: "1800000000000",
        },
      },
    ]);

    // What the manual-credentials form posts for X: the one field it renders,
    // left blank because secrets never reach the browser.
    await saveIntegrationAction("c1", "twitter", { accessToken: "" }, "@karos");

    expect(savedCredentials()).toEqual({
      accessToken: "x-stored",
      refreshToken: "x-refresh",
      expiresAt: "1800000000000",
    });
  });

  it("keeps a Meta channel's expiresAt, without which the 7-day re-exchange never runs", async () => {
    listMock.mockResolvedValue([
      {
        platform: "instagram",
        credentials: { accessToken: "meta-long-lived", pageId: "17841", expiresAt: "1805000000000" },
      },
    ]);

    await saveIntegrationAction("c1", "instagram", { accessToken: "", pageId: "17841999" });

    const saved = savedCredentials();
    expect(saved.expiresAt).toBe("1805000000000");
    expect(saved.accessToken).toBe("meta-long-lived");
    // The field the operator actually edited still wins.
    expect(saved.pageId).toBe("17841999");
  });

  it("lets an operator replace a token by hand — carry-over fills blanks, it does not override", async () => {
    listMock.mockResolvedValue([
      { platform: "reddit", credentials: { accessToken: "r-old", refreshToken: "r-old-refresh" } },
    ]);

    await saveIntegrationAction("c1", "reddit", {
      accessToken: "r-pasted",
      refreshToken: "r-pasted-refresh",
    });

    expect(savedCredentials()).toEqual({
      accessToken: "r-pasted",
      refreshToken: "r-pasted-refresh",
    });
  });
});
