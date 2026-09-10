import { vi, describe, expect, it } from "vitest";
import type { Client, ClientContextDoc } from "@/lib/types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent-engine/workspace-writer", () => ({
  isWorkspaceWriterConfigured: () => false,
  writeWorkspaceJson: async () => {
    throw new Error("production writer must not be reached from a unit test");
  },
}));

const { projectClientToWorkspace, selectDocsForProjection, toProjectedBrand, toProjectedProfile, toProjectedContextDoc } = await import(
  "../agent-engine/context-doc-projection"
);

const NOW = Date.parse("2026-09-05T14:00:00.000Z");

const CLIENT = {
  id: "iZLc0mtwSFXNKE2KkC2d",
  name: "Karos Labs",
  website: "https://karoslabs.com/",
  description: "AI marketing agency",
  industry: "AI Digital Marketing",
  agentsRepoSlug: "karoslabs",
  brandingGuidelines: {
    dominantColors: [
      { hex: "#1a1a1a", role: "Background / primary surface", dominanceRank: 1 },
      { hex: "#ff6b2c", role: "Accent / brand action colour", dominanceRank: 2 },
      { hex: "#f2f1ec", role: "Foreground / body text", dominanceRank: 3 },
    ],
    primaryAccent: "#ff6b2c",
    brandNeutralDark: "#1a1a1a",
    brandNeutralLight: "#f2f1ec",
    fontHeading: "Inter",
    fontBody: "Inter",
    toneKeywords: ["precise", "bold"],
    visualStyle: "Minimalist",
    logoUrl: "https://karoslabs.com/icon.svg",
    updatedAt: NOW,
  },
} as unknown as Client;

function doc(docType: string, tier: string, content: string, version = 1): ClientContextDoc {
  return { id: `${docType}-${tier}`, clientId: CLIENT.id, docType, tier, content, version, createdAt: NOW, updatedAt: NOW } as ClientContextDoc;
}

function fakeDeps() {
  const written = new Map<string, unknown>();
  return {
    written,
    deps: {
      isConfigured: () => true,
      write: async (path: string, value: unknown) => {
        written.set(path, value);
      },
      now: () => NOW,
    },
  };
}

describe("selectDocsForProjection", () => {
  it("projects C1's doc types only, preferring the internal tier", () => {
    const chosen = selectDocsForProjection([
      doc("target-audience", "client", "condensed"),
      doc("target-audience", "internal", "full"),
      doc("market-strategy", "client", "only the client tier exists"),
      doc("action-plan", "internal-only", "not in C1's set"),
      doc("brand-voice", "internal", "   "),
    ]);
    expect(chosen.map((d) => `${d.docType}:${d.tier}`).sort()).toEqual(["market-strategy:client", "target-audience:internal"]);
  });
});

describe("projectClientToWorkspace", () => {
  it("writes the projection the engine's tools actually read", async () => {
    // The prep failure: `context/<docType>.json` never existed, so every intel
    // report ran without the client's own audience and strategy.
    const { deps, written } = fakeDeps();
    const result = await projectClientToWorkspace(CLIENT, [doc("target-audience", "internal", "# Target Audience\nSenior CMOs.", 3)], deps);

    expect(result).toEqual({ projected: true, contextDocs: 1, brand: true, profile: true });
    expect([...written.keys()].sort()).toEqual([
      "clients/karoslabs/client/brand.json",
      "clients/karoslabs/client/profile.json",
      "clients/karoslabs/context/target-audience.json",
    ]);

    const ta = written.get("clients/karoslabs/context/target-audience.json") as ReturnType<typeof toProjectedContextDoc>;
    expect(ta.markdown).toBe("# Target Audience\nSenior CMOs.");
    expect(ta.source).toMatchObject({ firestoreDocId: "target-audience-internal", docVersion: 3, tier: "internal", projectedBy: "karoscmo" });
    expect(ta.source.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("projects the CURRENT brand, so the engine stops describing a palette the portal already corrected", async () => {
    // Prep's intel report called the background `#242429` a day after the
    // portal had established `#1a1a1a`: the engine's brand.json was a one-off
    // seed nobody refreshed.
    const { deps, written } = fakeDeps();
    await projectClientToWorkspace(CLIENT, undefined, deps);
    const brand = written.get("clients/karoslabs/client/brand.json") as ReturnType<typeof toProjectedBrand>;
    expect(brand.colors).toEqual(["#1a1a1a", "#ff6b2c", "#f2f1ec"]);
    expect(brand.dominantColors?.[1]).toMatchObject({ hex: "#ff6b2c", role: "Accent / brand action colour" });
    expect(brand.fonts).toEqual({ heading: "Inter", body: "Inter" });
    expect(brand.voice).toBe("precise, bold");
  });

  it("projects a hostname as the client domain, never an email address", async () => {
    // Prep's seeded profile carried `domains: ["hello@karoslabs.com"]`, which
    // no citation will ever match.
    const { deps, written } = fakeDeps();
    await projectClientToWorkspace(CLIENT, undefined, deps);
    const profile = written.get("clients/karoslabs/client/profile.json") as ReturnType<typeof toProjectedProfile>;
    expect(profile).toMatchObject({ name: "Karos Labs", industry: "AI Digital Marketing", domains: ["karoslabs.com"] });
  });

  it("does nothing, and says why, for a client with no agentsRepoSlug", async () => {
    const { deps, written } = fakeDeps();
    const result = await projectClientToWorkspace({ ...CLIENT, agentsRepoSlug: undefined } as Client, [], deps);
    expect(result.projected).toBe(false);
    expect(result.reason).toContain("agentsRepoSlug");
    expect(written.size).toBe(0);
  });

  it("does nothing when the workspace writer is not configured", async () => {
    const { deps, written } = fakeDeps();
    const result = await projectClientToWorkspace(CLIENT, [], { ...deps, isConfigured: () => false });
    expect(result.projected).toBe(false);
    expect(written.size).toBe(0);
  });

  it("never throws when the bucket rejects the write — a Regenerate must not fail on a side channel", async () => {
    const { deps } = fakeDeps();
    const result = await projectClientToWorkspace(CLIENT, [doc("brand-voice", "internal", "x")], {
      ...deps,
      write: async () => {
        throw new Error("403 storage.objects.create");
      },
    });
    expect(result.projected).toBe(false);
    expect(result.reason).toContain("403");
  });
});
