/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dataClientAgents from "@/lib/data-client-agents";

/**
 * §3 — a slot records that its day happened.
 *
 * `slot.status` is DERIVED: the asset is the source of truth for content state,
 * the slot for intent (template + day + note). The stamp exists so the plan can
 * say "this day is done" without re-deriving it from assets on every read — and
 * so a re-plan cannot silently overwrite a day the client already posted.
 * slot-plan's reorder validator has always refused a `posted` day; until this
 * landed, nothing could reach that state and the guard was dead code.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({
  listPlannedScheduledRuns: vi.fn(),
  updatePlannedScheduledRun: vi.fn(),
}));
vi.mock("@/lib/data-client-agents");

function slot(patch: Record<string, any> = {}): any {
  return {
    id: "ca1__2026-07-28",
    clientId: "c1",
    clientAgentId: "ca1",
    dateKey: "2026-07-28",
    templateKey: "by-the-numbers",
    status: "generated",
    assetId: "a1",
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncSlotPostedForAsset", () => {
  it("stamps the slot whose asset just went live", async () => {
    (dataClientAgents.listAgentSlots as any).mockResolvedValue([
      slot({ id: "other", assetId: "a-other" }),
      slot(),
    ]);
    const { syncSlotPostedForAsset } = await import("@/lib/client-agent-slots");

    const result = await syncSlotPostedForAsset({ clientId: "c1", assetId: "a1" });

    expect(result).toEqual({ changed: true });
    expect(dataClientAgents.updateAgentSlot).toHaveBeenCalledWith("ca1__2026-07-28", {
      status: "posted",
    });
  });

  it("is idempotent — a slot already posted is not rewritten", async () => {
    (dataClientAgents.listAgentSlots as any).mockResolvedValue([slot({ status: "posted" })]);
    const { syncSlotPostedForAsset } = await import("@/lib/client-agent-slots");

    const result = await syncSlotPostedForAsset({ clientId: "c1", assetId: "a1" });

    expect(result).toEqual({ changed: false });
    expect(dataClientAgents.updateAgentSlot).not.toHaveBeenCalled();
  });

  it("does nothing for an asset no slot fulfils", async () => {
    (dataClientAgents.listAgentSlots as any).mockResolvedValue([slot({ assetId: "a-other" })]);
    const { syncSlotPostedForAsset } = await import("@/lib/client-agent-slots");

    const result = await syncSlotPostedForAsset({ clientId: "c1", assetId: "a1" });

    expect(result).toEqual({ changed: false });
    expect(dataClientAgents.updateAgentSlot).not.toHaveBeenCalled();
  });

  it("ignores slots that carry no asset at all", async () => {
    (dataClientAgents.listAgentSlots as any).mockResolvedValue([
      slot({ assetId: null, status: "planned" }),
    ]);
    const { syncSlotPostedForAsset } = await import("@/lib/client-agent-slots");

    expect(await syncSlotPostedForAsset({ clientId: "c1", assetId: "a1" })).toEqual({
      changed: false,
    });
  });
});
