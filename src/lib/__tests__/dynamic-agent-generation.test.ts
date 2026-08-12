import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * generateDynamicAgentDraft (dynamic-agent-generation.ts): the free-text →
 * draft-spec generator. Only the model call is mocked (`generateObject`) —
 * the validation, the retry-once policy, and the AI-only/order-assignment
 * shaping all run for real, against the SAME validators a hand-built spec
 * clears (validateAndNormalizeInputSchema/Steps + checkDanglingReferences).
 */

vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: vi.fn((id: string) => id) }));
vi.mock("@/services/logger", () => ({ logger: { logError: vi.fn(), logUsage: vi.fn() } }));

import { generateObject } from "ai";

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
    vi.mocked(generateObject).mockResolvedValue({ object: validDraft() } as any);
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
      .mockResolvedValueOnce({
        object: validDraft({ steps: [{ id: "a", label: "A", model: "sonnet", prompt: "{{inputs.missing}}", allowNetwork: false, allowClientData: false }] }),
      } as any)
      .mockResolvedValueOnce({ object: validDraft() } as any);
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
    vi.mocked(generateObject).mockResolvedValue({ object: bad } as any);
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("An agent.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/invalid draft twice/i);
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it("catches a dangling {{outputs.STEP}} reference to a step that does not exist, exactly like a hand-built spec would fail", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: validDraft({ steps: [{ id: "a", label: "A", model: "sonnet", prompt: "{{outputs.nonexistent}}", allowNetwork: false, allowClientData: false }] }),
    } as any);
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("An agent.");
    expect(result.ok).toBe(false);
  });

  it("catches a dangling {{outputs.STEP}} reference to a LATER step", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: validDraft({
        steps: [
          { id: "a", label: "A", model: "sonnet", prompt: "{{outputs.b}}", allowNetwork: false, allowClientData: false },
          { id: "b", label: "B", model: "sonnet", prompt: "go", allowNetwork: false, allowClientData: false },
        ],
      }),
    } as any);
    const { generateDynamicAgentDraft } = await import("@/lib/dynamic-agent-generation");
    const result = await generateDynamicAgentDraft("An agent.");
    expect(result.ok).toBe(false);
  });

  it("produces a working zero-input draft when the model returns an empty inputSchema", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: validDraft({
        inputSchema: [],
        steps: [{ id: "write", label: "Write", model: "sonnet", prompt: "Write from the client's own documents.", allowNetwork: false, allowClientData: true }],
      }),
    } as any);
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
});
