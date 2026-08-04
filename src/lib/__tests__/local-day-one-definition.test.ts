import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import * as postChain from "@/lib/post-chain";
import * as scheduling from "@/lib/scheduling";
import { stripComments } from "./source-scan";

const SRC = join(process.cwd(), "src");

/**
 * "Which calendar day is this instant on" had two exported answers with two
 * bodies — `sameLocalDay` in lib/scheduling (Y/M/D triple compare) and
 * `sameLocalDay` in lib/post-chain (local-midnight compare) — and the first
 * carried the comment "one definition of 'same day'", which the second
 * falsified. They agreed, which is exactly why nobody noticed; the hazard is
 * the next edit to one of them.
 *
 * There is now ONE body, in lib/scheduling, with `sameLocalDay` defined FROM
 * `startOfDayMs` so the bucket and the comparison cannot come apart.
 * lib/post-chain re-exports both, because that is where the chain's callers
 * already look for day math.
 */
describe("one definition of the local calendar day", () => {
  it("hands out the same function object from both import paths", () => {
    // Identity, not behaviour: two bodies that happen to agree today would pass
    // a behavioural check and fail this one.
    expect(postChain.sameLocalDay).toBe(scheduling.sameLocalDay);
    expect(postChain.startOfDayMs).toBe(scheduling.startOfDayMs);
  });

  it("defines the comparison from the bucket, so the two cannot disagree", () => {
    // Runtime-zone independent: a local day is 23–25 hours long everywhere, so
    // midnight + 12h is always the same local day and midnight − 1ms never is.
    const anchors = [
      Date.parse("2026-01-01T00:00:00Z"),
      Date.parse("2026-03-08T09:00:00Z"), // a spring-forward day in the Americas
      Date.parse("2026-10-25T09:00:00Z"), // a fall-back day in Europe
      Date.parse("2026-06-15T23:30:00Z"),
    ];
    for (const t of anchors) {
      const midnight = scheduling.startOfDayMs(t);
      expect(scheduling.sameLocalDay(t, t), String(t)).toBe(true);
      expect(scheduling.sameLocalDay(midnight, midnight + 12 * 3600_000), String(t)).toBe(true);
      expect(scheduling.sameLocalDay(midnight, midnight - 1), String(t)).toBe(false);
      // The relationship the single body guarantees, asserted rather than assumed.
      expect(
        scheduling.sameLocalDay(t, midnight),
        String(t),
      ).toBe(scheduling.startOfDayMs(t) === scheduling.startOfDayMs(midnight));
    }
  });
});

/** Every .ts/.tsx under src, excluding the test directory itself. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      sourceFiles(full, out);
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * A third copy under a THIRD name is not caught here — this reads the two names
 * that exist, and no scan of source text can recognise a re-implementation that
 * calls itself something else. What it does catch is the shape that actually
 * happened: someone adding `function sameLocalDay` back to the module that used
 * to have one, or to a new module, instead of importing it.
 */
function declarationCount(name: string): { count: number; files: string[] } {
  const files: string[] = [];
  let count = 0;
  const re = new RegExp(
    `(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=\\s*(?:function\\b|\\())`,
    "g",
  );
  for (const file of sourceFiles(SRC)) {
    const hits = stripComments(readFileSync(file, "utf8")).match(re);
    if (hits) {
      count += hits.length;
      files.push(relative(SRC, file).split(sep).join("/"));
    }
  }
  return { count, files };
}

describe("no second body for the local-day rule", () => {
  it("declares sameLocalDay and startOfDayMs exactly once each, in lib/scheduling", () => {
    const same = declarationCount("sameLocalDay");
    expect(same.files).toEqual(["lib/scheduling.ts"]);
    expect(same.count).toBe(1);

    const bucket = declarationCount("startOfDayMs");
    expect(bucket.files).toEqual(["lib/scheduling.ts"]);
    expect(bucket.count).toBe(1);
  });

  it("reports a planted second declaration — the scan is not vacuous", () => {
    // The scan above reads files; this proves the regex it uses finds the shape
    // it claims to, on text that provably contains one and one that does not.
    const re = /(?:function\s+sameLocalDay\s*\(|(?:const|let|var)\s+sameLocalDay\s*=\s*(?:function\b|\())/g;
    expect(stripComments("export function sameLocalDay(a, b) { return a === b; }").match(re))
      .toHaveLength(1);
    expect(stripComments("const sameLocalDay = (a, b) => a === b;").match(re)).toHaveLength(1);
    // …and that a comment mentioning it is not a declaration.
    expect(stripComments("// function sameLocalDay(a, b) {}\nexport {};").match(re)).toBeNull();
  });
});
