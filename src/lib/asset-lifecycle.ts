/**
 * Asset lifecycle reconciliation — pure, client-safe decision logic.
 *
 * Fixes the "stuck on Approved/Scheduled" bug: an asset that has demonstrably
 * gone live (its auto-publish slot passed, or a real platform post id was
 * captured) should read as "published" on the portal. This is the decision half;
 * the transactional Firestore write (asset + parent task → published/completed)
 * lives in `reconcileAssetPublished` in data.ts.
 *
 * No I/O — trivially unit-testable.
 */

import type { Asset } from "@/lib/types";

/**
 * Should this asset be reconciled to "published"?
 *  - already published → no.
 *  - a captured platform post id → yes (it demonstrably went live).
 *  - an AUTO (or legacy/absent publishMode) scheduled/approved asset whose slot
 *    has passed → yes (mirrors the calendar's time-based "reads as live" rule).
 * Manual and placeholder assets are excluded: manual only goes live via an
 * explicit "Publish Now" (which already stamps published), and placeholders are
 * roadmap-only and never actually posted.
 */
export function shouldReconcilePublished(asset: Pick<Asset, "status" | "platformPostId" | "publishMode" | "scheduledAt">, now: number): boolean {
  if (asset.status === "published") return false;
  if (asset.platformPostId) return true;

  const isAuto = asset.publishMode === "auto" || asset.publishMode == null;
  const onCalendar = asset.status === "scheduled" || asset.status === "approved";
  return (
    isAuto &&
    onCalendar &&
    asset.scheduledAt != null &&
    asset.scheduledAt <= now
  );
}
