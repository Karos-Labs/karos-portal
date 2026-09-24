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

  /**
   * `brand.voice` is what the ENGINE reads as the brand's voice:
   * `readBrandVoiceField` pulls it out as a first-class `brandVoice: "..."`
   * drafting input and every channel's copy step threads it into its prompt.
   * It used to be the tone keywords joined with commas, so the whole fleet was
   * being told this brand sounds like "precise, bold" while the client's real
   * voice spec — sentence unit, banned punctuation, the verbatim CTA line —
   * was never projected at all.
   */
  it("projects the client's voice statement as brand.voice, keeping the keywords as keywords", async () => {
    const { deps, written } = fakeDeps();
    await projectClientToWorkspace(
      { ...CLIENT, brandVoice: "Short declarative sentences. No exclamation marks. Every claim carries a number." } as never,
      undefined,
      deps,
    );
    const brand = written.get("clients/karoslabs/client/brand.json") as ReturnType<typeof toProjectedBrand>;
    expect(brand.voice).toBe("Short declarative sentences. No exclamation marks. Every claim carries a number.");
    expect(brand.toneKeywords).toEqual(["precise", "bold"]);
  });

  it("falls back to the keywords when the client has no voice statement yet", async () => {
    // Branding has run but nobody wrote a voice: projecting the keywords is
    // better than projecting nothing, and it is what this field used to be.
    const { deps, written } = fakeDeps();
    await projectClientToWorkspace(CLIENT, undefined, deps);
    const brand = written.get("clients/karoslabs/client/brand.json") as ReturnType<typeof toProjectedBrand>;
    expect(brand.voice).toBe("precise, bold");
  });

  /**
   * T-A11 / SCRUM-240. `gate.brandCompliance` reads
   * `clientContext.brand.forbiddenTerms` and ran in every workflow with `[]`,
   * because nothing in this repo had ever written the field. These three cases
   * are the producer: that a configured list arrives, that an empty one is
   * OMITTED rather than sent as `[]`, and that a client with terms but no
   * branding still gets a brand file at all.
   */
  it("projects the client's forbidden terms onto the brand the gate reads", async () => {
    const { deps, written } = fakeDeps();
    await projectClientToWorkspace({ ...CLIENT, forbiddenTerms: ["revolutionary", "best-in-class"] } as never, undefined, deps);
    const brand = written.get("clients/karoslabs/client/brand.json") as ReturnType<typeof toProjectedBrand>;
    expect(brand.forbiddenTerms).toEqual(["revolutionary", "best-in-class"]);
  });

  it("omits forbiddenTerms entirely when the client has none, so the gate reports unconfigured rather than clean", async () => {
    // An empty array and an absent key mean the same thing to the gate, and
    // only one of them can be misread as "this client bans nothing on purpose".
    const { deps, written } = fakeDeps();
    await projectClientToWorkspace({ ...CLIENT, forbiddenTerms: [] } as never, undefined, deps);
    const brand = written.get("clients/karoslabs/client/brand.json") as ReturnType<typeof toProjectedBrand>;
    expect(brand).not.toHaveProperty("forbiddenTerms");
  });

  it("writes a brand file for a client that has forbidden terms but has never had branding run", async () => {
    // The terms are entered on the settings page, which a client fills in long
    // before anyone runs branding. Gating brand.json on `brandingGuidelines`
    // would leave exactly those clients' gate unconfigured with the rules
    // visibly filled in — the failure this ticket exists to end.
    const { deps, written } = fakeDeps();
    const noBranding = { ...CLIENT, brandingGuidelines: undefined, brandVoice: undefined, forbiddenTerms: ["risk-free-ish"] };
    const result = await projectClientToWorkspace(noBranding as never, undefined, deps);
    expect(result.brand).toBe(true);
    const brand = written.get("clients/karoslabs/client/brand.json") as ReturnType<typeof toProjectedBrand>;
    expect(brand.forbiddenTerms).toEqual(["risk-free-ish"]);
    expect(brand.colors).toBeUndefined();
  });

  it("writes no brand file when the client has neither branding nor forbidden terms", async () => {
    const { deps, written } = fakeDeps();
    const bare = { ...CLIENT, brandingGuidelines: undefined, brandVoice: undefined, forbiddenTerms: [] };
    const result = await projectClientToWorkspace(bare as never, undefined, deps);
    expect(result.brand).toBe(false);
    expect(written.has("clients/karoslabs/client/brand.json")).toBe(false);
  });

  /**
   * The portal's logo upload writes `Client.logoUrl`. brand.json read ONLY
   * `brandingGuidelines.logoUrl`, which nothing in the portal writes, so an
   * uploaded logo never reached a post (owner request 2026-09-24).
   */
  it("projects the UPLOADED logo onto brand.json, ahead of the guidelines' own field", async () => {
    const { deps, written } = fakeDeps();
    const uploaded = "https://firebasestorage.googleapis.com/v0/b/bkt/o/clients%2Fc1%2Flogos%2Fa-logo.svg?alt=media&token=t";
    await projectClientToWorkspace({ ...CLIENT, logoUrl: uploaded } as never, undefined, deps);
    const brand = written.get("clients/karoslabs/client/brand.json") as ReturnType<typeof toProjectedBrand>;
    expect(brand.logoUrl).toBe(uploaded);
  });

  it("keeps projecting the guidelines' logo for a client that never uploaded one", async () => {
    const { deps, written } = fakeDeps();
    await projectClientToWorkspace(CLIENT, undefined, deps);
    const brand = written.get("clients/karoslabs/client/brand.json") as ReturnType<typeof toProjectedBrand>;
    expect(brand.logoUrl).toBe("https://karoslabs.com/icon.svg");
  });

  it("writes a brand file for a client whose only brand fact is an uploaded logo", async () => {
    // A client uploads a logo long before anyone runs branding; gating the
    // file on `brandingGuidelines` would drop exactly that logo.
    const { deps, written } = fakeDeps();
    const logoOnly = { ...CLIENT, brandingGuidelines: undefined, brandVoice: undefined, forbiddenTerms: [], logoUrl: "https://cdn.test/logo.png" };
    const result = await projectClientToWorkspace(logoOnly as never, undefined, deps);
    expect(result.brand).toBe(true);
    const brand = written.get("clients/karoslabs/client/brand.json") as ReturnType<typeof toProjectedBrand>;
    expect(brand.logoUrl).toBe("https://cdn.test/logo.png");
  });

  it("never projects a logo URL the engine refuses to fetch", async () => {
    // agent-engine downloads https only (`gs://` is refused by name), so any
    // other scheme would read as configured and render as absent.
    const { deps, written } = fakeDeps();
    const gsOnly = { ...CLIENT, brandingGuidelines: undefined, brandVoice: undefined, forbiddenTerms: [], logoUrl: "gs://bkt/clients/c1/logos/a.png" };
    const result = await projectClientToWorkspace(gsOnly as never, undefined, deps);
    expect(result.brand).toBe(false);
    expect(written.has("clients/karoslabs/client/brand.json")).toBe(false);
    expect(toProjectedBrand({ logoUrl: "http://acme.test/logo.png" }, "t").logoUrl).toBeUndefined();
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
