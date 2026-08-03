import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isValidTimeZone } from "@/lib/run-cadence";
import { matchingBrace, matchingParen, skipStringLiteral, stripComments } from "./source-scan";

const SRC = join(process.cwd(), "src");

const read = (rel: string) => stripComments(readFileSync(join(SRC, rel), "utf8"));

/** Every string literal in `src`, without its delimiters. */
function stringLiterals(src: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const end = skipStringLiteral(src, i);
    if (end > i) {
      out.push(src.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

/** Top-level (depth-zero) argument count of a call whose `(` sits at `open`. */
function argCount(src: string, open: number): number {
  const close = matchingParen(src, open);
  if (close < 0) return -1;
  const inner = src.slice(open + 1, close);
  if (inner.trim() === "") return 0;
  let depth = 0;
  let args = 1;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    const jump = skipStringLiteral(inner, i);
    if (jump > i) {
      i = jump;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    else if (ch === "," && depth === 0) args++;
  }
  return args;
}

/**
 * ── #74: one calendar, one clock ──
 *
 * The month grid is drawn from the viewer's own `Date`: the month it opens on,
 * the day numbers in the cells and the "today" ring. `dayKey` decides which
 * cell an entry lands in, and it used to take an optional `timeZone` that only
 * scheduled runs passed — so run chips were bucketed on the SCHEDULE's calendar
 * while post chips and the grid itself were on the viewer's. Three sources for
 * one grid, and the pinned one is not even the viewer's: a schedule's zone is
 * the browser zone of whoever created it, usually a staff member in another
 * country.
 *
 * The schedule's zone is still PRINTED (`timeStr` + `zoneLabel`) — the wall
 * clock is the intent. The cell is the viewer's question.
 *
 * This is a source scan because `dayKey` is module-private and the grid is a
 * React tree; what it pins is the arity, which is the thing that came back
 * wrong. A second clock cannot be reintroduced without adding an argument.
 */
describe("the calendar grid buckets every entry on one clock", () => {
  const calendar = () => read("components/run-calendar.tsx");

  it("declares dayKey with exactly one parameter", () => {
    const src = calendar();
    const decl = src.indexOf("function dayKey");
    expect(decl).toBeGreaterThan(-1);
    // The paren AFTER the name — that is the parameter list. (The brace after a
    // name is not: it would be the next block entirely.)
    const paren = src.indexOf("(", decl);
    expect(argCount(src, paren)).toBe(1);
  });

  it("has no zone lookup inside dayKey's body", () => {
    const src = calendar();
    const decl = src.indexOf("function dayKey");
    const paren = src.indexOf("(", decl);
    const bodyOpen = src.indexOf("{", matchingParen(src, paren));
    const body = src.slice(bodyOpen, matchingBrace(src, bodyOpen) + 1);
    expect(body).not.toContain("Intl");
    expect(body).not.toContain("timeZone");
    // …and it does read the viewer's own Date, which is the grid's frame.
    expect(body).toContain("new Date(at)");
  });

  it("passes one argument at every call site", () => {
    const src = calendar();
    const calls: number[] = [];
    for (const m of src.matchAll(/\bdayKey\s*\(/g)) {
      // The declaration's own parameter list is not a call.
      if (/function\s+$/.test(src.slice(Math.max(0, m.index! - 12), m.index!))) continue;
      calls.push(m.index! + m[0].length - 1);
    }
    expect(calls.length).toBeGreaterThanOrEqual(2); // runsByDay and postsByDay
    for (const open of calls) {
      expect(argCount(src, open), src.slice(open - 30, open + 40)).toBe(1);
    }
  });

  it("still prints the schedule's own wall clock where a reader can SEE it", () => {
    // The remedy the consolidation must not take with it: dropping the zone from
    // the BUCKET is only honest if the LABEL keeps it.
    //
    // KEYED TO THE VISIBLE LINE, not to the file. Both strings occur TWICE in
    // run-calendar.tsx — once in a hover `title=` attribute and once in the
    // day-detail line — so `toContain` was satisfied by the tooltip alone, and
    // deleting the remedy from the surface it protects left this green. A
    // tooltip is not an affordance on touch, so the hover copy is not the
    // remedy. Enumerated trap #2, on the one assertion guarding rule 6.
    const src = calendar();
    const rendered = src
      .split("\n")
      .filter((line) => !/\btitle=/.test(line))
      .join("\n");
    expect(rendered, "the schedule's own clock survives only in a tooltip").toContain(
      "timeStr(run.at, run.timeZone)",
    );
    expect(rendered, "the zone label survives only in a tooltip").toContain("run.zoneLabel");
  });

  it("reports a planted second argument — the scan is not vacuous", () => {
    const planted = "function dayKey(at: number, timeZone?: string) { return `${at}`; }";
    const decl = planted.indexOf("function dayKey");
    expect(argCount(planted, planted.indexOf("(", decl))).toBe(2);
    expect(argCount("f(a)", 1)).toBe(1);
    expect(argCount("f(a, b)", 1)).toBe(2);
    // A comma inside a nested call or a string must not count as a second arg.
    expect(argCount("f(g(a, b))", 1)).toBe(1);
    expect(argCount('f("a, b")', 1)).toBe(1);
  });
});

/**
 * ── #75: no client starts on someone else's clock ──
 *
 * The legacy schedule form pre-filled `America/Sao_Paulo` for every client in
 * the product, from a hardcoded literal, into a free-text field nothing
 * validated. The planned scheduler had already answered this question — the
 * hour you type is the hour on your screen, and the zone travels with it — and
 * two schedule surfaces in one product with two answers is the shape that goes
 * wrong.
 *
 * Keyed to MEANING, not spelling: a candidate is anything the runtime's own
 * Intl resolves as a zone id, so a different region's literal is caught the
 * same way Brazil's was.
 */
describe("both schedule forms take their zone from the runtime, not a literal", () => {
  const RESOLVES_A_ZONE = /runtimeTimeZone\(\)|resolvedOptions\(\)\.timeZone/;

  // Every surface in the product that decides what zone a typed wall clock
  // means. All three, because "two answers" is the defect and a third surface
  // drifting is the same defect again.
  const forms = [
    "components/scheduled-runs.tsx", // the legacy ScheduledRun form
    "components/schedule-run-modal.tsx", // the planned-run scheduler
    "components/custom-agents.tsx", // the client pace dialog
  ];

  it("resolves the zone from the runtime on every schedule form", () => {
    for (const rel of forms) {
      expect(RESOLVES_A_ZONE.test(read(rel)), rel).toBe(true);
    }
  });

  it("carries no hardcoded IANA zone id on any schedule form", () => {
    for (const rel of forms) {
      const zones = stringLiterals(read(rel)).filter(
        (lit) => lit.includes("/") && isValidTimeZone(lit),
      );
      expect(zones, rel).toEqual([]);
    }
  });

  it("reports a planted zone literal — the scan is not vacuous", () => {
    const planted = 'const tz = "America/Sao_Paulo";';
    expect(
      stringLiterals(planted).filter((lit) => lit.includes("/") && isValidTimeZone(lit)),
    ).toEqual(["America/Sao_Paulo"]);
    // Another region's, to show the check is not a Brazil blocklist.
    expect(
      stringLiterals('x("Asia/Tokyo")').filter((lit) => lit.includes("/") && isValidTimeZone(lit)),
    ).toEqual(["Asia/Tokyo"]);
    // And that ordinary slashed strings in these files do not trip it.
    for (const lit of ["text-foreground/70", "bg-neon/40", "/clients/x", "en-US"]) {
      expect(isValidTimeZone(lit) && lit.includes("/"), lit).toBe(false);
    }
  });
});
