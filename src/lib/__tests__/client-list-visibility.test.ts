/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #39, THE DISCOVERABILITY HALF: `listClients({ employeeId })`.
 *
 * The predicate behind the `/clients/[id]` fence reads BOTH fields that express
 * one relationship — `Client.assignedEmployeeIds` and `AppUser.assignedClientIds`
 * — because the admin's assignment UIs only ever write the second. This query
 * read only the first. So an employee assigned the normal way could REACH a
 * client by URL and saw NO clients in any of the eight staff lists that feed off
 * this call: the clients page, jobs, assets, agents, dashboard, calendar, tasks
 * and the app layout's picker and bell feeds. Reachable but unlisted is worse
 * than fenced out — nothing tells them where to go.
 *
 * The pinning test is the last one in this file: for every assignment shape, the
 * list this query returns must equal the list `canViewClient` allows over the
 * whole collection. It DERIVES its expectation from the predicate instead of
 * restating the rule, which is what keeps the query and the fence from drifting
 * into two answers again. Its limit, stated: it compares the two over the shapes
 * in the matrix, so a brand-new way of being assigned is only pinned once it is
 * added here too.
 */

/** In-memory Firestore, keyed `${collection}/${id}` so users and clients cannot collide. */
const store = new Map<string, Record<string, unknown>>();
const key = (collection: string, id: string) => `${collection}/${id}`;

/** Every document read the double serves, so read cost is a measurement not a claim. */
const reads: string[] = [];

function snapshot(collection: string, id: string) {
  const data = store.get(key(collection, id));
  reads.push(key(collection, id));
  return { exists: data !== undefined, id, data: () => data };
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => {
  const docRef = (collection: string, id: string) => ({ id, __collection: collection, get: async () => snapshot(collection, id) });

  function query(collection: string, filters: Array<[string, string, unknown]>) {
    return {
      where: (field: string, op: string, value: unknown) =>
        query(collection, [...filters, [field, op, value]]),
      doc: (id: string) => docRef(collection, id),
      get: async () => {
        const docs = [...store.entries()]
          .filter(([k]) => k.startsWith(`${collection}/`))
          .filter(([, data]) =>
            filters.every(([field, op, value]) => {
              if (op !== "array-contains") throw new Error(`unsupported op ${op}`);
              const arr = data[field];
              return Array.isArray(arr) && arr.includes(value);
            }),
          )
          .map(([k, data]) => {
            reads.push(k);
            return { exists: true, id: k.slice(collection.length + 1), data: () => data };
          });
        return { docs, empty: docs.length === 0 };
      },
    };
  }

  const db = {
    collection: (name: string) => query(name, []),
    getAll: async (...refs: Array<{ __collection: string; id: string }>) =>
      refs.map((r) => snapshot(r.__collection, r.id)),
  };
  return { adminDb: () => db };
});

import { listClients } from "@/lib/data";
import { canViewClient } from "@/lib/client-visibility";

const CLIENTS = {
  // Names u-emp-1 on its own document.
  c1: { name: "Acme", assignedEmployeeIds: ["u-emp-1"], createdAt: 300 },
  // Names nobody — reachable only through a user document.
  c2: { name: "Bravo", assignedEmployeeIds: [], createdAt: 200 },
  // Legacy document with no assignment array at all.
  c3: { name: "Cosmo", createdAt: 100 },
};

const EMPLOYEES = {
  // Assigned on the CLIENT document only.
  "u-emp-1": { uid: "u-emp-1", role: "KAROS_EMPLOYEE", createdAt: 0 },
  // Assigned on the USER document only — what createTeamMemberAction writes.
  "u-emp-2": { uid: "u-emp-2", role: "KAROS_EMPLOYEE", assignedClientIds: ["c2"], createdAt: 0 },
  // Assigned on BOTH sides, to the same client.
  "u-emp-3": { uid: "u-emp-3", role: "KAROS_EMPLOYEE", assignedClientIds: ["c1"], createdAt: 0 },
  // Assigned to nothing.
  "u-emp-4": { uid: "u-emp-4", role: "KAROS_EMPLOYEE", createdAt: 0 },
  // Names a client that has since been deleted, plus one that exists.
  "u-emp-5": {
    uid: "u-emp-5",
    role: "KAROS_EMPLOYEE",
    assignedClientIds: ["c-deleted", "c3"],
    createdAt: 0,
  },
};

beforeEach(() => {
  store.clear();
  reads.length = 0;
  for (const [id, c] of Object.entries(CLIENTS)) store.set(key("clients", id), c);
  for (const [uid, u] of Object.entries(EMPLOYEES)) store.set(key("users", uid), u);
  // c1 also names u-emp-3, so the union has something to deduplicate.
  store.set(key("clients", "c1"), { ...CLIENTS.c1, assignedEmployeeIds: ["u-emp-1", "u-emp-3"] });
});

const ids = async (employeeId?: string) =>
  (await listClients(employeeId ? { employeeId } : undefined)).map((c) => c.id);

describe("listClients({ employeeId }) — two fields, one relationship", () => {
  it("lists the client an employee is assigned on the CLIENT document", async () => {
    expect(await ids("u-emp-1")).toEqual(["c1"]);
  });

  it("lists the client an employee is assigned on the USER document", async () => {
    // THE LOCKOUT. This is the assignment both admin UIs actually make, and it
    // returned an empty list on all eight staff surfaces.
    expect(await ids("u-emp-2")).toEqual(["c2"]);
  });

  it("lists a client recorded on both sides exactly once", async () => {
    expect(await ids("u-emp-3")).toEqual(["c1"]);
  });

  it("lists nothing for an employee neither document assigns", async () => {
    expect(await ids("u-emp-4")).toEqual([]);
  });

  it("drops an assigned id whose client no longer exists", async () => {
    // A stale id on the user document is a dangling reference, not a client. It
    // must not become a hole in the list, an entry with no name, or a throw.
    expect(await ids("u-emp-5")).toEqual(["c3"]);
  });

  it("still returns the whole collection when no employee is named", async () => {
    // The admin path, unchanged — including the legacy document with no array.
    expect(await ids()).toEqual(["c1", "c2", "c3"]);
  });

  it("returns newest first across BOTH sources, not one source after the other", async () => {
    // c1 (createdAt 300) comes from the query, c3 (100) from the user document.
    // Sorting each source separately and concatenating would put c3 first.
    store.set(key("users", "u-emp-1"), { ...EMPLOYEES["u-emp-1"], assignedClientIds: ["c3"] });
    expect(await ids("u-emp-1")).toEqual(["c1", "c3"]);
  });

  it("survives a missing user document without losing the client-side assignment", async () => {
    // Failing closed here would be a second lockout: the client side of the
    // relationship is a legitimate signal on its own.
    store.delete(key("users", "u-emp-1"));
    expect(await ids("u-emp-1")).toEqual(["c1"]);
  });

  it("ignores empty and nullish ids on the user document", async () => {
    store.set(key("users", "u-emp-4"), {
      ...EMPLOYEES["u-emp-4"],
      assignedClientIds: ["", null, undefined],
    });
    expect(await ids("u-emp-4")).toEqual([]);
  });

  it("reads a single-digit number of documents, and one batch beyond the query", async () => {
    // The read cost this replaced one query with, measured rather than asserted in
    // a comment: the array-contains match, the user document, and one batched
    // getAll of the ids the query did not already return.
    await listClients({ employeeId: "u-emp-5" });
    expect(reads).toEqual([
      "users/u-emp-5",
      "clients/c-deleted",
      "clients/c3",
    ]);
  });
});

/**
 * THE PINNING TEST — the query and the fence, compared rather than trusted.
 *
 * `canViewClient` is the single authority on "may this actor see this client".
 * This asserts the query's answer IS the predicate's answer over the whole
 * collection, for every assignment shape above, so the two cannot drift into two
 * answers — which is what produced this defect. It is not a tautology from the
 * query's own final filter: the filter can only narrow, so an incomplete union
 * (the actual bug) passes the filter and fails here.
 */
describe("the list is exactly what the predicate allows", () => {
  const allClients = () =>
    Object.entries(CLIENTS).map(([id, c]) => ({ id, ...c })) as any[];

  it.each(Object.keys(EMPLOYEES))("%s", async (uid) => {
    const user = store.get(key("users", uid)) as any;
    const expected = allClients()
      .filter((c) => canViewClient(user, c))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map((c) => c.id);
    expect(await ids(uid)).toEqual(expected);
  });

  it("compares a non-empty expectation at least once", () => {
    // Without this the block above could pass by agreeing that nobody sees
    // anything.
    const seen = allClients().filter((c) => canViewClient(EMPLOYEES["u-emp-2"] as any, c));
    expect(seen.map((c) => c.id)).toEqual(["c2"]);
  });
});
