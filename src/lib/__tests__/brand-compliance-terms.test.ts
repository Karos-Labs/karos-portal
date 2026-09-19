import { describe, expect, it } from "vitest";
import {
  MAX_FORBIDDEN_TERMS,
  MAX_FORBIDDEN_TERM_CHARS,
  MIN_FORBIDDEN_TERM_CHARS,
  formatForbiddenTerms,
  parseForbiddenTerms,
  parseLineList,
  validateForbiddenTerms,
} from "../brand-compliance-terms";
import { MAX_FORBIDDEN_TOPICS, MAX_FORBIDDEN_TOPIC_CHARS, parseForbiddenTopics } from "../dynamic-agent-guardrails";

describe("parseForbiddenTerms", () => {
  it("drops blanks, de-duplicates case-insensitively and keeps the first spelling", () => {
    // First spelling wins so the casing staff typed is what they read back.
    expect(parseForbiddenTerms("Revolutionary\n\n  revolutionary  \nBest-in-class\n")).toEqual(["Revolutionary", "Best-in-class"]);
  });

  it("truncates an over-long entry rather than refusing the whole save", () => {
    const long = "x".repeat(MAX_FORBIDDEN_TERM_CHARS + 40);
    expect(parseForbiddenTerms(long)).toEqual(["x".repeat(MAX_FORBIDDEN_TERM_CHARS)]);
  });

  it("stops at the cap", () => {
    const many = Array.from({ length: MAX_FORBIDDEN_TERMS + 25 }, (_, i) => `term-${i}`).join("\n");
    expect(parseForbiddenTerms(many)).toHaveLength(MAX_FORBIDDEN_TERMS);
  });

  it("round-trips through formatForbiddenTerms", () => {
    const terms = ["revolutionary", "best-in-class"];
    expect(parseForbiddenTerms(formatForbiddenTerms(terms))).toEqual(terms);
  });

  it("formats an absent list as an empty box rather than the string 'undefined'", () => {
    expect(formatForbiddenTerms(undefined)).toBe("");
  });
});

describe("validateForbiddenTerms", () => {
  it("accepts an empty list — an unconfigured client is not an error", () => {
    // The engine reports `configStatus: "unconfigured"` for this case, which is
    // the honest answer; refusing the save would force every client to invent
    // banned vocabulary they do not have.
    expect(validateForbiddenTerms([])).toBeNull();
  });

  it("rejects a term too short to match safely, and names it", () => {
    // "AI" is a substring of "said", "detail" and "campaign". Accepting it
    // would fail every draft and read to the client as a broken gate.
    const error = validateForbiddenTerms(["AI"]);
    expect(error).toContain("AI");
    expect(error).toContain(String(MIN_FORBIDDEN_TERM_CHARS));
  });

  it("rejects a sentence and points at the box it belongs in", () => {
    const error = validateForbiddenTerms(["x".repeat(MAX_FORBIDDEN_TERM_CHARS + 1)]);
    expect(error).toContain("Topics we do not cover");
  });

  it("rejects a list over the cap", () => {
    const terms = Array.from({ length: MAX_FORBIDDEN_TERMS + 1 }, (_, i) => `term-${i}`);
    expect(validateForbiddenTerms(terms)).toContain(String(MAX_FORBIDDEN_TERMS));
  });

  it("accepts an ordinary brand-voice list unchanged", () => {
    expect(validateForbiddenTerms(["revolutionary", "best-in-class", "game-changing", "synergy"])).toBeNull();
  });
});

/**
 * `parseForbiddenTopics` was reimplemented as a call to `parseLineList` when
 * this file needed the same five rules under different limits. These pin the
 * two against each other so the extraction cannot quietly change the topics
 * behaviour — the failure mode a shared helper introduces.
 */
describe("parseLineList, shared with the topics parser", () => {
  it("gives parseForbiddenTopics its documented behaviour under the topic limits", () => {
    const text = "Competitor pricing\n\n  competitor pricing \nPending litigation";
    expect(parseForbiddenTopics(text)).toEqual(parseLineList(text, { maxEntries: MAX_FORBIDDEN_TOPICS, maxChars: MAX_FORBIDDEN_TOPIC_CHARS }));
    expect(parseForbiddenTopics(text)).toEqual(["Competitor pricing", "Pending litigation"]);
  });

  it("honours each caller's own caps rather than one shared number", () => {
    // The two limits differ on purpose: a company has few subject areas and a
    // style guide bans dozens of individual words.
    expect(MAX_FORBIDDEN_TERMS).toBeGreaterThan(MAX_FORBIDDEN_TOPICS);
    expect(MAX_FORBIDDEN_TERM_CHARS).toBeLessThan(MAX_FORBIDDEN_TOPIC_CHARS);

    const long = "y".repeat(200);
    expect(parseForbiddenTopics(long)[0]).toHaveLength(MAX_FORBIDDEN_TOPIC_CHARS);
    expect(parseForbiddenTerms(long)[0]).toHaveLength(MAX_FORBIDDEN_TERM_CHARS);
  });

  it("splits on CRLF as well as LF — the editor's textarea submits either", () => {
    expect(parseLineList("one\r\ntwo\r\n", { maxEntries: 10, maxChars: 50 })).toEqual(["one", "two"]);
  });
});
