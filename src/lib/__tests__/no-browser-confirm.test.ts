import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The most consequential question of the session, asked in the browser's voice.
 *
 * `window.confirm()` cannot be styled, ignores the theme entirely, and renders
 * its buttons in the BROWSER's language on a surface that may be in Hebrew —
 * in a product that has just taught every content field to lay itself out
 * right-to-left. It also takes one string, so the question and its consequence
 * had to be crammed onto one line and then read as a system alert rather than
 * as part of the page.
 *
 * `ConfirmAction` is the same two-step pattern `client-seat-remove.tsx` had
 * already arrived at, extracted so the next caller does not invent a fourth
 * shape. This keeps the count going down rather than up.
 */

const SRC = join(process.cwd(), "src");

/**
 * The sites not yet converted, each with the reason.
 *
 * An empty list is the goal, and a NAMED list is the honest state on the way
 * there — an unnamed one is just a threshold that quietly ratchets.
 */
const REMAINING: Record<string, string> = {
  "components/post-management-row.tsx":
    "its confirm shares one `busy` flag with unpublish and re-schedule; converting it means restructuring three actions' state, not wrapping a trigger.",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(relative(SRC, full).split(sep).join("/"));
    }
  }
  return out;
}

/** A call to the global, not a prop named `confirmLabel` or a local function called `confirm`. */
const BROWSER_CONFIRM = /(?:^|[^.\w])(?:window\.)?confirm\s*\(/m;

/**
 * Comments first, and this is not tidiness.
 *
 * Every file that FIXES this problem explains it, and an explanation says
 * `window.confirm()` in prose. The first version of this scanner flagged
 * `ConfirmAction` itself, `job-delete.tsx` and the studio list — the three
 * files that had just stopped calling it — because it read their doc comments
 * as code. A guard that cannot tell a mention from a call reports the cure as
 * the disease.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*/g, "$1");
}

function callsBrowserConfirm(file: string): boolean {
  const text = withoutComments(readFileSync(join(SRC, file), "utf8"));
  // `function confirm()` is a local helper, not the global — `clients-grid.tsx`
  // has one, and matching it would make this test lie about its own count.
  const withoutDeclarations = text.replace(/function\s+confirm\s*\(/g, "function __local_confirm(");
  return BROWSER_CONFIRM.test(withoutDeclarations);
}

describe("destructive actions ask in the product's own voice", () => {
  it("walks a real tree, so an empty scan cannot pass", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(200);
  });

  it("leaves no unexplained window.confirm", () => {
    const offenders = sourceFiles(SRC)
      .filter(callsBrowserConfirm)
      .filter((file) => REMAINING[file] === undefined);

    expect(
      offenders,
      "these call the browser's confirm() — use `ConfirmAction`, or add an entry to REMAINING saying why not:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("keeps the remaining list honest — every entry still calls it", () => {
    // An exception that no longer applies is a standing excuse attached to
    // nothing, and it hides the day somebody adds a fifth.
    const stale = Object.keys(REMAINING).filter((file) => !callsBrowserConfirm(file));
    expect(stale, `these no longer call confirm() and can leave REMAINING:\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  it("gives every remaining site a real reason", () => {
    const thin = Object.entries(REMAINING).filter(([, why]) => why.trim().length < 40);
    expect(thin.map(([f]) => f)).toEqual([]);
  });
});

describe("ConfirmAction's two rules", () => {
  const SOURCE = readFileSync(join(SRC, "components/confirm-action.tsx"), "utf8");

  it("takes the verb as a label rather than offering OK", () => {
    // `confirm()`'s buttons say OK and Cancel, which read identically for
    // "delete this run" and "publish this post".
    expect(SOURCE).toMatch(/confirmLabel: string/);
    expect(SOURCE).not.toMatch(/>OK</);
  });

  it("keeps the block open when the action fails", () => {
    // Closing on failure returns the reader to a trigger that looks untouched,
    // with the reason gone.
    expect(SOURCE).toMatch(/if \(message\) \{[\s\S]{0,80}setError\(message\);[\s\S]{0,40}return;/);
  });
});
