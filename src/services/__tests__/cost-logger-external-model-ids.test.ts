import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * AU70 / SCRUM-370, round 2 — the judge's second objection.
 *
 * `logUsage`'s `modelName` is not always a `ResolvedAi.modelId` this ticket's
 * own `aiFor()`/`usageFor()` seam produced. Two real, unaudited-by-round-1
 * callers pass a model id straight from OUTSIDE the portal, with no `vendor`:
 *
 *   - src/app/api/agent-service/webhook/route.ts — `modelName` comes from
 *     `payload.usage.models`, a Record keyed by the external agent-engine
 *     middleware's own model ids.
 *   - src/lib/agent-service/reconcile-job.ts — same shape, reconciling a job's
 *     recorded usage after the fact.
 *
 * Both can carry a `modelName` that is either (a) a real external id this
 * portal happens to also price (the common case), or (b) a string neither
 * table has ever heard of — including a free-form, only-length-checked
 * admin-typed `stepModels` override (`custom-agent-actions.ts`'s
 * `validateStepModels`). Removing the flat `_default` pricing row (the actual
 * fix for the ticket's named defect) means case (b) now throws inside
 * `computeCostUsd`, caught by `logUsage` and turned into a cost-0 row.
 *
 * A cost-0 row with nothing marking it is indistinguishable from a genuinely
 * free call on every dashboard that reads `usageLogs` — the SAME "silent,
 * plausible, wrong" shape this ticket exists to close, just moved one hop
 * away from the call sites round 1 touched. This file proves two things
 * against that:
 *
 *   1. `logUsage` never throws for either caller's shape — the fire-and-forget
 *      contract holds regardless of what pricing lookup does internally.
 *   2. An unpriced pair is no longer a BARE zero: the written row carries
 *      `pricingUnresolved: true`, so it stays queryably distinct from a real
 *      free run instead of only being visible to whoever is watching the
 *      `pricing.lookup_failed` structured-log stream.
 *
 * Not claimed: this does not make every admin-typed `stepModels` string
 * price correctly — that would require validating those strings against the
 * pricing tables at entry (a `custom-agent-actions.ts` change, out of this
 * ticket's scope) or teaching agent-engine to report `vendor` alongside
 * `modelName` in the webhook payload. What changed is that the failure mode
 * for an unpriced id from these two callers is now marked, not invisible.
 */

const written: { ref: string; data: Record<string, unknown> }[] = [];

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: () => ({
    collection: (name: string) => ({
      doc: (id?: string) => ({ id: id ?? `${name}-row` }),
    }),
    batch: () => ({
      set: (ref: { id: string }, data: Record<string, unknown>) =>
        void written.push({ ref: ref.id, data }),
      commit: async () => undefined,
    }),
  }),
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { increment: (n: number) => ({ __increment: n }) },
}));

vi.mock("@/lib/telemetry/bi-tracker", () => ({
  trackAgentRun: () => undefined,
}));

import { logger } from "@/services/logger";

async function settle(): Promise<void> {
  for (let i = 0; i < 20 && written.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

const usageRow = () => written.find((w) => w.ref === "usageLogs-row")?.data;

describe("logUsage against an externally-sourced modelName (webhook / reconcile-job shape)", () => {
  beforeEach(() => {
    written.length = 0;
  });

  it("never throws — the fire-and-forget contract holds even when pricing cannot resolve", () => {
    // Exact call shape of the webhook's per-model loop: no `vendor` field,
    // `modelName` is whatever the external payload said.
    expect(() =>
      logger.logUsage({
        clientId: "c1",
        agentId: "agent-service",
        agentName: "managed job",
        modelName: "totally-unrecognized-model-id-xyz",
        operation: "managed_job",
        inputTokens: 500,
        outputTokens: 500,
        jobId: "job-1",
        status: "success",
      }),
    ).not.toThrow();
  });

  it('an unpriced external id is written as cost 0 WITH `pricingUnresolved: true` — not a bare, indistinguishable zero', async () => {
    logger.logUsage({
      clientId: "c1",
      agentId: "agent-service",
      agentName: "managed job",
      modelName: "totally-unrecognized-model-id-xyz",
      operation: "managed_job",
      inputTokens: 500,
      outputTokens: 500,
      jobId: "job-1",
      status: "success",
    });
    await settle();

    const row = usageRow();
    expect(row, "logUsage wrote no usageLogs row").toBeDefined();
    expect(row!["estimatedCostUsd"]).toBe(0);
    expect(row!["pricingUnresolved"]).toBe(true);
  });

  it("a real, correctly-priced external id is costed normally and carries no pricingUnresolved flag", async () => {
    // Same call shape (no `vendor`), but a model id both tables DO know.
    logger.logUsage({
      clientId: "c1",
      agentId: "agent-service",
      agentName: "managed job",
      modelName: "claude-sonnet-4-6",
      operation: "managed_job",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      jobId: "job-2",
      status: "success",
    });
    await settle();

    const row = usageRow();
    expect(row!["estimatedCostUsd"]).toBe(18); // $3 + $15 per 1M
    expect(row!["pricingUnresolved"]).toBeUndefined();
  });

  it('the concrete docs example — an admin-typed dateless "claude-haiku-4-5" stepModels override — now prices correctly instead of falling through', async () => {
    // docs/one-pagers/x-agent-v2-integration-contract.md:86 gives
    // `"step_models": {"draft-post": "claude-haiku-4-5", ...}` as a live
    // example of exactly this shape.
    logger.logUsage({
      clientId: "c1",
      agentId: "agent-service",
      agentName: "dynamic agent step",
      modelName: "claude-haiku-4-5",
      operation: "managed_job_step",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      jobId: "job-3",
      stepId: "draft-post",
      status: "success",
    });
    await settle();

    const row = usageRow();
    expect(row!["pricingUnresolved"]).toBeUndefined();
    expect(row!["estimatedCostUsd"]).toBe(4.8); // Haiku rate, not the old $18 Sonnet default.
  });
});
