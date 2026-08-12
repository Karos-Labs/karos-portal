import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * generateDynamicAgentDraft (dynamic-agent-generation.ts): the free-text →
 * draft-spec generator. Only the model call is mocked (`generateObject`) —
 * the validation, the retry-once policy, and the AI-only/order-assignment
 * shaping all run for real, against the SAME validators a hand-built spec
 * clears (validateAndNormalizeInputSchema/Steps + checkDanglingReferences).
 */

vi.mock("server-only", () => ({}));
vi.mock("ai", () => {
  // Mirrors the real `NoObjectGeneratedError` shape this module now checks
  // (`NoObjectGeneratedError.isInstance(err) && err.finishReason === "length"`)
  // closely enough to exercise the truncation-retry path without hitting the
  // real AI SDK.
  class NoObjectGeneratedError extends Error {
    finishReason?: string;
    constructor(opts: { message?: string; finishReason?: string } = {}) {
      super(opts.message ?? "No object generated");
      this.name = "NoObjectGeneratedError";
      this.finishReason = opts.finishReason;
    }
    static isInstance(err: unknown): err is NoObjectGeneratedError {
      return err instanceof NoObjectGeneratedError;
    }
  }
  return { generateObject: vi.fn(), NoObjectGeneratedError };
});
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: vi.fn((id: string) => id) }));
vi.mock("@/services/logger", () => ({ logger: { logError: vi.fn(), logUsage: vi.fn() } }));

import { generateObject, NoObjectGeneratedError } from "ai";

/** Only `object` is ever read off the result (dynamic-agent-generation.ts), so a mock only needs that field. */
type GeneratedObjectResult = Awaited<ReturnType<typeof generateObject>>;
const objectResult = (object: unknown): GeneratedObjectResult => ({ object }) as unknown as GeneratedObjectResult;

/**
 * `NoObjectGeneratedError` is imported from "ai" for its TYPE (so
 * `dynamic-agent-generation.ts`'s `NoObjectGeneratedError.isInstance` check
 * lines up), but at runtime the module is mocked above with a lenient
 * constructor — the real AI SDK's constructor requires `response`/`usage`,
 * which this test has no reason to fabricate. This helper is the one place
 * that bridges the two: it constructs through the mocked class but with a
 * signature matching what's actually mocked, not the real SDK's.
 */
const truncationError = (finishReason: string) =>
  new (NoObjectGeneratedError as unknown as new (opts: { finishReason: string }) => Error)({ finishReason });

function validDraft(overrides: Partial<{ inputSchema: unknown[]; steps: unknown[]; notes: string[] }> = {}) {
  return {
    inputSchema: [{ key: "company_name", type: "text", label: "Company name", required: true }],
    steps: [{ id: "write", label: "Write", model: "sonnet", prompt: "Write about {{inputs.company_name}}.", allowNetwork: false, allowClientData: false }],
    notes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateDynamicAgentDraft", () => {
  it("returns a valid draft on the first attempt, with order assigned positionally and type: 'ai' on every step", async () => {
    vi.mocked(generateObject).mockResolvedValue(objectResult(validDraft()));
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("An agent that writes about a company.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputSchema).toEqual([
      { key: "company_name", type: "text", label: "Company name", required: true, order: 0 },
    ]);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ id: "write", type: "ai", order: 0, allowNetwork: false, allowClientData: false });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once when the first draft fails validation, and succeeds if the retry is clean", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(
        objectResult(validDraft({ steps: [{ id: "a", label: "A", model: "sonnet", prompt: "{{inputs.missing}}", allowNetwork: false, allowClientData: false }] })),
      )
      .mockResolvedValueOnce(objectResult(validDraft()));
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("An agent.");
    expect(result.ok).toBe(true);
    expect(generateObject).toHaveBeenCalledTimes(2);
    // the retry prompt carries the specific error back
    const secondCallArgs = vi.mocked(generateObject).mock.calls[1]![0] as { prompt: string };
    expect(secondCallArgs.prompt).toMatch(/missing/);
  });

  it("returns an error — never an invalid draft — when the draft is invalid twice in a row", async () => {
    const bad = validDraft({ steps: [{ id: "a", label: "A", model: "sonnet", prompt: "{{inputs.missing}}", allowNetwork: false, allowClientData: false }] });
    vi.mocked(generateObject).mockResolvedValue(objectResult(bad));
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("An agent.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/invalid draft twice/i);
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it("catches a dangling {{outputs.STEP}} reference to a step that does not exist, exactly like a hand-built spec would fail", async () => {
    vi.mocked(generateObject).mockResolvedValue(
      objectResult(validDraft({ steps: [{ id: "a", label: "A", model: "sonnet", prompt: "{{outputs.nonexistent}}", allowNetwork: false, allowClientData: false }] })),
    );
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("An agent.");
    expect(result.ok).toBe(false);
  });

  it("catches a dangling {{outputs.STEP}} reference to a LATER step", async () => {
    vi.mocked(generateObject).mockResolvedValue(
      objectResult(
        validDraft({
          steps: [
            { id: "a", label: "A", model: "sonnet", prompt: "{{outputs.b}}", allowNetwork: false, allowClientData: false },
            { id: "b", label: "B", model: "sonnet", prompt: "go", allowNetwork: false, allowClientData: false },
          ],
        }),
      ),
    );
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("An agent.");
    expect(result.ok).toBe(false);
  });

  it("produces a working zero-input draft when the model returns an empty inputSchema", async () => {
    vi.mocked(generateObject).mockResolvedValue(
      objectResult(
        validDraft({
          inputSchema: [],
          steps: [{ id: "write", label: "Write", model: "sonnet", prompt: "Write from the client's own documents.", allowNetwork: false, allowClientData: true }],
        }),
      ),
    );
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("An agent that works entirely from the client's own documents.");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inputSchema).toEqual([]);
  });

  it("surfaces a thrown error from the model call as a plain-English failure, not an unhandled rejection", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("rate limited"));
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("An agent.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  // ── Regression coverage for the 2026-08 bugfix: generation calls were
  // capped at maxOutputTokens: 4_000, far too low for a richly-detailed
  // draft. The model would get cut off mid-JSON (finishReason: "length"),
  // the AI SDK's JSON parse would throw `NoObjectGeneratedError`, and that
  // landed in the outer catch as a generic "Generation failed" message for
  // EVERY sufficiently detailed description — reproduced live against the
  // real Anthropic API before this fix. See dynamic-agent-generation.ts's
  // own doc comments on `GENERATION_MAX_OUTPUT_TOKENS` and
  // `truncationCorrection`.

  it("calls the model with the raised token ceiling (DOC_MAX_TOKENS), not the old 4,000 cap", async () => {
    vi.mocked(generateObject).mockResolvedValue(objectResult(validDraft()));
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const { DOC_MAX_TOKENS } = await import("@/lib/constants");
    await generateDynamicAgentDraft("An agent.");
    const callArgs = vi.mocked(generateObject).mock.calls[0]![0] as { maxOutputTokens: number };
    expect(callArgs.maxOutputTokens).toBe(DOC_MAX_TOKENS);
    expect(callArgs.maxOutputTokens).toBeGreaterThan(4_000);
  });

  it("retries once when the first generation is truncated (finishReason: length), and succeeds when the retry finishes cleanly", async () => {
    vi.mocked(generateObject)
      .mockRejectedValueOnce(truncationError("length"))
      .mockResolvedValueOnce(objectResult(validDraft()));
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("A very detailed agent description.");
    expect(result.ok).toBe(true);
    expect(generateObject).toHaveBeenCalledTimes(2);
    // The retry asks for something SHORTER, not a validation fix — a distinct
    // correction from the dangling-reference/invalid-draft one.
    const secondCallArgs = vi.mocked(generateObject).mock.calls[1]![0] as { prompt: string };
    expect(secondCallArgs.prompt).toMatch(/cut off|concise|shorter/i);
  });

  it("reports a clear error — not the generic fallback — when generation is truncated twice in a row", async () => {
    vi.mocked(generateObject).mockRejectedValue(truncationError("length"));
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("A very detailed agent description.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cut off twice/i);
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it("still recovers via retry when the first attempt is truncated and the SECOND is merely invalid (not truncated again)", async () => {
    vi.mocked(generateObject)
      .mockRejectedValueOnce(truncationError("length"))
      .mockResolvedValueOnce(
        objectResult(validDraft({ steps: [{ id: "a", label: "A", model: "sonnet", prompt: "{{inputs.missing}}", allowNetwork: false, allowClientData: false }] })),
      );
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("A very detailed agent description.");
    // Only ONE retry budget total — a truncation on attempt 1 consumes it, so
    // an invalid (not truncated) attempt 2 is reported, not retried again.
    expect(result.ok).toBe(false);
    expect(generateObject).toHaveBeenCalledTimes(2);
  });
});
