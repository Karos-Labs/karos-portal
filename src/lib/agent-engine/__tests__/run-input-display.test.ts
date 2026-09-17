import { describe, expect, it } from "vitest";
import {
  expandJobInput,
  formatRunInputValue,
  humanizeWireKey,
  labelForWireKey,
  toJobInputSummary,
  toRunInputRows,
} from "../run-input-display";

/**
 * The defect these pin: a run page that said "No inputs." about a run carrying
 * a direction someone had typed. Every case below is one of the shapes that
 * produced that sentence, or one of the ways the old card lost a value.
 */
describe("run input display", () => {
  it("prints a typed direction under the name the product uses for the box", () => {
    const rows = toRunInputRows({ customPrompt: "Focus on the launch — keep it factual" });
    expect(rows).toEqual([
      { key: "customPrompt", label: "Direction for this run", value: "Focus on the launch — keep it factual" },
    ]);
  });

  it("keeps a key it has never seen rather than hiding it", () => {
    // The whole failure mode being fixed is silence. A wire field added in
    // product-mapping.ts tomorrow must appear here without an edit to this file.
    const rows = toRunInputRows({ somethingNobodyListed: "value" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("Something nobody listed");
    expect(rows[0]!.value).toBe("value");
  });

  it("spells out attachments instead of rendering [object Object]", () => {
    const rows = toRunInputRows({
      mediaAssets: [
        { uri: "gs://bucket/a.mp4", role: "source" },
        { uri: "https://example.com/b.png", role: "reference" },
      ],
    });
    expect(rows[0]!.label).toBe("Attachments");
    expect(rows[0]!.value).toBe("source: gs://bucket/a.mp4\nreference: https://example.com/b.png");
  });

  it("puts the direction first and the attachments last", () => {
    const rows = toRunInputRows({
      mediaAssets: [{ uri: "gs://x", role: "source" }],
      requestedTopic: "pricing",
      customPrompt: "short and factual",
    });
    expect(rows.map((r) => r.key)).toEqual(["customPrompt", "requestedTopic", "mediaAssets"]);
  });

  it("drops a key whose value is empty, because an empty box was never sent", () => {
    expect(toRunInputRows({ customPrompt: "", requestedTopic: "   " })).toEqual([]);
  });

  it("returns nothing for a run dispatched with no input at all", () => {
    // The page must say what this MEANS (a scheduled run drafting from the
    // standing brief) rather than "No inputs.", but the row list is empty here.
    expect(toRunInputRows(undefined)).toEqual([]);
    expect(toRunInputRows({})).toEqual([]);
  });

  it("unpacks the dynamic agent's JSON payload the old card filtered out", () => {
    const expanded = expandJobInput({
      agent: "Weekly digest",
      inputs: JSON.stringify({ topic: "Q3 numbers", tone: "plain" }),
    });
    expect(expanded).toEqual({ agent: "Weekly digest", topic: "Q3 numbers", tone: "plain" });
    expect(toRunInputRows(expanded).map((r) => r.key).sort()).toEqual(["agent", "tone", "topic"]);
  });

  it("shows the raw string when `inputs` is not JSON after all", () => {
    expect(expandJobInput({ inputs: "not json" })).toEqual({ inputs: "not json" });
  });

  it("flattens a wire payload into the job doc's string map", () => {
    const summary = toJobInputSummary({
      customPrompt: "one line",
      mediaAssets: [{ uri: "gs://x", role: "source" }],
    });
    expect(summary).toEqual({ customPrompt: "one line", mediaAssets: "source: gs://x" });
    // Every value is a string: `Job.input` is Record<string, string> and a
    // non-string here would reach Firestore as one.
    expect(Object.values(summary).every((v) => typeof v === "string")).toBe(true);
  });

  it("humanizes only where the raw key would mislead", () => {
    expect(labelForWireKey("customPrompt")).toBe("Direction for this run");
    expect(labelForWireKey("requestedSubreddit")).toBe("Subreddit");
    expect(humanizeWireKey("requestedExecutiveName")).toBe("Requested executive name");
  });

  it("formats scalars and nested objects without throwing", () => {
    expect(formatRunInputValue(3)).toBe("3");
    expect(formatRunInputValue(false)).toBe("false");
    expect(formatRunInputValue(null)).toBe("");
    expect(formatRunInputValue({ a: 1 })).toContain('"a": 1');
  });
});
