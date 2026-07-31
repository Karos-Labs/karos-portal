import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CREDIT_DENIAL_PREFIX,
  CREDIT_BLOCK_REASON,
  assessCharge,
  creditMonthKey,
  creditWeekKey,
  isCreditDenialMessage,
} from "@/lib/credits";
import type { ClientCredits } from "@/lib/types";

/**
 * The credits-UX cluster: a refusal a client cannot see is the same bug as no
 * refusal at all. On the 30 Jul call the pilot client ran out of credits and
 * the Generate Plan button simply came back empty — "instead of loading
 * forever" is the acceptance test, so the wiring that makes a denial visible is
 * pinned here. Two of the three are invisible to a type check (a discarded
 * field and a server-boundary filter), so they are asserted from the sources
 * themselves, in the style of settings-nav.test.ts.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const MODAL = "src/components/task-ticket-modal.tsx";
const TASKS_BODY = "src/app/(app)/tasks/tasks-body.tsx";

/** The body of a named top-level function in a source file. */
function functionBody(src: string, declaration: string): string {
  const open = src.indexOf(declaration);
  expect(open, `no ${declaration} in source`).toBeGreaterThan(-1);
  const close = src.indexOf("\n  }", open);
  expect(close).toBeGreaterThan(open);
  return src.slice(open, close);
}

describe("Generate Plan surfaces the refusal it is handed", () => {
  const modal = source(MODAL);
  const generate = functionBody(modal, "function generate()");

  it("reads result.error rather than dropping it", () => {
    expect(generate).toContain("result.error");
  });

  it("puts it in an error state, with a sentence-case fallback", () => {
    expect(modal).toContain("const [planError, setPlanError] = useState<string | null>(null)");
    expect(generate).toMatch(/setPlanError\(result\.error \?\? "[A-Z][^"]*"\)/);
    // A fresh press clears the previous refusal, like approve/adjust do.
    expect(generate).toContain("setPlanError(null)");
  });

  it("renders that state, so an out-of-credits press is not a dead button", () => {
    expect(modal).toContain("{planError && (");
    expect(modal).toContain("{planError}");
  });

  it("matches the panel's existing refusal handlers rather than inventing a style", () => {
    // The three that were already correct — the new one is the fourth of a
    // kind, not a fourth kind.
    expect(modal).toContain('setActionError(res.error ?? "Could not approve the deliverable")');
    expect(modal).toContain('setAdjustError(res.error ?? "Could not request adjustments")');
    expect(modal).toContain('setActionError(res.error ?? "Could not send the email")');
  });
});

describe("the tasks timeline hides failed runs from clients only", () => {
  const body = source(TASKS_BODY);
  const timelineJobs = body.slice(
    body.indexOf("const timelineJobs: TimelineJob[] = jobs"),
    body.indexOf(".map((job) => ({"),
  );

  it("filters failed jobs on the client-viewer branch", () => {
    expect(timelineJobs).toContain('.filter((job) => !(isClientViewer && job.status === "failed"))');
  });

  it("leaves the staff branch untouched — the guard is on isClientViewer", () => {
    // Every status filter in this projection must be conditional. An
    // unconditional one would take failures off the staff timeline too.
    const statusFilters = timelineJobs.match(/\.filter\(\(job\) => [^\n]*status[^\n]*\)/g) ?? [];
    expect(statusFilters).toHaveLength(1);
    expect(statusFilters[0]).toContain("isClientViewer &&");
  });

  it("is applied at the server boundary, not at render", () => {
    // tasks-body is the RSC that assembles the payload; a failed run must not
    // cross into it at all. If this file ever becomes a client component the
    // filter has moved to the wrong side of the boundary.
    expect(body).not.toContain('"use client"');
  });

  it("reads as the same decision the calendar already made", () => {
    const calendar = source("src/app/(app)/calendar/calendar-body.tsx");
    expect(calendar).toContain('.filter((j) => !(isClient && j.status === "failed"))');
    expect(calendar).toContain("hide internal failures from clients");
    expect(timelineJobs).toContain("hide internal failures from clients");
  });
});

describe("the denial prefixes and isCreditDenialMessage agree", () => {
  const NOW = Date.UTC(2026, 6, 31);
  // Keys derived, not spelled: a literal that misses the current window would
  // have rollCreditWindows zero the spend and quietly defuse the cap cases.
  const credits = (over: Partial<ClientCredits> = {}): ClientCredits => ({
    clientId: "c1",
    balance: 100,
    weekKey: creditWeekKey(NOW),
    weekSpent: 0,
    monthKey: creditMonthKey(NOW),
    monthSpent: 0,
    weeklyLimit: null,
    monthlyLimit: null,
    updatedAt: 0,
    ...over,
  });

  it("detects a message built from each prefix", () => {
    for (const prefix of Object.values(CREDIT_DENIAL_PREFIX)) {
      expect(isCreditDenialMessage(`${prefix} 25 credits and 3 are left.`)).toBe(true);
    }
  });

  it("detects every message assessCharge actually mints", () => {
    const denials = [
      assessCharge(credits({ balance: 1 }), 25, NOW),
      assessCharge(credits({ weeklyLimit: 10, weekSpent: 9 }), 5, NOW),
      assessCharge(credits({ monthlyLimit: 50, monthSpent: 49 }), 5, NOW),
    ];
    for (const denial of denials) {
      expect(denial.ok).toBe(false);
      if (denial.ok) continue;
      expect(isCreditDenialMessage(denial.message)).toBe(true);
    }
  });

  it("still detects the pre-2026-07-31 spaced-hyphen spelling", () => {
    // Stored refusals (clientAgent.lastError) predate the em-dash fix. If this
    // fails, clientSafeRefusal starts paraphrasing away real credit denials.
    expect(isCreditDenialMessage("Not enough credits - this action costs 25 credits and 3 are left.")).toBe(true);
  });

  it("does not pass an arbitrary quota error off as a credit denial", () => {
    expect(isCreditDenialMessage("Quota exceeded: rate limit for this project")).toBe(false);
    expect(isCreditDenialMessage("Not enough credits")).toBe(false);
  });

  it("says the same thing in both voices, with the house em dash", () => {
    expect(CREDIT_DENIAL_PREFIX.insufficient_balance).toContain(" — ");
    expect(CREDIT_DENIAL_PREFIX.insufficient_balance).not.toContain(" - ");
    // The ruling: the client is pointed at their Karos team, not at an "admin".
    expect(CREDIT_BLOCK_REASON.insufficient_balance).toBe(
      "Not enough credits — ask your Karos team for a top-up.",
    );
  });

  it("keeps every minted denial free of a spaced hyphen", () => {
    const denial = assessCharge(credits({ weeklyLimit: 10, weekSpent: 9 }), 5, NOW);
    expect(denial.ok).toBe(false);
    if (denial.ok) return;
    expect(denial.message).not.toContain(" - ");
  });
});
