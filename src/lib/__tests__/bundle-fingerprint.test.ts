import { describe, expect, it } from "vitest";

import { bundleFingerprint } from "@/lib/bundle-fingerprint";

/**
 * The fingerprint decides whether an already-imported bundle offers itself for
 * re-import. Two properties matter, and they pull against each other: a
 * cosmetic difference must NOT read as a change (or every reformat nags), and a
 * real edit must ALWAYS read as one (or a changed file looks done).
 */

describe("bundleFingerprint", () => {
  it("is stable for the same value", () => {
    const v = { schemaVersion: 1, clientId: "c1", docs: [{ docType: "brand-voice" }] };
    expect(bundleFingerprint(v)).toBe(bundleFingerprint(structuredClone(v)));
  });

  it("ignores key order — a re-export is not a change", () => {
    expect(bundleFingerprint({ a: 1, b: 2, nested: { x: 1, y: 2 } })).toBe(
      bundleFingerprint({ nested: { y: 2, x: 1 }, b: 2, a: 1 }),
    );
  });

  it("ignores whitespace, because it fingerprints the parsed value", () => {
    const compact = JSON.parse('{"a":1,"b":[1,2]}');
    const pretty = JSON.parse('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(bundleFingerprint(compact)).toBe(bundleFingerprint(pretty));
  });

  // Array order is meaning in a proposal — dominanceRank follows array position.
  it("respects array order", () => {
    expect(bundleFingerprint({ colors: ["a", "b"] })).not.toBe(bundleFingerprint({ colors: ["b", "a"] }));
  });

  it.each([
    ["a changed value", { a: 1 }, { a: 2 }],
    ["an added key", { a: 1 }, { a: 1, b: 2 }],
    ["a removed key", { a: 1, b: 2 }, { a: 1 }],
    ["a deep edit", { d: [{ content: "x" }] }, { d: [{ content: "y" }] }],
    ["a number vs its string", { a: 1 }, { a: "1" }],
    ["null vs missing", { a: null }, {}],
  ])("moves on %s", (_label, before, after) => {
    expect(bundleFingerprint(before)).not.toBe(bundleFingerprint(after));
  });

  it("is 8 hex characters", () => {
    expect(bundleFingerprint({ anything: true })).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles the empty and primitive cases without throwing", () => {
    for (const v of [{}, [], null, "s", 0, true]) {
      expect(bundleFingerprint(v)).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});
