import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * AU70 / SCRUM-370 — what the logger does with a refusal.
 *
 * `priceFor` throws on an inconsistent `(vendor, model id)` pair, but `logUsage`
 * is documented fire-and-forget and must never throw into the generation path.
 * So the refusal is converted, here, into the loudest thing that is still safe:
 * a structured ERROR naming the pair, and a row recorded at cost 0.
 *
 * That trade is the point of the ticket. Zero-next-to-an-ERROR is visibly wrong
 * and gets fixed; $3.00/$15.00 substituted for an unrecognised pair is "silent,
 * plausible, wrong" — the ticket's own words for the defect.
 */

const written: { ref: string; data: Record<string, unknown> }[] = [];
const structured: { severity: string; message: string; fields?: Record<string, unknown> }[] = [];

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: () => ({
    collection: (name: string) => ({ doc: (id?: string) => ({ id: id ?? `${name}-row` }) }),
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
vi.mock("@/lib/telemetry/bi-tracker", () => ({ trackAgentRun: () => undefined }));
vi.mock("@/lib/telemetry/structured-log", () => ({
  logStructured: (severity: string, message: string, fields?: Record<string, unknown>) =>
    void structured.push({ severity, message, fields }),
}));

import { logger } from "@/services/logger";

async function settle(): Promise<void> {
  for (let i = 0; i < 20 && written.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}
const usageRow = () => written.find((w) => w.ref === "usageLogs-row")?.data;

describe("logUsage on an inconsistent (vendor, model id) pair", () => {
  beforeEach(() => {
    written.length = 0;
    structured.length = 0;
  });

  it("does not throw into the caller — the fire-and-forget contract holds", () => {
    expect(() =>
      logger.logUsage({
        clientId: null,
        agentId: null,
        agentName: "AU70 probe",
        modelName: "claude-haiku-4-5-20251001", // first-party id …
        vendor: "vertex", // … under the vendor that does not serve it
        operation: "au70_probe",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).not.toThrow();
  });

  it("records cost 0 and an ERROR naming the pair, instead of a Sonnet-rate number", async () => {
    logger.logUsage({
      clientId: "c1",
      agentId: null,
      agentName: "AU70 probe",
      modelName: "claude-haiku-4-5-20251001",
      vendor: "vertex",
      operation: "au70_probe",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    await settle();

    const row = usageRow();
    expect(row).toBeDefined();
    // NOT 18 (the old `_default` answer) and NOT 4.8 (Haiku's real rate, which
    // this pair has not earned the right to be costed at).
    expect(row!["estimatedCostUsd"]).toBe(0);

    const errors = structured.filter((e) => e.severity === "ERROR");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.fields?.["event"]).toBe("pricing.lookup_failed");
    expect(errors[0]!.fields?.["vendor"]).toBe("vertex");
    expect(errors[0]!.fields?.["modelName"]).toBe("claude-haiku-4-5-20251001");
    expect(errors[0]!.fields?.["operation"]).toBe("au70_probe");
    // The tokens are preserved even though the money could not be computed —
    // the spend is real, and a reconciliation needs to be able to find it.
    expect(row!["inputTokens"]).toBe(1_000_000);
    expect(row!["outputTokens"]).toBe(1_000_000);
  });

  it("stays silent and correct on a CONSISTENT pair — no blanket error path", async () => {
    logger.logUsage({
      clientId: null,
      agentId: null,
      agentName: "AU70 probe",
      modelName: "claude-haiku-4-5@20251001",
      vendor: "vertex",
      operation: "au70_probe",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    await settle();

    expect(usageRow()!["estimatedCostUsd"]).toBe(4.8);
    expect(usageRow()!["vendor"]).toBe("vertex");
    // Claude on Vertex is invoiced by Google, not Anthropic.
    expect(usageRow()!["provider"]).toBe("google");
    expect(structured.filter((e) => e.severity === "ERROR")).toEqual([]);
  });
});
