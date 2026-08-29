import { resolve } from "node:path";
import { readSource } from "./source-scan";

import {
  CHAT_MESSAGE_CREDITS,
  CREDIT_BUCKET_LABEL,
  CREDIT_COSTS,
  CREDIT_OPERATION_LABEL,
  chatMessageCreditCost,
  chatModelFor,
  creditBucketFor,
  type CreditBucket,
} from "@/lib/credits";
import type { CreditOperation, JobRunType } from "@/lib/types";
import { describe, expect, it } from "vitest";
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
  defaultClientCredits,
  insightsRefreshPrice,
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

describe("bindingCreditLimit", () => {
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

describe("chatModelFor", () => {
  it("picks the default (Haiku) tier when the request did not opt into deep", () => {
    expect(chatModelFor(false)).toBe("haiku");
    expect(chatModelFor(undefined)).toBe("haiku");
  });

  it("picks Sonnet only when the request explicitly asked for a deep turn", () => {
    expect(chatModelFor(true)).toBe("sonnet");
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
