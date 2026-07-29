/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as dataClientAgents from "@/lib/data-client-agents";

/**
 * B1 — the wiring that makes WP-9 reachable at all.
 *
 * Nothing else in the system writes `AgentSlot.optionRefs`, so without this the
 * picker, the pick action and the whole telemetry loop are dead code: `row.today`
 * is always null because no day ever has candidates. §8.3 makes the batch-sliced
 * daily options the SHIPPING degraded mode until Tomer's T7, not a placeholder.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");

const BATCH = [
  "# Account 1 · Company page @getkaros",
  "",
  "## Avenue 1 · Playbook",
  "",
  "> Ship it weekly.",
  "",
  "## Avenue 2 · Founder POV",
  "",
  "> What I learned.",
  "",
  "## Avenue 3 · News-reaction (live)",
  "",
  "> On today's news.",
  "",
  "# Account 2 · Albert Kattan",
  "",
  "## Avenue 4 · Teardown",
  "",
  "> A teardown.",
  "",
].join("\n");

const UMBRELLA = {
  id: "ca1",
  clientId: "c1",
  customAgentId: "ca-x",
  displayName: "X Agent",
  launchState: "live",
  slotMode: "options",
  templates: [],
  scheduleRunId: "pr1",
} as any;

function slot(dateKey: string, patch: Record<string, any> = {}): any {
  return {
    id: `ca1__${dateKey}`,
    clientId: "c1",
    clientAgentId: "ca1",
    dateKey,
    kind: "options",
    templateKey: "daily-post",
    status: "planned",
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const NOW = Date.parse("2026-07-28T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  (data.listPlannedScheduledRuns as any).mockResolvedValue([
    {
      id: "pr1",
      clientId: "c1",
      customAgentId: "ca-x",
      clientAgentId: "ca1",
      cadence: "weekly",
      status: "active",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      hour: 9,
      minute: 0,
      timeZone: "UTC",
    },
  ]);
  (data.listAssets as any).mockResolvedValue([
    { id: "batch-1", clientId: "c1", content: BATCH, createdAt: 5 },
    { id: "a-post", clientId: "c1", content: "Just a normal post.", createdAt: 9 },
  ]);
  (dataClientAgents.createAgentSlots as any).mockResolvedValue(0);
  (dataClientAgents.updateAgentSlot as any).mockResolvedValue(undefined);
});

describe("ensureSlotHorizon — options assignment (B1)", () => {
  it("gives each unassigned day its candidate drafts and points it at the batch", async () => {
    (dataClientAgents.listAgentSlots as any).mockResolvedValue([
      slot("2026-07-28"),
      slot("2026-07-29"),
    ]);
    const { ensureSlotHorizon } = await import("@/lib/client-agent-slots");

    const result = await ensureSlotHorizon(UMBRELLA, "u1", NOW);

    expect(result.assigned).toBe(1);
    const calls = (dataClientAgents.updateAgentSlot as any).mock.calls;
    expect(calls.length).toBe(1);
    const [slotId, patch] = calls[0];
    expect(slotId).toBe("ca1__2026-07-28");
    expect(patch.assetId).toBe("batch-1");
    expect(patch.optionRefs).toHaveLength(3);
    // Refs use the shared convention, so the learning log stays one namespace.
    expect(patch.optionRefs[0]).toContain(" · ");
  });

  it("never reassigns a day that already has options — a pick would be stranded", async () => {
    (dataClientAgents.listAgentSlots as any).mockResolvedValue([
      slot("2026-07-28", { optionRefs: ["Company page @getkaros · Avenue 1 · Playbook"] }),
    ]);
    const { ensureSlotHorizon } = await import("@/lib/client-agent-slots");

    const result = await ensureSlotHorizon(UMBRELLA, "u1", NOW);

    expect(result.assigned).toBeUndefined();
    expect(dataClientAgents.updateAgentSlot).not.toHaveBeenCalled();
  });

  it("skips days that have already passed — they can never be picked", async () => {
    (dataClientAgents.listAgentSlots as any).mockResolvedValue([
      slot("2026-07-20"),
      slot("2026-07-21"),
    ]);
    const { ensureSlotHorizon } = await import("@/lib/client-agent-slots");

    await ensureSlotHorizon(UMBRELLA, "u1", NOW);

    expect(dataClientAgents.updateAgentSlot).not.toHaveBeenCalled();
  });

  it("does nothing when the client has no X batch to slice", async () => {
    (data.listAssets as any).mockResolvedValue([
      { id: "a-post", clientId: "c1", content: "Just a normal post.", createdAt: 9 },
    ]);
    (dataClientAgents.listAgentSlots as any).mockResolvedValue([slot("2026-07-28")]);
    const { ensureSlotHorizon } = await import("@/lib/client-agent-slots");

    const result = await ensureSlotHorizon(UMBRELLA, "u1", NOW);

    expect(result.assigned).toBeUndefined();
    expect(dataClientAgents.updateAgentSlot).not.toHaveBeenCalled();
  });

  it("leaves a SINGLE-mode umbrella untouched — options are the X model only", async () => {
    (dataClientAgents.listAgentSlots as any).mockResolvedValue([slot("2026-07-28")]);
    const { ensureSlotHorizon } = await import("@/lib/client-agent-slots");

    await ensureSlotHorizon(
      {
        ...UMBRELLA,
        slotMode: "single",
        rotation: ["t1"],
        templates: [{ key: "t1", name: "T1", status: "active" }],
      },
      "u1",
      NOW,
    );

    expect(dataClientAgents.updateAgentSlot).not.toHaveBeenCalled();
  });

  it("does not assign for an umbrella that is not live", async () => {
    (dataClientAgents.listAgentSlots as any).mockResolvedValue([slot("2026-07-28")]);
    const { ensureSlotHorizon } = await import("@/lib/client-agent-slots");

    const result = await ensureSlotHorizon({ ...UMBRELLA, launchState: "curating" }, "u1", NOW);

    expect(result.skipped).toBe("not_live");
    expect(dataClientAgents.updateAgentSlot).not.toHaveBeenCalled();
  });
});
