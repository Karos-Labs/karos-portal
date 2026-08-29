/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-B23: `modelName`/`provider` are telemetry the ledger write layer must
 * actually PERSIST, not just pass through a mock.
 *
 * The first round of this ticket added `modelName`/`provider` to
 * `chargeClientCredits`/`creditClientCredits` in `src/lib/data.ts` and to
 * `trackCreditUsage`'s event shape, but the only test that exercised them
 * (`client-model-charge.test.ts`) mocks `@/lib/data` wholesale — it proves
 * `client-model-charge.ts` FORWARDS the fields to `chargeClientCredits`, but
 * nothing proved `chargeClientCredits`'s own body writes them onto the
 * Firestore `creditLedger` document or onto the `trackCreditUsage` BI call.
 * Deleting the two forwarding lines inside `chargeClientCredits` /
 * `creditClientCredits` in data.ts left the full suite green — the exact
 * "would pass even if the fix were reverted" gap.
 *
 * This file closes that gap by driving the REAL `chargeClientCredits` /
 * `creditClientCredits` from `@/lib/data` (not mocked) against an in-memory
 * Firestore fake, matching this repo's own precedent for testing data.ts's
 * transactional writes directly (`seat-architecture.test.ts`,
 * `credit-reconcile.test.ts`'s fake-adminDb pattern) rather than through a
 * mock of the module under test.
 */

const clientCreditsDocs = new Map<string, Record<string, any>>();
const creditLedgerDocs = new Map<string, Record<string, any>>();
let autoId = 0;

vi.mock("server-only", () => ({}));

vi.mock("@/lib/firebase/admin", () => {
  const colOf = (name: string) => {
    if (name === "clientCredits") return clientCreditsDocs;
    if (name === "creditLedger") return creditLedgerDocs;
    throw new Error(`unexpected collection in this fake: ${name}`);
  };
  const db = {
    collection: (name: string) => ({
      // `col.creditLedger().doc()` (no id) must auto-generate one, the same
      // as a real Firestore CollectionReference — chargeClientCredits and
      // creditClientCredits both rely on this to mint the ledger entry id.
      doc: (id?: string) => ({ __col: name, id: id ?? `auto-${++autoId}` }),
    }),
    runTransaction: async (fn: (tx: any) => any) => {
      const pending: Array<() => void> = [];
      const out = await fn({
        async get(ref: any) {
          const d = colOf(ref.__col).get(ref.id);
          return { exists: d !== undefined, id: ref.id, data: () => d };
        },
        set(ref: any, data: any) {
          pending.push(() => void colOf(ref.__col).set(ref.id, data));
        },
      });
      for (const w of pending) w();
      return out;
    },
  };
  return { adminDb: () => db };
});

const trackCreditUsage = vi.fn();
vi.mock("@/lib/telemetry/bi-tracker", () => ({
  trackCreditUsage: (...args: any[]) => trackCreditUsage(...args),
}));

const { chargeClientCredits, creditClientCredits } = await import("@/lib/data");

beforeEach(() => {
  clientCreditsDocs.clear();
  creditLedgerDocs.clear();
  trackCreditUsage.mockClear();
  autoId = 0;
  clientCreditsDocs.set("c1", {
    clientId: "c1",
    balance: 100,
    weeklyLimit: null,
    monthlyLimit: null,
    weekKey: "2026-W28",
    weekSpent: 0,
    monthKey: "2026-07",
    monthSpent: 0,
    updatedAt: 0,
  });
});

function ledgerEntries() {
  return [...creditLedgerDocs.values()];
}

describe("chargeClientCredits writes modelName/provider onto the real ledger row (T-B23)", () => {
  it("persists the caller's modelName/provider on the Firestore creditLedger document", async () => {
    await chargeClientCredits({
      clientId: "c1",
      amount: 5,
      operation: "chat_message",
      reason: "Copilot chat message",
      actorUid: "u1",
      modelName: "claude-sonnet-4-6",
      provider: "anthropic",
    });

    const rows = ledgerEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      modelName: "claude-sonnet-4-6",
      provider: "anthropic",
      delta: -5,
    });
  });

  it("forwards modelName/provider into the trackCreditUsage BI call", async () => {
    await chargeClientCredits({
      clientId: "c1",
      amount: 5,
      operation: "chat_message",
      reason: "Copilot chat message",
      actorUid: "u1",
      modelName: "claude-haiku-4-5-20251001",
      provider: "anthropic",
    });

    expect(trackCreditUsage).toHaveBeenCalledTimes(1);
    expect(trackCreditUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "c1",
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
      }),
    );
  });

  it("writes null (not undefined) on both the ledger row and the BI event when the caller names no model", async () => {
    // Firestore rejects `undefined` field values — every other optional field
    // on this write already normalizes to null (agentId, jobId), and
    // modelName/provider must follow the same rule rather than being omitted.
    await chargeClientCredits({
      clientId: "c1",
      amount: 5,
      operation: "task_execution",
      reason: "Task execution",
      actorUid: "u1",
    });

    const rows = ledgerEntries();
    expect(rows[0]!.modelName).toBeNull();
    expect(rows[0]!.provider).toBeNull();
    expect(trackCreditUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: null, provider: null }),
    );
  });
});

describe("creditClientCredits (grants/refunds) writes modelName/provider onto the real ledger row (T-B23)", () => {
  it("persists modelName/provider on a refund's Firestore ledger document and BI event", async () => {
    await creditClientCredits({
      clientId: "c1",
      amount: 5,
      kind: "refund",
      operation: "chat_message",
      reason: "Refund · run failed",
      actorUid: "u1",
      modelName: "claude-sonnet-4-6",
      provider: "anthropic",
    });

    const rows = ledgerEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "refund",
      modelName: "claude-sonnet-4-6",
      provider: "anthropic",
      delta: 5,
    });
    expect(trackCreditUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6", provider: "anthropic" }),
    );
  });

  it("writes null on a grant that names no model (admin credit grants never carry one)", async () => {
    await creditClientCredits({
      clientId: "c1",
      amount: 50,
      kind: "grant",
      operation: "manual",
      reason: "Admin grant",
      actorUid: "admin1",
    });

    const rows = ledgerEntries();
    expect(rows[0]!.modelName).toBeNull();
    expect(rows[0]!.provider).toBeNull();
    expect(trackCreditUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: null, provider: null }),
    );
  });
});

/**
 * End-to-end through the mechanism layer (client-model-charge.ts), still
 * against the real data.ts — the actual shape a real charge site (the chat
 * route) drives. Not redundant with client-model-charge.test.ts, which mocks
 * data.ts and therefore cannot see past its own call arguments; this proves
 * the value chargeClientModelCall passes in actually lands in Firestore.
 */
describe("chargeClientModelCall -> real chargeClientCredits, end to end (T-B23)", () => {
  it("a charge made with modelName/provider lands on the real ledger row untouched", async () => {
    const { chargeClientModelCall } = await import("@/lib/client-model-charge");

    const outcome = await chargeClientModelCall({
      user: { uid: "u1", name: "Client One", role: "CLIENT_USER", impersonatedBy: undefined } as any,
      clientId: "c1",
      amount: 5,
      operation: "chat_message",
      reason: "Copilot chat message",
      modelName: "claude-sonnet-4-6",
      provider: "anthropic",
    });

    expect(outcome.denied).toBeNull();
    const rows = ledgerEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modelName: "claude-sonnet-4-6", provider: "anthropic" });
  });
});
