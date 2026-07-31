import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getRequestedScopes } from "@/lib/integrations/oauth";

const BUSINESS_MANAGE = "https://www.googleapis.com/auth/business.manage";

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
 * Regression: the "Connect all Google services" button used to list
 * business.manage unconditionally. Google gates that scope behind a manual
 * access request and rejects the WHOLE authorize request while it is
 * unapproved ("Access blocked: this app's request is invalid"), so one
 * unusable scope was taking YouTube, Search Console and Analytics down with
 * it. It now lives in extendedScopes behind GOOGLE_BUSINESS_PROFILE_APPROVED.
 */
describe("google_unified scopes — business.manage is approval-gated", () => {
  it("omits business.manage when the approval flag is unset", () => {
    withEnv("GOOGLE_BUSINESS_PROFILE_APPROVED", undefined, () => {
      expect(getRequestedScopes("google_unified")).not.toContain(BUSINESS_MANAGE);
    });
  });

  it("omits business.manage when the flag is set to anything other than \"1\"", () => {
    withEnv("GOOGLE_BUSINESS_PROFILE_APPROVED", "true", () => {
      expect(getRequestedScopes("google_unified")).not.toContain(BUSINESS_MANAGE);
    });
    withEnv("GOOGLE_BUSINESS_PROFILE_APPROVED", "", () => {
      expect(getRequestedScopes("google_unified")).not.toContain(BUSINESS_MANAGE);
    });
  });

  it("includes business.manage once the flag is \"1\"", () => {
    withEnv("GOOGLE_BUSINESS_PROFILE_APPROVED", "1", () => {
      expect(getRequestedScopes("google_unified")).toContain(BUSINESS_MANAGE);
    });
  });

  // The point of the fix is to STOP narrowing what already works. YouTube,
  // Search Console and Analytics are approved on this Google app today; they
  // must survive the gate in both directions.
  const APPROVED_FAMILIES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/webmasters.readonly",
    "https://www.googleapis.com/auth/analytics.readonly",
  ];

  it("keeps every approved Google scope with the flag unset", () => {
    withEnv("GOOGLE_BUSINESS_PROFILE_APPROVED", undefined, () => {
      const scopes = getRequestedScopes("google_unified");
      for (const s of APPROVED_FAMILIES) expect(scopes).toContain(s);
      expect(scopes).toHaveLength(APPROVED_FAMILIES.length);
    });
  });

  it("keeps every approved Google scope with the flag set", () => {
    withEnv("GOOGLE_BUSINESS_PROFILE_APPROVED", "1", () => {
      const scopes = getRequestedScopes("google_unified");
      for (const s of APPROVED_FAMILIES) expect(scopes).toContain(s);
      expect(scopes).toEqual([...APPROVED_FAMILIES, BUSINESS_MANAGE]);
    });
  });
});

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

  it("the standalone google_business_profile connector still requests business.manage ungated", () => {
    // This connector exists precisely to request that scope. It is honestly
    // broken until Google approves — that is not the unified button's bug.
    withEnv("GOOGLE_BUSINESS_PROFILE_APPROVED", undefined, () => {
      expect(getRequestedScopes("google_business_profile")).toEqual([BUSINESS_MANAGE]);
    });
  });

  it("the other single-service Google connectors are untouched", () => {
    expect(getRequestedScopes("google_search_console")).toEqual([
      "https://www.googleapis.com/auth/webmasters.readonly",
    ]);
    expect(getRequestedScopes("google_analytics")).toEqual([
      "https://www.googleapis.com/auth/analytics.readonly",
    ]);
  });

  it("returns an empty list for an unknown provider", () => {
    expect(getRequestedScopes("not_a_platform")).toEqual([]);
  });
});
