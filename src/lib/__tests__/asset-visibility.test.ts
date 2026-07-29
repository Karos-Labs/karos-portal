import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLIENT_ARCHIVE_WINDOW_MS,
  clientDeliveryStamp,
  getClientArchiveAssets,
  getClientLibraryAssets,
  isInClientArchive,
} from "@/lib/asset-visibility";
import type { Asset } from "@/lib/types";

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    clientId: "client-1",
    title: "Draft asset",
    content: "Body",
    createdBy: "staff-1",
    createdAt: 1,
    updatedAt: 1,
    status: "draft",
    type: "social_post",
    ...overrides,
  };
}

describe("getClientLibraryAssets", () => {
  it("keeps draft assets visible in the client library", () => {
    const draft = makeAsset({ id: "draft-1", status: "draft", updatedAt: 20 });
    const approved = makeAsset({ id: "approved-1", status: "approved", updatedAt: 10 });

    const visible = getClientLibraryAssets([draft, approved]);

    expect(visible.map((asset) => asset.id)).toEqual(["draft-1", "approved-1"]);
  });

  it("orders the client library by recency", () => {
    const older = makeAsset({ id: "older", status: "approved", updatedAt: 5 });
    const newer = makeAsset({ id: "newer", status: "draft", updatedAt: 99 });

    const visible = getClientLibraryAssets([older, newer]);

    expect(visible.map((asset) => asset.id)).toEqual(["newer", "older"]);
  });
});

describe("getClientArchiveAssets", () => {
  const now = 1_000_000_000_000;

  it("hides unapproved drafts", () => {
    const draft = makeAsset({ id: "draft-1", status: "draft", updatedAt: now });
    const approved = makeAsset({ id: "approved-1", status: "approved", updatedAt: now });

    expect(getClientArchiveAssets([draft, approved], { now }).map((a) => a.id)).toEqual([
      "approved-1",
    ]);
  });

  it("keeps work the client still has to post, whatever its age", () => {
    const old = makeAsset({
      id: "delivered-old",
      status: "delivered",
      updatedAt: now - 10 * CLIENT_ARCHIVE_WINDOW_MS,
    });

    expect(getClientArchiveAssets([old], { now }).map((a) => a.id)).toEqual(["delivered-old"]);
  });

  it("ages posted work out after the 30-day window", () => {
    const fresh = makeAsset({
      id: "posted-fresh",
      status: "published",
      publishedAt: now - 1000,
      updatedAt: now - 1000,
    });
    const stale = makeAsset({
      id: "posted-stale",
      status: "published",
      publishedAt: now - CLIENT_ARCHIVE_WINDOW_MS - 1000,
      updatedAt: now - CLIENT_ARCHIVE_WINDOW_MS - 1000,
    });

    expect(getClientArchiveAssets([fresh, stale], { now }).map((a) => a.id)).toEqual([
      "posted-fresh",
    ]);
  });

  it("never lists a future-dated post — upcoming work lives on the calendar", () => {
    const upcoming = makeAsset({
      id: "locked-1",
      status: "approved",
      scheduledAt: now + 3 * 24 * 60 * 60 * 1000,
      updatedAt: now,
    });

    expect(getClientArchiveAssets([upcoming], { now })).toEqual([]);
  });
});

/**
 * Membership is ONE predicate. The surfaces that decide whether an archive link
 * has a destination (client-home-overview's recent rows, the notification
 * bell's review rows) must agree with the list itself — the bug this replaces
 * was a `status !== "draft"` replica that answered "linkable" for three kinds of
 * asset the archive drops.
 */
describe("isInClientArchive", () => {
  const now = 1_000_000_000_000;

  it("answers exactly what getClientArchiveAssets keeps", () => {
    const assets = [
      makeAsset({ id: "draft", status: "draft", updatedAt: now }),
      makeAsset({ id: "approved", status: "approved", updatedAt: now }),
      makeAsset({ id: "delivered", status: "delivered", updatedAt: now - 5 * CLIENT_ARCHIVE_WINDOW_MS }),
      makeAsset({
        id: "posted-fresh",
        status: "published",
        publishedAt: now - 1000,
        updatedAt: now - 1000,
      }),
      makeAsset({
        id: "posted-stale",
        status: "published",
        publishedAt: now - CLIENT_ARCHIVE_WINDOW_MS - 1,
        updatedAt: now - CLIENT_ARCHIVE_WINDOW_MS - 1,
      }),
      makeAsset({
        id: "future",
        status: "approved",
        scheduledAt: now + 3 * 24 * 60 * 60 * 1000,
        updatedAt: now,
      }),
      makeAsset({
        id: "launch",
        status: "approved",
        meta: { launchDeliverable: true },
        updatedAt: now,
      }),
    ];

    const listed = new Set(getClientArchiveAssets(assets, { now }).map((a) => a.id));
    for (const asset of assets) {
      expect([asset.id, isInClientArchive(asset, now)]).toEqual([asset.id, listed.has(asset.id)]);
    }
  });

  it("rejects the three cases a `status !== \"draft\"` replica let through", () => {
    const future = makeAsset({
      id: "future",
      status: "approved",
      scheduledAt: now + 24 * 60 * 60 * 1000,
      updatedAt: now,
    });
    const launch = makeAsset({
      id: "launch",
      status: "approved",
      meta: { launchDeliverable: true },
      updatedAt: now,
    });
    const agedOut = makeAsset({
      id: "aged",
      status: "published",
      publishedAt: now - CLIENT_ARCHIVE_WINDOW_MS - 1,
      updatedAt: now - CLIENT_ARCHIVE_WINDOW_MS - 1,
    });

    for (const asset of [future, launch, agedOut]) {
      expect(asset.status).not.toBe("draft");
      expect(isInClientArchive(asset, now)).toBe(false);
    }
  });
});

/**
 * The client home's "Recent activity" list.
 *
 * It listed every asset, drafts included, stamped `updatedAt ?? createdAt`. A
 * fire mints its drafts in one second and nothing moves them until a staff
 * member approves, so five rows carried the same stamp — the generation run's
 * shape, on the client's home screen (A3/A4), for work that has not reached
 * them at all. Membership is now the archive's own predicate and the stamp is
 * the archive's own stamp, so the row, its link and the screen it links to
 * cannot disagree.
 */
describe("the client home's recent list", () => {
  const now = 1_000_000_000_000;

  it("excludes the drafts whose stamp is the fire", () => {
    // The set the old list rendered, minted together: same createdAt, same
    // updatedAt, five rows reading "3 hours ago".
    const fire = now - 3 * 60 * 60 * 1000;
    const drafts = [1, 2, 3, 4, 5].map((n) =>
      makeAsset({ id: `draft-${n}`, status: "draft", createdAt: fire, updatedAt: fire }),
    );
    for (const draft of drafts) expect(isInClientArchive(draft, now)).toBe(false);
    // And a row that survives is one the client has actually been given.
    const approved = makeAsset({ id: "approved-1", status: "approved", updatedAt: now - 60_000 });
    expect(isInClientArchive(approved, now)).toBe(true);
  });

  it("stamps a delivered row by delivery, not by generation", () => {
    // Same fire, delivered on different days: the stamp that separates them is
    // the one the archive already sorts by.
    const fire = now - 5 * 24 * 60 * 60 * 1000;
    const first = makeAsset({
      id: "a",
      status: "published",
      createdAt: fire,
      updatedAt: fire + 1000,
      publishedAt: now - 2 * 24 * 60 * 60 * 1000,
    });
    const second = makeAsset({
      id: "b",
      status: "approved",
      createdAt: fire,
      updatedAt: now - 60 * 60 * 1000,
    });
    expect(clientDeliveryStamp(first)).toBe(first.publishedAt);
    expect(clientDeliveryStamp(second)).toBe(second.updatedAt);
    expect(clientDeliveryStamp(second)).toBeGreaterThan(clientDeliveryStamp(first));
    // Both are generation-stamped identically — which is the whole problem.
    expect(first.createdAt).toBe(second.createdAt);
  });

  it("is wired to those two helpers, and only for a client viewer", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/client-home-overview.tsx"),
      "utf8",
    );
    expect(src).toMatch(/\.filter\(\(a\) => !viewerIsClient \|\| isInClientArchive\(a, now\)\)/);
    expect(src).toMatch(
      /viewerIsClient \? clientDeliveryStamp\(a\) : a\.updatedAt \?\? a\.createdAt/,
    );
    expect(src).toMatch(/relativeTime\(stampOf\(a\)\)/);
    // Staff pass nothing and keep the full list: the prop defaults to false.
    expect(src).toContain("viewerIsClient = false");
    const page = readFileSync(join(process.cwd(), "src/app/(app)/clients/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/viewerIsClient=\{isClientViewer\}/);
  });
});
