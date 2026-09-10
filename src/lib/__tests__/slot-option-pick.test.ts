/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as dataClientAgents from "@/lib/data-client-agents";
import * as sharedActions from "@/lib/actions/_shared";
import * as xActions from "@/lib/actions/x-agent-actions";
import * as slots from "@/lib/client-agent-slots";

/**
 * §4.5c / WP-9 — the pick action's guards.
 *
 * The churn gate is the one that matters: a FUTURE day's options must not be
 * pickable. Offering them would confirm that tomorrow's posts already exist,
 * which is the single fact the whole slot model keeps indistinguishable (A3/A4).
 * The projection already refuses to send them; this is the server half, because
 * a payload the browser never received is not a permission check.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/actions/_shared");
vi.mock("@/lib/actions/x-agent-actions");
vi.mock("@/lib/client-agent-slots");
vi.mock("@/lib/client-agent-gate", () => ({
  clientAgentRunRefusal: vi.fn().mockResolvedValue(null),
}));

const CLIENT = {
  uid: "u-client",
  name: "Client User",
  role: "CLIENT_USER",
  clientId: "c1",
} as any;

/** Real DRAFTS.md shape: "# Account N · Title", "## Avenue", blockquote posts. */
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
  "# Account 2 · Albert Kattan",
  "",
  "## Avenue 1 · Playbook",
  "",
  "> My own build-in-public post.",
  "",
].join("\n");

const REF_A = "Company page @getkaros · Avenue 1 · Playbook";
const REF_B = "Company page @getkaros · Avenue 2 · Founder POV";
const REF_SEAT = "Albert Kattan · Avenue 1 · Playbook";

function slot(patch: Record<string, any> = {}): any {
  return {
    id: "ca1__2026-07-28",
    clientId: "c1",
    clientAgentId: "ca1",
    dateKey: "2026-07-28",
    kind: "options",
    templateKey: "daily-post",
    status: "generated",
    assetId: "batch-1",
    optionRefs: [REF_A, REF_B],
    optionPick: null,
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(new Date("2026-07-28T12:00:00Z"));
  (sharedActions.requireClientAccess as any).mockResolvedValue(CLIENT);
  (sharedActions.logActivity as any).mockResolvedValue(undefined);
  (dataClientAgents.getAgentSlot as any).mockResolvedValue(slot());
  (dataClientAgents.getClientAgent as any).mockResolvedValue({
    id: "ca1",
    clientId: "c1",
    customAgentId: "ca-x",
    displayName: "X Agent",
    launchState: "live",
    templates: [],
  });
  (slots.resolveUmbrellaSchedule as any).mockResolvedValue({ timeZone: "UTC" });
  (data.getAsset as any).mockResolvedValue({ id: "batch-1", clientId: "c1", content: BATCH });
  (data.createAsset as any).mockResolvedValue("new-asset");
  (data.listClientSeats as any).mockResolvedValue([
    { id: "seat-albert", clientId: "c1", name: "Albert Kattan", slug: "albert-kattan", createdBy: "u1", createdAt: 0, updatedAt: 0 },
  ]);
  (xActions.addXDraftFeedbackAction as any).mockResolvedValue({});
  // The CAS claim succeeds by default; the concurrency case below flips it.
  (dataClientAgents.claimAgentSlotOptionPick as any).mockResolvedValue(true);
});

describe("pickAgentSlotOptionAction", () => {
  it("materializes the chosen option as its own approved, manual post", async () => {
    const { pickAgentSlotOptionAction } = await import("@/lib/actions/slot-option-actions");

    const result = await pickAgentSlotOptionAction({
      clientId: "c1",
      slotId: "ca1__2026-07-28",
      optionRef: REF_A,
    });

    expect(result.assetId).toBe("new-asset");
    expect(data.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "c1",
        status: "approved",
        publishMode: "manual",
        templateKey: "daily-post",
        content: "Ship it weekly.",
      }),
    );
    // The pick is written by the CLAIM, inside a transaction.
    expect(dataClientAgents.claimAgentSlotOptionPick).toHaveBeenCalledWith(
      "ca1__2026-07-28",
      expect.objectContaining({ optionRef: REF_A, edited: false }),
    );
    // The slot then re-points at the materialized post.
    expect(dataClientAgents.updateAgentSlot).toHaveBeenCalledWith(
      "ca1__2026-07-28",
      expect.objectContaining({ assetId: "new-asset" }),
    );
  });

  it("writes a not_posted row for every option NOT chosen, with a reason naming the winner", async () => {
    const { pickAgentSlotOptionAction } = await import("@/lib/actions/slot-option-actions");

    await pickAgentSlotOptionAction({
      clientId: "c1",
      slotId: "ca1__2026-07-28",
      optionRef: REF_A,
    });

    expect(xActions.addXDraftFeedbackAction).toHaveBeenCalledTimes(1);
    const call = (xActions.addXDraftFeedbackAction as any).mock.calls[0][0];
    expect(call).toMatchObject({ draftRef: REF_B, action: "not_posted" });
    // addXDraftFeedbackAction hard-rejects not_posted with an empty reason.
    expect(call.reason).toContain(REF_A);
  });

  it("marks an edited pick as edited and stores the client's text", async () => {
    const { pickAgentSlotOptionAction } = await import("@/lib/actions/slot-option-actions");

    await pickAgentSlotOptionAction({
      clientId: "c1",
      slotId: "ca1__2026-07-28",
      optionRef: REF_A,
      finalText: "My own words.",
    });

    expect(data.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({ content: "My own words." }),
    );
    expect(dataClientAgents.claimAgentSlotOptionPick).toHaveBeenCalledWith(
      "ca1__2026-07-28",
      expect.objectContaining({ edited: true }),
    );
  });

  it("stamps personalSeatId when the chosen option is a seat's own account", async () => {
    (dataClientAgents.getAgentSlot as any).mockResolvedValue(
      slot({ optionRefs: [REF_A, REF_B, REF_SEAT] }),
    );
    const { pickAgentSlotOptionAction } = await import("@/lib/actions/slot-option-actions");

    await pickAgentSlotOptionAction({
      clientId: "c1",
      slotId: "ca1__2026-07-28",
      optionRef: REF_SEAT,
    });

    expect(data.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({ personalSeatId: "seat-albert" }),
    );
  });

  it("leaves personalSeatId null for a company-account pick", async () => {
    const { pickAgentSlotOptionAction } = await import("@/lib/actions/slot-option-actions");

    await pickAgentSlotOptionAction({
      clientId: "c1",
      slotId: "ca1__2026-07-28",
      optionRef: REF_A,
    });

    expect(data.createAsset).toHaveBeenCalledWith(expect.objectContaining({ personalSeatId: null }));
  });

  it("REFUSES a future day — its options existing is the churn tell", async () => {
    (dataClientAgents.getAgentSlot as any).mockResolvedValue(slot({ dateKey: "2026-07-30" }));
    const { pickAgentSlotOptionAction } = await import("@/lib/actions/slot-option-actions");

    const result = await pickAgentSlotOptionAction({
      clientId: "c1",
      slotId: "ca1__2026-07-30",
      optionRef: REF_A,
    });

    expect(result.error).toMatch(/hasn't arrived/i);
    expect(data.createAsset).not.toHaveBeenCalled();
    expect(xActions.addXDraftFeedbackAction).not.toHaveBeenCalled();
  });

  it("is idempotent per slot — a second press mints no second post", async () => {
    (dataClientAgents.getAgentSlot as any).mockResolvedValue(
      slot({ optionPick: { optionRef: REF_A, pickedAt: 1, pickedBy: "u", edited: false } }),
    );
    const { pickAgentSlotOptionAction } = await import("@/lib/actions/slot-option-actions");

    const result = await pickAgentSlotOptionAction({
      clientId: "c1",
      slotId: "ca1__2026-07-28",
      optionRef: REF_B,
    });

    expect(result.error).toMatch(/already chosen/i);
    expect(data.createAsset).not.toHaveBeenCalled();
  });

  it("loses cleanly when a concurrent pick won the claim first (B6)", async () => {
    // Both tabs read an unpicked slot — the pre-flight check passes for both.
    // Only the transaction can decide, and the loser must mint nothing.
    (dataClientAgents.claimAgentSlotOptionPick as any).mockResolvedValue(false);
    const { pickAgentSlotOptionAction } = await import("@/lib/actions/slot-option-actions");

    const result = await pickAgentSlotOptionAction({
      clientId: "c1",
      slotId: "ca1__2026-07-28",
      optionRef: REF_A,
    });

    expect(result.error).toMatch(/already chosen/i);
    expect(data.createAsset).not.toHaveBeenCalled();
    expect(dataClientAgents.updateAgentSlot).not.toHaveBeenCalled();
    // The loser must not write the winner's rivals off either.
    expect(xActions.addXDraftFeedbackAction).not.toHaveBeenCalled();
  });

  it("stores the humanised direction on the pick, never raw lane vocabulary (B3)", async () => {
    const { pickAgentSlotOptionAction } = await import("@/lib/actions/slot-option-actions");

    await pickAgentSlotOptionAction({
      clientId: "c1",
      slotId: "ca1__2026-07-28",
      optionRef: REF_A,
    });

    const pick = (dataClientAgents.claimAgentSlotOptionPick as any).mock.calls[0][1];
    expect(pick.direction).toBeTruthy();
    expect(pick.direction).not.toMatch(/^Avenue \d/);
  });

  it("refuses a ref that is not one of that day's options", async () => {
    const { pickAgentSlotOptionAction } = await import("@/lib/actions/slot-option-actions");

    const result = await pickAgentSlotOptionAction({
      clientId: "c1",
      slotId: "ca1__2026-07-28",
      optionRef: "Someone else · Avenue 9 · Not mine",
    });

    expect(result.error).toMatch(/isn't one of/i);
    expect(data.createAsset).not.toHaveBeenCalled();
  });

  it("refuses another client's slot without confirming it exists", async () => {
    (dataClientAgents.getAgentSlot as any).mockResolvedValue(slot({ clientId: "c2" }));
    const { pickAgentSlotOptionAction } = await import("@/lib/actions/slot-option-actions");

    const result = await pickAgentSlotOptionAction({
      clientId: "c1",
      slotId: "ca1__2026-07-28",
      optionRef: REF_A,
    });

    expect(result.error).toBe("That day isn't on your plan.");
  });
});
