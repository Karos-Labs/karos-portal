import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreditError } from "@/lib/credits";

/**
 * The contract of the one charge home (lib/client-model-charge.ts).
 *
 * Five surfaces answered "who pays for this model call, and what happens if it
 * fails" in five hand-written spellings, and the answers had drifted: two threw
 * a CreditError on denial and two returned the message, and NOT ONE of them
 * handed the credits back when the model call itself threw. So the properties
 * below are the ones the drift produced, asked of the single implementation
 * they all now share.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");

import { chargeClientCredits, creditClientCredits } from "@/lib/data";
import {
  chargeClientModelCall,
  refundClientModelCall,
  refundOnce,
  withClientModelCharge,
} from "@/lib/client-model-charge";

const CLIENT_USER = { uid: "u-client", name: "Dana", role: "CLIENT_USER" as const };
/** A KAROS_ADMIN in "View as Client": role reads CLIENT_USER, impersonatedBy set. */
const VIEW_AS_CLIENT = { ...CLIENT_USER, impersonatedBy: "admin-1" };
const STAFF = { uid: "u-staff", name: "Tomer", role: "KAROS_EMPLOYEE" as const };

const call = (user: typeof CLIENT_USER | typeof STAFF | typeof VIEW_AS_CLIENT) => ({
  user,
  clientId: "c1",
  amount: 5,
  operation: "ai_tool" as const,
  reason: "Audience simulation · Launch post",
});

beforeEach(() => {
  vi.mocked(chargeClientCredits).mockReset().mockResolvedValue({ balance: 95, entryId: "charge-1" });
  vi.mocked(creditClientCredits).mockReset().mockResolvedValue({ balance: 100 });
});

describe("who pays", () => {
  it("charges a real client user", async () => {
    const out = await chargeClientModelCall(call(CLIENT_USER));
    expect(out.denied).toBeNull();
    expect(out.chargedAt).toEqual(expect.any(Number));
    expect(chargeClientCredits).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "c1", amount: 5, operation: "ai_tool", actorUid: "u-client" }),
    );
  });

  it("charges staff nothing at all — no ledger row, not a zero one", async () => {
    const out = await chargeClientModelCall(call(STAFF));
    expect(out).toEqual({ denied: null, chargedAt: null, chargeEntryId: null });
    expect(chargeClientCredits).not.toHaveBeenCalled();
  });

  it("charges an admin in View as Client nothing", async () => {
    const out = await chargeClientModelCall(call(VIEW_AS_CLIENT));
    expect(out).toEqual({ denied: null, chargedAt: null, chargeEntryId: null });
    expect(chargeClientCredits).not.toHaveBeenCalled();
  });

  /**
   * The refusal has to behave sanely for the free actors too. `denied: null` is
   * what lets the work proceed, and staff get it — a caller that gated on a
   * successful CHARGE instead would have locked staff out of their own tooling
   * the moment metering was added.
   */
  it("lets a free actor through rather than treating 'not charged' as refused", async () => {
    const ran = vi.fn().mockResolvedValue("done");
    const out = await withClientModelCharge(call(STAFF), ran);
    expect(out).toEqual({ ok: true, result: "done" });
    expect(ran).toHaveBeenCalled();
  });
});

describe("a denial", () => {
  const denial = new CreditError("weekly_limit", "Weekly credit limit reached (150 of 150 used).");

  it("comes back as a message instead of throwing", async () => {
    vi.mocked(chargeClientCredits).mockRejectedValueOnce(denial);
    const out = await chargeClientModelCall(call(CLIENT_USER));
    // `chargeEntryId` joins the outcome with two-phase charging (credits rework,
    // 2026-09): a denial wrote no ledger row, so there is no hold to settle.
    expect(out).toEqual({ denied: denial.message, chargedAt: null, chargeEntryId: null });
  });

  it("stops the model call from running at all", async () => {
    vi.mocked(chargeClientCredits).mockRejectedValueOnce(denial);
    const ran = vi.fn();
    const out = await withClientModelCharge(call(CLIENT_USER), ran);
    expect(out).toEqual({ ok: false, denied: denial.message });
    expect(ran).not.toHaveBeenCalled();
  });

  /**
   * A Firestore outage is not a refusal. Swallowing it would let the model call
   * run for free, which is the exact defect this module exists to close.
   */
  it("is not confused with an infrastructure failure", async () => {
    vi.mocked(chargeClientCredits).mockRejectedValueOnce(new Error("DEADLINE_EXCEEDED"));
    await expect(chargeClientModelCall(call(CLIENT_USER))).rejects.toThrow("DEADLINE_EXCEEDED");
  });
});

describe("a model call that fails after it has been paid for", () => {
  it("hands the credits back and rethrows unchanged", async () => {
    const boom = new Error("anthropic 529 overloaded");
    await expect(
      withClientModelCharge(call(CLIENT_USER), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(creditClientCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "c1",
        amount: 5,
        kind: "refund",
        operation: "ai_tool",
        chargedAt: expect.any(Number),
      }),
    );
  });

  it("refunds nothing for a staff run, because nothing was charged", async () => {
    await expect(
      withClientModelCharge(call(STAFF), async () => {
        throw new Error("anthropic 529 overloaded");
      }),
    ).rejects.toThrow();
    expect(creditClientCredits).not.toHaveBeenCalled();
  });

  /**
   * The refund is paired to the charge WINDOW, not to now. applyCredit only
   * gives weekly/monthly spend back to the window the charge accrued in, and it
   * needs `chargedAt` to know which. Dropping it would silently erase the
   * current window's spend after a Monday rollover.
   */
  it("tells the ledger when the original charge happened", async () => {
    const before = Date.now();
    await expect(
      withClientModelCharge(call(CLIENT_USER), async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow();
    const { chargedAt } = vi.mocked(creditClientCredits).mock.calls[0]![0] as { chargedAt: number };
    expect(chargedAt).toBeGreaterThanOrEqual(before);
    expect(chargedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("a model call that succeeds but delivers nothing", () => {
  it("is refunded by the caller through the handle it is given", async () => {
    const out = await withClientModelCharge(call(CLIENT_USER), async ({ refund }) => {
      await refund("Refund · nothing to show");
      return "empty";
    });
    expect(out).toEqual({ ok: true, result: "empty" });
    expect(creditClientCredits).toHaveBeenCalledTimes(1);
    expect(vi.mocked(creditClientCredits).mock.calls[0]![0]).toMatchObject({
      kind: "refund",
      reason: "Refund · nothing to show",
    });
  });

  /**
   * "Refund, then fail while cleaning up" is a real path — the second refund
   * would come from the wrapper's own catch. Double-refunding a client is a
   * worse bug than the one being fixed, so the handle is idempotent.
   */
  it("is refunded ONCE even if the run then throws", async () => {
    await expect(
      withClientModelCharge(call(CLIENT_USER), async ({ refund }) => {
        await refund("Refund · nothing to show");
        throw new Error("cleanup blew up");
      }),
    ).rejects.toThrow("cleanup blew up");
    expect(creditClientCredits).toHaveBeenCalledTimes(1);
  });

  it("is refunded once however many times the caller asks", async () => {
    await withClientModelCharge(call(CLIENT_USER), async ({ refund }) => {
      await refund("first");
      await refund("second");
      await refund("third");
    });
    expect(creditClientCredits).toHaveBeenCalledTimes(1);
  });
});

describe("a refund that itself fails", () => {
  /**
   * Never turn an already-failed run into a second, different error for the
   * client. The reconciler picks up a lost refund when the charge carried a
   * jobId, and the console line is the record either way.
   */
  it("does not mask the original failure", async () => {
    vi.mocked(creditClientCredits).mockRejectedValueOnce(new Error("ledger write failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("anthropic 529 overloaded");

    await expect(
      withClientModelCharge(call(CLIENT_USER), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("is a no-op when there was no charge to hand back", async () => {
    await refundClientModelCall(call(CLIENT_USER), null, "Refund · nothing");
    expect(creditClientCredits).not.toHaveBeenCalled();
  });
});

/**
 * A STREAMING HANDLER CANNOT PAIR BY HAND, because it does not control how many
 * times its failure hook runs. The AI SDK calls `onError` once per `error`
 * PART — two error parts, two calls — and `creditClientCredits` has no
 * idempotency key, so the naked refund paid the client twice for one charge.
 */
describe("the once-only refund handle", () => {
  it("hands the credits back exactly once however many times it is called", async () => {
    const c = call(CLIENT_USER);
    const { chargedAt } = await chargeClientModelCall(c);
    const handBack = refundOnce(c, chargedAt);

    await handBack("Refund · insights refresh failed");
    await handBack("Refund · insights refresh failed");
    await handBack("Refund · insights refresh failed");

    expect(creditClientCredits).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a run that was never charged (staff, or an unforced rerun)", async () => {
    const { chargedAt } = await chargeClientModelCall(call(STAFF));
    await refundOnce(call(STAFF), chargedAt)("Refund · never charged");
    expect(creditClientCredits).not.toHaveBeenCalled();
  });

  it("gives each run its own guard — one run's refund cannot silence another's", async () => {
    const c = call(CLIENT_USER);
    const first = refundOnce(c, Date.now());
    const second = refundOnce(c, Date.now());

    await first("Refund · run one");
    await second("Refund · run two");

    expect(creditClientCredits).toHaveBeenCalledTimes(2);
  });
});

/**
 * T-B23: which model actually served a charged call is carried onto the
 * ledger write as telemetry — the chat route's per-model chat pricing is the
 * first caller to pass it. Asserted on the actual `chargeClientCredits` /
 * `creditClientCredits` arguments, matching this file's own style, so a
 * refactor that drops the field on the way to the data layer fails here.
 */
describe("model telemetry (T-B23)", () => {
  it("carries modelName/provider onto the charge when the caller supplies them", async () => {
    await chargeClientModelCall({
      ...call(CLIENT_USER),
      modelName: "claude-haiku-4-5-20251001",
      provider: "anthropic",
    });
    expect(chargeClientCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: "claude-haiku-4-5-20251001",
        provider: "anthropic",
      }),
    );
  });

  it("writes null, not undefined, when the caller names no model", async () => {
    // Firestore rejects `undefined` field values (the same reason logger.ts's
    // webSearchCount is coalesced before a write) — every other optional
    // field on this call already normalizes to null, and this one must too.
    await chargeClientModelCall(call(CLIENT_USER));
    expect(chargeClientCredits).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: null, provider: null }),
    );
  });

  it("carries the same model info onto a refund", async () => {
    const c = { ...call(CLIENT_USER), modelName: "claude-sonnet-4-6", provider: "anthropic" as const };
    const { chargedAt } = await chargeClientModelCall(c);
    await refundClientModelCall(c, chargedAt, "Refund · run failed");
    expect(creditClientCredits).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: "claude-sonnet-4-6", provider: "anthropic" }),
    );
  });

  it("never lets model info change the amount charged — it is telemetry, not pricing, at this layer", async () => {
    // This module owns the mechanism only (see its own header note); the
    // PRICE is decided by the caller before it ever reaches here. Passing a
    // different modelName must not perturb the amount this layer forwards.
    await chargeClientModelCall({ ...call(CLIENT_USER), amount: 5, modelName: "claude-sonnet-4-6" });
    await chargeClientModelCall({ ...call(CLIENT_USER), amount: 5, modelName: "claude-haiku-4-5-20251001" });
    for (const call_ of vi.mocked(chargeClientCredits).mock.calls) {
      expect(call_[0].amount).toBe(5);
    }
  });
});
