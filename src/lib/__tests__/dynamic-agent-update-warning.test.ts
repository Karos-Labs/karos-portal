import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The non-blocking dangling-reference warning on the manual save path
 * (updateDynamicAgentSpecAction), added alongside the free-text generator's
 * HARD version of the same check. Deliberately non-blocking here: making it
 * a hard failure on manual save would break every spec that already has a
 * dangling reference today.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth");
vi.mock("@/lib/data");
vi.mock("@/lib/jobs/submit-custom", () => ({ submitDynamicAgentJob: vi.fn() }));
vi.mock("@/lib/dynamic-agent-generation", () => ({ generateDynamicAgentDraft: vi.fn() }));

import { getCurrentUser } from "@/lib/auth";
import * as data from "@/lib/data";
import type { AppUser, DynamicAgentSpec } from "@/lib/types";

const ADMIN = { uid: "u-admin", email: "admin@karoslabs.test", name: "Admin", role: "KAROS_ADMIN", disabled: false, createdAt: 0 } as AppUser;

function spec(patch: Partial<DynamicAgentSpec> = {}): DynamicAgentSpec {
  return {
    id: "spec-1",
    name: "Test agent",
    description: "d",
    category: "c",
    icon: "Sparkles",
    creditsCost: 1,
    active: true,
    version: 3,
    allowedClientIds: [],
    inputSchema: [{ key: "company_name", type: "text", label: "Company name", required: true, order: 0 }],
    steps: [{ id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Go", order: 0 }],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "u-admin",
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
  vi.mocked(data.updateDynamicAgentSpec).mockResolvedValue(undefined);
});

describe("updateDynamicAgentSpecAction — dangling-reference warning", () => {
  it("saves cleanly with no warning when every reference resolves", async () => {
    vi.mocked(data.getDynamicAgentSpec).mockResolvedValue(spec());
    const { updateDynamicAgentSpecAction } = await import("@/lib/actions/dynamic-agent-actions");
    const result = await updateDynamicAgentSpecAction("spec-1", {
      steps: [{ id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Research {{inputs.company_name}}", order: 0 }],
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("still saves, but returns a warning, when the new pipeline has a dangling reference", async () => {
    vi.mocked(data.getDynamicAgentSpec).mockResolvedValue(spec());
    const { updateDynamicAgentSpecAction } = await import("@/lib/actions/dynamic-agent-actions");
    const result = await updateDynamicAgentSpecAction("spec-1", {
      steps: [{ id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "{{inputs.not_a_real_key}}", order: 0 }],
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toMatch(/not_a_real_key/);
    expect(data.updateDynamicAgentSpec).toHaveBeenCalledTimes(1); // the save still happened
  });

  it("checks the reference against the COMBINED spec (a step saved alone against the EXISTING input schema)", async () => {
    vi.mocked(data.getDynamicAgentSpec).mockResolvedValue(spec({ inputSchema: [{ key: "company_name", type: "text", label: "Company", required: true, order: 0 }] }));
    const { updateDynamicAgentSpecAction } = await import("@/lib/actions/dynamic-agent-actions");
    // Only the pipeline is saved this time — inputSchema comes from the EXISTING spec.
    const result = await updateDynamicAgentSpecAction("spec-1", {
      steps: [{ id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Research {{inputs.company_name}}", order: 0 }],
    });
    expect(result.warning).toBeUndefined();
  });

  it("does not run the check at all on a general-settings-only save", async () => {
    vi.mocked(data.getDynamicAgentSpec).mockResolvedValue(
      spec({ steps: [{ id: "a", type: "ai", label: "A", model: "sonnet", prompt: "{{inputs.dangling}}", order: 0 }] }),
    );
    const { updateDynamicAgentSpecAction } = await import("@/lib/actions/dynamic-agent-actions");
    const result = await updateDynamicAgentSpecAction("spec-1", {
      general: { name: "Renamed", description: "d", category: "c", icon: "Sparkles", creditsCost: 1, active: true, allowedClientIds: [] },
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});
