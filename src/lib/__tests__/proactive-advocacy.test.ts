import { describe, it, expect } from "vitest";
import { buildArtifactGenerationPrompt } from "@/lib/ai/prompts/proactive-assistant";

describe("buildArtifactGenerationPrompt — employee advocacy injection", () => {
  it("injects employee resume when provided", () => {
    const prompt = buildArtifactGenerationPrompt(
      "Senior leadership POV",
      "A short LinkedIn caption about product strategy",
      "manual",
      "medium",
      "content_generation",
      "Acme Co",
      undefined,
      undefined,
      "Confident, concise, factual",
      undefined,
      undefined,
      { name: "Alex Engineer", resumeText: "Alex has 10 years experience building scalable platforms.", resumeUrl: null },
    );

    expect(prompt).toContain("EMPLOYEE ADVOCACY — WRITE AS THIS PERSON");
    expect(prompt).toContain("Alex has 10 years experience building scalable platforms.");
  });

  it("falls back to brand voice when no employee advocacy is provided", () => {
    const prompt = buildArtifactGenerationPrompt(
      "Weekly roundup",
      "Summary of this week's wins",
      "manual",
      "low",
      "content_generation",
      "Acme Co",
      undefined,
      undefined,
      "Friendly and helpful",
      undefined,
      undefined,
      undefined,
    );

    expect(prompt).toContain("BRAND VOICE GUIDANCE: Friendly and helpful");
    expect(prompt).not.toContain("EMPLOYEE ADVOCACY — WRITE AS THIS PERSON");
  });
});
