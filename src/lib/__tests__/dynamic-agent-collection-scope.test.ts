import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchingBrace, stripComments } from "./source-scan";

/**
 * THE DoD's COLLECTION-SCOPE RULE, ASKED OF data.ts.
 *
 * Two clauses, pulling in opposite directions:
 *   - "`dynamicAgentSpecs` is global and intentionally excluded" from
 *     CLIENT_SCOPED_COLLECTIONS. A spec is an admin-owned artifact shared across
 *     clients; if it were listed, deleting ONE client would cascade-delete every
 *     agent in the Studio, for everybody.
 *   - "Any new client-scoped Firestore collection is registered in
 *     CLIENT_SCOPED_COLLECTIONS" — the epic names `dynamicAgentRuns` as the
 *     likely one. An omission there leaves per-client rows behind forever when a
 *     client is deleted, and the orphan-purge scripts never see them.
 *
 * data.ts says so itself, right above the array: "an omission here is not a
 * compile error and no test covers the contents." This is that test, scoped to
 * the collections this epic is responsible for — it does not try to police the
 * pre-existing entries, only to make the epic's two obligations enforceable.
 */

const DATA_FILE = join(__dirname, "..", "data.ts");
const source = stripComments(readFileSync(DATA_FILE, "utf8"));

/** The literal entries of a `const NAME: ... = [ ... ];` string array. */
function arrayEntries(constName: string): string[] {
  const at = source.indexOf(`const ${constName}`);
  expect(at, `${constName} not found in data.ts`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("[", at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  expect(close, `unbalanced brackets in ${constName}`).toBeGreaterThan(open);
  return [...source.slice(open, close).matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1] as string);
}

/** The keys of the `col` registry — every collection this app touches. */
function colKeys(): string[] {
  const at = source.indexOf("const col = {");
  expect(at, "the col registry moved").toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", at);
  const close = matchingBrace(source, open);
  const body = source.slice(open, close);
  return [...body.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\(\)\s*=>/gm)].map((m) => m[1] as string);
}

describe("dynamicAgentSpecs is global, and stays global", () => {
  it("is registered in the col collection registry", () => {
    expect(colKeys()).toContain("dynamicAgentSpecs");
  });

  it("is NOT in CLIENT_SCOPED_COLLECTIONS — a client delete must not wipe the Studio", () => {
    expect(arrayEntries("CLIENT_SCOPED_COLLECTIONS")).not.toContain("dynamicAgentSpecs");
  });

  it("is NOT in CLIENT_DOC_COLLECTIONS either — it is not a per-client singleton", () => {
    expect(arrayEntries("CLIENT_DOC_COLLECTIONS")).not.toContain("dynamicAgentSpecs");
  });

  it("says why, next to the declaration, so the exclusion reads as deliberate rather than forgotten", () => {
    const raw = readFileSync(DATA_FILE, "utf8");
    const at = raw.indexOf("dynamicAgentSpecs: () =>");
    const preceding = raw.slice(Math.max(0, at - 400), at);
    expect(preceding).toMatch(/NOT in CLIENT_SCOPED_COLLECTIONS/);
  });
});

describe("any per-client dynamic-agent collection added later must be registered", () => {
  /**
   * The epic's own example is `dynamicAgentRuns`. This epic did not introduce
   * one — run history rides the existing `jobs` collection, which is already
   * client-scoped — so the assertion is conditional: it does nothing today and
   * becomes a real requirement the moment someone adds the collection.
   */
  const PER_CLIENT_CANDIDATES = ["dynamicAgentRuns", "dynamicAgentHistory", "dynamicAgentInputs"];

  it("no per-client dynamic collection exists yet — run history rides `jobs`", () => {
    const keys = colKeys();
    for (const name of PER_CLIENT_CANDIDATES) {
      expect(keys, `${name} now exists and must be classified below`).not.toContain(name);
    }
    // The collection dynamic runs actually land in, which IS client-scoped.
    expect(arrayEntries("CLIENT_SCOPED_COLLECTIONS")).toContain("jobs");
  });

  it("if one is ever added, it is registered for the cascade", () => {
    const keys = colKeys();
    const scoped = arrayEntries("CLIENT_SCOPED_COLLECTIONS");
    const docs = arrayEntries("CLIENT_DOC_COLLECTIONS");
    for (const name of PER_CLIENT_CANDIDATES) {
      if (keys.includes(name)) {
        expect(
          scoped.includes(name) || docs.includes(name),
          `${name} is a per-client collection but is in neither cascade list — a deleted client would orphan its rows`,
        ).toBe(true);
      }
    }
  });

  it("the purge script's mirror list is kept in step with data.ts", () => {
    // data.ts's own comment asks for this and nothing enforced it.
    const purge = stripComments(
      readFileSync(join(__dirname, "..", "..", "..", "scripts", "purge-orphaned-client-docs.ts"), "utf8"),
    );
    for (const name of PER_CLIENT_CANDIDATES) {
      if (colKeys().includes(name)) expect(purge).toContain(name);
    }
    // And the Studio's global collection must NOT appear there.
    expect(purge).not.toContain("dynamicAgentSpecs");
  });
});

describe("the scope sweep under the loosenings it forbids", () => {
  it("goes red if dynamicAgentSpecs is added to the client cascade", () => {
    const scoped = arrayEntries("CLIENT_SCOPED_COLLECTIONS");
    const planted = [...scoped, "dynamicAgentSpecs"];
    expect(planted).toContain("dynamicAgentSpecs"); // the plant is the failure this test's sibling asserts against
    expect(scoped).not.toContain("dynamicAgentSpecs");
  });

  it("reads the real array, not an empty parse — the entries are recognisable", () => {
    const scoped = arrayEntries("CLIENT_SCOPED_COLLECTIONS");
    expect(scoped.length).toBeGreaterThan(10);
    expect(scoped).toContain("assets");
  });
});
