import { describe, expect, it } from "vitest";
import {
  CREDIT_DEFAULTS,
  applyCredit,
  assessCharge,
  availableCredits,
  creditMonthKey,
  creditWeekKey,
  defaultClientCredits,
  isBillableClientActor,
  rollCreditWindows,
  scheduledAgentWeeklyCost,
} from "../credits";
import type { ClientCredits } from "../types";

// 2026-07-08 12:00 UTC — a Wednesday in ISO week 28.
const NOW = Date.UTC(2026, 6, 8, 12);

function credits(patch: Partial<ClientCredits> = {}): ClientCredits {
  return { ...defaultClientCredits("c1", NOW), ...patch };
}

describe("scheduled agent pricing", () => {
  it("multiplies posts, outputs, and the agent's unit cost", () => {
    expect(scheduledAgentWeeklyCost(25, 3, 2)).toBe(150);
  });
});

describe("credit window keys", () => {
  it("computes ISO week keys (UTC)", () => {
    expect(creditWeekKey(NOW)).toBe("2026-W28");
    // Sunday belongs to the same ISO week as the preceding Monday.
    expect(creditWeekKey(Date.UTC(2026, 6, 12))).toBe("2026-W28");
    // Next Monday rolls the week.
    expect(creditWeekKey(Date.UTC(2026, 6, 13))).toBe("2026-W29");
    // Jan 1 2027 (Friday) belongs to ISO 2026-W53.
    expect(creditWeekKey(Date.UTC(2027, 0, 1))).toBe("2026-W53");
  });

  it("computes month keys", () => {
    expect(creditMonthKey(NOW)).toBe("2026-07");
    expect(creditMonthKey(Date.UTC(2026, 11, 31))).toBe("2026-12");
  });
});

describe("rollCreditWindows", () => {
  it("keeps spend inside the same window", () => {
    const c = credits({ weekSpent: 10, monthSpent: 30 });
    const rolled = rollCreditWindows(c, NOW + 60_000);
    expect(rolled.weekSpent).toBe(10);
    expect(rolled.monthSpent).toBe(30);
  });

  it("resets only the window that rolled over", () => {
    const c = credits({ weekSpent: 10, monthSpent: 30 });
    // Next Monday: new ISO week, same month.
    const rolled = rollCreditWindows(c, Date.UTC(2026, 6, 13));
    expect(rolled.weekSpent).toBe(0);
    expect(rolled.weekKey).toBe("2026-W29");
    expect(rolled.monthSpent).toBe(30);
    expect(rolled.monthKey).toBe("2026-07");
  });

  it("resets both windows across a month + week boundary", () => {
    const c = credits({ weekSpent: 10, monthSpent: 30 });
    const rolled = rollCreditWindows(c, Date.UTC(2026, 7, 10));
    expect(rolled.weekSpent).toBe(0);
    expect(rolled.monthSpent).toBe(0);
  });
});

describe("assessCharge", () => {
  it("deducts balance and accrues window spend", () => {
    const res = assessCharge(credits(), 5, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.balance).toBe(CREDIT_DEFAULTS.startingBalance - 5);
      expect(res.next.weekSpent).toBe(5);
      expect(res.next.monthSpent).toBe(5);
    }
  });

  it("denies when the balance is short", () => {
    const res = assessCharge(credits({ balance: 3 }), 5, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("insufficient_balance");
  });

  it("denies when the weekly cap would be exceeded", () => {
    const res = assessCharge(credits({ weekSpent: 148 }), 5, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("weekly_limit");
  });

  it("denies when the monthly cap would be exceeded", () => {
    const res = assessCharge(credits({ weekSpent: 0, monthSpent: 398 }), 5, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("monthly_limit");
  });

  it("ignores caps set to null", () => {
    const res = assessCharge(
      credits({ weeklyLimit: null, monthlyLimit: null, weekSpent: 9999, monthSpent: 9999 }),
      5,
      NOW,
    );
    expect(res.ok).toBe(true);
  });

  it("allows the charge again after the window rolls", () => {
    const c = credits({ weekSpent: 150 });
    expect(assessCharge(c, 5, NOW).ok).toBe(false);
    expect(assessCharge(c, 5, Date.UTC(2026, 6, 13)).ok).toBe(true);
  });

  it("treats a non-positive amount as a no-op", () => {
    const res = assessCharge(credits({ balance: 0 }), 0, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.next.balance).toBe(0);
  });
});

describe("applyCredit", () => {
  it("grants without touching window spend", () => {
    const next = applyCredit(credits({ weekSpent: 10, monthSpent: 20 }), 100, "grant", NOW);
    expect(next.balance).toBe(CREDIT_DEFAULTS.startingBalance + 100);
    expect(next.weekSpent).toBe(10);
    expect(next.monthSpent).toBe(20);
  });

  it("refunds hand back window spend (floored at zero)", () => {
    const next = applyCredit(credits({ weekSpent: 3, monthSpent: 10 }), 5, "refund", NOW);
    expect(next.balance).toBe(CREDIT_DEFAULTS.startingBalance + 5);
    expect(next.weekSpent).toBe(0);
    expect(next.monthSpent).toBe(5);
  });

  it("negative adjustments deduct balance", () => {
    const next = applyCredit(credits(), -50, "adjustment", NOW);
    expect(next.balance).toBe(CREDIT_DEFAULTS.startingBalance - 50);
  });

  it("a refund landing after a window rollover does not erase the new window's spend", () => {
    // Charged Wednesday W28; refund lands the following Tuesday (W29) after
    // 7 credits were legitimately spent in the new week.
    const afterRoll = rollCreditWindows(credits({ weekSpent: 5 }), Date.UTC(2026, 6, 14));
    const state = { ...afterRoll, weekSpent: 7, monthSpent: 12 };
    const next = applyCredit(state, 5, "refund", Date.UTC(2026, 6, 14), NOW);
    expect(next.balance).toBe(state.balance + 5);
    // Same month → month spend handed back; different ISO week → week spend untouched.
    expect(next.weekSpent).toBe(7);
    expect(next.monthSpent).toBe(7);
  });
});

describe("availableCredits", () => {
  it("is the balance when caps leave more room", () => {
    expect(availableCredits(credits({ balance: 50 }), NOW)).toBe(50);
  });

  it("is clipped by the tighter of the weekly/monthly caps", () => {
    expect(availableCredits(credits({ balance: 500, weekSpent: 140 }), NOW)).toBe(10);
    expect(availableCredits(credits({ balance: 500, monthSpent: 395 }), NOW)).toBe(5);
  });

  it("never goes negative and ignores null caps", () => {
    expect(availableCredits(credits({ balance: 500, weekSpent: 160 }), NOW)).toBe(0);
    expect(
      availableCredits(credits({ balance: 500, weeklyLimit: null, monthlyLimit: null }), NOW),
    ).toBe(500);
  });
});

describe("isBillableClientActor", () => {
  it("bills real client users only", () => {
    expect(isBillableClientActor({ role: "CLIENT_USER" })).toBe(true);
    expect(isBillableClientActor({ role: "KAROS_ADMIN" })).toBe(false);
    expect(isBillableClientActor({ role: "KAROS_EMPLOYEE" })).toBe(false);
  });

  it("never bills admin View-as-Client sessions", () => {
    expect(isBillableClientActor({ role: "CLIENT_USER", impersonatedBy: "admin-1" })).toBe(false);
  });
});
