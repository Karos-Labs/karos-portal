/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicAgentSpec } from "@/lib/types";

/**
 * The de-duplication opt-in through the Studio's own save path
 * (docs/dynamic-agent-guardrails.md §1.2).
 *
 * The rule being pinned is default-deny: a boolean arriving from the wire is
 * coerced with `=== true`, never trusted for truthiness, and an agent that
 * never mentions the field saves with it OFF. That is what lets this feature
 * ship without changing a single existing agent's behaviour.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth");
vi.mock("@/lib/data");
vi.mock("@/lib/jobs/submit-custom", () => ({ submitDynamicAgentJob: vi.fn() }));
vi.mock("@/lib/dynamic-agent-generation", () => ({
  generateDynamicAgentDraft: vi.fn(),
  MAX_GENERATION_DESCRIPTION_CHARS: 5_000,
}));

import { getCurrentUser } from "@/lib/auth";
import * as data from "@/lib/data";

const ADMIN = {
  uid: "u-admin",
  email: "admin@karoslabs.test",
  name: "Admin",
  role: "KAROS_ADMIN",
  disabled: false,
  createdAt: 0,
} as any;

const GENERAL = {
  name: "Weekly poster",
  description: "d",
  category: "Content",
  icon: "Sparkles",
  creditsCost: 1,
  active: true,
  allowedClientIds: [],
};

function spec(patch: Partial<DynamicAgentSpec> = {}): DynamicAgentSpec {
  return {
    id: "spec-1",
    name: "Weekly poster",
    description: "d",
    category: "Content",
    icon: "Sparkles",
    creditsCost: 1,
    active: true,
    version: 3,
    allowedClientIds: [],
    inputSchema: [],
    steps: [{ id: "write", type: "ai", label: "Write", model: "sonnet", prompt: "Go", order: 0 }],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "u-admin",
    ...patch,
  };
}

function created() {
  return (data.createDynamicAgentSpec as any).mock.calls[0][0];
}
function updated() {
  return (data.updateDynamicAgentSpec as any).mock.calls[0][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  (getCurrentUser as any).mockResolvedValue(ADMIN);
  (data.createDynamicAgentSpec as any).mockResolvedValue("spec-new");
  (data.updateDynamicAgentSpec as any).mockResolvedValue(undefined);
  (data.getDynamicAgentSpec as any).mockResolvedValue(spec());
});

describe("createDynamicAgentSpecAction", () => {
  it("creates a new agent with de-duplication OFF when the field is absent", async () => {
    const { createDynamicAgentSpecAction } = await import("@/lib/actions/dynamic-agent-actions");
    await createDynamicAgentSpecAction(GENERAL);
    expect(created().dedupeAgainstHistory).toBe(false);
  });

  it("honours an explicit opt-in", async () => {
    const { createDynamicAgentSpecAction } = await import("@/lib/actions/dynamic-agent-actions");
    await createDynamicAgentSpecAction({ ...GENERAL, dedupeAgainstHistory: true });
    expect(created().dedupeAgainstHistory).toBe(true);
  });

  it("coerces a truthy non-boolean to OFF rather than accidentally opting in", async () => {
    const { createDynamicAgentSpecAction } = await import("@/lib/actions/dynamic-agent-actions");
    await createDynamicAgentSpecAction({ ...GENERAL, dedupeAgainstHistory: "yes" as unknown as boolean });
    expect(created().dedupeAgainstHistory).toBe(false);
  });
});

describe("updateDynamicAgentSpecAction", () => {
  it("turns de-duplication on", async () => {
    const { updateDynamicAgentSpecAction } = await import("@/lib/actions/dynamic-agent-actions");
    const result = await updateDynamicAgentSpecAction("spec-1", {
      general: { ...GENERAL, dedupeAgainstHistory: true },
    });
    expect(result.ok).toBe(true);
    expect(updated().dedupeAgainstHistory).toBe(true);
  });

  it("turns it back off — an omitted checkbox must CLEAR it, not leave it set", async () => {
    // The form always sends the whole general block, so "absent" here means the
    // admin unticked the box. Writing `false` rather than dropping the key is
    // what makes the toggle actually reversible against a merging store.
    (data.getDynamicAgentSpec as any).mockResolvedValue(spec({ dedupeAgainstHistory: true }));
    const { updateDynamicAgentSpecAction } = await import("@/lib/actions/dynamic-agent-actions");
    await updateDynamicAgentSpecAction("spec-1", { general: GENERAL });
    expect(updated().dedupeAgainstHistory).toBe(false);
  });

  it("does not touch the flag on a save that carries no general block at all", async () => {
    // An Inputs-tab or Pipeline-tab save must not silently reset the setting.
    (data.getDynamicAgentSpec as any).mockResolvedValue(spec({ dedupeAgainstHistory: true }));
    const { updateDynamicAgentSpecAction } = await import("@/lib/actions/dynamic-agent-actions");
    await updateDynamicAgentSpecAction("spec-1", {
      steps: [{ id: "write", type: "ai", label: "Write", model: "sonnet", prompt: "Go", order: 0 }],
    });
    expect(updated()).not.toHaveProperty("dedupeAgainstHistory");
  });

  it("still refuses a non-admin session", async () => {
    (getCurrentUser as any).mockResolvedValue({ ...ADMIN, role: "KAROS_EMPLOYEE" });
    const { updateDynamicAgentSpecAction } = await import("@/lib/actions/dynamic-agent-actions");
    await expect(
      updateDynamicAgentSpecAction("spec-1", { general: { ...GENERAL, dedupeAgainstHistory: true } }),
    ).rejects.toThrow(/forbidden/i);
    expect(data.updateDynamicAgentSpec).not.toHaveBeenCalled();
  });
});
