import { describe, expect, it } from "vitest";
import {
  HANDLE_PLATFORMS,
  STEPS,
  botLine,
  brandSlug,
  emptyAnswers,
  isPrefilled,
  looksLikeWebsite,
  nextStep,
  seedFromClient,
  simulateDiscovery,
  stepOptions,
  voiceSamples,
} from "@/components/onboarding-chat/script";

describe("onboarding chat script", () => {
  it("walks every step once, ending on the summary", () => {
    const seen = [];
    let id = STEPS[0]!.id;
    for (let i = 0; i < STEPS.length; i++) {
      seen.push(id);
      id = nextStep(id);
    }
    expect(seen).toEqual(STEPS.map((s) => s.id));
    expect(nextStep("done")).toBe("done");
  });

  it("asks every step in both languages, and Hebrew lines are Hebrew", () => {
    const a = { ...emptyAnswers(), name: "Dana Levi", companyName: "Acme", website: "acme.com" };
    for (const s of STEPS) {
      for (const lang of ["en", "he"] as const) {
        for (const prefilled of [false, true]) {
          expect(botLine(s.id, lang, a, prefilled).trim(), `${s.id}/${lang}`).not.toBe("");
        }
      }
      if (s.id !== "language") expect(botLine(s.id, "he", a, false), s.id).toMatch(/[֐-׿]/);
    }
  });

  it("offers chips for every choice and multi step", () => {
    const a = { ...emptyAnswers(), competitors: ["Globex"] };
    for (const s of STEPS.filter((x) => x.kind === "choice" || x.kind === "multi")) {
      expect(stepOptions(s.id, "en", a).length, s.id).toBeGreaterThan(0);
    }
  });

  it("reads a brand slug from any website spelling", () => {
    expect(brandSlug("https://www.acme.co.il/about")).toBe("acme");
    expect(brandSlug("acme.com")).toBe("acme");
    expect(brandSlug("")).toBe("");
    expect(looksLikeWebsite("acme.com")).toBe(true);
    expect(looksLikeWebsite("https://acme.co.il/x")).toBe(true);
    expect(looksLikeWebsite("acme")).toBe(false);
    expect(looksLikeWebsite("my company")).toBe(false);
  });

  it("simulated discovery covers every card platform and always shows a missing one", () => {
    const d = simulateDiscovery("acme.com", "Acme");
    for (const p of HANDLE_PLATFORMS) expect(p in d.handles, p).toBe(true);
    expect(Object.values(d.handles)).toContain(null);
    expect(d.colors.every((c) => /^#[0-9A-F]{6}$/.test(c))).toBe(true);
  });

  it("an existing client's record opens its steps as verifications", () => {
    const seed = seedFromClient({
      name: "Acme",
      website: "acme.com",
      socialLinks: { instagram: "@acme", website: "acme.com" },
      category: "Fintech",
    });
    expect(seed.handles).toEqual({ instagram: "@acme" });
    for (const id of ["company", "website", "handles", "brand"] as const) expect(isPrefilled(id, seed), id).toBe(true);
    expect(isPrefilled("company", {})).toBe(false);
  });

  it("names the company in every voice sample", () => {
    for (const lang of ["en", "he"] as const) {
      for (const v of voiceSamples("Acme", lang)) expect(v.post).toContain("Acme");
    }
  });
});
