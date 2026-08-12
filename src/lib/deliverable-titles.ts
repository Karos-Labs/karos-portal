/**
 * What a delivered post is CALLED in a client's archive row.
 *
 * The rows used to be named by their family and their date ("X draft batch ·
 * 4 Aug"), which tells a client when something happened and never what any of
 * it said. Scanning a list of those means opening every one. A title made from
 * the post's own subject is the whole point of the row.
 *
 * Pure and family-agnostic: the callers own the parsing (parseXDrafts /
 * parseLiDrafts) and hand the pieces here, so this file has no opinion about
 * markdown shapes and can be tested without one.
 *
 * ONE POST ONLY. A title is a promise that the row is about one subject, and a
 * multi-draft delivery (the pre-single-post batches that are still in clients'
 * archives) cannot honestly keep it — those keep the dated family noun. The
 * callers enforce that by only asking when they hold exactly one draft.
 */

import { stripInlineMarkdown } from "@/lib/doc-render";
import { normalizeDashes } from "@/lib/text-utils";
import { parseXDrafts } from "@/lib/x-drafts";
import { parseLiDrafts } from "@/lib/li-drafts";
import { isRedditV2Envelope, parseRedditDrafts } from "@/lib/reddit-drafts";

/** Wordy filler a "Topic:" bullet sometimes opens with, stripped for the title. */
const TOPIC_PREFIX = /^(topic|subject|about)\s*[:\-–]\s*/i;

/**
 * A thread's position marker ("1/5"), which opens the first post of every X
 * thread and is the lab's numbering, not the post's subject. Left in, a thread
 * row reads "X thread · 1/5 Hiring is broken" and the client's eye lands on a
 * fraction.
 */
const THREAD_MARKER = /^\d{1,2}\s*\/\s*\d{1,2}\s*/;

const MAX_WORDS = 6;

/**
 * A short subject phrase from a post's own text, or null when there is nothing
 * quotable in it.
 *
 * URLs are dropped before the words are counted: a post that opens with a link
 * would otherwise be titled with half of one, which is noise where a subject
 * should be. Trailing sentence punctuation goes too, so the ellipsis this adds
 * for a truncated phrase cannot land on top of a full stop.
 */
export function topicPhrase(source: string): string | null {
  const cleaned = stripInlineMarkdown(source ?? "")
    // AFTER stripInlineMarkdown, never before: a markdown link is `[label](url)`,
    // so stripping bare URLs first leaves the `[label](` scaffolding behind and
    // titles the row with punctuation. The shared helper collapses the link to
    // its label, and only then is a leftover URL a bare one.
    .replace(/https?:\/\/\S+/g, " ");
  const firstLine = cleaned
    .split("\n")
    // Leading BLOCK markers, which stripInlineMarkdown leaves alone by design:
    // it handles inline markup, and a heading hash or a quote caret is line
    // shape. Both open agent-written blocks, so both would otherwise open a row.
    .map((line) => line.replace(/^\s*(?:#{1,6}|>+|[-*+])\s+/, "").trim())
    .find(Boolean);
  if (!firstLine) return null;
  const words = firstLine
    .replace(TOPIC_PREFIX, "")
    .replace(THREAD_MARKER, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  const phrase = words
    .slice(0, MAX_WORDS)
    .join(" ")
    .replace(/[.,;:!?"'…]+$/, "")
    .trim();
  if (!phrase) return null;
  // The agent's own words reach a client here, so they are subject to the copy
  // rule the rest of this surface follows: no em dashes anywhere a client reads.
  // Safe to normalize at this boundary, unlike a post BODY, because a row title
  // is only ever read, never copied out and posted (see the long note in
  // reddit-drafts-review on why the body itself is left exactly as written).
  const titled = normalizeDashes(words.length > MAX_WORDS ? `${phrase}…` : phrase).trim();
  // A phrase has to contain something READABLE. Stripping markup off a line of
  // pure decoration ("***", "---") leaves punctuation that is not a subject,
  // and "LinkedIn post · *" is worse than the dated noun it would replace.
  // Unicode-aware so a title in any script counts as readable.
  return titled && /[\p{L}\p{N}]/u.test(titled) ? titled : null;
}

/**
 * The row title for a single delivered post: `<noun> · <subject>`.
 *
 * The subject comes from the post's own opening words, and deliberately NOT
 * from the agent's stated topic. LinkedIn writes a "Topic:" meta bullet, which
 * looks like the better source until you read one: they carry the lab's own
 * vocabulary ("catalog row `playbook-250k-cmo-vs-ai-cmo` (signature-series)"),
 * which is internal shorthand no client should be shown, let alone as the name
 * of their post. The post's hook is the thing the client actually recognises.
 *
 * Null when there is nothing quotable, which is the caller's signal to keep the
 * dated family noun rather than print a bare prefix.
 */
export function deliverableTitle(args: { noun: string; body?: string | null }): string | null {
  const subject = topicPhrase(args.body ?? "");
  return subject ? `${args.noun} · ${subject}` : null;
}

/**
 * True when the stored title was written by the ingestion titler
 * (asset-titles.ts) rather than defaulted to the agent's name. Surfaces that
 * compose a display name from content (draftsDisplayTitle below) step aside
 * for it: the generated title read the WHOLE deliverable and named its topic,
 * where the composer can only quote the first post's opening words.
 */
export function hasGeneratedTitle(asset: { meta?: Record<string, unknown> | null }): boolean {
  return asset.meta?.titleGenerated === true;
}

/**
 * The display name for a WHOLE X or LinkedIn deliverable, or null when the
 * content is not one of those (the caller then keeps the stored title).
 *
 * ONE function, called by every surface that names this asset — the agent
 * page's archive rows and the modal those rows open. They used to disagree:
 * the row composed a client-safe name while the modal printed the raw stored
 * title, which for every agent-service delivery is just the agent's name, so
 * clicking "X post · <subject>" opened a panel headed "X Agent".
 *
 * It carries NO date. The surfaces that show these titles already stamp the row
 * with a relative time, and a second date inside the name was the reason the
 * old rows read as bookkeeping rather than as posts.
 */
export function draftsDisplayTitle(content: string | null | undefined): string | null {
  const raw = content ?? "";
  if (!raw.trim()) return null;

  // SAME ORDER AS THE MODAL'S OWN SNIFFS (asset-detail-modal): LinkedIn, then
  // Reddit, then X. The three shapes are deliberately distinct, but the order
  // is what guarantees that this function and the reader mounted underneath it
  // can never decide a deliverable is two different products.
  const li = parseLiDrafts(raw);
  if (li) {
    const drafts = li.accounts.flatMap((account) => account.drafts);
    return composed("LinkedIn post", "LinkedIn drafts", drafts[0]?.text, drafts.length);
  }

  if (isRedditV2Envelope(raw) || raw.includes("# Reddit answer drafts")) {
    const reddit = parseRedditDrafts(raw);
    if (reddit) {
      const drafts = reddit.accounts.flatMap((account) => account.drafts);
      const first = drafts[0];
      // A Reddit reply is identified by the THREAD it answers, not by its own
      // opening words: the client is deciding whether to go and post it into
      // that conversation, and "r/SaaS" plus the thread's title is how they
      // recognise it. The reply's own text is the last resort.
      const thread = first?.threadTitle?.trim();
      const subject = thread || first?.text;
      const noun = first?.subreddit?.trim()
        ? `Reddit reply · ${first.subreddit.trim()}`
        : "Reddit reply";
      return composed(noun, "Reddit replies", subject, drafts.length);
    }
  }

  const x = parseXDrafts(raw);
  if (x) {
    const drafts = x.accounts.flatMap((account) => account.drafts);
    const first = drafts[0];
    // One draft is one AVENUE block, which may hold a thread. "X post" over
    // five tweets undercounts it, and the reader this title opens already calls
    // that a thread.
    const noun = (first?.posts.length ?? 0) > 1 ? "X thread" : "X post";
    return composed(noun, "X drafts", first?.posts[0]?.text, drafts.length);
  }

  return null;
}

/**
 * `<singular> · <subject>` for a one-post delivery, `<plural> · <subject> +N
 * more` for one holding several.
 *
 * A multi-draft delivery still gets a SUBJECT rather than a bare noun and a
 * date: a client running an agent several times a day needs to tell one row
 * from another, and "X drafts · 4 Aug" is the generic name that made that
 * impossible. The count keeps it honest about how many are inside, so the row
 * cannot promise one post and open onto ten.
 */
function composed(
  singular: string,
  plural: string,
  body: string | null | undefined,
  count: number,
): string | null {
  if (count <= 0) return null;
  const subject = topicPhrase(body ?? "");
  if (count === 1) return subject ? `${singular} · ${subject}` : singular;
  const rest = count - 1;
  return subject ? `${plural} · ${subject} +${rest} more` : `${plural} · ${count} drafts`;
}
