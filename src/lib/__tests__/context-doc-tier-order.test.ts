import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ORDERED, ALLOWLISTED CONTEXT-DOC READ (#59).
 *
 * `getClientContextDoc` gained a REQUIRED tier and became an exact
 * `where("tier","==",tier)`. That is right for the callers that read a document
 * in order to WRITE IT BACK at the tier they read (`src/lib/branding.ts`,
 * `src/lib/actions/branding-actions.ts` both do `tier: doc?.tier ?? "internal"`),
 * and it broke the callers that only wanted the document's text: a client whose
 * workspace was imported from the lab repo has internal-tier documents only
 * (`scripts/import-lab-client.ts`), so an exact client-tier read returned
 * nothing for a client with a complete workspace.
 *
 * `getClientContextDocInTierOrder` is the read for that second kind of caller,
 * and this file pins the two properties the single-tier read does not have:
 *
 *   1. the ORDER is the caller's argument, not Firestore's document order;
 *   2. the list is an ALLOWLIST — a tier the caller did not name is never
 *      returned, however plainly it exists. That is what keeps "internal-only"
 *      (client-guidelines, action-plan — the never-published tier) out of every
 *      caller that does not spell it.
 *
 * Driven against a fake Firestore rather than a mocked data layer, because the
 * behaviour under test lives INSIDE `src/lib/data.ts`: the ordering function
 * calls `getClientContextDocByTier` through the module's own binding, so a
 * mocked export would not be the thing that runs.
 */

interface Row {
  clientId: string;
  docType: string;
  tier: string;
  content: string;
}

/** The rows the fake collection holds for this test. Reset per test. */
const store: Row[] = [];
/** Every `where` triple a query carried when it ran — the queries actually issued. */
const issued: Array<Array<[string, string, unknown]>> = [];

vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/firebase/admin", () => {
  function query(collection: string, filters: Array<[string, string, unknown]>, limit: number | null) {
    return {
      where: (field: string, op: string, value: unknown) =>
        query(collection, [...filters, [field, op, value]], limit),
      limit: (n: number) => query(collection, filters, n),
      get: async () => {
        issued.push(filters);
        if (collection !== "clientContextDocs") return { docs: [], empty: true };
        let matched = store.filter((row) =>
          filters.every(([field, op, value]) => {
            if (op !== "==") throw new Error(`unsupported op ${op}`);
            return (row as unknown as Record<string, unknown>)[field] === value;
          }),
        );
        if (limit !== null) matched = matched.slice(0, limit);
        const docs = matched.map((row, i) => ({
          exists: true,
          id: `doc-${i}`,
          data: () => row,
        }));
        return { docs, empty: docs.length === 0 };
      },
    };
  }
  return { adminDb: () => ({ collection: (name: string) => query(name, [], null) }) };
});

import { getClientContextDocInTierOrder } from "@/lib/data";

const row = (tier: string, content: string): Row => ({
  clientId: "c1",
  docType: "target-audience",
  tier,
  content,
});

beforeEach(() => {
  store.length = 0;
  issued.length = 0;
});

describe("getClientContextDocInTierOrder", () => {
  it("returns the client copy when both tiers exist — the first tier named wins", async () => {
    store.push(row("internal", "INTERNAL COPY"), row("client", "CLIENT COPY"));

    const doc = await getClientContextDocInTierOrder("c1", "target-audience", [
      "client",
      "internal",
    ]);

    expect(doc?.content).toBe("CLIENT COPY");
  });

  it("returns the internal copy when the client tier is absent — the #59 regression", async () => {
    // A lab-imported client: profile/*.md landed at tier "internal" and nothing
    // was ever condensed, so the exact client-tier read this replaced returned
    // null and the caller refused with "not enough context".
    store.push(row("internal", "INTERNAL COPY"));

    const doc = await getClientContextDocInTierOrder("c1", "target-audience", [
      "client",
      "internal",
    ]);

    expect(doc?.content).toBe("INTERNAL COPY");
  });

  it("reads the order from the argument, not from the store", async () => {
    // Same two rows, same store order, opposite preference: the winner flips.
    // Without this the first test passes on a function that simply returns
    // whichever row Firestore listed first.
    store.push(row("internal", "INTERNAL COPY"), row("client", "CLIENT COPY"));

    const doc = await getClientContextDocInTierOrder("c1", "target-audience", [
      "internal",
      "client",
    ]);

    expect(doc?.content).toBe("INTERNAL COPY");
  });

  it("never returns a tier the caller did not name, however plainly it exists", async () => {
    // The fence. `internal-only` is the never-published tier; a caller that asks
    // for the two publishable tiers must get null rather than that document.
    store.push(row("internal-only", "ANALYST ONLY"));

    const doc = await getClientContextDocInTierOrder("c1", "target-audience", [
      "client",
      "internal",
    ]);

    expect(doc).toBeNull();
  });

  it("issues one query per named tier and no others", async () => {
    // Keyed to the QUERIES, so a future implementation that reads the whole
    // docType and filters in memory — which would pull an unnamed tier's text
    // into the process — fails here rather than passing on the return value.
    store.push(row("client", "CLIENT COPY"), row("internal-only", "ANALYST ONLY"));

    await getClientContextDocInTierOrder("c1", "target-audience", ["client", "internal"]);

    const tiersQueried = issued.map(
      (filters) => filters.find(([field]) => field === "tier")?.[2] ?? null,
    );
    expect(tiersQueried.sort()).toEqual(["client", "internal"]);
    for (const filters of issued) {
      expect(filters.find(([field]) => field === "clientId")?.[2]).toBe("c1");
      expect(filters.find(([field]) => field === "docType")?.[2]).toBe("target-audience");
    }
  });

  it("returns null when the client has nothing at all", async () => {
    const doc = await getClientContextDocInTierOrder("c1", "target-audience", [
      "client",
      "internal",
    ]);
    expect(doc).toBeNull();
  });
});
