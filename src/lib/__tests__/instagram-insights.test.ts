import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchInstagramFollowerCount } from "@/lib/integrations/instagram-insights";

vi.mock("server-only", () => ({}));

const TOKEN = "EAAtest-system-user-token";
const IG_USER_ID = "17841400000000000";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchInstagramFollowerCount", () => {
  it("reads the account's current follower total", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ followers_count: 12_345 })));
    await expect(fetchInstagramFollowerCount(TOKEN, IG_USER_ID)).resolves.toBe(12_345);
  });
});
