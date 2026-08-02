/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as creditActions from "@/lib/actions/credit-actions";
import * as data from "@/lib/data";
import * as auth from "@/lib/auth";

/**
 * #160 — THE ADMIN MONEY PATH, WHICH NOTHING TESTED.
 *
 * `src/lib/credits.ts` (pricing, windows, affordability) is thoroughly covered
 * and pure. `credit-actions.ts` is the WRITE side of the same subject — the two
 * server actions that grant a client credits, deduct them, and set the weekly
 * and monthly spend caps that are the per-client rate limit — and no test
 * referenced it at all.
 *
 * A server action is a public endpoint: the "Grant credits" field only exists
 * on the admin client-settings page, but the action behind it is POST-able by
 * anything that can reach the origin. So the questions asked here are, in order:
 * is the refusal real, does a refused caller move NOTHING, and does an accepted
 * grant land with the actor's name on the ledger row.
 *
 * `@/lib/auth` is mocked at the session reader only, so the `requireAdmin` these
 * actions actually call is the real one from `_shared.ts` — a second copy of the
 * role ladder written in this file is exactly how the two would drift apart.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: vi.fn() };
});

const CLIENT = { id: "c1", name: "Acme", status: "active", createdAt: 0 };

const ADMIN = { uid: "u-admin", name: "Dana Admin", role: "KAROS_ADMIN", clientId: null };
const EMPLOYEE = { uid: "u-emp", name: "Eli Employee", role: "KAROS_EMPLOYEE", clientId: null };
const CLIENT_USER = { uid: "u-client", name: "Cass Client", role: "CLIENT_USER", clientId: "c1" };
/** An account that still says KAROS_ADMIN but has been deactivated. */
const DISABLED_ADMIN = { ...ADMIN, uid: "u-ex-admin", disabled: true };

/** Every actor the two actions must turn away, with the message they get. */
const REFUSED = [
  ["nobody at all", null, "Unauthorized"],
  ["a deactivated admin", DISABLED_ADMIN, "Unauthorized"],
  ["an employee", EMPLOYEE, "Forbidden"],
  ["the client themselves", CLIENT_USER, "Forbidden"],
] as const;

function as(user: unknown) {
  vi.mocked(auth.getCurrentUser).mockResolvedValue(user as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  as(ADMIN);
  vi.mocked(data.getClient).mockResolvedValue(CLIENT as any);
  vi.mocked(data.creditClientCredits).mockResolvedValue({ balance: 120 } as any);
  vi.mocked(data.setClientCreditLimits).mockResolvedValue(undefined as any);
});

describe("adjustCreditsAction — granting and deducting a client's credits", () => {
  it.each(REFUSED)("refuses %s, and moves no credits", async (_label, actor, message) => {
    as(actor);

    const res = await creditActions.adjustCreditsAction("c1", 50, "Goodwill");

    expect(res).toEqual({ ok: false, error: message });
    // The refusal is only worth anything if nothing happened on the way to it.
    expect(data.creditClientCredits).not.toHaveBeenCalled();
  });

  it("grants an admin's credits with the actor recorded on the ledger row", async () => {
    const res = await creditActions.adjustCreditsAction("c1", 50, "  Launch goodwill  ");

    expect(res).toEqual({ ok: true, balance: 120 });
    expect(data.creditClientCredits).toHaveBeenCalledTimes(1);
    expect(vi.mocked(data.creditClientCredits).mock.calls[0]![0]).toMatchObject({
      clientId: "c1",
      amount: 50,
      kind: "grant",
      operation: "manual",
      reason: "Launch goodwill",
      // WHO moved the money. The ledger is the only record of a manual
      // adjustment, and an entry with no actor cannot be asked about later.
      actorUid: "u-admin",
      actorName: "Dana Admin",
    });
  });

  it("files a deduction as an adjustment, not a grant", async () => {
    // The two are different rows in the ledger and different words on the
    // client's credit history; a deduction filed as a grant reads as the
    // opposite of what happened.
    await creditActions.adjustCreditsAction("c1", -20);

    expect(vi.mocked(data.creditClientCredits).mock.calls[0]![0]).toMatchObject({
      amount: -20,
      kind: "adjustment",
      reason: "Credit adjustment",
    });
  });

  it.each([
    ["zero", 0],
    ["a fraction", 1.5],
    ["not a number", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("refuses %s before writing anything", async (_label, amount) => {
    const res = await creditActions.adjustCreditsAction("c1", amount);

    expect(res).toEqual({ ok: false, error: "Enter a non-zero whole number of credits" });
    expect(data.creditClientCredits).not.toHaveBeenCalled();
  });

  it("refuses a client that does not exist", async () => {
    vi.mocked(data.getClient).mockResolvedValue(null as any);

    const res = await creditActions.adjustCreditsAction("nope", 10);

    expect(res).toEqual({ ok: false, error: "Client not found" });
    expect(data.creditClientCredits).not.toHaveBeenCalled();
  });

  it("returns the write failure as data rather than throwing it", async () => {
    // These actions deliberately return `{ error }` instead of throwing:
    // thrown server-action errors are masked in a production build, and the
    // admin would be told nothing at all.
    vi.mocked(data.creditClientCredits).mockRejectedValue(new Error("ledger write failed"));

    const res = await creditActions.adjustCreditsAction("c1", 10);

    expect(res).toEqual({ ok: false, error: "ledger write failed" });
  });
});

describe("setCreditLimitsAction — the per-client spend caps", () => {
  it.each(REFUSED)("refuses %s, and changes no cap", async (_label, actor, message) => {
    as(actor);

    const res = await creditActions.setCreditLimitsAction("c1", 100, 400);

    expect(res).toEqual({ ok: false, error: message });
    expect(data.setClientCreditLimits).not.toHaveBeenCalled();
  });

  it("sets both caps for an admin", async () => {
    const res = await creditActions.setCreditLimitsAction("c1", 100, 400);

    expect(res).toEqual({ ok: true });
    expect(data.setClientCreditLimits).toHaveBeenCalledWith("c1", {
      weeklyLimit: 100,
      monthlyLimit: 400,
    });
  });

  it("passes null through as 'no cap' rather than treating it as zero", async () => {
    // The difference matters in one direction only, and it is the expensive one:
    // a cap of 0 stops every run the client tries to make.
    await creditActions.setCreditLimitsAction("c1", null, null);

    expect(data.setClientCreditLimits).toHaveBeenCalledWith("c1", {
      weeklyLimit: null,
      monthlyLimit: null,
    });
  });

  it.each([
    ["a negative weekly cap", -1, null],
    ["a negative monthly cap", null, -1],
    ["a fractional weekly cap", 2.5, null],
    ["a fractional monthly cap", null, 2.5],
  ])("refuses %s before writing anything", async (_label, weekly, monthly) => {
    const res = await creditActions.setCreditLimitsAction("c1", weekly, monthly);

    expect(res).toEqual({
      ok: false,
      error: "Limits must be whole numbers of credits (or empty for no cap)",
    });
    expect(data.setClientCreditLimits).not.toHaveBeenCalled();
  });

  it("refuses a client that does not exist", async () => {
    vi.mocked(data.getClient).mockResolvedValue(null as any);

    const res = await creditActions.setCreditLimitsAction("nope", 10, 10);

    expect(res).toEqual({ ok: false, error: "Client not found" });
    expect(data.setClientCreditLimits).not.toHaveBeenCalled();
  });
});
