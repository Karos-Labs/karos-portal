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
  return sorted.map((a) => (isAssetUnlockedForClient(a, now) ? a : redactLockedAsset(a)));
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
