import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In-memory Firestore double keyed by `${collection}/${id}` so `users` and
 * `clients` docs never collide (unlike a single flat Map keyed only by id).
 * Mirrors the transaction shape used elsewhere (get-before-write, tx.set merge).
 */
const store = new Map<string, Record<string, unknown>>();

function key(collection: string, id: string) {
  return `${collection}/${id}`;
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => {
  const docRef = (collection: string, id: string) => ({
    id,
    __collection: collection,
    async get() {
      const data = store.get(key(collection, id));
      return { exists: data !== undefined, id, data: () => data };
    },
  });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => docRef(name, id) }),
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        async get(ref: { __collection: string; id: string }) {
          const data = store.get(key(ref.__collection, ref.id));
          return { exists: data !== undefined, id: ref.id, data: () => data };
        },
        set(ref: { __collection: string; id: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) {
          const k = key(ref.__collection, ref.id);
          const prev = opts?.merge ? (store.get(k) ?? {}) : {};
          store.set(k, { ...prev, ...data });
        },
      }),
  };
  return { adminDb: () => db };
});

import { completeOnboarding } from "@/lib/data";

describe("completeOnboarding — transactional wizard finish", () => {
  beforeEach(() => {
    store.clear();
    store.set(key("users", "u1"), {
      uid: "u1",
      email: "a@acme.com",
      name: "Ada",
      role: "CLIENT_USER",
      clientId: "c1",
      hasCompletedOnboarding: false,
      createdAt: 0,
    });
    store.set(key("clients", "c1"), {
      name: "Old Name Inc",
      category: "",
      brandVoice: "",
    });
  });
  afterEach(() => vi.clearAllMocks());

  it("flips hasCompletedOnboarding and applies the workspace patch atomically", async () => {
    // The wizard's "Industry / niche" box fills `category` — the ONE field the
    // profile chip shows and every pipeline reads (CD-L). It used to write the
    // legacy `industry`, so a client answered the question at signup and then
    // found the chip in their own sidebar still empty.
    await completeOnboarding("u1", "c1", { name: "Acme Corp", category: "SaaS", brandVoice: "Bold and direct" });

    const user = store.get(key("users", "u1"));
    const client = store.get(key("clients", "c1"));
    expect(user?.hasCompletedOnboarding).toBe(true);
    expect(client).toMatchObject({ name: "Acme Corp", category: "SaaS", brandVoice: "Bold and direct" });
  });

  it("never touches the client doc when the user doc is missing", async () => {
    store.delete(key("users", "ghost"));
    await expect(completeOnboarding("ghost", "c1", { name: "Hijacked" })).rejects.toThrow(/not found/i);
    expect(store.get(key("clients", "c1"))).toMatchObject({ name: "Old Name Inc" });
  });

  it("refuses to patch a workspace that isn't this user's own client", async () => {
    await expect(completeOnboarding("u1", "someone-elses-client", { name: "Hijacked" })).rejects.toThrow(
      /forbidden/i,
    );
    expect(store.get(key("clients", "c1"))).toMatchObject({ name: "Old Name Inc" });
  });
});
