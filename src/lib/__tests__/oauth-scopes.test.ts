import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getRequestedScopes } from "@/lib/integrations/oauth";

/** Set an env var for one test and restore whatever was there (including unset). */
function withEnv(name: string, value: string | undefined, fn: () => void) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    fn();
  } finally {
    if (had) process.env[name] = previous;
    else delete process.env[name];
  }
}

/**
 * A scope change is a production auth change. These pin the exact resolved
 * scope list for providers the Google fix had no business touching, so a
 * future edit to oauth.ts cannot quietly move them.
 */
describe("no collateral scope drift on other providers", () => {
  it("linkedin requests exactly its four base scopes", () => {
    expect(getRequestedScopes("linkedin")).toEqual([
      "w_member_social",
      "openid",
      "profile",
      "email",
    ]);
  });

  it("linkedin_community requests exactly its two org scopes", () => {
    expect(getRequestedScopes("linkedin_community")).toEqual([
      "r_organization_social",
      "r_organization_admin",
    ]);
  });

  it("facebook requests base scopes only until Meta advanced access is approved", () => {
    withEnv("META_ADVANCED_ACCESS_APPROVED", undefined, () => {
      expect(getRequestedScopes("facebook")).toEqual([
        "pages_manage_posts",
        "pages_read_engagement",
        "publish_video",
      ]);
    });
  });

  it("facebook adds its advanced-access scopes when Meta approval is flagged", () => {
    withEnv("META_ADVANCED_ACCESS_APPROVED", "1", () => {
      expect(getRequestedScopes("facebook")).toEqual([
        "pages_manage_posts",
        "pages_read_engagement",
        "publish_video",
        "pages_read_user_content",
        "pages_show_list",
        "read_insights",
      ]);
    });
  });

  it("instagram requests base scopes only until Meta advanced access is approved", () => {
    withEnv("META_ADVANCED_ACCESS_APPROVED", undefined, () => {
      expect(getRequestedScopes("instagram")).toEqual([
        "instagram_content_publish",
        "instagram_manage_insights",
        "pages_read_engagement",
        "pages_manage_posts",
      ]);
    });
  });

  it("instagram adds business_management alongside pages_read_user_content once Meta approval is flagged", () => {
    withEnv("META_ADVANCED_ACCESS_APPROVED", "1", () => {
      expect(getRequestedScopes("instagram")).toEqual([
        "instagram_content_publish",
        "instagram_manage_insights",
        "pages_read_engagement",
        "pages_manage_posts",
        "pages_read_user_content",
        "business_management",
      ]);
    });
  });

  it("returns an empty list for an unknown provider", () => {
    expect(getRequestedScopes("not_a_platform")).toEqual([]);
  });
});
