import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The two guards the audience-simulation route was missing, and the ONE thing
 * about them that a per-surface test cannot say.
 *
 * WHY THIS FILE EXISTS AT ALL. Both guards were written, reviewed and reported
 * as done — and neither reached this route, because two fixers split the tree by
 * file ownership: the one who wrote `isAssetContentVisibleToClient` did not own
 * the route, and the one who owned the route was busy adding a credit charge to
 * it. The predicate landed with zero callers and the A3 hole shipped WITH a
 * 5-credit charge attached to it. Nobody was wrong; nobody owned the join.
 *
 * So the assertions below are deliberately about the JOIN rather than about
 * either half: a predicate that exists is not a predicate that is asked.
 *
 * ORDER IS THE OTHER HALF. A client refused for visibility must not be billed,
 * so the refusal has to sit above the charge — which is a property of position,
 * not of presence, and the campaign has already been caught once by a guard that
 * asked "is there an X before Y" when the question was "is Y inside an X".
 */

const SRC = join(process.cwd(), "src");
const ROUTE = join(SRC, "app", "api", "clients", "[id]", "simulate", "route.ts");

/** Source with comments stripped — the prose here quotes the very names it checks. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const route = code(readFileSync(ROUTE, "utf8"));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe("the audience-simulation route asks the rules the rest of the app asks", () => {
  it("runs the client's asset through the shared visibility predicate", () => {
    // The predicate, by name, from its one home. Not a re-implementation: a
    // second answer to "may this client see this asset" is how A3 got a hole.
    expect(route).toMatch(/isAssetContentVisibleToClient\s*\(/);
    expect(route).toMatch(/from "@\/lib\/asset-visibility"/);
  });

  it("scopes staff by the same fence the pages use", () => {
    expect(route).toMatch(/canViewClient\s*\(/);
    expect(route).toMatch(/from "@\/lib\/client-visibility"/);
  });

  it("refuses BEFORE it charges, so a refused client is never billed", () => {
    // Position, asked as an index comparison rather than as "is there a guard
    // above" — the two things are not the same question and the difference has
    // already cost this campaign one silent fail-open.
    const visibility = route.search(/isAssetContentVisibleToClient\s*\(/);
    const scope = route.search(/canViewClient\s*\(/);
    const charge = route.search(/chargeClientModelCall\s*\(/);
    expect(visibility, "visibility guard missing").toBeGreaterThan(-1);
    expect(scope, "staff scope guard missing").toBeGreaterThan(-1);
    expect(charge, "the charge this route takes has moved or gone").toBeGreaterThan(-1);
    expect(visibility, "a client refused for visibility must not be charged").toBeLessThan(charge);
    expect(scope, "an out-of-scope employee must not be charged").toBeLessThan(charge);
  });

  it("does not hand a hidden asset a distinguishable refusal", () => {
    // A 403 or a bespoke message on the visibility branch would confirm that a
    // hidden asset exists, which is half of what the churn rule withholds. The
    // branch must answer the way "no such asset" already answers.
    //
    // Sliced from the predicate to the END OF ITS OWN `return`, not to wherever
    // the next guard happens to sit. Keying it to `canViewClient` assumed an
    // order, so moving that fence ABOVE this one — which closed a separate leak —
    // left the slice empty and the assertion vacuously reading "". A guard that
    // measures a distance between two unrelated things breaks when either moves.
    const start = route.search(/isAssetContentVisibleToClient\s*\(/);
    expect(start, "visibility predicate missing").toBeGreaterThan(-1);
    const rest = route.slice(start);
    const end = rest.indexOf(";", rest.indexOf("return"));
    expect(end, "the visibility branch returns nothing").toBeGreaterThan(-1);
    const branch = rest.slice(0, end);
    expect(branch).toContain("404");
    expect(branch).not.toContain("403");
  });
});

describe("a predicate that exists is not a predicate that is asked", () => {
  /**
   * The generalised version, and the only assertion here that would have caught
   * the original failure: for each shared rule, at least one caller outside its
   * own module and tests. A rule with no caller is a rule that is not enforced,
   * however well it is written and tested.
   */
  const RULES = [
    { name: "isAssetContentVisibleToClient", home: "lib/asset-visibility.ts" },
    { name: "canViewClient", home: "lib/client-visibility.ts" },
  ] as const;

  const files = walk(SRC).filter((f) => !f.includes("__tests__"));

  it("finds the tree at all", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  for (const rule of RULES) {
    it(`${rule.name} has a caller outside its own module`, () => {
      const callers = files
        .filter((f) => relative(SRC, f).split("\\").join("/") !== rule.home)
        .filter((f) => new RegExp(`\\b${rule.name}\\s*\\(`).test(code(readFileSync(f, "utf8"))))
        .map((f) => relative(SRC, f).split("\\").join("/"))
        .sort();
      expect(
        callers.length,
        `${rule.name} is written and tested but nothing asks it — the rule is not enforced`,
      ).toBeGreaterThan(0);
    });
  }
});
