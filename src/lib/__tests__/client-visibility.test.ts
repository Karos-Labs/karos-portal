import { describe, expect, it } from "vitest";
import { hasAiProcessingFailure, toClientPortalView } from "@/lib/client-visibility";
import type { Client } from "@/lib/types";

function makeClient(patch: Partial<Client> = {}): Client {
  return {
    id: "c1",
    name: "Acme",
    status: "active",
    assignedEmployeeIds: ["staff-1", "staff-2"],
    clientKeyId: "ck_supersecretjointoken",
    agentsRepoSlug: "acme",
    logoStoragePath: "clients/c1/logo.png",
    onboardingError: "pipeline blew up on stage 3",
    customAgentIds: ["agent-1"],
    linkedinSeatLimit: 5,
    website: "https://acme.test",
    brandVoice: "warm",
    isAiProcessing: true,
    aiProcessingError: "out of credits",
    createdAt: 1,
    createdBy: "staff-1",
    ...patch,
  };
}

describe("toClientPortalView", () => {
  it("never carries the workspace join token into the client payload", () => {
    const view = toClientPortalView(makeClient());
    expect(view.clientKeyId).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("ck_supersecretjointoken");
  });

  it("drops internal routing, storage and pipeline fields", () => {
    const view = toClientPortalView(makeClient());
    expect(view.agentsRepoSlug).toBeUndefined();
    expect(view.logoStoragePath).toBeUndefined();
    expect(view.onboardingError).toBeUndefined();
    expect(view.customAgentIds).toBeUndefined();
    expect(view.linkedinSeatLimit).toBeUndefined();
    expect(view.assignedEmployeeIds).toEqual([]);
    expect(view.createdBy).toBe("");
  });

  it("keeps what the rail actually renders", () => {
    const view = toClientPortalView(makeClient());
    expect(view.id).toBe("c1");
    expect(view.name).toBe("Acme");
    expect(view.website).toBe("https://acme.test");
    expect(view.brandVoice).toBe("warm");
    expect(view.isAiProcessing).toBe(true);
  });

  // F69: both client-side readers only ever asked WHETHER the last run failed,
  // and aiProcessingError is a raw provider string (500 chars of it).
  it("tells the client THAT generation failed, never why", () => {
    const view = toClientPortalView(makeClient());
    expect(view.aiProcessingFailed).toBe(true);
    expect(view.aiProcessingError).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("out of credits");
  });

  it("sets no failure flag when the last run did not fail", () => {
    const view = toClientPortalView(makeClient({ aiProcessingError: undefined }));
    expect(view.aiProcessingFailed).toBeUndefined();
  });

  it("hasAiProcessingFailure answers the same on either side of the boundary", () => {
    const staff = makeClient();
    expect(hasAiProcessingFailure(staff)).toBe(true);
    expect(hasAiProcessingFailure(toClientPortalView(staff))).toBe(true);
    const healthy = makeClient({ aiProcessingError: undefined });
    expect(hasAiProcessingFailure(healthy)).toBe(false);
    expect(hasAiProcessingFailure(toClientPortalView(healthy))).toBe(false);
  });

  it("is built by construction — an unknown future field is excluded by default", () => {
    const withFuture = { ...makeClient(), someNewSecret: "leak-me" } as unknown as Client;
    expect(JSON.stringify(toClientPortalView(withFuture))).not.toContain("leak-me");
  });

  /**
   * The branding sub-projection used to spread-and-delete: `{ ...g }` with one
   * field rebuilt, plus an early `return g` for a record with no palette. So
   * every other field was opted IN by default, one level down from the
   * whitelist above — including the storage path this same test file asserts is
   * excluded at the top level.
   */
  describe("branding sub-projection", () => {
    const branded = (patch: Partial<Client["brandingGuidelines"]> = {}) =>
      toClientPortalView(
        makeClient({
          brandingGuidelines: {
            dominantColors: [
              { hex: "#e91e8c", dominanceRank: 1, role: "Logo fill", usagePct: 60 },
              { hex: "#101014", dominanceRank: 2, usagePct: 40 },
            ],
            fontHeading: "Söhne",
            toneKeywords: ["warm", "direct"],
            logoUrl: "https://cdn.test/logo.png",
            logoStoragePath: "clients/c1/branding/logo.png",
            updatedAt: 42,
            ...patch,
          },
        }),
      ).brandingGuidelines!;

    it("strips the agency's internal usage mix from every swatch", () => {
      const view = branded();
      expect(view.dominantColors?.every((c) => c.usagePct === undefined)).toBe(true);
      expect(JSON.stringify(view)).not.toContain("usagePct");
    });

    it("drops the storage path nested inside branding, not just at the top level", () => {
      expect(branded().logoStoragePath).toBeUndefined();
      expect(JSON.stringify(branded())).not.toContain("clients/c1/branding");
    });

    it("still drops it for a record with NO palette (the old early return)", () => {
      const view = branded({ dominantColors: undefined });
      expect(view.logoStoragePath).toBeUndefined();
      expect(view.dominantColors).toBeUndefined();
    });

    it("excludes an unknown future branding field by default", () => {
      const view = branded({ someNewInternal: "leak-me" } as never);
      expect(JSON.stringify(view)).not.toContain("leak-me");
    });

    it("keeps what the brand panel renders and lets the client edit", () => {
      const view = branded({
        primaryAccent: "#e91e8c",
        guidelines: "Warm, never shouty.",
        visualStyle: "Minimalist",
      });
      expect(view.dominantColors).toHaveLength(2);
      expect(view.dominantColors?.[0]).toEqual({
        hex: "#e91e8c",
        dominanceRank: 1,
        role: "Logo fill",
      });
      expect(view.fontHeading).toBe("Söhne");
      expect(view.toneKeywords).toEqual(["warm", "direct"]);
      expect(view.logoUrl).toBe("https://cdn.test/logo.png");
      expect(view.guidelines).toBe("Warm, never shouty.");
      expect(view.visualStyle).toBe("Minimalist");
      // The legacy scalar the modal falls back to for pre-palette records.
      expect(view.primaryAccent).toBe("#e91e8c");
      expect(view.updatedAt).toBe(42);
    });
  });
});
