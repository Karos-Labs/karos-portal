import type { Asset } from "@/lib/types";
import { clientSafePublishError } from "@/lib/custom-agent-launch";
import { isAssetUnlockedForClient, templateForAsset } from "@/lib/post-chain";

/**
 * THE server boundary for a failed publish's reason.
 *
 * `publishError` holds the platform SDK's own exception, and every client-facing
 * asset payload goes through one of the two functions below — so this is where
 * the raw string stops. Four surfaces read the field once it has crossed (the
 * calendar's chip tooltip and its projected CalendarPost, the dashboard's
 * "needs your attention" hint, and the detail modal's "Publish failed" panel),
 * and none of them can be the fix: `RunCalendar` is handed the whole `Asset`
 * for its detail modal, so sanitizing the projected CalendarPost alone would
 * still have shipped the exception in the same payload.
 *
 * Not covered by `redactLockedAsset`, which excludes the field by construction:
 * that only runs for LOCKED assets, and a failed publish is past due — so every
 * one of them took the un-redacted path. The COPY rule itself lives in
 * clientSafePublishError, once; this only decides where it is applied.
 */
function withClientSafePublishError(a: Asset): Asset {
  if (a.publishError == null) return a;
  const safe = clientSafePublishError(a.publishError);
  return safe === a.publishError ? a : { ...a, publishError: safe };
}

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
    .filter((a) => !isLaunchDeliverable(a) && !isTestRunAsset(a))
    // `isAssetContentVisibleToClient` rather than the bare unlock test: after
    // the filter above the two are equivalent here, and asking the shared
    // predicate is what keeps a future tightening of it from applying
    // everywhere EXCEPT the library.
    .map((a) =>
      isAssetContentVisibleToClient(a, now)
        ? withClientSafePublishError(a)
        : redactLockedAsset(a),
    );
}

/**
 * MAY THIS CLIENT BE HANDED THIS ASSET'S REAL CONTENT — the churn rule (A3) as
 * one predicate, for anything that is not a list projection.
 *
 * The two client asset projections above answer it for the surfaces they build,
 * by dropping or redacting rows. Anything that takes ONE asset id from the
 * browser and derives something from that asset's text has the same question to
 * answer and no list to filter, so it has to ask here — otherwise the redaction
 * is a property of two read paths rather than of the asset, and the next
 * endpoint reintroduces the hole. The whole point of the rule is that a client
 * cannot learn that next Thursday's post already exists; an endpoint that
 * paraphrases that post's text back to them tells them exactly that, and it
 * does not matter that no list ever rendered it.
 *
 * Three ways to fail, all of them already the library's:
 *   1. **Launch deliverable** — a setup run's working material, never a
 *      deliverable (see isLaunchDeliverable).
 *   2. **Test run** — staff checking the pipeline (see isTestRunAsset).
 *   3. **Still locked** — chain date in the future. This is the churn rule.
 *
 * Drafts are deliberately NOT a fourth: an unlocked draft is visible in the
 * client library by design ("pending work is reviewable"), so refusing one here
 * would refuse content the client is already reading. The ARCHIVE excludes
 * drafts, and it asks this predicate and then adds that rule on top — which is
 * the honest relationship between the two sets, rather than two lists of rules
 * that have to be kept equal by hand.
 */
export function isAssetContentVisibleToClient(
  a: Pick<Asset, "meta" | "status" | "scheduledAt" | "publishedAt" | "updatedAt" | "createdAt">,
  now: number,
): boolean {
  if (isLaunchDeliverable(a)) return false;
  // Not covered by any status test: approveAssetAction has no test-run guard,
  // so a staff member approving one by mistake (the plain review queue shows no
  // TEST badge) flips its status without going through promoteTestAssetAction.
  if (isTestRunAsset(a)) return false;
  return isAssetUnlockedForClient(a, now);
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

/**
 * A Control Room staff "Test Run" deliverable — flagged by the webhook
 * (route.ts's `isTestRun`) the same way a launch deliverable is. Excluded
 * from the client library for the same reason: it is not a deliverable, it
 * is staff verifying the pipeline still works. Unlike a launch deliverable it
 * never leaves `status: "draft"` (chain-reflow is skipped for it too), so
 * `isInClientArchive`'s existing `status === "draft"` exclusion already keeps
 * it out of the archive — only the library's drafts-included view needs this
 * explicit check.
 */
export function isTestRunAsset(a: Pick<Asset, "meta">): boolean {
  return a.meta?.testRun === true;
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
  return assets
    .filter((a) => isInClientArchive(a, now))
    .sort((a, b) => clientDeliveryStamp(b) - clientDeliveryStamp(a))
    // The archive is the OTHER client asset projection — the agent detail page
    // feeds `agentProducedAssets` straight from here for a client viewer, and
    // that set reaches the same detail modal (via the archive rows and the clip
    // gallery) without passing getClientLibraryAssets. A held or failed post is
    // `status: "scheduled"` and past due, so it is squarely in this set.
    .map(withClientSafePublishError);
}

/**
 * The moment the archive sorts and ages a row by: when the client got it.
 *
 * Also THE timestamp client-facing deliverable rows print. `createdAt` is the
 * generation instant, and a week of "daily" posts shares one of those — so
 * stamping a client's rows with it publishes the batch shape on every surface
 * that lists deliverables (A3/A4). Published work carries its posting time;
 * everything else carries the last time it moved, which for an approved
 * deliverable is the approval. Staff surfaces keep `createdAt`: for them the
 * generation instant is the fact worth knowing.
 */
export function clientDeliveryStamp(
  a: Pick<Asset, "publishedAt" | "updatedAt" | "createdAt">,
): number {
  return a.publishedAt ?? a.updatedAt ?? a.createdAt;
}

/**
 * Archive membership as ONE predicate — the four rules above, in one place.
 *
 * Every surface that wants to say "this is (or will be) in your archive" has to
 * ask THIS, not re-derive a subset. Two surfaces had grown one-rule replicas of
 * the set (`status !== "draft"`), which answers "yes, linkable" for a
 * future-dated post, a launch deliverable, and a published post that has already
 * aged past the 30-day window — three ways to land a client on a screen that
 * provably excludes the row they just clicked. A link is only honest if the
 * asset behind it passes the same filter the archive itself applies.
 */
export function isInClientArchive(
  a: Pick<Asset, "meta" | "status" | "scheduledAt" | "publishedAt" | "updatedAt" | "createdAt">,
  now: number,
): boolean {
  // Rules 1 and 2 plus the launch/test-run exclusions are the same question the
  // library asks, so they are asked in the same place — the archive is a strict
  // subset of "content this client may be handed", not a parallel list.
  if (!isAssetContentVisibleToClient(a, now)) return false;
  if (a.status === "draft") return false;
  if (a.status === "published") return clientDeliveryStamp(a) >= now - CLIENT_ARCHIVE_WINDOW_MS;
  return true;
}

/**
 * Why an asset may NOT be pushed live, or null when it may.
 *
 * "Publish Now" is the one control that actually posts to a client's live
 * account through our integration, and it had grown three hand-written gates
 * that gave three different answers: the asset card required nothing but
 * "not already published" (so it offered the button on unapproved drafts AND on
 * calendar-only placeholders), the detail modal excluded placeholders but still
 * offered drafts, and the server action refused only the already-published case
 * — and the server is the only gate that counts, so anything reaching it went
 * out. This is that rule, once:
 *
 * 1. **Already published** — nothing to push, and pushing again duplicates the post.
 * 2. **Placeholder** — a calendar-only roadmap entry. "Karos never posts it" is
 *    the tier's own promise to the client; there is nothing to post.
 * 3. **Not approved** — only approved / scheduled / delivered work has been
 *    signed off. Publishing a draft posts unreviewed copy to a real account,
 *    which is strictly worse than the same hole in `markAssetPostedAction`
 *    (where a client merely mis-attests) or in `canMarkPosted` — both of which
 *    already refuse exactly this set.
 *
 * The per-surface conditions stay with their surfaces: a compatible connected
 * platform and the staff capability check are facts about the VIEWER and the
 * environment, not about the asset.
 */
export type AssetPublishBlock = "published" | "placeholder" | "unapproved";

export function assetPublishBlock(
  a: Pick<Asset, "status" | "publishMode">,
): AssetPublishBlock | null {
  if (a.status === "published") return "published";
  if (a.publishMode === "placeholder") return "placeholder";
  if (a.status !== "approved" && a.status !== "scheduled" && a.status !== "delivered") {
    return "unapproved";
  }
  return null;
}

/**
 * Can this asset be pushed live at all? THE predicate behind "Publish Now" —
 * asked by the asset card, the detail modal's PublishNowRow and
 * `publishAssetNowAction`, so the three cannot drift again. Says nothing about
 * WHERE it would go: platform compatibility and integration health are the
 * caller's business (see PUBLISHABLE_PLATFORMS, which deliberately has no
 * Reddit entry at all — Reddit is draft-only by contract).
 */
export function isAssetPublishable(a: Pick<Asset, "status" | "publishMode">): boolean {
  return assetPublishBlock(a) === null;
}

/**
 * Whitelist-redacted placeholder for a future-dated asset. Built by
 * CONSTRUCTION (never spread-and-delete) so any field added to Asset later is
 * excluded by default. Deliberately excluded: the original title/content/meta,
 * mimeType, imageUrl, recommendedAt/recommendedReason, publishedAt,
 * publishError, publishClaimedAt, scheduledPlatform, and orderKey (it embeds
 * internal run names/dates — ordering is internal-only). The title becomes the
 * template placeholder (post titles reveal content).
 *
 * `publishMode` CROSSES, AND ONLY AS THE PLACEHOLDER MARKER — the one value
 * that is a PROMISE to the client rather than internal routing.
 *
 * Dropping it outright made the calendar misdescribe the client's own week.
 * `postKind` (lib/calendar-kind) classifies on `publishMode === "placeholder"`,
 * so with the field gone every locked roadmap entry — an item the tier's own
 * promise says Karos never posts — was painted with the info-blue "Scheduled
 * post" chip, then flipped to "Placeholder" on the day the redaction lifted.
 * mark-posted-row.tsx had already been bitten by this same omission; the
 * calendar's classifier was its second reader.
 *
 * "auto" and "manual" stay behind, because they say who pushes the button and
 * a locked post's chip does not distinguish them (both read "Scheduled post"),
 * so withholding them costs the client nothing. The value scoping is also what
 * makes the field's ABSENCE meaningful rather than lossy: on a redacted asset
 * `publishMode === "placeholder"` holds exactly when the real asset is one, so
 * a classifier reading it reaches the same answer either side of the unlock.
 * That equivalence — not this paragraph — is what has to stay true, and it is
 * asked of every shape `postKind` reads in calendar-locked-chip.test.ts.
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
    // The placeholder marker only — see the note above for why the other two
    // modes stay behind and why this one has to travel.
    ...(a.publishMode === "placeholder" ? { publishMode: "placeholder" as const } : {}),
    ...(a.scheduledAt != null ? { scheduledAt: a.scheduledAt } : {}),
    ...(a.templateKey ? { templateKey: a.templateKey } : {}),
    ...(templateName ? { templateName } : {}),
    locked: true,
    createdBy: "",
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
