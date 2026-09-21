/**
 * Recognises an approved X/LinkedIn agent draft as a SINGLE post ready to
 * hand to `publishAssetToPlatform` — the deliverable-side half of the
 * per-client `ClientIntegration.agentAutoPublish` opt-in (see that field's
 * doc comment in lib/types.ts for the product reasoning).
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

export interface AgentDraftAutoPublishTarget {
  platform: "linkedin" | "twitter";
  /** The one post's exact text, straight off the draft — nothing re-derived. */
  text: string;
}

/**
 * The single post to auto-publish for an approved agent-drafted note, and
 * which platform it targets — or null when this asset is not a recognised
 * SINGLE-post LinkedIn/X agent batch, so the caller must leave the existing
 * manual "Pick & post" flow as the only way out.
 *
 * DELIBERATELY NARROW, on two axes:
 *
 *  - ONE ACCOUNT, ONE DRAFT. "One run produces one post" is the current
 *    product rule for both agents (docs/x-agent-portal.md §"One run
 *    produces ONE post"; docs/linkedin-agent-portal.md's writer instructions
 *    default to one post per run too), so that is what a live run's batch
 *    looks like. An older or edge-case multi-draft batch has no single post
 *    to choose automatically and is left for a human to pick — never
 *    guessed at.
 *  - PLAIN TEXT ONLY, for X. A thread (more than one post in the draft) and
 *    a reply/quote (addressed at another post) have no plain-tweet publish
 *    path today — `publishAssetToPlatform`'s `publishToTwitter` posts one
 *    bare 280-char tweet and nothing else, no reply/quote targeting, no
 *    chaining. Both stay on the manual hand-off, where X's own compose UI
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
 * never reads), so auto-publishing it through the client's single shared
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
      ? { platform: "linkedin", text: onlyDraft.text }
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
      return { platform: "twitter", text: onlyDraft.posts[0].text };
    }
    return null;
  }

  return null;
}
