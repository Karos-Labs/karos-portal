import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldReconcilePublished } from "@/lib/asset-lifecycle";
import type { Asset } from "@/lib/types";

const NOW = Date.UTC(2026, 6, 8, 12);
const PAST = NOW - 60_000;
const FUTURE = NOW + 60_000;

function asset(patch: Partial<Asset> = {}): Asset {
  return {
    id: "a1",
    clientId: "c1",
    type: "social_post",
    title: "Post",
    content: "hi",
    status: "scheduled",
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Asset;
}

/* ── Pure decision ───────────────────────────────────────────────────── */

describe("shouldReconcilePublished", () => {
  it("is false for an already-published asset", () => {
    expect(shouldReconcilePublished(asset({ status: "published", scheduledAt: PAST }), NOW)).toBe(false);
  });

  it("is true when a platform post id was captured (demonstrably live)", () => {
    expect(shouldReconcilePublished(asset({ status: "approved", platformPostId: "urn:123" }), NOW)).toBe(true);
  });

  it("is true for an auto/absent-mode scheduled or approved asset whose slot passed", () => {
    expect(shouldReconcilePublished(asset({ status: "scheduled", publishMode: "auto", scheduledAt: PAST }), NOW)).toBe(true);
    expect(shouldReconcilePublished(asset({ status: "approved", scheduledAt: PAST }), NOW)).toBe(true); // absent mode = auto
  });

  it("is false for manual and placeholder modes (never auto-flipped)", () => {
    expect(shouldReconcilePublished(asset({ status: "scheduled", publishMode: "manual", scheduledAt: PAST }), NOW)).toBe(false);
    expect(shouldReconcilePublished(asset({ status: "scheduled", publishMode: "placeholder", scheduledAt: PAST }), NOW)).toBe(false);
  });

  it("is false when the slot is still in the future", () => {
    expect(shouldReconcilePublished(asset({ status: "scheduled", publishMode: "auto", scheduledAt: FUTURE }), NOW)).toBe(false);
  });

  it("is false for a draft with no post id and no passed slot", () => {
    expect(shouldReconcilePublished(asset({ status: "draft" }), NOW)).toBe(false);
  });
});

/* ── Transactional reconcile (asset + parent task) ───────────────────── */

const store = new Map<string, Record<string, unknown> | undefined>();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => {
  const docRef = (id: string) => ({
    id,
    async get() {
      const data = store.get(id);
      return { exists: data !== undefined, id, data: () => data };
    },
  });
  return {
    adminDb: () => ({
      collection: () => ({ doc: (id: string) => docRef(id) }),
      runTransaction: async (fn: (tx: unknown) => unknown) =>
        fn({
          async get(ref: { id: string }) {
            const data = store.get(ref.id);
            return { exists: data !== undefined, id: ref.id, data: () => data };
          },
          set(ref: { id: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) {
            const prev = opts?.merge ? store.get(ref.id) ?? {} : {};
            store.set(ref.id, { ...prev, ...data });
          },
        }),
    }),
  };
});

import { reconcileAssetPublished } from "@/lib/data";

describe("reconcileAssetPublished (transactional)", () => {
  beforeEach(() => store.clear());
  afterEach(() => vi.clearAllMocks());

  it("flips a passed-slot asset AND completes its parent task", async () => {
    store.set("a1", { id: "a1", clientId: "c1", status: "scheduled", publishMode: "auto", scheduledAt: PAST, meta: { taskId: "t1" } });
    store.set("t1", { id: "t1", clientId: "c1", status: "in_progress" });

    const r = await reconcileAssetPublished("a1", NOW);
    expect(r).toEqual({ changed: true, taskCompleted: true });
    expect(store.get("a1")).toMatchObject({ status: "published", publishedAt: NOW });
    expect(store.get("t1")).toMatchObject({ status: "completed", completedAt: NOW });
  });

  it("is idempotent — a second run makes no change", async () => {
    store.set("a1", { id: "a1", clientId: "c1", status: "scheduled", publishMode: "auto", scheduledAt: PAST, meta: { taskId: "t1" } });
    store.set("t1", { id: "t1", clientId: "c1", status: "in_progress" });
    await reconcileAssetPublished("a1", NOW);
    const second = await reconcileAssetPublished("a1", NOW);
    expect(second.changed).toBe(false);
  });

  it("stores a verified post id and publishes even without a passed slot", async () => {
    store.set("a1", { id: "a1", clientId: "c1", status: "approved" });
    const r = await reconcileAssetPublished("a1", NOW, "urn:li:share:999");
    expect(r.changed).toBe(true);
    expect(store.get("a1")).toMatchObject({ status: "published", platformPostId: "urn:li:share:999" });
  });

  it("publishes an asset with no parent task (taskCompleted false)", async () => {
    store.set("a1", { id: "a1", clientId: "c1", status: "scheduled", publishMode: "auto", scheduledAt: PAST });
    const r = await reconcileAssetPublished("a1", NOW);
    expect(r).toEqual({ changed: true, taskCompleted: false });
    expect(store.get("a1")).toMatchObject({ status: "published" });
  });

  it("does nothing for an asset that doesn't qualify", async () => {
    store.set("a1", { id: "a1", clientId: "c1", status: "scheduled", publishMode: "manual", scheduledAt: PAST });
    const r = await reconcileAssetPublished("a1", NOW);
    expect(r.changed).toBe(false);
    expect(store.get("a1")).toMatchObject({ status: "scheduled" });
  });
});
