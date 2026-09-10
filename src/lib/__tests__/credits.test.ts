import { resolve } from "node:path";
import { readSource } from "./source-scan";

import {
  CHAT_MESSAGE_CREDITS,
  CREDIT_BUCKET_LABEL,
  CREDIT_COSTS,
  CREDIT_OPERATION_LABEL,
  chatMessageCreditCost,
  chatPricingFor,
  creditBucketFor,
  type CreditBucket,
} from "@/lib/credits";
import { CHAT_MODEL_KEYS } from "@/lib/ai/chat-models";
import type { CreditOperation, JobRunType } from "@/lib/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREDIT_BLOCK_REASON,
  CREDIT_DEFAULTS,
  CREDIT_WINDOW_RESET,
  applyCredit,
  assessCharge,
  availableCredits,
  bindingCreditLimit,
  creditBlockReason,
  creditMonthKey,
  creditWeekKey,
  creditsLabel,
  creditsForUsd,
  defaultClientCredits,
  insightsRefreshPrice,
  isBillableClientActor,
  isCreditsPlanV2Enabled,
  creditDefaults,
  simulationPrice,
  taskMapRefreshPrice,
  xRosterProposalPrice,
  LEGACY_CREDIT_DEFAULTS,
  applySettlement,
  rollCreditWindows,
  settlementFor,
  CREDITS_PER_USD,
  MONTHLY_ALLOWANCE,
  SETTLEMENT_CAP_FACTOR,
  UNSETTLED_OPERATIONS,
  USD_PER_CREDIT,
  estimatedCreditsLabel,
  settledCreditsLabel,
  scheduledAgentWeeklyCost,
} from "../credits";
import type { ClientCredits } from "../types";

// 2026-07-08 12:00 UTC — a Wednesday in ISO week 28.
const NOW = Date.UTC(2026, 6, 8, 12);

/**
 * THE FLAG IS OFF UNLESS A TEST SAYS OTHERWISE, matching production. Every
 * block that exercises the credits rework turns it on explicitly and puts it
 * back afterwards, so a suite that forgets cannot inherit v2 behaviour from the
 * one before it — and so the "off" blocks below are asserting the real default,
 * not an artefact of ordering.
 */
function withPlanV2() {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.CREDITS_PLAN_V2_ENABLED;
    process.env.CREDITS_PLAN_V2_ENABLED = "1";
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.CREDITS_PLAN_V2_ENABLED;
    else process.env.CREDITS_PLAN_V2_ENABLED = prior;
  });
}

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
  withPlanV2();
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
  withPlanV2();
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

  /**
   * THE WEEKLY CAP IS NO LONGER A DEFAULT, so the limit is set explicitly here
   * (credits rework, 2026-09). The MACHINERY is unchanged and still under test:
   * an admin can still set a weekly cap from the credits panel and it is still
   * enforced, in the same ladder position, with the same denial code. What
   * moved is `CREDIT_DEFAULTS.weeklyLimit` — see "the new plan's defaults"
   * below, which pins that nothing sets one any more.
   */
  it("denies when an admin-set weekly cap would be exceeded", () => {
    const res = assessCharge(credits({ weeklyLimit: 150, weekSpent: 148 }), 5, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("weekly_limit");
  });

  it("denies when the monthly cap would be exceeded", () => {
    const res = assessCharge(
      credits({ weekSpent: 0, monthSpent: MONTHLY_ALLOWANCE - 2 }),
      5,
      NOW,
    );
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
    const c = credits({ weeklyLimit: 150, weekSpent: 150 });
    expect(assessCharge(c, 5, NOW).ok).toBe(false);
    expect(assessCharge(c, 5, Date.UTC(2026, 6, 13)).ok).toBe(true);
  });

  it("treats a non-positive amount as a no-op", () => {
    const res = assessCharge(credits({ balance: 0 }), 0, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.next.balance).toBe(0);
  });
});

describe("bindingCreditLimit", () => {
  withPlanV2();
  // The pre-flight reason must name the SAME limit the server denial would, so
  // the contract is simply: whenever assessCharge denies, bindingCreditLimit
  // returns its code. A cost-ordered ladder, not an argmin over the balances.
  const cases: Array<{ name: string; patch: Partial<ClientCredits>; cost: number; code: string }> = [
    // Repro A from the risk lens: balance 5, weekLeft 2, monthLeft 400, cost 10.
    // Argmin would pick weekly (2 is smallest) and tell the client to wait till
    // Monday; the server refuses on the balance, which a top-up fixes.
    {
      name: "balance binds before a tighter weekly window",
      patch: { balance: 5, weeklyLimit: 2, weekSpent: 0, monthlyLimit: 400, monthSpent: 0 },
      cost: 10,
      code: "insufficient_balance",
    },
    // Repro B: balance 100, weekLeft 5, monthLeft 1, cost 10. Argmin would pick
    // monthly (1 is smallest); the server checks weekly first, so it is weekly.
    {
      name: "weekly binds before a tighter monthly window",
      patch: { balance: 100, weeklyLimit: 5, weekSpent: 0, monthlyLimit: 1, monthSpent: 0 },
      cost: 10,
      code: "weekly_limit",
    },
    {
      name: "monthly binds when balance and weekly both clear",
      patch: { balance: 100, weeklyLimit: 50, weekSpent: 0, monthlyLimit: 1, monthSpent: 0 },
      cost: 10,
      code: "monthly_limit",
    },
  ];

  for (const { name, patch, cost, code } of cases) {
    it(name, () => {
      const c = credits(patch);
      expect(bindingCreditLimit(c, cost, NOW)).toBe(code);
      // The load-bearing invariant: it agrees with the server for that cost.
      const denial = assessCharge(c, cost, NOW);
      expect(denial.ok).toBe(false);
      if (!denial.ok) expect(bindingCreditLimit(c, cost, NOW)).toBe(denial.code);
    });
  }

  it("rolls the spend windows when given `now`, so a new week reads fresh", () => {
    // Capped this week, but `now` is next Monday — the window has rolled, so the
    // weekly cap no longer binds and a plain top-up gate is wrong.
    const c = credits({ balance: 5, weeklyLimit: 150, weekSpent: 150 });
    const nextMonday = Date.UTC(2026, 6, 13);
    expect(bindingCreditLimit(c, 10, nextMonday)).toBe("insufficient_balance");
  });

  it("creditBlockReason maps the binding code to its client line", () => {
    const c = credits({ balance: 100, weeklyLimit: 5, weekSpent: 0 });
    expect(creditBlockReason(c, 10, NOW)).toBe(CREDIT_BLOCK_REASON.weekly_limit);
  });

  // The credits card prints the reset clause under each usage meter so a client
  // can plan BEFORE the wall; the denial prints it after. One source, so the
  // meter and the refusal can never name different reset days.
  it("block reasons are composed from the shared window-reset clauses", () => {
    expect(CREDIT_BLOCK_REASON.weekly_limit).toContain(CREDIT_WINDOW_RESET.weekly_limit);
    expect(CREDIT_BLOCK_REASON.monthly_limit).toContain(CREDIT_WINDOW_RESET.monthly_limit);
    // Balance shortfalls are not a window and must not claim a reset day.
    expect(CREDIT_BLOCK_REASON.insufficient_balance).not.toMatch(/resets/i);
  });
});

describe("applyCredit", () => {
  withPlanV2();
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
  withPlanV2();
  it("is the balance when caps leave more room", () => {
    expect(availableCredits(credits({ balance: 50 }), NOW)).toBe(50);
  });

  it("is clipped by the tighter of the weekly/monthly caps", () => {
    expect(availableCredits(credits({ balance: 500, weeklyLimit: 150, weekSpent: 140 }), NOW)).toBe(
      10,
    );
    expect(
      availableCredits(credits({ balance: 500, monthSpent: MONTHLY_ALLOWANCE - 5 }), NOW),
    ).toBe(5);
  });

  it("never goes negative and ignores null caps", () => {
    expect(availableCredits(credits({ balance: 500, weeklyLimit: 150, weekSpent: 160 }), NOW)).toBe(
      0,
    );
    expect(
      availableCredits(credits({ balance: 500, weeklyLimit: null, monthlyLimit: null }), NOW),
    ).toBe(500);
  });
});

/**
 * THE PLURAL, asked of the helper rather than of a price.
 *
 * A price quote's number is a CONSTANT, and a test that compares the quote with
 * a string built from that same constant stays green through the exact bug it
 * should catch: `${CREDIT_COSTS.taskExecution} credits` matched
 * "5 credits" AND would have matched "1 credits" after a reprice. So the rule is
 * exercised at the numbers themselves, where a literal oracle is possible.
 */
describe("creditsLabel", () => {
  it("pluralises off the number, including the singular a reprice would expose", () => {
    expect(creditsLabel(1)).toBe("1 credit");
    expect(creditsLabel(2)).toBe("2 credits");
    expect(creditsLabel(5)).toBe("5 credits");
    expect(creditsLabel(0)).toBe("0 credits");
  });

  it("never says token — that word belongs to PATs and LLM counts", () => {
    expect(creditsLabel(1)).not.toMatch(/token/i);
  });
});

/**
 * The free case is NULL, not "0 credits" and not "": every control renders its
 * price only when truthy, so anything else would put a number on a surface that
 * is never charged. Asked of one quote here; the other two assert the same in
 * client-model-metering.test.ts, beside the charge each of them mirrors.
 */
describe("a press price for a reader who is not billed", () => {
  it("is null rather than a zero or an empty string", () => {
    expect(insightsRefreshPrice(false)).toBeNull();
  });

  it("is the quote itself for a reader who is", () => {
    expect(insightsRefreshPrice(true)).toBe(creditsLabel(CREDIT_COSTS.chatMessage));
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

/**
 * §6.2 — the ledger's grouping keys.
 *
 * Rows have always rendered their free-text `reason`, composed per charge site.
 * That cannot be grouped without re-parsing English, which is why the KIND has
 * a stable label and a bucket.
 */
describe("credit ledger presentation", () => {
  /**
   * The union is READ OUT OF types.ts rather than retyped here. The hand-kept
   * list this replaces was eight names long and the test promised "every
   * operation in the union" — a name that outran its assertion the moment a
   * ninth was added, which is exactly what happened when `ai_tool` landed. A
   * label map missing an entry renders a blank chip in the client's own spend
   * breakdown, so the sweep has to widen by itself.
   */
  const operationsInTheUnion = (): CreditOperation[] => {
    const src = readSource(resolve(__dirname, "..", "types.ts"));
    const union = /export type CreditOperation =([\s\S]*?);\n/.exec(src);
    expect(union, "CreditOperation is no longer a string-literal union in types.ts").not.toBeNull();
    return [...union![1].matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1] as CreditOperation);
  };

  it("labels every operation in the union", () => {
    const operations = operationsInTheUnion();
    // Non-vacuity: a regex that matched nothing would make the loop below a
    // no-op and this test a green light over an unlabelled operation.
    expect(operations.length).toBeGreaterThanOrEqual(9);
    expect(operations).toContain("ai_tool");
    for (const op of operations) {
      expect(CREDIT_OPERATION_LABEL[op], `no ledger label for "${op}"`).toBeTruthy();
    }
  });

  it("buckets a launch as setup regardless of run type", () => {
    expect(creditBucketFor("agent_launch")).toBe("setup");
    expect(creditBucketFor("agent_launch", "launch")).toBe("setup");
  });

  it("splits agent runs by the job's run type", () => {
    expect(creditBucketFor("custom_agent_run", "scheduled")).toBe("scheduled");
    expect(creditBucketFor("custom_agent_run", "manual_template")).toBe("manual");
    expect(creditBucketFor("custom_agent_run", "manual")).toBe("manual");
  });

  it("falls back honestly when the job is gone or predates run-type stamping", () => {
    // Not a guess at which KIND of run it was — but still a run, because the
    // operation says so. Collapsing this into "other" is what made a client
    // whose history predates run-type stamping read "Other usage" and nothing
    // else, for spend that was entirely agent runs.
    expect(creditBucketFor("custom_agent_run", null)).toBe("runs");
    expect(creditBucketFor("custom_agent_run")).toBe("runs");
    expect(creditBucketFor("agent_run")).toBe("runs");
    expect(CREDIT_BUCKET_LABEL.runs).toBe("Runs (kind not recorded)");
    // AND IT MAY NOT READ AS A TOTAL. It sits in the same row as "Scheduled
    // runs" and "Runs you started"; a residual named like their sum makes the
    // row look as though it double-counts. Asked as the closed question rather
    // than pinning one wording: the residual's label may not be a prefix of, or
    // contained in, either sibling — which is what "Agent runs" was.
    for (const sibling of [CREDIT_BUCKET_LABEL.scheduled, CREDIT_BUCKET_LABEL.manual]) {
      const words = CREDIT_BUCKET_LABEL.runs.toLowerCase().split(/\s+/);
      expect(
        words.every((w) => sibling.toLowerCase().includes(w)),
        `the residual bucket reads as a total of "${sibling}"`,
      ).toBe(false);
    }
  });

  it("leaves non-agent operations out of the agent buckets", () => {
    expect(creditBucketFor("chat_message")).toBe("other");
    expect(creditBucketFor("task_execution", "scheduled")).toBe("other");
    // …including the run type they can never legitimately carry: `other` is
    // "not an agent run", not "no run type".
    expect(creditBucketFor("doc_correction", "manual")).toBe("other");
    expect(creditBucketFor("ai_tool", "scheduled")).toBe("other");
  });

  it("labels every bucket creditBucketFor can return", () => {
    const returned = new Set<CreditBucket>();
    const operations: CreditOperation[] = [
      "agent_launch",
      "custom_agent_run",
      "agent_run",
      "chat_message",
      "task_execution",
      "doc_correction",
      "seat_purchase",
      "ai_tool",
      "manual",
    ];
    const runTypes: Array<JobRunType | null | undefined> = [
      "launch",
      "scheduled",
      "manual",
      "manual_template",
      "test",
      null,
      undefined,
    ];
    for (const op of operations) {
      for (const rt of runTypes) returned.add(creditBucketFor(op, rt));
    }
    // Non-vacuity: the loops above must actually reach more than one bucket,
    // or an unlabelled one could hide behind an empty set.
    expect(returned.size).toBeGreaterThanOrEqual(5);
    for (const bucket of returned) {
      expect(CREDIT_BUCKET_LABEL[bucket], `no label for bucket "${bucket}"`).toBeTruthy();
    }
    // Two buckets rendered side by side on one row must not share a word for
    // two different things.
    const labels = Object.values(CREDIT_BUCKET_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

/* ── T-B23: per-model chat pricing ────────────────────────────────── */

describe("chatPricingFor", () => {
  // T-B23 originally resolved the model itself, from `body.deep`. T-B3
  // (SCRUM-246) landed in the same round and owns that decision behind a
  // mandatory server-side allowlist, so pricing now maps the RESOLVED key to
  // its price row instead of forming a second opinion about which model ran.
  it("prices the default option on its own provider, not a hardcoded anthropic", () => {
    expect(chatPricingFor("gemini-flash")).toEqual({ provider: "google", model: "gemini-flash" });
  });

  it("prices the deep/quality option on anthropic", () => {
    expect(chatPricingFor("haiku")).toEqual({ provider: "anthropic", model: "haiku" });
  });

  it("has a real price for every option the chat allowlist can resolve to", () => {
    // The gap this closes: T-B23 shipped `google: {}` as a reserved-empty
    // row because no Gemini chat option existed yet. T-B3 then made Gemini
    // the DEFAULT, so an empty row would have made chatMessageCreditCost
    // throw on the most common turn in the product.
    for (const key of CHAT_MODEL_KEYS) {
      const row = chatPricingFor(key);
      expect(() => chatMessageCreditCost(row.model, row.provider), `no credit price for chat option "${key}"`).not.toThrow();
    }
  });
});

describe("chatMessageCreditCost", () => {
  it("prices the default Haiku turn at the unchanged CREDIT_COSTS.chatMessage rate", () => {
    // The whole point of keeping this constant: nothing changes for the
    // by-far-most-common case, only for the deep/Sonnet turn that used to be
    // billed identically to it.
    expect(chatMessageCreditCost("haiku")).toBe(CREDIT_COSTS.chatMessage);
  });

  it("prices a deep Sonnet turn ABOVE the Haiku rate — the bug this ticket fixes", () => {
    const haiku = chatMessageCreditCost("haiku");
    const sonnet = chatMessageCreditCost("sonnet");
    expect(sonnet).toBeGreaterThan(haiku);
    // Specifically the "one Sonnet call" rate this file's own scale already
    // defines (taskExecution), not a freestanding new number.
    expect(sonnet).toBe(CREDIT_COSTS.taskExecution);
  });

  it("defaults to the anthropic provider when none is passed", () => {
    expect(chatMessageCreditCost("haiku")).toBe(chatMessageCreditCost("haiku", "anthropic"));
  });

  it("refuses an unpriced (model, provider) pair rather than guessing a price", () => {
    // No Gemini chat model is wired yet — see CHAT_MESSAGE_CREDITS's own
    // docstring for why "google" is reserved rather than populated. Reading
    // it must throw, not silently fall back to the Haiku/Sonnet rate.
    expect(() => chatMessageCreditCost("haiku", "google")).toThrow(/No credit price/);
    expect(() => chatMessageCreditCost("sonnet", "openai")).toThrow(/No credit price/);
  });

  it("CHAT_MESSAGE_CREDITS reserves a slot for every provider the internal cost tracker prices", () => {
    // @/lib/models/usage-log.ts's ProviderId is "anthropic" | "openai" |
    // "google" — this table must have a bucket for each so that a future
    // Gemini/GPT chat model is a price DECISION, not a table reshape. This
    // is exactly the gap the ticket names ("no Gemini rows anywhere in the
    // pricing table").
    expect(Object.keys(CHAT_MESSAGE_CREDITS).sort()).toEqual(["anthropic", "google", "openai"]);
    expect(CHAT_MESSAGE_CREDITS.anthropic.haiku).toBeDefined();
    expect(CHAT_MESSAGE_CREDITS.anthropic.sonnet).toBeDefined();
  });
});

/* ── The credits rework (2026-09): what a credit is worth ──────────── */

/**
 * THE $130 LINE, PINNED IN CODE. Albert's ruling fixes two numbers — 2600
 * credits a month, never more than $130 of our cost in that month — and the
 * third follows from them. These assertions exist so the third can never be
 * edited on its own: change any one constant and this file says which promise
 * just broke, rather than the arithmetic quietly meaning something else.
 */
describe("what one credit is worth", () => {
  it("recovers exactly the ruling's cost per credit", () => {
    expect(MONTHLY_ALLOWANCE * USD_PER_CREDIT).toBe(130);
  });

  it("states the multiple as the inverse of the price, not as a second opinion", () => {
    expect(CREDITS_PER_USD).toBe(1 / USD_PER_CREDIT);
  });
});

describe("creditsForUsd", () => {
  it("is ceil(usd × 20)", () => {
    expect(creditsForUsd(1)).toBe(20);
    expect(creditsForUsd(0.9)).toBe(18);
    expect(creditsForUsd(1.25)).toBe(25);
  });

  it("rounds UP, so a sub-cent remainder is never given away", () => {
    // 0.901 × 20 = 18.02. A floor would hand back the .02 on every run.
    expect(creditsForUsd(0.901)).toBe(19);
  });

  it("floors at one credit, so a cheap action is never free", () => {
    // A gemini-flash copilot turn is ~$0.002 — under a twentieth of a credit.
    expect(creditsForUsd(0.002)).toBe(1);
    expect(creditsForUsd(0.05)).toBe(1);
  });

  it("returns the floor rather than zero for a cost it cannot use", () => {
    // Callers must refuse "cost unknown" before they get here (settleJobCharge
    // does); if one does not, one credit is the honest failure and refunding
    // the whole hold is not.
    for (const bad of [0, -1, NaN, Infinity]) expect(creditsForUsd(bad)).toBe(1);
  });
});

describe("settlementFor", () => {
  it("hands back the difference when the run cost less than the estimate", () => {
    const s = settlementFor(25, 0.9);
    expect(s).toMatchObject({ credits: 18, delta: 7, capped: false });
  });

  it("takes the extra when the run cost more", () => {
    const s = settlementFor(25, 2);
    expect(s).toMatchObject({ credits: 40, delta: -15, capped: false });
  });

  it("writes a zero delta when the estimate was exactly right", () => {
    // Still a settlement, not a no-op: the row is what marks the hold resolved.
    expect(settlementFor(20, 1)).toMatchObject({ credits: 20, delta: 0, capped: false });
  });

  it("clips a runaway run at the cap and keeps the uncapped figure", () => {
    // $4.00 is 80 credits against a 25-credit estimate. Karos eats the 30 above
    // the cap; the real number is still reported so staff can see the drift.
    const s = settlementFor(25, 4);
    expect(s).toMatchObject({
      credits: 25 * SETTLEMENT_CAP_FACTOR,
      delta: -25,
      capped: true,
      uncappedCredits: 80,
    });
  });

  it("never caps a settlement that hands credits BACK", () => {
    // The cap bounds what a client can be charged, not what they can be
    // refunded — a cheap run settles to its real price however cheap it was.
    expect(settlementFor(100, 0.1)).toMatchObject({ credits: 2, delta: 98, capped: false });
  });

  it("keeps a one-credit hold settleable at the floor", () => {
    // hold × 2 = 2, and the floor is 1, so a 1-credit action settles to 1 and
    // the cap is not what decides it.
    expect(settlementFor(1, 0.002)).toMatchObject({ credits: 1, delta: 0, capped: false });
  });
});

describe("which operations never settle", () => {
  it("exempts the seat SKU and the setup charge by name", () => {
    // Both are monetization decisions, not measurements of compute — the seat
    // buys a seat and calls no model at all, and the setup price is calibrated
    // deliberately from a cross-client ratio.
    expect(UNSETTLED_OPERATIONS.has("seat_purchase")).toBe(true);
    expect(UNSETTLED_OPERATIONS.has("agent_launch")).toBe(true);
    expect(UNSETTLED_OPERATIONS.has("manual")).toBe(true);
  });

  it("settles every operation that measures a real run, small ones included", () => {
    // The ruling is "each run costs what it costs us", and the 1-credit floor
    // is what keeps a copilot turn from settling to nothing — not an exemption.
    for (const op of [
      "custom_agent_run",
      "agent_run",
      "chat_message",
      "task_execution",
      "doc_correction",
      "ai_tool",
    ] as const) {
      expect(UNSETTLED_OPERATIONS.has(op), `${op} must settle`).toBe(false);
    }
  });
});

describe("applySettlement", () => {
  withPlanV2();
  it("moves window spend OPPOSITE the balance, so the monthly cap stays true", () => {
    // A settlement that took 15 more credits and left monthSpent alone would
    // let a client spend past 2600 with the cap reading unbreached.
    const next = applySettlement(credits({ weekSpent: 30, monthSpent: 30 }), -15, NOW, NOW);
    expect(next.balance).toBe(CREDIT_DEFAULTS.startingBalance - 15);
    expect(next.weekSpent).toBe(45);
    expect(next.monthSpent).toBe(45);
  });

  it("hands window spend back when the run cost less", () => {
    const next = applySettlement(credits({ weekSpent: 30, monthSpent: 30 }), 7, NOW, NOW);
    expect(next.balance).toBe(CREDIT_DEFAULTS.startingBalance + 7);
    expect(next.weekSpent).toBe(23);
    expect(next.monthSpent).toBe(23);
  });

  it("corrects only the windows the HOLD accrued in", () => {
    // The hold landed in June; the settlement lands in July. July's spend is
    // not the spend being corrected, so it must not move — only the balance.
    const june = Date.UTC(2026, 5, 30, 12);
    const july = Date.UTC(2026, 6, 3, 12);
    const state: ClientCredits = {
      ...defaultClientCredits("c1", july),
      weekSpent: 40,
      monthSpent: 40,
    };
    const next = applySettlement(state, 7, july, june);
    expect(next.balance).toBe(CREDIT_DEFAULTS.startingBalance + 7);
    expect(next.monthSpent).toBe(40);
  });

  it("is allowed to push the balance negative — the work is already delivered", () => {
    // Refusing the settlement would strand the difference or retry forever. The
    // NEXT charge is denied through the existing insufficient_balance path, and
    // availableCredits floors at 0 so no pill renders a negative.
    const next = applySettlement(credits({ balance: 5 }), -20, NOW, NOW);
    expect(next.balance).toBe(-15);
    expect(availableCredits(next)).toBe(0);
  });
});

describe("the new plan's defaults", () => {
  withPlanV2();
  it("starts a client on the allowance, capped at the allowance, with no weekly cap", () => {
    expect(CREDIT_DEFAULTS.startingBalance).toBe(MONTHLY_ALLOWANCE);
    expect(CREDIT_DEFAULTS.monthlyLimit).toBe(MONTHLY_ALLOWANCE);
    // Dropped, not lowered: one cap, one denial message to explain.
    expect(CREDIT_DEFAULTS.weeklyLimit).toBeNull();
  });

  it("lets a fresh client spend their whole month in week one", () => {
    const fresh = defaultClientCredits("c1", NOW);
    expect(availableCredits(fresh)).toBe(MONTHLY_ALLOWANCE);
    expect(assessCharge(fresh, MONTHLY_ALLOWANCE, NOW).ok).toBe(true);
  });
});

describe("the monthly allowance top-up", () => {
  withPlanV2();
  const JUNE = Date.UTC(2026, 5, 15, 12);
  const JULY = Date.UTC(2026, 6, 15, 12);

  it("raises a spent-down balance back to the allowance when the month rolls", () => {
    const spent: ClientCredits = { ...defaultClientCredits("c1", JUNE), balance: 40, monthSpent: 2560 };
    const rolled = rollCreditWindows(spent, JULY);
    expect(rolled.balance).toBe(MONTHLY_ALLOWANCE);
    expect(rolled.monthSpent).toBe(0);
  });

  it("does NOT roll unused credits over — 2600 a month is the ceiling", () => {
    // Rollover would let one month legitimately cost us far more than $130,
    // which is the whole line this rework exists to hold.
    const barelyUsed: ClientCredits = { ...defaultClientCredits("c1", JUNE), balance: 2500 };
    expect(rollCreditWindows(barelyUsed, JULY).balance).toBe(MONTHLY_ALLOWANCE);
  });

  it("never takes credits away — a paid top-up survives the roll", () => {
    // `max`, not assignment. Robbing a client of credits an admin granted, in a
    // function called "roll the windows", would be the worst place to hide it.
    const toppedUp: ClientCredits = { ...defaultClientCredits("c1", JUNE), balance: 5000 };
    expect(rollCreditWindows(toppedUp, JULY).balance).toBe(5000);
  });

  it("does not top up on a mere WEEK roll", () => {
    const midMonth: ClientCredits = { ...defaultClientCredits("c1", JUNE), balance: 40 };
    const nextWeek = Date.UTC(2026, 5, 22, 12);
    const rolled = rollCreditWindows(midMonth, nextWeek);
    expect(rolled.balance).toBe(40);
    expect(rolled.weekSpent).toBe(0);
  });
});

describe("the lazy migration onto the new plan", () => {
  withPlanV2();
  /** A doc exactly as it was written before the rework: no plan stamp. */
  function legacyDoc(patch: Partial<ClientCredits> = {}): ClientCredits {
    const { planVersion: _drop, ...rest } = defaultClientCredits("c1", NOW);
    void _drop;
    return { ...rest, balance: 200, weeklyLimit: 150, monthlyLimit: 400, ...patch };
  }

  it("moves an untouched doc onto the new caps on the next read", () => {
    // There is no batch script: every read already passes through here, so the
    // migration rides the reads a client's own activity already causes.
    const rolled = rollCreditWindows(legacyDoc(), NOW);
    expect(rolled.weeklyLimit).toBeNull();
    expect(rolled.monthlyLimit).toBe(MONTHLY_ALLOWANCE);
  });

  it("leaves an admin's deliberate caps alone", () => {
    const rolled = rollCreditWindows(legacyDoc({ weeklyLimit: 42, monthlyLimit: 900 }), NOW);
    expect(rolled.weeklyLimit).toBe(42);
    expect(rolled.monthlyLimit).toBe(900);
  });

  it("grants the monthly allowance to an untouched doc the moment it enters the plan", () => {
    // Reversed on 2026-09-04 by the product owner looking at prep: a migrated
    // client whose cap said 2600 while the pill still said 195 read as the
    // rework not having shipped. Entering the plan is the first month of it.
    // Same `max` rule as the roll - a higher balance is never clawed back.
    expect(rollCreditWindows(legacyDoc(), NOW).balance).toBe(MONTHLY_ALLOWANCE);
    expect(rollCreditWindows(legacyDoc({ balance: 5000 }), NOW).balance).toBe(5000);
  });

  it("does not touch the balance of a doc an admin configured", () => {
    // An admin-set cap is a decision; the top-up follows the cap that admin
    // chose, on the next month roll, not on the deploy.
    expect(rollCreditWindows(legacyDoc({ monthlyLimit: 900 }), NOW).balance).toBe(200);
    expect(rollCreditWindows(legacyDoc({ weeklyLimit: 42, monthlyLimit: 900 }), NOW).balance).toBe(200);
  });

  it("leaves BOTH caps alone when only one of them is still the default", () => {
    // The docstring says an untouched doc is one "still reading exactly
    // 150/400", and checking the two independently did not implement that
    // sentence: a client whose MONTHLY cap an admin had raised to 900 still
    // carried the default 150 weekly, so the weekly half fired and quietly
    // removed a burst limiter from an account somebody had configured on
    // purpose. Any admin fingerprint on the caps means hands off, both of them.
    const mixed = rollCreditWindows(legacyDoc({ monthlyLimit: 900 }), NOW);
    expect(mixed.weeklyLimit).toBe(150);
    expect(mixed.monthlyLimit).toBe(900);
    // …and the other way round.
    const mixedOther = rollCreditWindows(legacyDoc({ weeklyLimit: 42 }), NOW);
    expect(mixedOther.weeklyLimit).toBe(42);
    expect(mixedOther.monthlyLimit).toBe(400);
  });

  it("stamps a half-legacy doc anyway, so it is judged once and then left alone", () => {
    // "Seen, decided, leave alone" is the whole point of the stamp. Without it
    // this doc would be re-inspected by the heuristic on every read forever.
    expect(rollCreditWindows(legacyDoc({ monthlyLimit: 900 }), NOW).planVersion).toBeDefined();
  });

  it("runs at most once: an admin who later types 150 keeps it", () => {
    // The stamp is what bounds the value-matching heuristic. Without it, 150
    // would be re-read as "untouched default" forever.
    const migrated = rollCreditWindows(legacyDoc(), NOW);
    const adminSet = { ...migrated, weeklyLimit: 150 };
    expect(rollCreditWindows(adminSet, NOW).weeklyLimit).toBe(150);
  });
});

describe("estimate copy", () => {
  it("hedges a quoted price without breaking the plural", () => {
    expect(estimatedCreditsLabel(25)).toBe("about 25 credits");
    expect(estimatedCreditsLabel(1)).toBe("about 1 credit");
  });

  it("shows both figures once a run has settled", () => {
    expect(settledCreditsLabel(18, 25)).toBe("18 credits (estimated 25)");
    expect(settledCreditsLabel(1, 5)).toBe("1 credit (estimated 5)");
  });

  it("never says token — the reason a price is an estimate is the temptation", () => {
    for (const s of [estimatedCreditsLabel(25), settledCreditsLabel(18, 25)]) {
      expect(s.toLowerCase()).not.toContain("token");
    }
  });
});

/**
 * THE FLAG OFF IS A PRODUCT STATE, NOT A GAP, and it is the one every
 * environment is in until somebody deliberately flips it. So it gets the same
 * treatment as the new behaviour: asserted, not assumed. Every case here is a
 * thing that must NOT have changed on the merge that introduced the rework.
 */
describe("with CREDITS_PLAN_V2_ENABLED off", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.CREDITS_PLAN_V2_ENABLED;
    delete process.env.CREDITS_PLAN_V2_ENABLED;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.CREDITS_PLAN_V2_ENABLED;
    else process.env.CREDITS_PLAN_V2_ENABLED = prior;
  });

  it("is off for an unset env var and for anything that is not exactly '1'", () => {
    expect(isCreditsPlanV2Enabled()).toBe(false);
    for (const v of ["", "0", "true", "yes"]) {
      process.env.CREDITS_PLAN_V2_ENABLED = v;
      expect(isCreditsPlanV2Enabled(), `"${v}" must not enable it`).toBe(false);
    }
    process.env.CREDITS_PLAN_V2_ENABLED = "1";
    expect(isCreditsPlanV2Enabled()).toBe(true);
  });

  it("starts a new client on the OLD plan", () => {
    expect(creditDefaults()).toEqual(LEGACY_CREDIT_DEFAULTS);
    const fresh = defaultClientCredits("c1", NOW);
    expect(fresh.balance).toBe(200);
    expect(fresh.weeklyLimit).toBe(150);
    expect(fresh.monthlyLimit).toBe(400);
    // Unstamped, so turning the flag on later still sees an untouched doc.
    expect(fresh.planVersion).toBeUndefined();
  });

  it("does not migrate an existing doc's caps", () => {
    const legacy: ClientCredits = {
      ...defaultClientCredits("c1", NOW),
      weeklyLimit: 150,
      monthlyLimit: 400,
    };
    const rolled = rollCreditWindows(legacy, NOW);
    expect(rolled.weeklyLimit).toBe(150);
    expect(rolled.monthlyLimit).toBe(400);
    expect(rolled.planVersion).toBeUndefined();
  });

  it("does not top a balance up when the month rolls", () => {
    // The single most consequential thing the flag holds back: without it, the
    // first read of any credits doc in a new month grants up to 2600 credits.
    const june = Date.UTC(2026, 5, 15, 12);
    const july = Date.UTC(2026, 6, 15, 12);
    const spent: ClientCredits = { ...defaultClientCredits("c1", june), balance: 40 };
    const rolled = rollCreditWindows(spent, july);
    expect(rolled.balance).toBe(40);
    // The windows still roll — that behaviour predates the rework.
    expect(rolled.monthSpent).toBe(0);
  });

  it("still enforces the old weekly and monthly caps", () => {
    const c: ClientCredits = { ...defaultClientCredits("c1", NOW), weekSpent: 148 };
    expect(assessCharge(c, 5, NOW).ok).toBe(false);
  });

  it("quotes an exact price at a metered control, with no hedge", () => {
    // "about 5 credits" would be a lie in the other direction: with settlement
    // off, the charge IS this figure.
    expect(simulationPrice(true)).toBe(creditsLabel(CREDIT_COSTS.taskExecution));
    expect(simulationPrice(true)).not.toContain("about");
    expect(insightsRefreshPrice(true)).toBe(creditsLabel(CREDIT_COSTS.chatMessage));
  });

  it("still quotes nothing to a reader who is never charged", () => {
    expect(simulationPrice(false)).toBeNull();
  });
});

describe("with CREDITS_PLAN_V2_ENABLED on, the price quotes hedge", () => {
  withPlanV2();

  it("says 'about' at every metered control", () => {
    for (const quote of [
      simulationPrice(true),
      taskMapRefreshPrice(true),
      insightsRefreshPrice(true),
      xRosterProposalPrice(true),
    ]) {
      expect(quote).toMatch(/^about \d+ credits?$/);
    }
  });

  it("still says nothing to an unbilled reader", () => {
    expect(simulationPrice(false)).toBeNull();
  });
});
