import { describe, expect, it, vi } from "vitest";
import type { DynamicAgentStepDef } from "@/lib/types";

vi.mock("server-only", () => ({}));

/**
 * The generator is AI-only by contract (dynamic-agent-generation.ts's own
 * top DECISION comment — it never emits a `code` step), so every step this
 * module returns has `prompt`/`allowNetwork`/`allowClientData`. The return
 * type is still the full `DynamicAgentStepDef` union, though, so these tests
 * narrow explicitly rather than asserting the field exists.
 */
type AiStepDef = Extract<DynamicAgentStepDef, { type: "ai" }>;
function asAiStep(step: DynamicAgentStepDef): AiStepDef {
  if (step.type !== "ai") throw new Error(`Expected an AI step, got "${step.type}" — the generator is AI-only.`);
  return step;
}

/**
 * LIVE end-to-end coverage for generateDynamicAgentDraft, hitting the real
 * Anthropic API instead of mocking `generateObject`. Every other test in
 * this suite (dynamic-agent-generation.test.ts) mocks the model, which is
 * exactly what let the 2026-08 bug (maxOutputTokens: 4_000 truncating any
 * sufficiently detailed draft) ship unnoticed — a mock can't reproduce a
 * REAL model getting cut off mid-JSON. This file proves the fix against the
 * real API for descriptions across the full length range the product
 * allows, not just a mocked object handed back unconditionally.
 *
 * // DECISION: opt-in only (`RUN_LIVE_AI_TESTS=1`), never part of the default
 * `npm test`/CI run. It costs real tokens, needs a real `ANTHROPIC_API_KEY`,
 * and can be slow/flaky on model-side hiccups — none of which belong in a
 * suite that must be fast and hermetic. Run it explicitly after touching
 * `dynamic-agent-generation.ts`'s prompt, schema, or token ceiling:
 *
 *   RUN_LIVE_AI_TESTS=1 npx vitest run src/lib/__tests__/dynamic-agent-generation.e2e.test.ts
 */
const LIVE = process.env.RUN_LIVE_AI_TESTS === "1" && !!process.env.ANTHROPIC_API_KEY;

const SHORT_DESCRIPTION =
  "An agent that writes a weekly LinkedIn post recapping the client's latest blog article. Ask for the article URL and a desired tone.";

const MEDIUM_DESCRIPTION = `An agent that produces a monthly newsletter for a B2B SaaS client. Ask for the client's company name, the month's top three product updates, their brand tone (professional, casual, or technical), and whether the newsletter may mention pricing changes. First extract the facts into a clean brief, then write the final newsletter copy in the chosen tone, never inventing a feature or number that was not provided.`;

/** Deliberately dense: many distinct client-restriction fields and a long, multi-stage pipeline — the shape of description that used to get truncated at maxOutputTokens: 4_000. Still comfortably under the 5,000 char action-level cap. */
const LONG_DESCRIPTION = `I want a comprehensive dynamic agent that produces a full quarterly marketing content plan for a B2B SaaS client. It should ask for: the client's company name, their target industry, their main product name, a description of the product (up to 2000 characters), their top 3 competitors, their brand tone (a finite set: professional, casual, technical, bold), whether they allow humor in marketing copy, a list of banned words or phrases, their preferred content pillars (multi-select from a list), whether the agent may search the live web for competitor news, whether the agent may read the client's own stored documents (brand voice, market strategy, competitor analysis), the client's fiscal quarter start date, and any compliance restrictions specific to their regulated industry (e.g. financial services disclaimers, healthcare HIPAA language, or none).

The pipeline should: first extract and structure all the raw facts from the client's inputs and their own stored documents into a clean brief (haiku), then, if web access is granted, research the top 3 competitors' recent public announcements and summarize them factually with no speculation (haiku, allowNetwork true), then synthesize a strategic content plan naming several specific content ideas across the chosen pillars with rationale for each (sonnet, uses client's own documents if granted), then write full first-draft copy for the single highest-priority content idea in the client's specified tone, respecting every banned word/phrase and every compliance restriction named (sonnet, final step, must include an internal gaps section), and finally a fact-check step that reviews the draft against the extracted brief and flags any claim, statistic or company name not present in the brief (haiku). Every step should be given a clear one-word id and a short label. Only the fact-check and content-synthesis steps should reference earlier steps' outputs; the final writing step should reference the content plan and the extracted brief. Make sure every restriction becomes its own dedicated input field, never buried in a general notes field. Also ask for the specific social platforms this plan should be adapted for (multi-select: LinkedIn, Twitter/X, Instagram, Facebook, none) and whether images should be described for a designer to create (yes/no). Include a field for the client's preferred call-to-action style. Add a field asking whether the client wants this content plan to explicitly avoid mentioning any named competitor by name even in a positive light. Add a field for the specific date range this quarter covers. Add a field for the client's brand color palette description. Add a field for any current live promotions, discounts or events the client wants highlighted this quarter, and a field for anything the client explicitly wants left OUT of this quarter's content.`;

describe.skipIf(!LIVE)("generateDynamicAgentDraft — live end-to-end (real Anthropic API)", () => {
  it("produces a valid draft for a short description", async () => {
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft(SHORT_DESCRIPTION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.every((s) => s.type === "ai")).toBe(true);
  }, 60_000);

  it("produces a valid draft for a medium description", async () => {
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft(MEDIUM_DESCRIPTION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputSchema.length).toBeGreaterThan(0);
    expect(result.steps.length).toBeGreaterThan(0);
  }, 60_000);

  it("produces a valid draft for a long, richly-detailed description without getting cut off (the exact case that used to fail)", async () => {
    expect(LONG_DESCRIPTION.length).toBeLessThan(5_000); // stays under the action's own cap
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft(LONG_DESCRIPTION);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`Expected a valid draft for the long description, got: ${result.error}`);
    }
    expect(result.inputSchema.length).toBeGreaterThan(5);
    expect(result.steps.length).toBeGreaterThan(1);
    // Every AI-only invariant the editor relies on.
    for (const step of result.steps) {
      expect(asAiStep(step).prompt.length).toBeGreaterThan(0);
    }
  }, 180_000);

  it("produces a valid draft at the exact 5,000-character description cap", async () => {
    const atCap = (LONG_DESCRIPTION + " ").repeat(20).slice(0, 5_000);
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft(atCap);
    expect(result.ok).toBe(true);
  }, 180_000);

  // ── Network access / client data access: the generator must decide these
  // per step from its OWN understanding of the description, not default them
  // on (over-grant is a real capability risk) or leave them all off (the
  // Studio's per-step toggles would silently never reflect what the admin
  // actually described).

  it("grants allowNetwork ONLY to a step that needs live web research, and grants nothing else", async () => {
    const description =
      "An agent that, every time it runs, searches the live web for the client's latest press mentions and recent competitor news, then writes a short LinkedIn update summarizing what it found in a professional tone. It should NOT read any of the client's own stored documents, and should not ask the client anything beyond a company name.";
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft(description);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.steps.some((s) => asAiStep(s).allowNetwork)).toBe(true);
    expect(result.steps.every((s) => !asAiStep(s).allowClientData)).toBe(true);
  }, 60_000);

  it("grants allowClientData ONLY to a step that needs the client's stored documents, and grants nothing else", async () => {
    const description =
      "An agent that reads the client's own stored brand voice and market strategy documents to understand their tone and positioning, then writes a one-paragraph brand summary in that exact tone. It asks the client nothing and never searches the web.";
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft(description);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.steps.some((s) => asAiStep(s).allowClientData)).toBe(true);
    expect(result.steps.every((s) => !asAiStep(s).allowNetwork)).toBe(true);
    // The prompt's own rule: an agent that asks the client nothing gets an empty inputSchema.
    expect(result.inputSchema.length).toBe(0);
  }, 60_000);

  it("grants neither flag when the description needs neither capability", async () => {
    const description =
      "An agent that asks the client for a product name and a target audience, then writes three tagline options in a bold tone. No research, no stored documents — just the two answers provided.";
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft(description);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.steps.every((s) => !asAiStep(s).allowNetwork && !asAiStep(s).allowClientData)).toBe(true);
  }, 60_000);
});
