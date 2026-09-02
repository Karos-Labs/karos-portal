import { describe, expect, it } from "vitest";
import { sanitizeIntegrations } from "../sanitize";
import type { ClientIntegration } from "@/lib/types";

function integration(overrides: Partial<ClientIntegration>): ClientIntegration {
  return {
    id: "c1_linkedin",
    clientId: "c1",
    platform: "linkedin",
    credentials: {},
    method: "oauth",
    connectedBy: "u1",
    connectedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("sanitizeIntegrations", () => {
  it("returns an empty list for a newly created client workspace with no integrations", () => {
    expect(sanitizeIntegrations([])).toEqual([]);
  });

  it("surfaces an existing client workspace's connected channels with public fields intact", () => {
    const raw = [
      // Was Facebook, which left PLATFORM_REGISTRY entirely (portal feedback
      // round 2, 2026-09) and so now sanitizes as an unknown platform — the
      // case the last test in this file covers. Instagram declares the same
      // two fields (a password `accessToken`, a text `pageId`), so the shape
      // under test is unchanged.
      integration({
        platform: "instagram",
        accountName: "Acme Co",
        status: "active",
        credentials: { accessToken: "secret-token", pageId: "123456789" },
      }),
      integration({
        platform: "linkedin",
        accountName: "Acme Inc.",
        status: "active",
        credentials: { accessToken: "secret-token", organizationId: "urn:li:organization:12345" },
      }),
    ];

    const views = sanitizeIntegrations(raw);

    expect(views).toHaveLength(2);
    const instagram = views.find((v) => v.platform === "instagram")!;
    expect(instagram.accountName).toBe("Acme Co");
    expect(instagram.status).toBe("active");
    expect(instagram.credentials).toEqual({ pageId: "123456789" });
    expect(instagram.secretsSet).toEqual(["accessToken"]);

    const linkedin = views.find((v) => v.platform === "linkedin")!;
    expect(linkedin.credentials).toEqual({ organizationId: "urn:li:organization:12345" });
  });

  it("never leaks password-typed fields, even though they are present on the raw doc", () => {
    const raw = [
      integration({
        platform: "youtube",
        credentials: { accessToken: "at", refreshToken: "rt", channelId: "UC123" },
      }),
    ];

    const [view] = sanitizeIntegrations(raw);
    expect(view.credentials).toEqual({ channelId: "UC123" });
    expect(view.secretsSet.sort()).toEqual(["accessToken", "refreshToken"]);
    expect(Object.values(view.credentials)).not.toContain("at");
    expect(Object.values(view.credentials)).not.toContain("rt");
  });

  it("treats fields undeclared in the platform registry as secret (allowlist, not denylist)", () => {
    const raw = [
      integration({
        platform: "twitter",
        credentials: { accessToken: "at", someUndeclaredToken: "leaky" },
      }),
    ];

    const [view] = sanitizeIntegrations(raw);
    expect(view.credentials).toEqual({});
  });

  it("degrades gracefully for an unknown platform id", () => {
    const raw = [integration({ platform: "myspace", credentials: { anything: "x" } })];
    const [view] = sanitizeIntegrations(raw);
    expect(view.credentials).toEqual({});
    expect(view.secretsSet).toEqual([]);
  });
});
