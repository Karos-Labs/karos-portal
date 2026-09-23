import { describe, expect, it } from "vitest";
import { jsonText, labelForGateKey, structuredShape } from "@/lib/gate-structured-shape";

/**
 * The reviewer deciding whether a client's post goes out was reading braces.
 *
 * Every non-scalar value in a gate payload rendered as
 * `JSON.stringify(value, null, 2)` inside an 11px `<pre>`. The same deliverable
 * then looks completely different in the asset modal, which paints only mapped
 * fields — so the two surfaces disagreed about the same object.
 *
 * The generic rule is not the bug and does not change: eleven products open
 * gates of six payload shapes, and a per-product table would show the twelfth
 * nothing. A key nobody anticipated must still reach the screen.
 *
 * What these pin is the line between "render it properly" and "keep the JSON":
 * the three shapes the products actually write get a real render, and
 * everything else keeps the block. Guessing at a shape nobody has seen is how
 * a reviewer gets a confident screen that is subtly wrong.
 */

const DEPTH = { at: 0, max: 2 };
const shape = (v: unknown, depth = DEPTH.at) => structuredShape(v, depth, DEPTH.max);

describe("the three shapes the products actually write", () => {
  it("renders a list of strings as a list", () => {
    // sources, hashtags, flags, reasons
    const result = shape(["https://a.example", "https://b.example"]);
    expect(result.kind).toBe("strings");
    expect(result.kind === "strings" && result.items).toEqual(["https://a.example", "https://b.example"]);
  });

  it("renders a list of objects as a list of blocks", () => {
    // slides, recommendations, competitors
    const result = shape([{ n: 1, headline: "a" }, { n: 2, headline: "b" }]);
    expect(result.kind).toBe("records");
    expect(result.kind === "records" && result.items).toHaveLength(2);
  });

  it("renders an object of scalars as labelled rows", () => {
    const result = shape({ seoScore: 30, coverage: "62%" });
    expect(result.kind).toBe("record");
    expect(result.kind === "record" && result.entries).toEqual([
      ["seoScore", 30],
      ["coverage", "62%"],
    ]);
  });

  it("drops null and undefined rather than printing them", () => {
    // "null" next to a label tells a reviewer nothing and costs a row.
    const result = shape({ kept: 1, dropped: null, alsoDropped: undefined });
    expect(result.kind === "record" && result.entries.map(([k]) => k)).toEqual(["kept"]);
  });
});

describe("what deliberately keeps the JSON block", () => {
  it("a mixed list, because guessing which element is the odd one is the wrong screen", () => {
    expect(shape([{ a: 1 }, "not an object"]).kind).toBe("json");
  });

  it("anything past the depth cap, checked BEFORE the shape", () => {
    // Checked before, so a deep value is never HALF rendered — a reviewer
    // reading two levels of a four-level object would be reading a truncation
    // nothing told them about.
    expect(structuredShape({ a: { b: 1 } }, 2, 2).kind).toBe("json");
  });

  it("an empty list or object, which has nothing to lay out", () => {
    expect(shape([]).kind).toBe("json");
    expect(shape({}).kind).toBe("json");
  });

  it("a value JSON itself refuses, without throwing", () => {
    // A log line, or a gate row, is the last thing that should crash the panel.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const result = structuredShape(cyclic, 2, 2);
    expect(result.kind).toBe("json");
    expect(result.kind === "json" && result.text.length).toBeGreaterThan(0);
  });
});

describe("scalars stay scalars", () => {
  it.each([["a string", "a string"], [42, 42], [true, true]])("%s", (input, expected) => {
    const result = shape(input);
    expect(result.kind).toBe("scalar");
    expect(result.kind === "scalar" && result.value).toBe(expected);
  });
});

describe("labels", () => {
  it("turns a payload key into something a person reads", () => {
    // "Slide Templates", not "Slide templates": the camel split leaves the
    // second word capitalised, and this is the transform the gate's own fact
    // rows already use — matching it is the point, not improving on it.
    expect(labelForGateKey("slideTemplates")).toBe("Slide Templates");
    expect(labelForGateKey("target_thread")).toBe("Target thread");
  });
});

describe("jsonText", () => {
  it("never throws, whatever it is handed", () => {
    expect(() => jsonText(BigInt(1))).not.toThrow();
  });
});
