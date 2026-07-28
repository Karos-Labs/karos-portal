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
].join("\n");

const REF_A = "Company page @getkaros · Avenue 1 · Playbook";
const REF_B = "Company page @getkaros · Avenue 2 · Founder POV";

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
  (xActions.addXDraftFeedbackAction as any).mockResolvedValue({});
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
    // The slot re-points at the materialized post and records the pick.
    expect(dataClientAgents.updateAgentSlot).toHaveBeenCalledWith(
      "ca1__2026-07-28",
      expect.objectContaining({
        assetId: "new-asset",
        optionPick: expect.objectContaining({ optionRef: REF_A, edited: false }),
      }),
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
    expect(dataClientAgents.updateAgentSlot).toHaveBeenCalledWith(
      "ca1__2026-07-28",
      expect.objectContaining({ optionPick: expect.objectContaining({ edited: true }) }),
    );
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
