import { describe, expect, it } from "vitest";
import {
  buildArtifactGenerationPrompt,
  type EmployeeAdvocacyProfile,
} from "@/lib/ai/prompts/proactive-assistant";

/** Positional-arg helper so tests read by name. */
function prompt(opts: {
  taskType?: string;
  brandVoice?: string;
  advocacy?: EmployeeAdvocacyProfile;
  winners?: string;
} = {}): string {
  return buildArtifactGenerationPrompt(
    "Write a LinkedIn post on onboarding speed",
    "desc",
    "content_dispatch",
    "high",
    opts.taskType ?? "content_generation",
    "Acme",
    "saas",
    "https://acme.com",
    opts.brandVoice,
    undefined,
    undefined,
    opts.advocacy,
    opts.winners,
  );
}

describe("buildArtifactGenerationPrompt — employee advocacy (Phase 5.5 item 2)", () => {
  const ada: EmployeeAdvocacyProfile = {
    name: "Ada Lovelace",
    resumeText: "15 years in analytical engines; VP of Computation at Babbage & Co.",
  };

  it("writes as the employee, overriding the brand voice", () => {
    const out = prompt({ brandVoice: "Corporate and formal", advocacy: ada });
    expect(out).toContain("EMPLOYEE ADVOCACY — WRITE AS THIS PERSON, NOT THE BRAND");
    expect(out).toContain("Ada Lovelace");
    expect(out).not.toContain("BRAND VOICE GUIDANCE");
    // Resume analysed for tone/depth calibration.
    expect(out).toContain("ADA LOVELACE'S PROFESSIONAL BACKGROUND");
    expect(out).toContain("analytical engines");
    // Standards line switches to first-person authenticity.
    expect(out).toMatch(/authentic first-person voice/);
  });

  it("falls back to a resumeUrl reference when no raw text is on file", () => {
    const out = prompt({ advocacy: { name: "Grace", resumeUrl: "https://cv.example/grace.pdf" } });
    expect(out).toContain("https://cv.example/grace.pdf");
    expect(out).not.toContain("PROFESSIONAL BACKGROUND (analyse");
  });

  it("caps very long resume text at 2000 chars", () => {
    const long = "x".repeat(5000);
    const out = prompt({ advocacy: { name: "Max", resumeText: long } });
    expect(out).not.toContain("x".repeat(2001));
    expect(out).toContain("x".repeat(2000));
  });

  it("uses the brand voice when no advocacy target is set", () => {
    const out = prompt({ brandVoice: "Bold and playful" });
    expect(out).toContain("BRAND VOICE GUIDANCE: Bold and playful");
    expect(out).not.toContain("EMPLOYEE ADVOCACY");
  });
});

describe("buildArtifactGenerationPrompt — measured winners injection (Phase 1 loop)", () => {
  const winners = `- [engagement 92.1/100 · linkedin · social_post] "How we cut onboarding 40%" (6.2% engagement, 12,400 impressions)`;

  it("injects the successful-past-content block with emulate-don't-copy discipline", () => {
    const out = prompt({ winners });
    expect(out).toContain("SUCCESSFUL PAST CONTENT EXAMPLES — MEASURED WINNERS");
    expect(out).toContain("How we cut onboarding 40%");
    expect(out).toMatch(/Do NOT copy their wording/);
  });

  it("omits the block entirely when there are no measured winners", () => {
    expect(prompt({})).not.toContain("SUCCESSFUL PAST CONTENT EXAMPLES");
  });

  it("keeps the integration_action (email) branch free of winners/advocacy blocks", () => {
    const out = prompt({ taskType: "integration_action", winners, advocacy: { name: "Ada" } });
    expect(out).toContain("ready-to-send email");
    expect(out).not.toContain("SUCCESSFUL PAST CONTENT EXAMPLES");
    expect(out).not.toContain("EMPLOYEE ADVOCACY");
  });
});
