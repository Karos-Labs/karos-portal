/**
 * Recognises an approved X/LinkedIn agent draft as a SINGLE post ready to
 * hand to `publishAssetToPlatform` — the deliverable-side half of BOTH
 * publish doors a LinkedIn/X agent draft can go out through:
 *
 *  - the automatic one, `ClientIntegration.agentAutoPublish` (see that
 *    field's doc comment in lib/types.ts) — fires the instant approval
 *    lands, when the client has opted the platform in;
 *  - the manual one, `publishAgentDraftNowAction` (asset-actions.ts) — the
 *    same "Publish Now" button every other publishable asset type already
 *    has, extended to a note the way the CEO asked for it (2026-09-21):
 *    the SAME button set on every network, not a bespoke one for LinkedIn/X.
 *
 * BUTTON VISIBILITY reads this file's `agentDraftAutoPublishTarget` plus a
 * list of the client's CONNECTED, usable integrations — never the
 * `agentAutoPublish` flag. The flag only decides whether approving an
 * eligible draft fires the publish immediately or waits for a manual
 * Publish Now click; it was never meant to hide or show a button (see the
 * flag's own doc comment in lib/types.ts for the full reasoning).
 *
 * Pure and client-safe (no server-only import), same discipline as
 * li-drafts.ts / x-drafts.ts: this reads `asset.content`, which is exactly
 * what those two parsers already read, and the sniff + precedence below is
 * copied from asset-card.tsx's own `liBatch` / `redditBatch` / `xBatch`
 * computation rather than re-derived — LinkedIn and Reddit both open on an
 * "## Account N · …" heading, which contains the X sniff's "# Account "
 * substring, so both must be ruled out before X is even tried.
 */

import { parseLiDrafts } from "@/lib/li-drafts";
import { isRedditV2Envelope, parseRedditDrafts } from "@/lib/reddit-drafts";
import { parseXDrafts } from "@/lib/x-drafts";
import type { Asset } from "@/lib/types";

/**
 * THE single source of truth for "which platforms can this whole feature
 * ever target" — client-safe and framework-free on purpose, so both a
 * runtime filter (integrations-tab.tsx's "Agent draft auto-publish"
 * checklist) and the `AgentDraftAutoPublishTarget.platform` type below can
 * read it without duplicating the list by hand. `agentDraftAutoPublishTarget`
 * only ever returns one of these two; a platform not on this list has no
 * agent-drafted pick-to-post content today, so a checkbox for it would be a
 * no-op that looks like a real toggle (the product owner's own read of a
 * live screenshot, 2026-09-21, of a checklist that listed every connected
 * publishable channel — Instagram, YouTube, TikTok included — none of which
 * this flag does anything for). Add a platform here THE DAY it grows
 * agent-drafted note content of its own, and every reader of this list
 * (the checklist, this file's own target sniff) picks it up together.
 */
export const AGENT_DRAFT_PLATFORM_IDS = ["linkedin", "twitter"] as const;

export interface AgentDraftAutoPublishTarget {
  platform: (typeof AGENT_DRAFT_PLATFORM_IDS)[number];
  /** The one post's exact text, straight off the draft — nothing re-derived. */
  text: string;
  /** The batch section title this draft came from ("… Company page" / a seat's name). */
  accountTitle: string;
  /**
   * `${accountTitle} · ${lane}` — the same key `li-drafts-review.tsx` /
   * `x-drafts-review.tsx` build for `addLiDraftFeedbackAction` /
   * `addXDraftFeedbackAction`'s own `draftRef`, so a caller outside the
   * reader component (the host-level Publish Now button) can log feedback
   * against the identical row.
   */
  draftRef: string;
}

/**
 * The single post a real OAuth publish would send for this asset, and which
 * platform it targets — or null when this asset is not a recognised
 * SINGLE-post LinkedIn/X agent batch, so the only way out is the compose
 * shortcut (which needs no eligibility check — it just opens the platform's
 * own composer with the text prefilled).
 *
 * DELIBERATELY NARROW, on two axes:
 *
 *  - ONE ACCOUNT, ONE DRAFT. "One run produces one post" is the current
 *    product rule for both agents (docs/x-agent-portal.md §"One run
 *    produces ONE post"; docs/linkedin-agent-portal.md's writer instructions
 *    default to one post per run too), so that is what a live run's batch
 *    looks like. An older or edge-case multi-draft batch has no single post
 *    to choose automatically and is left for the compose shortcut on each
 *    draft — never guessed at.
 *  - PLAIN TEXT ONLY, for X. A thread (more than one post in the draft) and
 *    a reply/quote (addressed at another post) have no plain-tweet publish
 *    path today — `publishAssetToPlatform`'s `publishToTwitter` posts one
 *    bare 280-char tweet and nothing else, no reply/quote targeting, no
 *    chaining. Both stay on the compose shortcut, where X's own compose UI
 *    can actually address them.
 *
 * Never returns a Reddit target: Reddit is draft-only by hard product rule
 * (no posting code path exists or may be added — see
 * deliverable-asset-type.ts), and this function only ever names "linkedin"
 * or "twitter".
 *
 * COMPANY PAGE ONLY, for both platforms — a third axis, and load-bearing for
 * a reason neither agent's own docs state (their `ClientIntegration` is a
 * single shared credential, not one per identity): `publishAssetToPlatform`
 * posts LinkedIn as `credentials.organizationId` (falling back to the token's
 * own member) and X as whatever account `credentials.accessToken` belongs
 * to — ONE identity per client, the same one "Publish Now" already posts as.
 * A personal seat's draft is written to go out under THAT PERSON'S own
 * handle (LinkedIn employee-advocacy seats / X seats each carry their own
 * separate credentials — `EmployeeSeat`, `clientSeats` — that this publisher
 * never reads), so publishing it through the client's single shared
 * integration would post someone else's words under the wrong name. The
 * reader components (`li-drafts-review.tsx`, `x-drafts-review.tsx`) tell a
 * company-page account apart from a seat the same way this does — by title —
 * so this stays exactly as reliable as what a human already sees on the card.
 */
export function agentDraftAutoPublishTarget(
  asset: Pick<Asset, "type" | "content">,
): AgentDraftAutoPublishTarget | null {
  if (asset.type !== "note" || !asset.content) return null;
  const content = asset.content;
  const isCompanyPage = (title: string) => title.toLowerCase().includes("company page");

  if (content.includes("# LinkedIn drafts")) {
    const batch = parseLiDrafts(content);
    const onlyAccount = batch && batch.accounts.length === 1 ? batch.accounts[0] : null;
    const onlyDraft = onlyAccount && onlyAccount.drafts.length === 1 ? onlyAccount.drafts[0] : null;
    return onlyAccount && onlyDraft && isCompanyPage(onlyAccount.title)
      ? {
          platform: "linkedin",
          text: onlyDraft.text,
          accountTitle: onlyAccount.title,
          draftRef: `${onlyAccount.title} · ${onlyDraft.lane}`,
        }
      : null;
  }

  const looksLikeReddit =
    isRedditV2Envelope(content) ||
    content.includes("# Reddit answer drafts") ||
    parseRedditDrafts(content) !== null;
  if (!looksLikeReddit && content.includes("# Account ")) {
    const batch = parseXDrafts(content);
    const onlyAccount = batch && batch.accounts.length === 1 ? batch.accounts[0] : null;
    const onlyDraft = onlyAccount && onlyAccount.drafts.length === 1 ? onlyAccount.drafts[0] : null;
    if (
      onlyAccount &&
      onlyDraft &&
      isCompanyPage(onlyAccount.title) &&
      onlyDraft.posts.length === 1 &&
      !onlyDraft.replyToUrl &&
      !onlyDraft.quoteUrl &&
      onlyDraft.posts[0].text.trim().length > 0
    ) {
      return {
        platform: "twitter",
        text: onlyDraft.posts[0].text,
        accountTitle: onlyAccount.title,
        draftRef: `${onlyAccount.title} · ${onlyDraft.avenue}`,
      };
    }
    return null;
  }

  return null;
}

/**
 * Whether the host's "Publish Now" button should render for this agent
 * draft — TECHNICAL eligibility only: `agentDraftAutoPublishTarget`
 * recognises the shape AND the client has a connected, usable integration
 * for the platform it targets. Deliberately blind to
 * `ClientIntegration.agentAutoPublish`: that flag decides whether approving
 * fires the publish immediately, not whether the button exists at all (the
 * CEO's own words, 2026-09-21: "if there's approval for auto-publish, the
 * only change is that if they approve and at some point choose to publish,
 * it'll publish automatically. If not, it won't auto-publish" — a button
 * that "chooses to publish" has to exist either way).
 *
 * Asset-status eligibility (approved/scheduled/delivered, not already
 * published, not a placeholder) is asked separately by the caller via
 * `isAssetPublishable` — the same split every other Publish Now button in
 * this codebase already keeps between "can this content go out at all" and
 * "is a platform actually connected for it".
 */
export function agentDraftManualPublishTarget(
  asset: Pick<Asset, "type" | "content">,
  /** Platform ids this client has a CONNECTED, usable integration for. */
  connectedPlatforms: readonly string[] | undefined,
): AgentDraftAutoPublishTarget | null {
  if (!connectedPlatforms || connectedPlatforms.length === 0) return null;
  const target = agentDraftAutoPublishTarget(asset);
  return target && connectedPlatforms.includes(target.platform) ? target : null;
}
