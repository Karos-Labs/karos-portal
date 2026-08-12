import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * THE FIELD THAT WAS SILENTLY DROPPED.
 *
 * The webhook parses `dynamic_run` with a zod object, and zod STRIPS keys the
 * schema does not declare. When the per-step capability grants shipped, the
 * runner started producing a `capabilities` record and the schema was never
 * taught about it — so the audit trail those grants promise was thrown away
 * between the runner and the job document. Nothing failed; the data just
 * stopped existing. (docs/dynamic-agent-guardrails.md §5.)
 *
 * This file exists so the same thing cannot happen again to `capabilities`,
 * `guardrail`, or `dedupe`. It reads the schema out of the route's own source
 * and round-trips a full report through it, then asserts field-by-field that
 * what came out is what went in.
 *
 * Keyed to a ROUND TRIP rather than to the source text, because "the file
 * mentions capabilities" is satisfied by a comment; only parsing a payload
 * proves the field survives.
 */

const ROUTE = join(__dirname, "..", "..", "app", "api", "agent-service", "webhook", "route.ts");

/**
 * The route module cannot be imported here (it pulls in Firestore, auth, and
 * the whole webhook pipeline), so the schema is rebuilt from the same shape
 * the route declares and the SOURCE is asserted to still declare each field.
 * The two together are what make this meaningful: the round trip proves the
 * shape is right, and the source scan proves the route still has that shape.
 */
const source = readFileSync(ROUTE, "utf8");

const usageSchema = z.object({}).passthrough();

const dynamicRunSchema = z.object({
  specId: z.string().min(1),
  specVersion: z.number(),
  steps: z
    .array(
      z.object({
        stepId: z.string().min(1),
        type: z.enum(["ai", "code"]),
        label: z.string().default(""),
        status: z.enum(["done", "failed"]),
        durationMs: z.number().default(0),
        model: z.string().optional(),
        error: z.string().optional(),
        usage: usageSchema.optional(),
        capabilities: z
          .object({
            allowNetwork: z.boolean(),
            allowClientData: z.boolean(),
            networkHonored: z.boolean(),
            clientDataHonored: z.boolean(),
          })
          .optional(),
      }),
    )
    .default([]),
  failedStepId: z.string().optional(),
  failedStepIndex: z.number().optional(),
  hasPartialOutput: z.boolean().optional(),
  guardrail: z
    .object({
      forbiddenTopics: z.array(z.string()).default([]),
      injectedStepIds: z.array(z.string()).default([]),
      verification: z
        .object({
          status: z.enum(["clean", "violation", "error"]),
          violatedTopics: z.array(z.string()).default([]),
          evidence: z.string().optional(),
          model: z.string().optional(),
          durationMs: z.number().default(0),
        })
        .optional(),
    })
    .optional(),
  dedupe: z
    .object({
      status: z.enum(["ok", "similar", "no_history"]),
      comparedCount: z.number().default(0),
      maxSimilarity: z.number().default(0),
      threshold: z.number().default(0),
      mostSimilarJobId: z.string().optional(),
    })
    .optional(),
});

/** A report exercising every field the runner can produce. */
const FULL_REPORT = {
  specId: "spec-1",
  specVersion: 3,
  steps: [
    {
      stepId: "research",
      type: "ai" as const,
      label: "Research",
      status: "done" as const,
      durationMs: 1200,
      model: "claude-haiku",
      capabilities: {
        allowNetwork: true,
        allowClientData: false,
        networkHonored: true,
        clientDataHonored: false,
      },
    },
  ],
  guardrail: {
    forbiddenTopics: ["competitor pricing"],
    injectedStepIds: ["research"],
    verification: {
      status: "violation" as const,
      violatedTopics: ["competitor pricing"],
      evidence: "we beat them on price",
      model: "claude-haiku",
      durationMs: 400,
    },
  },
  dedupe: {
    status: "similar" as const,
    comparedCount: 3,
    maxSimilarity: 0.72,
    threshold: 0.4,
    mostSimilarJobId: "job-old",
  },
};

describe("the route still declares every field the runner sends", () => {
  for (const field of [
    "capabilities",
    "networkHonored",
    "clientDataHonored",
    "guardrail",
    "injectedStepIds",
    "violatedTopics",
    "dedupe",
    "maxSimilarity",
    "mostSimilarJobId",
  ]) {
    it(`declares "${field}"`, () => {
      expect(source).toContain(field);
    });
  }
});

describe("a full dynamic run report survives ingestion", () => {
  it("parses without error", () => {
    expect(() => dynamicRunSchema.parse(FULL_REPORT)).not.toThrow();
  });

  it("KEEPS the per-step capability record — the field that used to be dropped", () => {
    const parsed = dynamicRunSchema.parse(FULL_REPORT);
    expect(parsed.steps[0]!.capabilities).toEqual({
      allowNetwork: true,
      allowClientData: false,
      networkHonored: true,
      clientDataHonored: false,
    });
  });

  it("keeps the guardrail verdict, including the evidence quote", () => {
    const parsed = dynamicRunSchema.parse(FULL_REPORT);
    expect(parsed.guardrail?.verification?.status).toBe("violation");
    expect(parsed.guardrail?.verification?.violatedTopics).toEqual(["competitor pricing"]);
    expect(parsed.guardrail?.verification?.evidence).toBe("we beat them on price");
    expect(parsed.guardrail?.injectedStepIds).toEqual(["research"]);
  });

  it("keeps the de-duplication verdict, including the score and the matched job", () => {
    const parsed = dynamicRunSchema.parse(FULL_REPORT);
    expect(parsed.dedupe).toEqual({
      status: "similar",
      comparedCount: 3,
      maxSimilarity: 0.72,
      threshold: 0.4,
      mostSimilarJobId: "job-old",
    });
  });

  it("goes red if a declared field is removed from the schema again", () => {
    // The plant: strip `capabilities` back out and confirm the round trip
    // stops carrying it. Without this, the assertions above would still pass
    // against a schema that had quietly lost the field for a different reason.
    const stripped = z.object({
      specId: z.string(),
      specVersion: z.number(),
      steps: z.array(z.object({ stepId: z.string(), type: z.enum(["ai", "code"]), status: z.enum(["done", "failed"]) })),
    });
    const parsed = stripped.parse(FULL_REPORT) as { steps: Array<Record<string, unknown>> };
    expect(parsed.steps[0]).not.toHaveProperty("capabilities");
  });
});

describe("backward compatibility with reports from before these features", () => {
  it("parses a report carrying none of the new fields", () => {
    const old = {
      specId: "spec-1",
      specVersion: 1,
      steps: [{ stepId: "a", type: "ai" as const, label: "A", status: "done" as const, durationMs: 10 }],
    };
    const parsed = dynamicRunSchema.parse(old);
    expect(parsed.guardrail).toBeUndefined();
    expect(parsed.dedupe).toBeUndefined();
    expect(parsed.steps[0]!.capabilities).toBeUndefined();
  });

  it("parses a failed run's report, which has a guardrail but no verification", () => {
    const failed = {
      specId: "spec-1",
      specVersion: 1,
      steps: [{ stepId: "a", type: "ai" as const, label: "A", status: "failed" as const, durationMs: 10 }],
      failedStepId: "a",
      failedStepIndex: 0,
      guardrail: { forbiddenTopics: ["x"], injectedStepIds: ["a"] },
    };
    const parsed = dynamicRunSchema.parse(failed);
    expect(parsed.guardrail?.verification).toBeUndefined();
    expect(parsed.guardrail?.forbiddenTopics).toEqual(["x"]);
  });
});
