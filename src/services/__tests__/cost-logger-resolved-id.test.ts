import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("server-only", () => ({}));

/**
 * AU70 / SCRUM-370 — the two assertions that fail on the code as it stood
 * before this change and pass after it.
 *
 *   1. No executable call site logs a TIER CONSTANT any more. (39 did.)
 *   2. A Vertex-resolved model id is costed at ITS OWN rate, not at the
 *      `_default` Sonnet rate the flat lookup fell to. (It was 3.75x high.)
 *
 * Neither of these references an API that only exists after the change, so both
 * run unmodified against either tree.
 */

/* ── 2's plumbing: capture what the logger actually writes ─────────────── */

const written: { ref: string; data: Record<string, unknown> }[] = [];
const biRows: Record<string, unknown>[] = [];

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
  trackAgentRun: (row: Record<string, unknown>) => void biRows.push(row),
}));

import { logger } from "@/services/logger";

/** logUsage is fire-and-forget; give its microtask chain a turn to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20 && written.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

const usageRow = () => written.find((w) => w.ref === "usageLogs-row")?.data;

/* ── 1. the sweep ──────────────────────────────────────────────────────── */

/**
 * `src/lib/ai/` is exempt for the same reason the existing wiring sweep exempts
 * it (provider-wiring.test.ts): it is the layer that OWNS the constants, and its
 * doc comments quote the banned form on purpose.
 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "ai") continue;
        walk(path.join(dir, entry.name));
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  walk(path.join(process.cwd(), "src"));
  return out;
}

describe("no call site logs a tier constant in place of the resolved model id", () => {
  it("finds zero `modelName: MODELS.*` / `modelName: MODEL` sites outside the ai layer", () => {
    const banned = /modelName:\s*(MODELS\.[A-Z_]+|MODEL)\b/;
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((text, i) => {
        if (banned.test(text)) {
          offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}`);
        }
      });
    }
    // The message names the fix, because whoever trips this is adding a call
    // site and needs the alternative, not just the rule.
    expect(
      offenders,
      `these log a tier constant instead of the resolved model id — on Vertex the ` +
        `two disagree and the cost is wrong. Spread usageFor("<role>") from ` +
        `@/lib/ai/provider instead, which returns { modelName, vendor } from the ` +
        `same map aiFor() resolves through:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});

/* ── 2. the money ──────────────────────────────────────────────────────── */

describe("a Vertex-resolved model id is costed at its own rate", () => {
  beforeEach(() => {
    written.length = 0;
    biRows.length = 0;
  });

  it("prices claude-haiku-4-5@20251001 as Haiku ($0.80/$4.00), not as the Sonnet default", async () => {
    logger.logUsage({
      clientId: null,
      agentId: null,
      agentName: "AU70 probe",
      // The id Vertex actually serves for the HAIKU tier — `@`, not `-`.
      modelName: "claude-haiku-4-5@20251001",
      operation: "au70_probe",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    await settle();

    const row = usageRow();
    expect(row, "logUsage wrote no usageLogs row").toBeDefined();
    // 1M in * $0.80 + 1M out * $4.00 = $4.80.
    expect(row!["estimatedCostUsd"]).toBe(4.8);
    // What the flat `?? _default` lookup produced for the same call: $18.00.
    expect(row!["estimatedCostUsd"]).not.toBe(18);
  });

  it("carries the resolved id — not a constant — into the BigQuery row", async () => {
    logger.logUsage({
      clientId: null,
      agentId: null,
      agentName: "AU70 probe",
      modelName: "claude-haiku-4-5@20251001",
      operation: "au70_probe",
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    await settle();

    expect(biRows).toHaveLength(1);
    expect(biRows[0]!["model"]).toBe("claude-haiku-4-5@20251001");
    expect(biRows[0]!["costUsd"]).toBe(0.0048);
  });
});
