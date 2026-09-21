import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetaAccessNotGrantedError,
  fetchInstagramFollowerCount,
  resolveInstagramBusinessAccountId,
} from "@/lib/integrations/instagram-insights";
import { TokenExpiredError } from "@/lib/integrations/publishers";

vi.mock("server-only", () => ({}));

const TOKEN = "EAAtest-system-user-token";
const PAGE_ID = "1234567890";
const IG_USER_ID = "17841400000000000";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveInstagramBusinessAccountId", () => {
  it("resolves the linked Instagram account id from a Page id", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain(`/${PAGE_ID}?fields=instagram_business_account`);
      expect(url).toContain(`access_token=${TOKEN}`);
      return jsonResponse({ instagram_business_account: { id: IG_USER_ID } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveInstagramBusinessAccountId(TOKEN, PAGE_ID)).resolves.toBe(IG_USER_ID);
  });

  it("returns null, not an error, when the Page has no linked Instagram account", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    await expect(resolveInstagramBusinessAccountId(TOKEN, PAGE_ID)).resolves.toBeNull();
  });

  it("throws TokenExpiredError on Meta's dead-token shape (code 190)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { code: 190, message: "Error validating access token" } }, 401)));
    await expect(resolveInstagramBusinessAccountId(TOKEN, PAGE_ID)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("throws MetaAccessNotGrantedError on Meta's permission-pending shape (code 10)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: 10, message: "Application does not have permission for this action" } }, 403)),
    );
    await expect(resolveInstagramBusinessAccountId(TOKEN, PAGE_ID)).rejects.toBeInstanceOf(MetaAccessNotGrantedError);
  });
});

describe("fetchInstagramFollowerCount", () => {
  it("reads the account's current follower total", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ followers_count: 12_345 })));
    await expect(fetchInstagramFollowerCount(TOKEN, IG_USER_ID)).resolves.toBe(12_345);
  });
});
