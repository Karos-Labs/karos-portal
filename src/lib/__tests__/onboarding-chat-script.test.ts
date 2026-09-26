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
import { CHAT_LANGUAGES, OPENING_MESSAGE, isRtl, tr, type ChatLang, type MsgKey } from "@/lib/onboarding-i18n";

const LANGS = CHAT_LANGUAGES.map((l) => l.code) as ChatLang[];
const NEW = { prefilled: false, existing: false };
const ON_FILE = { prefilled: true, existing: true };

describe("onboarding chat script", () => {
  it("walks every step once, starting at the name and ending on the summary", () => {
    const seen: StepId[] = [];
    let id = STEPS[0]!.id;
    for (let i = 0; i < STEPS.length; i++) {
      seen.push(id);
      id = nextStep(id);
    }
    expect(seen).toEqual(STEPS.map((s) => s.id));
    expect(seen[0]).toBe("name");
    expect(nextStep("done")).toBe("done");
  });

  it("does not ask for the language: it is a dropdown, and the opening message is English only", () => {
    expect(STEPS.map((s) => s.id as string)).not.toContain("language");
    expect(OPENING_MESSAGE).toMatch(/^Hi, I'm Karos/);
    expect(OPENING_MESSAGE).toMatch(/what's your name\?$/);
    expect(OPENING_MESSAGE).not.toMatch(/[֐-׿؀-ۿ]/);
    for (const lang of LANGS) expect(botLine("name", lang, emptyAnswers(), NEW)).toBe(OPENING_MESSAGE);
  });

  it("asks every step in every language", () => {
    const a = { ...emptyAnswers(), name: "Dana Levi", companyName: "Acme", website: "acme.com" };
    for (const s of STEPS) {
      for (const lang of LANGS) {
        for (const ctx of [NEW, ON_FILE]) {
          const line = botLine(s.id, lang, a, ctx);
          expect(line.trim(), `${s.id}/${lang}`).not.toBe("");
          expect(line, `${s.id}/${lang} left a placeholder`).not.toMatch(/\{\w+\}/);
        }
      }
    }
  });

  it("speaks the chosen language, not English, after the opening", () => {
    const a = { ...emptyAnswers(), companyName: "Acme" };
    expect(botLine("goals", "he", a, NEW)).toMatch(/[֐-׿]/);
    expect(botLine("goals", "ar", a, NEW)).toMatch(/[؀-ۿ]/);
    expect(botLine("goals", "ru", a, NEW)).toMatch(/[Ѐ-ӿ]/);
    for (const lang of ["es", "fr", "pt", "de", "it"] as const) {
      expect(botLine("goals", lang, a, NEW), lang).not.toBe(botLine("goals", "en", a, NEW));
    }
    expect(isRtl("he") && isRtl("ar")).toBe(true);
    expect(LANGS.filter(isRtl)).toEqual(["he", "ar"]);
  });

  it("an existing client is told what is ON FILE, a new one what the scan found", () => {
    const withAccounts = { ...emptyAnswers(), handles: { instagram: "acme" }, competitors: ["Globex"] };
    const bare = emptyAnswers();
    expect(botLine("handles", "en", withAccounts, ON_FILE)).toMatch(/on file/);
    expect(botLine("handles", "en", bare, ON_FILE)).toMatch(/don't have any/);
    expect(botLine("handles", "en", withAccounts, NEW)).toMatch(/I found/);
    expect(botLine("handles", "en", bare, NEW)).toMatch(/couldn't find/);
    expect(botLine("competitors", "en", withAccounts, ON_FILE)).toMatch(/we track/);
    expect(botLine("competitors", "en", withAccounts, NEW)).toMatch(/look like/);
    expect(botLine("competitors", "en", bare, NEW)).toMatch(/skip/);
    expect(botLine("logo", "en", bare, { prefilled: false, existing: true })).toMatch(/don't have your logo/);
    expect(botLine("logo", "en", { ...bare, logoUrl: "https://a/l.png" }, NEW)).toMatch(/found this logo/);
  });

  it("never asks for the rest of the brand: the research after Finish produces it", () => {
    const a = { ...emptyAnswers(), companyName: "Acme" };
    for (const s of STEPS) {
      expect(botLine(s.id, "en", a, NEW), s.id).not.toMatch(/brand as (I read|we have)|is this you|palette|colou?rs|industry/i);
    }
  });

  it("tells the client the research starts at Finish and lands in their workspace", () => {
    const a = { ...emptyAnswers(), companyName: "Acme" };
    expect(botLine("done", "en", a, NEW)).toMatch(/start researching Acme[\s\S]*workspace[\s\S]*carry on/);
    expect(botLine("done", "he", a, NEW)).toMatch(/נתחיל לאסוף מידע על Acme[\s\S]*באזור האישי/);
    for (const lang of LANGS) expect(botLine("done", lang, a, NEW), lang).toContain("Acme");
  });

  it("offers chips for every choice and multi step, and every language as a content language", () => {
    const a = { ...emptyAnswers(), competitors: ["Globex"] };
    for (const s of STEPS.filter((x) => x.kind === "choice" || x.kind === "multi")) {
      expect(stepOptions(s.id, "en", a).length, s.id).toBeGreaterThan(0);
    }
    expect(stepOptions("contentLanguage", "fr", a).map((o) => o.value)).toEqual(LANGS);
    // Values stay stable English ids whatever language the chips are shown in.
    expect(stepOptions("goals", "ar", a).map((o) => o.value)).toEqual(stepOptions("goals", "en", a).map((o) => o.value));
  });

  it("accepts websites and refuses non-websites at the url step", () => {
    expect(looksLikeWebsite("acme.com")).toBe(true);
    expect(looksLikeWebsite("https://acme.co.il/x")).toBe(true);
    expect(looksLikeWebsite("acme")).toBe(false);
    expect(looksLikeWebsite("my company")).toBe(false);
  });

  it("an existing client's record is loaded, marked existing, and opens its steps as verifications", () => {
    const seed = seedFromClient(
      { name: "Acme", website: "acme.com", socialLinks: { instagram: "@acme", website: "acme.com" }, brandVoice: "Plain.", logoUrl: "https://cdn/l.png" },
      ["Globex", " ", "Initech"],
    );
    expect(seed.existing).toBe(true);
    expect(seed.handles).toEqual({ instagram: "@acme" });
    expect(seed.competitors).toEqual(["Globex", "Initech"]);
    for (const id of ["company", "website", "handles", "logo", "voice"] as const) expect(isPrefilled(id, seed), id).toBe(true);
  });

  it("reads the record's logo the way every portal surface does: uploaded first, then the guidelines'", () => {
    const fromGuidelines = seedFromClient({ name: "Acme", brandingGuidelines: { logoUrl: "https://cdn/g.png" } as never });
    expect(fromGuidelines.logoUrl).toBe("https://cdn/g.png");
    expect(fromGuidelines.existing).toBe(true);
    const both = seedFromClient({ name: "Acme", logoUrl: "https://cdn/u.png", brandingGuidelines: { logoUrl: "https://cdn/g.png" } as never });
    expect(both.logoUrl).toBe("https://cdn/u.png");
  });

  it("a company an admin only named is NOT existing: it gets the scan", () => {
    const seed = seedFromClient({ name: "Acme" });
    expect(seed.existing).toBeUndefined();
    expect(isPrefilled("company", seed)).toBe(true);
    expect(isPrefilled("handles", seed)).toBe(false);
    expect(isPrefilled("company", {})).toBe(false);
  });

  it("uses the scan's own posts, and falls back per tone in the chat language", () => {
    const written = [{ id: "bold" as const, post: "Acme ships payroll in a day." }];
    const samples = voiceSamples("Acme", "pt", written);
    expect(samples.find((s) => s.id === "bold")?.post).toBe("Acme ships payroll in a day.");
    expect(samples.find((s) => s.id === "warm")?.post).toContain("Acme");
    expect(samples.find((s) => s.id === "warm")?.label).toBe("Caloroso");
  });

  it("stores the picked voice as a brief plus the example the client chose", () => {
    const voice = brandVoiceFromSample("expert", "We analysed 200 workflows.");
    expect(voice).toMatch(/evidence-led/);
    expect(voice).toContain('"We analysed 200 workflows."');
  });

  it("sanitises answers from the browser: bounded, typed, unknown keys dropped", () => {
    const a = sanitizeChatAnswers({
      name: "x".repeat(500),
      language: "xx",
      handles: { instagram: " @acme ", tiktok: null, reddit: "nope", linkedin: 42 },
      voice: "sarcastic",
      contentLanguages: ["pt", "ar", "de-CH"],
      logoUrl: "http://insecure.example/logo.png",
      logoSource: "stolen",
      colors: ["#ff0000"],
      admin: true,
    });
    expect(a.name).toHaveLength(100);
    expect(a.language).toBe("en");
    expect(a.handles).toEqual({ instagram: "@acme", tiktok: null });
    expect(a.voice).toBe("");
    expect(a.contentLanguages).toEqual(["pt", "ar"]);
    for (const dropped of ["admin", "colors", "logoUrl", "logoSource"]) expect(dropped in a, dropped).toBe(false);
    expect(sanitizeChatAnswers({ language: "ar", logoUrl: "https://cdn/l.png", logoSource: "scan" })).toMatchObject({
      language: "ar",
      logoUrl: "https://cdn/l.png",
      logoSource: "scan",
    });
  });

  it("round-trips a draft and refuses anything that is not one (including the retired language step)", () => {
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
    expect(sanitizeChatDraft({ ...draft, step: "language" })).toBeNull();
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
      contentLanguages: ["he", "pt"],
    });
    expect(brief).toContain("More leads, Hiring");
    expect(brief).toContain("HR leads at mid-size companies");
    expect(brief).toContain("Globex");
    expect(brief).toContain("Hebrew and Portuguese");
    expect(intelBriefFromAnswers(emptyAnswers())).toBe("");
  });
});

describe("the translation table", () => {
  // Completeness itself is a type error, not a test: the table is
  // `satisfies Record<string, Record<ChatLang, string>>`. These ask what the
  // type cannot: that placeholders survive and nothing was left in English.
  it("fills every placeholder the English carries, in every language", () => {
    // A sample of keys with placeholders; a missing {company} would print the literal braces.
    const withVars: [MsgKey, Record<string, string | number>][] = [
      ["askRoleNamed", { name: "Dana" }],
      ["verifyCompany", { company: "Acme" }],
      ["verifyWebsite", { website: "acme.com" }],
      ["scanning", { website: "acme.com" }],
      ["confirmedAccounts", { count: 3 }],
      ["done", { company: "Acme" }],
      ["researchNotice", { company: "Acme" }],
      ["voicePostBold", { company: "Acme" }],
      ["voicePostWarm", { company: "Acme" }],
      ["voicePostExpert", { company: "Acme" }],
    ];
    for (const [key, vars] of withVars) {
      for (const lang of LANGS) {
        const text = tr(lang, key, vars);
        expect(text, `${key}/${lang}`).not.toMatch(/\{\w+\}/);
        for (const v of Object.values(vars)) expect(text, `${key}/${lang} lost ${v}`).toContain(String(v));
      }
    }
  });

  it("has a real translation for every language (no English copied into another language)", () => {
    for (const key of ["askGoals", "askAudience", "finishSetup", "channelsHint", "theseAreOurs"] as MsgKey[]) {
      const texts = LANGS.map((l) => tr(l, key));
      expect(new Set(texts).size, key).toBe(LANGS.length);
    }
  });
});
