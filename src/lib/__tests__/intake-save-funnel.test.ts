import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { INTAKE_SAVE_FAILED, INTAKE_UPLOAD_FAILED, intakeSave } from "@/lib/intake-save";
import {
  insideAnyRange,
  isStringDelimiter,
  matchingBrace,
  matchingParen,
  skipStringLiteral,
  stripComments,
} from "./source-scan";

/**
 * #86: every write on an intake surface must go through a wrapper that cannot
 * throw past it.
 *
 * THE DEFECT. Fourteen call sites were written as
 * `const result = await <someAction>(…); if (result.error) …` inside a
 * `startTransition` with no try/catch. A server action can REJECT rather than
 * return — `requireClientAccess` throws on a lapsed session and on a foreign
 * client id — and a rejection escapes the transition instead of producing a
 * `result`, so `setError` is never reached. There is no error.tsx anywhere in
 * this tree, so nothing renders a recovery: the user gets a dropped click, and
 * on the CV upload a file input that has already been consumed.
 *
 * WHY THE GUARD IS A SOURCE SCAN AND NOT A LIST. The fix is one function
 * (`intakeSave`), and a list of the fourteen sites it was applied to would say
 * nothing about the fifteenth. So the file set is DERIVED: every
 * `*-agent-intake.tsx` in the components tree, plus every `@/components` module
 * those files import, transitively — which is where an action call can hide
 * without being written in an intake file at all. That closure is how
 * `company-news-box.tsx` (mounted inside two of the three intake surfaces) got
 * counted; it was not on the reported list of twelve.
 *
 * WHAT IT ASKS, of code with its comments removed:
 *
 *   1. no `await <name>Action(` anywhere — awaiting an action directly is the
 *      shape that cannot be caught;
 *   2. every `<name>Action(` call sits inside a `intakeSave(() => …)` THUNK, by
 *      character range, so the block-bodied form the CV upload needs is legal
 *      and the second-argument position (evaluated before the funnel's try) is
 *      not.
 *
 * Rule 2 is the load-bearing one: rule 1 alone would pass a call that was fired
 * without `await` and its rejection dropped on the floor.
 *
 * WHAT IT DOES NOT CLAIM. IT IS NOT REPO-WIDE, and the residual is large. Before
 * this change, 75 of the 90 `startTransition(async () => { await … })` blocks in
 * `src/` had neither a try/catch nor a funnel (77 awaited call sites). Wrapping
 * this cluster closed 16 of them; 59 blocks and 61 awaited call sites are STILL
 * unprotected — the task board, the agent launch/live cards, the feedback modal,
 * the job controls, custom agents, the drafts-review panes, the signup form and
 * more. Every one carries the identical hazard. Those surfaces belong to other
 * clusters, so this file guards the intake cluster and that number is a RESIDUAL
 * written down, not a claim that the shape is closed.
 *
 * (Measured with the same two questions this file asks, applied to every
 * transition body in `src/`: does the body hold a `try {`, or a call to
 * `intakeSave(`. Re-measure before quoting it — it is a count, and a count in a
 * comment is a claim the file cannot verify.)
 */

const REPO = path.resolve(__dirname, "../..", "..");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

/* ─────────────────────────── what the funnel does ───────────────────────── */

describe("intakeSave", () => {
  it("hands back the action's own result untouched", async () => {
    const ok = await intakeSave(async () => ({ seatId: "s1" }));
    expect(ok).toEqual({ seatId: "s1" });
    const refused = await intakeSave(async () => ({ error: "Name is required." }));
    expect(refused).toEqual({ error: "Name is required." });
  });

  it("turns a REJECTED action into a readable result instead of a dropped click", async () => {
    // The real shape: requireClientAccess throws `new Error("Unauthorized")`.
    const result = await intakeSave(async () => {
      throw new Error("Unauthorized");
    });
    expect(result).toEqual({ error: INTAKE_SAVE_FAILED });
  });

  it("catches a throw in the CALL expression too, not only a rejected promise", async () => {
    // Why `run` is a thunk: the CV upload builds a FormData before it calls the
    // action, and a throw there is the same dropped click.
    const result = await intakeSave(() => {
      throw new Error("boom");
    });
    expect(result).toEqual({ error: INTAKE_SAVE_FAILED });
  });

  it("leaks no internal string into the sentence a client reads", async () => {
    const thrown = "Forbidden: FIRESTORE_EMULATOR_HOST unset at getCurrentUser";
    const result = await intakeSave(async () => {
      throw new Error(thrown);
    });
    const message = "error" in result ? (result.error ?? "") : "";
    expect(message).not.toContain(thrown);
    for (const internal of ["Unauthorized", "Forbidden", "Error", "undefined"]) {
      expect(message, internal).not.toContain(internal);
    }
  });

  it("holds the copy standard for two sentences no channel sweeps", () => {
    // These live in lib/, so client-copy-boundary.test.ts sees neither: it
    // reads server actions and the app/components trees, and this module is
    // neither. They are rendered verbatim in a client's error banner, so the
    // two rules that file asks of every other channel are asked here.
    for (const line of [INTAKE_SAVE_FAILED, INTAKE_UPLOAD_FAILED]) {
      expect(line, `spaced hyphen — use an em dash: ${line}`).not.toMatch(/\S[ \t]-[ \t]\S/);
      expect(line, `stored-enum shape in prose: ${line}`).not.toMatch(/[a-z]+_[a-z]+/);
      expect(line[0], line).toBe(line[0]!.toUpperCase());
    }
  });

  it("lets the upload path say something true about a consumed file input", async () => {
    // "Your answers are still on screen" is false for a file input, which has
    // already been read by the time the action rejects.
    const result = await intakeSave(async () => {
      throw new Error("Unauthorized");
    }, INTAKE_UPLOAD_FAILED);
    expect(result).toEqual({ error: INTAKE_UPLOAD_FAILED });
    expect(INTAKE_UPLOAD_FAILED).not.toBe(INTAKE_SAVE_FAILED);
    expect(INTAKE_UPLOAD_FAILED).toMatch(/choose the file again/i);
  });
});

/* ──────────────────── the file set, derived from the source ─────────────── */

/** Every intake surface in the components tree, found rather than listed. */
function intakeSurfaces(): string[] {
  return readdirSync(path.join(REPO, "src/components"))
    .filter((name) => name.endsWith("-agent-intake.tsx"))
    .sort()
    .map((name) => `src/components/${name}`);
}

/**
 * The seeds. The intake surfaces are discovered; the employee-seat roster is
 * NAMED, because it is reached from the settings page rather than from an intake
 * page and so cannot be found by following imports from these seeds — and it is
 * the file whose own comment taught this lesson, with two of its three writes
 * left unwrapped when it did.
 */
function seeds(): string[] {
  return [...intakeSurfaces(), "src/components/linkedin-seats-workspace.tsx"];
}

/** Every `@/components` module reachable from the seeds, transitively. */
function componentClosure(from: string[]): string[] {
  const seen = new Set<string>();
  const stack = [...from];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const m of read(rel).matchAll(/from\s+"@\/components\/([\w./-]+)"/g)) {
      const base = `src/components/${m[1]}`;
      stack.push(base.endsWith(".tsx") || base.endsWith(".ts") ? base : `${base}.tsx`);
    }
  }
  return [...seen].sort();
}

const AWAITED_ACTION = /\bawait\s+([A-Za-z_$][\w$]*Action)\s*\(/g;
const ANY_ACTION_CALL = /([A-Za-z_$][\w$]*Action)\s*\(/g;
const FUNNEL_CALL = /\bintakeSave\s*\(/g;
/** The funnel's first argument must be a no-arg thunk — `() =>`. */
const THUNK_HEAD = /^\s*\(\s*\)\s*=>\s*/;

/**
 * Where an EXPRESSION-bodied thunk's body ends: the first `,` sitting at the
 * funnel's own argument depth, or — when the thunk is the only argument — the
 * funnel's closing paren.
 *
 * That comma is the only thing separating the thunk from the failure message, so
 * it is the whole difference between a range that stops at the thunk and one
 * that runs on over the second argument. Brackets of all three kinds are
 * counted and string literals skipped whole, so a comma inside the action's own
 * argument list, inside an object literal or inside a template cannot end the
 * body early.
 *
 * ANGLE BRACKETS ARE NOT COUNTED, stated because it is the one comma this cannot
 * read: a type argument list (`foo<A, B>()`) written at the top level of a thunk
 * body would end the body at its comma. That direction over-reports — the range
 * gets SHORTER, so a real call past it is reported rather than exempted — which
 * is the direction a guard is allowed to be wrong in. No site in the closure has
 * one; if one appears it will show up as a spurious offence, not as silence.
 */
function expressionThunkEnd(code: string, bodyAt: number, close: number): number {
  let depth = 0;
  for (let i = bodyAt; i < close; i++) {
    const ch = code[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(code, i);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return close;
}

/**
 * Every funnel call whose first argument is a thunk: the character range that
 * thunk's BODY occupies — the only place an action call is allowed to sit — and
 * the index at which a second argument to that funnel would begin.
 *
 * THE SHAPE, NOT A LOCATION: it says the call is inside this funnel's own thunk,
 * so renaming the action, moving the handler or adding arguments cannot loosen
 * it, and moving the call out from between the thunk's delimiters stops it being
 * exempt immediately.
 *
 * FAILS CLOSED in both directions it can be unsure. An `intakeSave(` whose first
 * argument is NOT a thunk contributes no range at all, so anything inside it is
 * reported; and the range stops at the THUNK's own end rather than at the
 * funnel's closer, so a call in the second-argument position (the failure
 * message, evaluated BEFORE the funnel's try) is outside it and reported too.
 *
 * THE SECOND HALF IS SPELLED PER BODY FORM, because it used to hold for only one
 * of them. A block body ends at its matching `}`, which is correct and always
 * was. An expression body was handed the FUNNEL's closing paren as its end,
 * which swallowed the comma and the whole second argument — so the protection
 * this comment claimed was absent at EVERY expression-bodied site, and the CV
 * upload is the only block-bodied one in the closure. It now ends at
 * `expressionThunkEnd` above, and the plant in "reports a call in the funnel's
 * SECOND-argument position" asserts it against the real text of every site, in
 * both forms — so this paragraph is a claim the file itself checks rather than
 * one a reader has to take.
 */
function funnelSites(
  code: string,
): Array<{ form: "block" | "expression"; body: [number, number]; secondArgAt: number }> {
  const out: Array<{ form: "block" | "expression"; body: [number, number]; secondArgAt: number }> =
    [];
  for (const m of code.matchAll(FUNNEL_CALL)) {
    const afterOpen = m.index + m[0].length;
    const close = matchingParen(code, afterOpen - 1);
    const head = THUNK_HEAD.exec(code.slice(afterOpen));
    if (!head || close < 0) continue;
    const bodyAt = afterOpen + head[0].length;
    if (code[bodyAt] === "{") {
      const end = matchingBrace(code, bodyAt);
      // The second argument starts after the block's own closing brace.
      if (end > bodyAt) out.push({ form: "block", body: [bodyAt, end], secondArgAt: end + 1 });
      continue;
    }
    const end = expressionThunkEnd(code, bodyAt, close);
    out.push({ form: "expression", body: [bodyAt - 1, end], secondArgAt: end });
  }
  return out;
}

/** The permitted ranges alone, for the offence scan. */
function funnelThunkRanges(code: string): Array<[number, number]> {
  return funnelSites(code).map((site) => site.body);
}

/** Offences in one file's code, as sentences naming the action. */
function offences(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(AWAITED_ACTION)) {
    out.push(`awaits ${m[1]} directly — a rejection here produces no result to read`);
  }
  const permitted = funnelThunkRanges(code);
  for (const m of code.matchAll(ANY_ACTION_CALL)) {
    if (!insideAnyRange(permitted, m.index)) {
      out.push(`calls ${m[1]} outside a intakeSave(() => …) thunk`);
    }
  }
  return out;
}

describe("#86 — every intake write goes through the funnel", () => {
  const surfaces = intakeSurfaces();
  const files = componentClosure(seeds());

  it("finds the intake surfaces at all", () => {
    // Non-vacuity. An empty glob would make every assertion below pass by
    // asking nothing, which is the quietest way for this guard to die.
    expect(surfaces).toEqual([
      "src/components/blog-agent-intake.tsx",
      "src/components/linkedin-agent-intake.tsx",
      "src/components/newsletter-agent-intake.tsx",
      "src/components/reddit-agent-intake.tsx",
      "src/components/x-agent-intake.tsx",
    ]);
  });

  it("reaches the modules those surfaces mount, not just the surfaces", () => {
    // The closure is the point: an action call can live in a component an
    // intake page merely mounts. Both of these are found that way.
    expect(files).toContain("src/components/company-news-box.tsx");
    expect(files).toContain("src/components/client-seat-remove.tsx");
  });

  it("routes every action call in that closure through intakeSave", () => {
    const found: Record<string, string[]> = {};
    for (const rel of files) {
      const bad = offences(stripComments(read(rel)));
      if (bad.length > 0) found[rel] = bad;
    }
    expect(found).toEqual({});
  });

  it("would report an unwrapped call in any of those files", () => {
    // THE TEETH, checked against the real text of every scanned file rather
    // than a synthetic string: if a stray delimiter had opened a bogus range in
    // one of them, the scan above would report clean over source it cannot see,
    // and this is where that shows up. Appended, so a range running to EOF
    // hides the plant and fails here.
    for (const rel of files) {
      const planted = `${stripComments(read(rel))}\nconst x = await plantedFakeAction();\n`;
      expect(offences(planted), rel).not.toEqual([]);
    }
  });

  it("reports a call in the funnel's SECOND-argument position, in both body forms", () => {
    // THE CLAIM THE RANGE MAKES, ASKED OF THE RANGE. The second argument is the
    // failure message and it is evaluated BEFORE the funnel's try, so an action
    // call there is the dropped click #86 is about, wearing the funnel's name.
    // The expression form used to be handed the funnel's own closer as its end,
    // which permitted exactly this plant at all but one of the sites below —
    // so the plant is made in the REAL text of every site rather than in a
    // synthetic string, and both body forms are asserted to occur.
    const forms = new Set<string>();
    let sites = 0;
    for (const rel of files) {
      const code = stripComments(read(rel));
      for (const site of funnelSites(code)) {
        const at = site.secondArgAt;
        const planted = `${code.slice(0, at)}, plantedSecondArgAction()${code.slice(at)}`;
        const reported = offences(planted).filter((o) => o.includes("plantedSecondArgAction"));
        expect(reported, `${rel} @${at} (${site.form}-bodied)`).not.toEqual([]);
        forms.add(site.form);
        sites++;
      }
    }
    // Non-vacuity, and the half a count cannot give: no sites at all would make
    // the loop assert nothing, and one form present would leave the other
    // untested. Bounded loosely rather than pinned to a number, because the
    // number of wrapped sites is expected to move.
    expect(sites).toBeGreaterThan(10);
    expect([...forms].sort()).toEqual(["block", "expression"]);
  });

  it("counts the funnel's users, so a surface cannot quietly stop importing it", () => {
    // Every file in the closure that calls an action must also import the
    // funnel. Rule 2 above already implies it, but a file that dropped its
    // import AND its calls in one edit would pass silently — this says the
    // cluster still has the number of funnelled surfaces it had.
    const users = files.filter((rel) => /\bintakeSave\b/.test(stripComments(read(rel))));
    expect(users).toEqual([
      "src/components/blog-agent-intake.tsx",
      "src/components/client-seat-remove.tsx",
      "src/components/company-news-box.tsx",
      "src/components/linkedin-agent-intake.tsx",
      "src/components/linkedin-seats-workspace.tsx",
      "src/components/newsletter-agent-intake.tsx",
      "src/components/reddit-agent-intake.tsx",
      "src/components/x-agent-intake.tsx",
    ]);
  });
});
