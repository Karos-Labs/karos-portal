import { describe, expect, it, vi } from "vitest";
import {
  parseVerificationJson,
  reconcileTopics,
  verifyForbiddenTopics,
} from "../runner/src/dynamic/guardrail-verify.js";

/**
 * The topic-guardrail verification pass (docs/dynamic-agent-guardrails.md §2.2).
 *
 * The model call is injected (`deps.runVerification`), so the parsing, the
 * topic reconciliation, and — the part that matters most — the FAIL-OPEN
 * policy all run for real. The policy is the thing worth guarding: a verifier
 * that could manufacture a violation against good output, or that could turn a
 * successful run into a failed one by throwing, would be worse than no
 * verifier at all.
 */

const TOPICS = ["competitor pricing", "pending litigation"];

describe("parseVerificationJson", () => {
  it("parses a bare JSON object", () => {
    const parsed = parseVerificationJson('{"violations": [{"topic": "competitor pricing", "evidence": "we beat X on price"}]}');
    expect(parsed).toEqual({ violations: [{ topic: "competitor pricing", evidence: "we beat X on price" }] });
  });

  it("parses an object wrapped in a fenced code block", () => {
    const parsed = parseVerificationJson('```json\n{"violations": []}\n```');
    expect(parsed).toEqual({ violations: [] });
  });

  it("parses an object with prose around it", () => {
    // "Reply with only JSON" is a request, not a guarantee.
    const parsed = parseVerificationJson('Sure! Here is the result:\n{"violations": []}\nHope that helps.');
    expect(parsed).toEqual({ violations: [] });
  });

  it("returns null for text with no JSON at all", () => {
    expect(parseVerificationJson("I cannot help with that.")).toBeNull();
  });

  it("returns null for malformed JSON rather than guessing", () => {
    expect(parseVerificationJson('{"violations": [')).toBeNull();
  });

  it("returns null when violations is not an array", () => {
    expect(parseVerificationJson('{"violations": "none"}')).toBeNull();
  });

  it("drops entries with no usable topic instead of failing the whole parse", () => {
    const parsed = parseVerificationJson('{"violations": [{"evidence": "x"}, {"topic": "  "}, {"topic": "ok"}]}');
    expect(parsed).toEqual({ violations: [{ topic: "ok" }] });
  });
});

describe("reconcileTopics", () => {
  it("keeps only topics that were actually on the client's list", () => {
    // A model that invents or paraphrases a topic would otherwise put a finding
    // in front of staff that they cannot trace back to a rule they wrote.
    const out = reconcileTopics(
      [{ topic: "competitor pricing" }, { topic: "something nobody configured" }],
      TOPICS,
    );
    expect(out).toEqual([{ topic: "competitor pricing" }]);
  });

  it("matches case-insensitively but reports the configured spelling", () => {
    const out = reconcileTopics([{ topic: "COMPETITOR PRICING" }], TOPICS);
    expect(out).toEqual([{ topic: "competitor pricing" }]);
  });

  it("de-duplicates a topic claimed twice", () => {
    const out = reconcileTopics(
      [{ topic: "competitor pricing", evidence: "first" }, { topic: "Competitor Pricing", evidence: "second" }],
      TOPICS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toBe("first");
  });

  it("carries evidence through when present", () => {
    const out = reconcileTopics([{ topic: "pending litigation", evidence: "the ongoing suit" }], TOPICS);
    expect(out[0]!.evidence).toBe("the ongoing suit");
  });
});

describe("verifyForbiddenTopics", () => {
  it("reports clean when the model finds nothing", async () => {
    const result = await verifyForbiddenTopics("A perfectly ordinary draft.", TOPICS, {
      runVerification: async () => '{"violations": []}',
    });
    expect(result.status).toBe("clean");
    expect(result.violatedTopics).toEqual([]);
  });

  it("reports a violation with the topic and the evidence quote", async () => {
    const result = await verifyForbiddenTopics("We undercut them on price.", TOPICS, {
      runVerification: async () =>
        '{"violations": [{"topic": "competitor pricing", "evidence": "We undercut them on price."}]}',
    });
    expect(result.status).toBe("violation");
    expect(result.violatedTopics).toEqual(["competitor pricing"]);
    expect(result.evidence).toBe("We undercut them on price.");
  });

  it("sends the deliverable AND every topic to the model", async () => {
    const runVerification = vi.fn().mockResolvedValue('{"violations": []}');
    await verifyForbiddenTopics("the draft body", TOPICS, { runVerification });
    const prompt = runVerification.mock.calls[0]![0] as string;
    expect(prompt).toContain("the draft body");
    for (const topic of TOPICS) expect(prompt).toContain(topic);
  });

  /* ── the fail-open policy ── */

  it("reports error, NOT violation, when the model call throws", async () => {
    const result = await verifyForbiddenTopics("A draft.", TOPICS, {
      runVerification: async () => {
        throw new Error("503 overloaded");
      },
    });
    expect(result.status).toBe("error");
    expect(result.violatedTopics).toEqual([]);
  });

  it("reports error, NOT violation, when the reply is unparseable", async () => {
    const result = await verifyForbiddenTopics("A draft.", TOPICS, {
      runVerification: async () => "I'm not going to answer that.",
    });
    expect(result.status).toBe("error");
  });

  it("reports error, NOT clean, for an empty deliverable", async () => {
    // A clean verdict on an empty deliverable is a green tick the run never earned.
    const runVerification = vi.fn();
    const result = await verifyForbiddenTopics("   ", TOPICS, { runVerification });
    expect(result.status).toBe("error");
    expect(runVerification).not.toHaveBeenCalled();
  });

  it("never throws, whatever the model does — a post-check must not fail a finished run", async () => {
    await expect(
      verifyForbiddenTopics("A draft.", TOPICS, {
        runVerification: async () => {
          throw new Error("catastrophic");
        },
      }),
    ).resolves.toMatchObject({ status: "error" });
  });

  it("reports error, not clean, when every claimed violation is a hallucinated topic", async () => {
    // The model claimed a finding, so this is NOT the same as a genuinely
    // clean draft — reporting "clean" would silently ship a deliverable the
    // model itself flagged. "error" tells staff the check could not be
    // trusted, matching the fail-open invariant for every other broken-check
    // path above.
    const result = await verifyForbiddenTopics("A draft.", TOPICS, {
      runVerification: async () => '{"violations": [{"topic": "a topic nobody configured"}]}',
    });
    expect(result.status).toBe("error");
  });

  it("records the model and a duration on every verdict", async () => {
    let t = 1_000;
    const result = await verifyForbiddenTopics("A draft.", TOPICS, {
      runVerification: async () => '{"violations": []}',
      now: () => (t += 250),
    });
    expect(result.model).toBeTruthy();
    expect(result.durationMs).toBeGreaterThan(0);
  });
});
