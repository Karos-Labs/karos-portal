import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deleteClientCascade is the only thing standing between a deleted client and
 * "spillage" — its rows resurfacing in cross-client staff views (task board,
 * assets, calendar, admin analytics). Every clientId-scoped collection in
 * data.ts's `col` map has to be swept, and the roster below is the guard: a new
 * collection that carries clientId but never makes it into
 * CLIENT_SCOPED_COLLECTIONS fails here rather than silently leaking rows.
 *
 * The retained collections matter just as much — the credit ledger is a
 * financial audit trail and users are accounts with their own lifecycle, so
 * both must SURVIVE the cascade.
 */

/** collection name → doc id → doc data */
const store = new Map<string, Map<string, Record<string, unknown>>>();

function coll(name: string) {
  let c = store.get(name);
  if (!c) {
    c = new Map();
    store.set(name, c);
  }
  return c;
}

function seed(name: string, id: string, data: Record<string, unknown>) {
  coll(name).set(id, data);
}

function docRef(name: string, id: string) {
  return {
    id,
    __collection: name,
    async delete() {
      coll(name).delete(id);
    },
  };
}

/** Re-reads the store on every get(), so the cascade's delete-then-requery loop pages for real. */
function query(name: string, field: string, value: unknown, cap = Infinity) {
  return {
    limit: (n: number) => query(name, field, value, n),
    async get() {
      const hits = [...coll(name).entries()]
        .filter(([, data]) => data[field] === value)
        .slice(0, cap);
      return {
        empty: hits.length === 0,
        size: hits.length,
        docs: hits.map(([id]) => ({ id, ref: docRef(name, id) })),
      };
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: () => ({
    collection: (name: string) => ({
      where: (field: string, _op: string, value: unknown) => query(name, field, value),
      doc: (id: string) => docRef(name, id),
    }),
    batch: () => {
      const ops: Array<{ __collection: string; id: string }> = [];
      return {
        delete(ref: { __collection: string; id: string }) {
          ops.push(ref);
        },
        async commit() {
          for (const ref of ops) coll(ref.__collection).delete(ref.id);
        },
      };
    },
  }),
}));

import { deleteClientCascade } from "@/lib/data";

/**
 * Every clientId-scoped collection the cascade must sweep. Keep in sync with
 * CLIENT_SCOPED_COLLECTIONS in data.ts AND its hand-maintained mirror in
 * scripts/purge-orphaned-client-docs.ts — all three are edited together.
 *
 * This roster cannot read the private list it guards, so it catches a
 * regression (an entry REMOVED from data.ts stops being swept and fails here)
 * but not an omission (an entry added to data.ts and not here is simply
 * untested). That is why the comment above the list names all three files.
 */
const SCOPED = [
  "jobs",
  "assets",
  "transcripts",
  "contextItems",
  "clientCompetitors",
  "clientContextDocs",
  "clientActivityLogs",
  "clientIntegrations",
  "clientTasks",
  "taskComments",
  "feedbacks",
  "actionItems",
  "scheduledRuns",
  "clientMarketingAnalytics",
  "campaigns",
  "clientSeats",
  "agentIntake",
  "xNewsUpdates",
  "xTakes",
  "xDraftFeedback",
  "liDraftFeedback",
  "redditDraftFeedback",
  "plannedScheduledRuns",
];

/** Per-client singleton docs (doc ID = clientId). */
const SINGLETONS = [
  "clientReports",
  "clientSeoGeo",
  "clientInsightsCache",
  "clientCredits",
  "clientSettings",
];

/** Deliberately retained: audit trail + accounts with their own lifecycle. */
const RETAINED = ["creditLedger", "users"];

describe("deleteClientCascade", () => {
  beforeEach(() => {
    store.clear();
    seed("clients", "c1", { id: "c1", name: "Doomed Co" });
    seed("clients", "c2", { id: "c2", name: "Survivor Co" });
    for (const name of SCOPED) {
      seed(name, `${name}-c1`, { clientId: "c1" });
      seed(name, `${name}-c2`, { clientId: "c2" });
    }
    for (const name of SINGLETONS) {
      seed(name, "c1", { clientId: "c1" });
      seed(name, "c2", { clientId: "c2" });
    }
    for (const name of RETAINED) {
      seed(name, `${name}-c1`, { clientId: "c1" });
    }
  });

  it("sweeps every clientId-scoped collection", async () => {
    const { deleted } = await deleteClientCascade("c1");

    const leaked = SCOPED.filter((name) => coll(name).has(`${name}-c1`));
    expect(leaked).toEqual([]);
    expect(deleted).toBe(SCOPED.length);
  });

  it("leaves other clients' rows alone", async () => {
    await deleteClientCascade("c1");

    const collateral = SCOPED.filter((name) => !coll(name).has(`${name}-c2`));
    expect(collateral).toEqual([]);
    for (const name of SINGLETONS) expect(coll(name).has("c2")).toBe(true);
    expect(coll("clients").has("c2")).toBe(true);
  });

  it("removes the per-client singleton docs and the client doc last", async () => {
    await deleteClientCascade("c1");

    for (const name of SINGLETONS) expect(coll(name).has("c1")).toBe(false);
    expect(coll("clients").has("c1")).toBe(false);
  });

  it("retains the credit ledger and user accounts", async () => {
    await deleteClientCascade("c1");

    for (const name of RETAINED) expect(coll(name).has(`${name}-c1`)).toBe(true);
  });

  it("pages past the 400-doc batch limit", async () => {
    for (let i = 0; i < 401; i++) seed("assets", `bulk-${i}`, { clientId: "c1" });

    const { deleted } = await deleteClientCascade("c1");

    expect([...coll("assets").values()].filter((d) => d.clientId === "c1")).toEqual([]);
    expect(deleted).toBe(SCOPED.length + 401);
  });

  it("refuses a blank clientId rather than deleting docs at a garbage path", async () => {
    await expect(deleteClientCascade("  ")).rejects.toThrow(/clientId is required/);

    expect(coll("clients").has("c1")).toBe(true);
    for (const name of SINGLETONS) expect(coll(name).has("c1")).toBe(true);
  });
});
