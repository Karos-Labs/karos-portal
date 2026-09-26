import { describe, expect, it } from "vitest";
import {
  STEPS,
  botLine,
  brandVoiceFromSample,
  emptyAnswers,
  intelBriefFromAnswers,
  isPrefilled,
  looksLikeWebsite,
  nextStep,
  sanitizeChatAnswers,
  sanitizeChatDraft,
  seedFromClient,
  stepOptions,
  voiceSamples,
  type StepId,
} from "@/lib/onboarding-chat";

describe("onboarding chat script", () => {
  it("walks every step once, ending on the summary", () => {
    const seen: StepId[] = [];
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

  it("says so when the scan found no accounts or competitors, instead of claiming it did", () => {
    const none = emptyAnswers();
    expect(botLine("handles", "en", none, false)).toMatch(/couldn't find/);
    expect(botLine("competitors", "en", none, false)).toMatch(/skip/);
    const some = { ...none, handles: { instagram: "acme" }, competitors: ["Globex"] };
    expect(botLine("handles", "en", some, false)).toMatch(/I found/);
    expect(botLine("competitors", "en", some, false)).toMatch(/look like/);
  });

  it("offers chips for every choice and multi step", () => {
    const a = { ...emptyAnswers(), competitors: ["Globex"] };
    for (const s of STEPS.filter((x) => x.kind === "choice" || x.kind === "multi")) {
      expect(stepOptions(s.id, "en", a).length, s.id).toBeGreaterThan(0);
    }
  });

  it("accepts websites and refuses non-websites at the url step", () => {
    expect(looksLikeWebsite("acme.com")).toBe(true);
    expect(looksLikeWebsite("https://acme.co.il/x")).toBe(true);
    expect(looksLikeWebsite("acme")).toBe(false);
    expect(looksLikeWebsite("my company")).toBe(false);
  });

  it("an existing client's record opens its steps as verifications", () => {
    const seed = seedFromClient({
      name: "Acme",
      website: "acme.com",
      socialLinks: { instagram: "@acme", website: "acme.com" },
      category: "Fintech",
      brandVoice: "Plain and warm.",
    });
    expect(seed.handles).toEqual({ instagram: "@acme" });
    for (const id of ["company", "website", "handles", "brand", "voice"] as const) expect(isPrefilled(id, seed), id).toBe(true);
    expect(isPrefilled("company", {})).toBe(false);
  });

  it("uses the scan's own posts, and falls back per tone", () => {
    const written = [{ id: "bold" as const, post: "Acme ships payroll in a day." }];
    const samples = voiceSamples("Acme", "en", written);
    expect(samples.find((s) => s.id === "bold")?.post).toBe("Acme ships payroll in a day.");
    expect(samples.find((s) => s.id === "warm")?.post).toContain("Acme");
  });

  it("stores the picked voice as a brief plus the example the client chose", () => {
    const voice = brandVoiceFromSample("expert", "We analysed 200 workflows.");
    expect(voice).toMatch(/evidence-led/);
    expect(voice).toContain('"We analysed 200 workflows."');
  });

  it("sanitises answers from the browser: bounded, typed, unknown keys dropped", () => {
    const a = sanitizeChatAnswers({
      name: "x".repeat(500),
      language: "fr",
      handles: { instagram: " @acme ", tiktok: null, reddit: "nope", linkedin: 42 },
      colors: ["#ff0000", "red", "javascript:alert(1)"],
      voice: "sarcastic",
      contentLanguages: ["he", "de"],
      logoUrl: "http://insecure.example/logo.png",
      admin: true,
    });
    expect(a.name).toHaveLength(100);
    expect(a.language).toBe("en");
    expect(a.handles).toEqual({ instagram: "@acme", tiktok: null });
    expect(a.colors).toEqual(["#ff0000"]);
    expect(a.voice).toBe("");
    expect(a.contentLanguages).toEqual(["he"]);
    expect(a.logoUrl).toBeUndefined();
    expect("admin" in a).toBe(false);
  });

  it("round-trips a draft and refuses anything that is not one", () => {
    const draft = {
      step: "goals",
      answers: { ...emptyAnswers(), name: "Dana" },
      messages: [{ id: 1, from: "bot", text: "hi" }, { from: "system", text: "x" }],
      voiceSamples: [{ id: "warm", post: "Hello" }, { id: "evil", post: "x" }],
    };
    const clean = sanitizeChatDraft(draft)!;
    expect(clean.step).toBe("goals");
    expect(clean.answers.name).toBe("Dana");
    expect(clean.messages).toHaveLength(1);
    expect(clean.voiceSamples).toEqual([{ id: "warm", post: "Hello" }]);
    expect(sanitizeChatDraft({ step: "nowhere" })).toBeNull();
    expect(sanitizeChatDraft("draft")).toBeNull();
    expect(sanitizeChatDraft(undefined)).toBeNull();
  });

  it("briefs the first Intel Report with what has no field of its own", () => {
    const brief = intelBriefFromAnswers({
      ...emptyAnswers(),
      name: "Dana",
      role: "Marketing",
      goals: ["leads", "hiring"],
      audience: "HR leads at mid-size companies",
      competitors: ["Globex"],
      contentLanguages: ["he"],
    });
    expect(brief).toContain("More leads, Hiring");
    expect(brief).toContain("HR leads at mid-size companies");
    expect(brief).toContain("Globex");
    expect(brief).toContain("Hebrew");
    expect(intelBriefFromAnswers(emptyAnswers())).toBe("");
  });
});
