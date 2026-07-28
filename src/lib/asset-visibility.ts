import type { Asset } from "@/lib/types";
import { isAssetUnlockedForClient, templateForAsset } from "@/lib/post-chain";

/**
 * Returns the asset set that should be visible in the client-facing library.
 * Drafts remain visible so pending work is reviewable alongside approved and
 * published deliverables, and the list is ordered by recency.
 *
 * `forClient` is THE server-side security boundary for upcoming content: every
 * asset whose chain date is still in the future is replaced by a
 * whitelist-redacted placeholder (redactLockedAsset) BEFORE it crosses the RSC
 * boundary — a client browser never receives the content, image, meta, or even
 * the real title of a not-yet-unlocked post. Staff callers omit opts and get
 * full objects.
 */
export function getClientLibraryAssets(
  assets: Asset[],
  opts?: { forClient?: boolean; now?: number },
): Asset[] {
  const sorted = [...assets].sort(
    (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
  );
  if (!opts?.forClient) return sorted;
  const now = opts.now ?? Date.now();
  return sorted
    .filter((a) => !isLaunchDeliverable(a))
    .map((a) => (isAssetUnlockedForClient(a, now) ? a : redactLockedAsset(a)));
}

/**
 * A client agent's SETUP-run output: the research write-up and the proposed
 * template set. Working material staff curate, not a deliverable — it is
 * excluded here so all three client surfaces (library, calendar, archive)
 * inherit one exclusion instead of each growing its own filter.
 *
 * Not covered by the draft/date rules: a launch deliverable is undated (so the
 * lock never applies) and would age into the archive the moment staff approved
 * anything. The flag is written by the webhook at creation.
 */
export function isLaunchDeliverable(a: Pick<Asset, "meta">): boolean {
  return a.meta?.launchDeliverable === true;
}

/** How far back the client archive reaches. Older posts are hidden, never deleted. */
export const CLIENT_ARCHIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The client-facing Archive set (QA F149, call directive A4).
 *
 * The archive used to be every deliverable the moment it existed, badged
 * "draft" — breaking the approval promise the run dialog makes and handing the
 * client the whole batch at generation time. Three rules now:
 *
 * 1. **No drafts.** An unapproved draft is never client-visible, so nothing
 *    appears "the moment it is generated".
 * 2. **No future-dated posts.** Upcoming work lives on the calendar as slots;
 *    the archive never hints that a later day's post already exists (A3/A4).
 * 3. **Posted work ages out at ~30 days**, while work the client still has to
 *    post (approved / scheduled / delivered) stays until they mark it posted —
 *    that is what keeps "Mark as posted" reachable from the archive modal, and
 *    keeps the per-draft pick/edit/skip reader (F46) reachable at all.
 *
 * Ageing out is a VIEW filter — nothing is deleted, and staff surfaces keep the
 * full history.
 */
export function getClientArchiveAssets(assets: Asset[], opts?: { now?: number }): Asset[] {
  const now = opts?.now ?? Date.now();
  const cutoff = now - CLIENT_ARCHIVE_WINDOW_MS;
  const postedAt = (a: Asset) => a.publishedAt ?? a.updatedAt ?? a.createdAt;
  return assets
    .filter((a) => {
      if (isLaunchDeliverable(a)) return false;
      if (a.status === "draft") return false;
      if (!isAssetUnlockedForClient(a, now)) return false;
      if (a.status === "published") return postedAt(a) >= cutoff;
      return true;
    })
    .sort((a, b) => postedAt(b) - postedAt(a));
}

/**
 * Whitelist-redacted placeholder for a future-dated asset. Built by
 * CONSTRUCTION (never spread-and-delete) so any field added to Asset later is
 * excluded by default. Deliberately excluded: the original title/content/meta,
 * mimeType, imageUrl, recommendedAt/recommendedReason, publishedAt,
 * publishError, publishClaimedAt, publishMode, scheduledPlatform, and orderKey
 * (it embeds internal run names/dates — ordering is internal-only). The title
 * becomes the template placeholder (post titles reveal content).
 */
export function redactLockedAsset(a: Asset): Asset {
  const templateName = a.templateName ?? templateForAsset(a)?.name;
  return {
    id: a.id,
    clientId: a.clientId,
    jobId: null,
    agentId: a.agentId ?? null,
    type: a.type,
    title: templateName ?? "Upcoming post",
    content: "",
    meta: { locked: true },
    imageUrl: null,
    ...(a.channels ? { channels: a.channels } : {}),
    status: a.status,
    ...(a.scheduledAt != null ? { scheduledAt: a.scheduledAt } : {}),
    ...(a.templateKey ? { templateKey: a.templateKey } : {}),
    ...(templateName ? { templateName } : {}),
    locked: true,
    createdBy: "",
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
