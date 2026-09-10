/**
 * Parser for the X agent's DRAFTS.md deliverable (structure pinned in the
 * agent instructions — see docs/x-agent-portal.md): "# Account N · <name>"
 * sections, "## Avenue N · <lane>" blocks, posts as "> " blockquotes (threads
 * carry **1/3**-style markers), a `NNN chars` line per post, and "- **" meta
 * bullets. Pure and client-safe; returns null when the shape isn't there so
 * callers can fall back to plain rendering.
 *
 * The compose deep link lives here too: a client component cannot be imported
 * by a test (its server-action import pulls in the Admin SDK), and the reply
 * addressing is the part worth pinning down.
 */

import { isInternalLine } from "@/lib/doc-render";

export interface XParsedPost {
  text: string;
  /** Thread position marker, e.g. "1/3". */
  marker?: string;
  /** "256 chars" style note when present. */
  chars?: string;
}

export interface XParsedDraft {
  /** e.g. "Avenue 3 · News-reaction (live)". */
  avenue: string;
  /** The italic lane note under the heading. */
  laneNote?: string;
  posts: XParsedPost[];
  /** Source / grounding bullets, markdown bold stripped. */
  meta: string[];
  /** For replies: the status URL this draft answers (from the meta). */
  replyToUrl?: string;
  /** For quote-comments: the status URL being quoted (from the meta). */
  quoteUrl?: string;
}

export interface XParsedAccount {
  /** e.g. "Company page @getkaros" or "Albert Kattan (seat 1, handle pending)". */
  title: string;
  /** The italic account note under the heading. */
  note?: string;
  drafts: XParsedDraft[];
}

export interface XParsedBatch {
  accounts: XParsedAccount[];
}

const stripBold = (s: string) => s.replace(/\*\*/g, "");

/** A single post's URL on either host — twitter.com links still resolve. */
const STATUS_URL = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/;

/**
 * A meta bullet only names a reply or quote target when it is labelled as one,
 * or says so in words. Addressing a reply at the wrong post is worse than a
 * plain unaddressed compose, so a bare URL is never treated as a target and a
 * source bullet that merely mentions a reply is not one either.
 */
const REPLY_LABEL = /^(?:in\s+)?repl(?:y|ying)(?:\s+(?:to|target|post))?$/i;
const QUOTE_LABEL = /^quot(?:e|ed|ing)(?:\s+(?:source|target|post))?$/i;
const REPLY_PHRASE = /\b(?:in reply to|replying to|reply target)\b/i;
const QUOTE_PHRASE = /\b(?:quote source|quote target|quoted post)\b/i;

/**
 * Which target, if either, a meta bullet names. BOTH labels are tested before
 * either phrase: the phrases match anywhere in the bullet, so
 * "Quote source: <url> (replying to their pricing thread)" would otherwise be
 * addressed as a reply to the very post it means to quote. A bullet with no
 * label and no phrase names nothing.
 */
function metaTarget(label: string, meta: string): "reply" | "quote" | null {
  if (REPLY_LABEL.test(label)) return "reply";
  if (QUOTE_LABEL.test(label)) return "quote";
  if (REPLY_PHRASE.test(meta)) return "reply";
  if (QUOTE_PHRASE.test(meta)) return "quote";
  return null;
}

export function parseXDrafts(markdown: string): XParsedBatch | null {
  const lines = markdown.split("\n");
  const accounts: XParsedAccount[] = [];
  let account: XParsedAccount | null = null;
  let draft: XParsedDraft | null = null;
  let pendingMarker: string | undefined;

  const flushDraft = () => {
    if (draft && account && draft.posts.length > 0) account.drafts.push(draft);
    draft = null;
    pendingMarker = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const accountHead = line.match(/^# Account \d+\s*·\s*(.+)$/);
    if (accountHead) {
      flushDraft();
      account = { title: stripBold(accountHead[1]).trim(), drafts: [] };
      accounts.push(account);
      continue;
    }

    const avenueHead = line.match(/^## (.+)$/);
    if (avenueHead && account) {
      flushDraft();
      draft = { avenue: stripBold(avenueHead[1]).trim(), posts: [], meta: [] };
      continue;
    }

    // "### ... at a glance" tables and any other h3+ end the current draft.
    if (/^###/.test(line)) {
      flushDraft();
      continue;
    }

    if (!account) continue;

    // Italic note directly under an account or avenue heading.
    //
    // Filtered HERE, in the parser, rather than at render. The readers only
    // ever put `stripInlineMarkdown` on these, which removes the marks and
    // leaves the words — so an italic line carrying the run's own bookkeeping
    // ("*status: pending_review · job e52ffe1e*", which is the same agent
    // writing the same file as the header toPlainSummary already drops)
    // reached the client intact. The parser is the one choke point every
    // consumer goes through, server-side (client-agent-rows resolving slot
    // options) and in the browser alike, so a note that is bookkeeping is
    // simply never captured. The render-side strip stays as the belt.
    const italic = line.match(/^\*([^*].*)\*$/);
    if (italic) {
      const text = italic[1].trim();
      if (isInternalLine(text)) continue;
      if (draft && !draft.laneNote && draft.posts.length === 0) draft.laneNote = text;
      else if (!draft && !account.note && account.drafts.length === 0) account.note = text;
      continue;
    }

    // Thread position marker before a blockquote, e.g. **1/3**.
    const marker = line.match(/^\*\*(\d+\s*\/\s*\d+)\*\*$/);
    if (marker) {
      pendingMarker = marker[1].replace(/\s/g, "");
      continue;
    }

    // A blockquote group = one post.
    if (/^>\s?/.test(line) && draft) {
      const post: string[] = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j])) {
        post.push(lines[j].replace(/^>\s?/, ""));
        j++;
      }
      i = j - 1;
      draft.posts.push({
        text: stripBold(post.join("\n")).trim(),
        ...(pendingMarker ? { marker: pendingMarker } : {}),
      });
      pendingMarker = undefined;
      continue;
    }

    // `NNN chars` note — attach to the latest post without one.
    const chars = line.match(/`(\d+)\s*(?:\/\s*280)?\s*chars?`/);
    if (chars && draft) {
      const open = draft.posts.find((p) => !p.chars);
      if (open) open.chars = `${chars[1]} chars`;
      continue;
    }

    // Meta bullets (sources, groundings). Reply/quote targets also become
    // deep-link fields so the reader can open X compose pre-addressed.
    if (/^-\s+/.test(line) && draft && draft.posts.length > 0) {
      const meta = stripBold(line.replace(/^-\s+/, "")).trim();
      draft.meta.push(meta);
      const statusUrl = meta.match(STATUS_URL)?.[0];
      if (statusUrl) {
        const label = meta.match(/^([^:]{1,40}):/)?.[1].trim() ?? "";
        const target = metaTarget(label, meta);
        if (target === "reply" && !draft.replyToUrl) draft.replyToUrl = statusUrl;
        if (target === "quote" && !draft.quoteUrl) draft.quoteUrl = statusUrl;
      }
      continue;
    }
  }
  flushDraft();

  if (accounts.length === 0 || accounts.every((a) => a.drafts.length === 0)) return null;
  return { accounts };
}

/**
 * X compose deep link: text pre-filled, replies addressed, quotes attached.
 * The intent has used both `in_reply_to` and `in_reply_to_status_id` for the
 * target post and nobody has live-verified which one x.com/intent/post reads
 * today, so both carry the same id — whichever it honours, the reply lands on
 * the right post.
 */
export function xIntentUrl(draft: XParsedDraft, text: string): string {
  const params = new URLSearchParams();
  params.set("text", draft.quoteUrl ? `${text}\n\n${draft.quoteUrl}` : text);
  const replyId = draft.replyToUrl?.match(/status\/(\d+)/)?.[1];
  if (replyId) {
    params.set("in_reply_to", replyId);
    params.set("in_reply_to_status_id", replyId);
  }
  return `https://x.com/intent/post?${params.toString()}`;
}
