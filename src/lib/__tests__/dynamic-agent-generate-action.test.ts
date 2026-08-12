import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * generateDynamicAgentDraftAction (dynamic-agent-actions.ts): the admin-only
 * wrapper around generateDynamicAgentDraft. Auth and the generator itself are
 * mocked here — the RBAC source-scan (dynamic-agent-studio-rbac.test.ts)
 * already proves requireAdmin is called first in every action including this
 * one; this file proves the ACTUAL runtime behavior: the character cap, the
 * pass-through of a generator error, and — the specific thing an auto-save
 * regression would violate — that this action never touches Firestore.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth");
vi.mock("@/lib/data");
vi.mock("@/lib/jobs/submit-custom", () => ({ submitDynamicAgentJob: vi.fn() }));
vi.mock("@/lib/dynamic-agent-generation", () => ({
  generateDynamicAgentDraft: vi.fn(),
  // The real value, not a mock — the cap itself is a plain constant this
  // module re-exports unchanged; only the model-calling function is faked.
  MAX_GENERATION_DESCRIPTION_CHARS: 5_000,
}));

import { getCurrentUser } from "@/lib/auth";
import * as data from "@/lib/data";
import { generateDynamicAgentDraft } from "@/lib/dynamic-agent-generation";
import type { AppUser } from "@/lib/types";

const ADMIN = { uid: "u-admin", email: "admin@karoslabs.test", name: "Admin", role: "KAROS_ADMIN", disabled: false, createdAt: 0 } as AppUser;
const EMPLOYEE = { uid: "u-emp", email: "emp@karoslabs.test", name: "Employee", role: "KAROS_EMPLOYEE", disabled: false, createdAt: 0 } as AppUser;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateDynamicAgentDraftAction", () => {
  it("refuses a non-admin session before calling the generator at all", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(EMPLOYEE);
    const { generateDynamicAgentDraftAction } = await import("@/lib/actions/dynamic-agent-actions");
    await expect(generateDynamicAgentDraftAction({ description: "An agent." })).rejects.toThrow(/Forbidden/i);
    expect(generateDynamicAgentDraft).not.toHaveBeenCalled();
  });

  it("rejects an empty description before calling the generator", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const { generateDynamicAgentDraftAction } = await import("@/lib/actions/dynamic-agent-actions");
    const result = await generateDynamicAgentDraftAction({ description: "   " });
    expect(result.ok).toBe(false);
    expect(generateDynamicAgentDraft).not.toHaveBeenCalled();
  });

  it("rejects a description over the character cap with an English message, before calling the generator", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const { generateDynamicAgentDraftAction } = await import("@/lib/actions/dynamic-agent-actions");
    const { MAX_GENERATION_DESCRIPTION_CHARS } = await import("@/lib/dynamic-agent-generation");
    const tooLong = "x".repeat(MAX_GENERATION_DESCRIPTION_CHARS + 1);
    const result = await generateDynamicAgentDraftAction({ description: tooLong });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too long/i);
    expect(generateDynamicAgentDraft).not.toHaveBeenCalled();
  });

  it("accepts a description exactly at the character cap", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    vi.mocked(generateDynamicAgentDraft).mockResolvedValue({ ok: true, inputSchema: [], steps: [], notes: [] });
    const { generateDynamicAgentDraftAction } = await import("@/lib/actions/dynamic-agent-actions");
    const { MAX_GENERATION_DESCRIPTION_CHARS } = await import("@/lib/dynamic-agent-generation");
    const atCap = "x".repeat(MAX_GENERATION_DESCRIPTION_CHARS);
    const result = await generateDynamicAgentDraftAction({ description: atCap });
    expect(result.ok).toBe(true);
  });

  it("passes the generator's success through unchanged", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const draft = {
      ok: true as const,
      inputSchema: [{ key: "company_name", type: "text" as const, label: "Company", required: true, order: 0 }],
      steps: [{ id: "write", type: "ai" as const, label: "Write", model: "sonnet" as const, prompt: "go", order: 0 }],
      notes: ["Assumed the client wants a casual tone."],
    };
    vi.mocked(generateDynamicAgentDraft).mockResolvedValue(draft);
    const { generateDynamicAgentDraftAction } = await import("@/lib/actions/dynamic-agent-actions");
    const result = await generateDynamicAgentDraftAction({ description: "An agent." });
    expect(result).toEqual({ ok: true, inputSchema: draft.inputSchema, steps: draft.steps, notes: draft.notes });
  });

  it("passes the generator's error through unchanged", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    vi.mocked(generateDynamicAgentDraft).mockResolvedValue({ ok: false, error: "Generation failed twice." });
    const { generateDynamicAgentDraftAction } = await import("@/lib/actions/dynamic-agent-actions");
    const result = await generateDynamicAgentDraftAction({ description: "An agent." });
    expect(result).toEqual({ ok: false, error: "Generation failed twice." });
  });

  it("never writes to Firestore — this is an authoring tool, not a save path", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    vi.mocked(generateDynamicAgentDraft).mockResolvedValue({ ok: true, inputSchema: [], steps: [], notes: [] });
    const { generateDynamicAgentDraftAction } = await import("@/lib/actions/dynamic-agent-actions");
    await generateDynamicAgentDraftAction({ description: "An agent." });
    expect(data.createDynamicAgentSpec).not.toHaveBeenCalled();
    expect(data.updateDynamicAgentSpec).not.toHaveBeenCalled();
  });
});
