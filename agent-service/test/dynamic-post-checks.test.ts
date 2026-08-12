import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicAgentJobPayload, DynamicAgentSpec } from "../src/dynamic-types.js";

/**
 * runPostChecks — the orchestration of the two engine-owned checks
 * (docs/dynamic-agent-guardrails.md).
 *
 * The verification model call is mocked at the module boundary; the
 * de-duplication scoring is left REAL, because it is a pure function and
 * mocking it would leave the actual threshold comparison — the thing that
 * decides whether staff see a flag — untested here.
 *
 * The first describe block is the zero-impact guarantee. It is the reason this
 * feature can ship without touching any existing client: an unconfigured run
 * must do no work, make no calls, and produce no report fields.
 */

const verifyMock = vi.fn();
vi.mock("../runner/src/dynamic/guardrail-verify.js", () => ({
  verifyForbiddenTopics: (...args: unknown[]) => verifyMock(...args),
}));

const { runPostChecks, deliverableText } = await import("../runner/src/dynamic/run-dynamic-job.js");

function spec(patch: Partial<DynamicAgentSpec> = {}): DynamicAgentSpec {
  return {
    id: "spec-1",
    name: "Test agent",
    description: "d",
    category: "c",
    icon: "Sparkles",
    creditsCost: 1,
    active: true,
    version: 1,
    inputSchema: [],
    steps: [{ id: "write", type: "ai", label: "Write", model: "sonnet", prompt: "go", order: 0 }],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "u",
    ...patch,
  };
}

function payload(patch: Partial<DynamicAgentJobPayload> = {}): DynamicAgentJobPayload {
  return {
    specId: "spec-1",
    specVersion: 1,
    specSnapshot: spec(),
    clientId: "client-1",
    inputs: {},
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockResolvedValue({ status: "clean", violatedTopics: [], durationMs: 5 });
});

describe("zero impact when neither feature is configured", () => {
  it("returns an empty result and makes no verification call", async () => {
    const checks = await runPostChecks(payload(), [], "some deliverable text");
    expect(checks).toEqual({});
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("produces no guardrail field for an EMPTY forbidden-topics list", async () => {
    // Absent and empty must mean the same thing everywhere, or "off" would
    // depend on which code path wrote the field.
    const checks = await runPostChecks(payload({ guardrails: { forbiddenTopics: [] } }), [], "text");
    expect(checks.guardrail).toBeUndefined();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("produces no dedupe field when the agent did not opt in", async () => {
    const checks = await runPostChecks(payload(), [], "text");
    expect(checks.dedupe).toBeUndefined();
  });
});

describe("topic guardrails", () => {
  it("records the topics in force and the steps they were injected into", async () => {
    const checks = await runPostChecks(
      payload({ guardrails: { forbiddenTopics: ["competitor pricing"] } }),
      ["research", "write"],
      "text",
    );
    expect(checks.guardrail?.forbiddenTopics).toEqual(["competitor pricing"]);
    expect(checks.guardrail?.injectedStepIds).toEqual(["research", "write"]);
  });

  it("runs the verification against the deliverable and attaches the verdict", async () => {
    verifyMock.mockResolvedValue({
      status: "violation",
      violatedTopics: ["competitor pricing"],
      evidence: "we beat them on price",
      durationMs: 12,
    });
    const checks = await runPostChecks(
      payload({ guardrails: { forbiddenTopics: ["competitor pricing"] } }),
      ["write"],
      "we beat them on price",
    );
    expect(verifyMock).toHaveBeenCalledWith("we beat them on price", ["competitor pricing"]);
    expect(checks.guardrail?.verification?.status).toBe("violation");
    expect(checks.guardrail?.verification?.evidence).toBe("we beat them on price");
  });
});

describe("output de-duplication", () => {
  const HISTORY_TEXT =
    "Our new onboarding flow cuts setup time for enterprise teams. We rebuilt the invite step, removed three screens, and moved billing to the end.";

  it("reports no_history when the feature is on but nothing has been produced yet", async () => {
    // Distinct from "compared and found nothing similar": an agent's first run
    // for a client has SKIPPED a check, not passed one.
    const checks = await runPostChecks(payload({ outputHistory: { items: [] } }), [], "a fresh draft");
    expect(checks.dedupe?.status).toBe("no_history");
    expect(checks.dedupe?.comparedCount).toBe(0);
  });

  it("reports ok and the closest score when the new draft is distinct", async () => {
    const checks = await runPostChecks(
      payload({
        outputHistory: { items: [{ jobId: "job-old", createdAt: 1, excerpt: HISTORY_TEXT }] },
      }),
      [],
      "An entirely different piece about hiring three engineers in Lisbon this spring.",
    );
    expect(checks.dedupe?.status).toBe("ok");
    expect(checks.dedupe?.comparedCount).toBe(1);
    expect(checks.dedupe?.maxSimilarity).toBeLessThan(checks.dedupe!.threshold);
    expect(checks.dedupe?.mostSimilarJobId).toBeUndefined();
  });

  it("reports similar and names the prior run when the draft repeats one", async () => {
    const checks = await runPostChecks(
      payload({
        outputHistory: {
          items: [
            { jobId: "job-unrelated", createdAt: 2, excerpt: "Something about office moves and hiring." },
            { jobId: "job-dupe", createdAt: 1, excerpt: HISTORY_TEXT },
          ],
        },
      }),
      [],
      HISTORY_TEXT,
    );
    expect(checks.dedupe?.status).toBe("similar");
    expect(checks.dedupe?.mostSimilarJobId).toBe("job-dupe");
    expect(checks.dedupe?.maxSimilarity).toBeGreaterThanOrEqual(checks.dedupe!.threshold);
    expect(checks.dedupe?.comparedCount).toBe(2);
  });

  it("reports no_history rather than a bogus score when the deliverable is empty", async () => {
    const checks = await runPostChecks(
      payload({ outputHistory: { items: [{ jobId: "job-old", createdAt: 1, excerpt: HISTORY_TEXT }] } }),
      [],
      "   ",
    );
    expect(checks.dedupe?.status).toBe("no_history");
  });

  it("always states the threshold it judged against", async () => {
    const checks = await runPostChecks(payload({ outputHistory: { items: [] } }), [], "x");
    expect(checks.dedupe?.threshold).toBeGreaterThan(0);
  });
});

describe("the two features are independent", () => {
  it("runs both when both are configured", async () => {
    const checks = await runPostChecks(
      payload({
        guardrails: { forbiddenTopics: ["pending litigation"] },
        outputHistory: { items: [{ jobId: "job-old", createdAt: 1, excerpt: "old text here" }] },
      }),
      ["write"],
      "a brand new draft about something else entirely",
    );
    expect(checks.guardrail).toBeDefined();
    expect(checks.dedupe).toBeDefined();
  });

  it("runs dedupe alone when only the agent opted in", async () => {
    const checks = await runPostChecks(payload({ outputHistory: { items: [] } }), [], "x");
    expect(checks.guardrail).toBeUndefined();
    expect(checks.dedupe).toBeDefined();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("runs guardrails alone when only the client configured topics", async () => {
    const checks = await runPostChecks(payload({ guardrails: { forbiddenTopics: ["x"] } }), ["write"], "text");
    expect(checks.guardrail).toBeDefined();
    expect(checks.dedupe).toBeUndefined();
  });
});

/**
 * REGRESSION: the checks must see exactly the text that ships.
 *
 * The first version of this read `finalOutput` as a string and treated
 * anything else as empty. A pipeline whose last step is a CODE step returns an
 * object, so it shipped real JSON to the client in output.md while the
 * guardrail reported "error" and the de-duplication reported "no_history" on
 * every single run — a whole class of agent silently exempt from both checks,
 * behind an error status staff would learn to ignore.
 */
describe("deliverableText — the checks read what actually ships", () => {
  it("passes a string through unchanged", () => {
    expect(deliverableText("the draft body")).toBe("the draft body");
  });

  it("serializes an object final output, exactly as output.md does", () => {
    expect(deliverableText({ post: "hello" })).toBe(JSON.stringify({ post: "hello" }, null, 2));
  });

  it("is empty for a run that produced nothing", () => {
    expect(deliverableText(undefined)).toBe("");
    expect(deliverableText(null)).toBe("");
  });

  it("actually checks a code-step deliverable instead of reporting error", async () => {
    const objectOutput = { post: "we undercut them on price" };
    const checks = await runPostChecks(
      payload({ guardrails: { forbiddenTopics: ["competitor pricing"] } }),
      ["write"],
      deliverableText(objectOutput),
    );
    // The verifier was called with real content, not "".
    expect(verifyMock).toHaveBeenCalledWith(expect.stringContaining("undercut them on price"), [
      "competitor pricing",
    ]);
    expect(checks.guardrail?.verification?.status).not.toBe("error");
  });

  it("de-duplicates a code-step deliverable against history", async () => {
    const body = { post: "Our new onboarding flow cuts setup time for enterprise teams every quarter." };
    const text = deliverableText(body);
    const checks = await runPostChecks(
      payload({ outputHistory: { items: [{ jobId: "job-old", createdAt: 1, excerpt: text }] } }),
      [],
      text,
    );
    expect(checks.dedupe?.status).toBe("similar");
    expect(checks.dedupe?.mostSimilarJobId).toBe("job-old");
  });
});
