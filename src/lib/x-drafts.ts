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
import { splitMetaLinks } from "@/lib/draft-meta";

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

/**
 * Reply/quote WORDING as a bullet's own LABEL, deliberately broader than the
 * target labels above and used for the opposite purpose: those decide what may
 * be ADDRESSED, this decides what must NOT be printed as an address.
 *
 * "First reply" and "Reply URL" are the two the agent actually writes and
 * neither is a target label — in a thread "first reply" names the draft's own
 * second post, not somebody else's. Widening REPLY_LABEL to catch them would
 * aim a client's reply at whatever URL followed, which is the one failure this
 * module is written to avoid.
 *
 * ANCHORED: the label must BE a reply or quote reference, not merely contain
 * the word. "Quote of the week", "Reply rate" and "Replies to date" are
 * ordinary labels over ordinary links, and swapping them for "Source" would
 * destroy a bullet's only descriptive words to fix a different bullet's lie.
 */
const TARGET_LABEL =
  /^(?:the\s+)?(?:(?:first|next|second|last|final)\s+)?(?:in\s+)?(?:repl(?:y|ies|ying)|quot(?:e|ed|ing))(?:\s+(?:to|target|post|source|url|link))?$/i;

/**
 * The same wording as a bullet's LEAD-IN, and only where it stands directly in
 * front of the link ("replying to <url>", "First reply — <url>") — the one
 * position in which it reads as that link's title rather than as a sentence.
 *
 * Anchored, and lookahead-guarded, on purpose. Removing the wording wherever it
 * appeared cut the verb out of honest sentences: "Angle: what to say when
 * replying to critics, per <url>" came back as "…when critics, per <url>" and
 * stopped meaning anything. The agent's prose about the draft is client copy
 * and is left alone; only a lead-in between the reader and the link may go.
 */
const TARGET_LEAD_IN =
  /^(?:the\s+)?(?:(?:first|next|second|last|final)\s+)?(?:in\s+)?(?:repl(?:y|ies|ying)|quot(?:e|ed|ing))(?:\s+(?:to|target|post|source|url|link))?\b[\s:.,—–-]*(?=https?:\/\/)/i;

/**
 * The bullet's own leading label, e.g. "First reply" in "First reply: <url>".
 *
 * A URL's scheme is not a label, so a colon followed by "//" does not end one —
 * without that, "replying to https://…" reads as a label of "replying to https"
 * and dropping it would take the scheme off the link with it.
 */
const META_LABEL = /^([^:]{1,40}):(?!\/\/)/;

/** One meta bullet, told apart by what its URL actually is. */
export interface XMetaBullet {
  /**
   * The words to print. Identical to the bullet as parsed, EXCEPT when `label`
   * is set — then the misleading label or lead-in has been taken out of it.
   */
  text: string;
  /**
   * - `reply-target` / `quote-target`: an X status URL this draft addresses;
   * - `source`: any other URL — something to read, never a target;
   * - `note`: no URL at all.
   */
  kind: "reply-target" | "quote-target" | "source" | "note";
  /** The bullet's URL, when it carries one. */
  url?: string;
  /**
   * What the reader must print in front of the bullet INSTEAD of its own
   * label. Set only when that label (or lead-in) claims a reply or quote target
   * the URL cannot be — so a bullet that keeps a label of its own never gets a
   * second one printed over it.
   */
  label?: string;
}

/**
 * How a meta bullet may be shown.
 *
 * THE RULE THIS EXISTS FOR: a bullet labelled "First reply" carrying a page
 * that is not an X post reads, once the reader links it, as the post the draft
 * answers — a client was shown a Notion page that way (2026-09-15). Only an
 * x.com/twitter.com STATUS url can be a reply or quote target; anything else is
 * a source, and the wording that claimed otherwise is dropped rather than the
 * bullet, so the link a client may want to read survives as "Source: <link>".
 *
 * TWO LIMITS, both of them about not damaging honest copy. The claim is judged
 * against the URL it actually governs — the first one after the label — so a
 * bullet naming a real X post further along ("…, quoted from <x link>") cannot
 * buy the link under its reply label a pass. And the only words that may be
 * taken off are the bullet's own leading claim: its label, or a lead-in
 * standing in front of the link. Reply wording anywhere else is the agent
 * describing the draft, and it stays exactly as written.
 *
 * Pure, so the reader component (which cannot be imported by a test — its
 * server-action import pulls in the Admin SDK) is left with nothing to decide.
 */
export function classifyXMetaBullet(meta: string): XMetaBullet {
  const text = stripBold(meta).trim();
  const url = splitMetaLinks(text).find((seg) => seg.href)?.href;
  if (!url) return { text, kind: "note" };

  const labelMatch = text.match(META_LABEL);
  const label = labelMatch?.[1].trim() ?? "";
  const body = labelMatch ? text.slice(labelMatch[0].length).trim() : text;
  const governed = splitMetaLinks(body).find((seg) => seg.href)?.href ?? url;

  if (STATUS_URL.test(governed)) {
    // A real X post: the existing label/phrase rules decide, and a bullet that
    // names one keeps its own words — they are true.
    const target = metaTarget(label, text);
    if (target === "reply") return { text, kind: "reply-target", url: governed };
    if (target === "quote") return { text, kind: "quote-target", url: governed };
    return { text, kind: "source", url: governed };
  }

  // Not an X post, so nothing here may be shown as a target. The label goes
  // when the label is what claimed it; otherwise a lead-in goes, but only when
  // the bullet had no label of its own to keep.
  if (TARGET_LABEL.test(label)) {
    const rest = body.replace(TARGET_LEAD_IN, "").trim();
    return { text: rest || governed, kind: "source", url: governed, label: "Source" };
  }
  if (!label) {
    const rest = text.replace(TARGET_LEAD_IN, "").trim();
    if (rest !== text) return { text: rest || governed, kind: "source", url: governed, label: "Source" };
  }
  return { text, kind: "source", url: governed };
}

/**
 * The engine's `meta.thread` for an X asset, as post texts.
 *
 * The field is the agent-engine deliverable's own (materializeXPost carries it
 * across verbatim) and its element shape is NOT pinned in this repo, so plain
 * strings and `{ text }` / `{ post }` objects are read and anything else is
 * ignored rather than guessed at.
 *
 * Each part is de-marked exactly as a post parsed out of the markdown is
 * (`stripBold`, trimmed) — that parity is the point. These render beside those
 * posts and the clipboard hands them to X, where a literal `**` is two
 * asterisks in the client's post and a leading space is an indent.
 */
export function xThreadParts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const parts: string[] = [];
  for (const entry of value) {
    const raw =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? ["text", "post"]
              .map((k) => (entry as Record<string, unknown>)[k])
              .find((v): v is string => typeof v === "string")
          : undefined;
    const text = raw ? stripBold(raw).trim() : "";
    if (text) parts.push(text);
  }
  return parts;
}

/** Case, punctuation, quote and dash shape folded away for a body comparison. */
const foldPost = (s: string) =>
  stripBold(s)
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[\s.,;:!?"'\u2026-]+$/, "");

/**
 * The tail one copy of a post may have gained and still be that post: spacing,
 * punctuation, hashtags, links. Anything a reader would call a sentence is not
 * drift — it is a different post.
 */
const DRIFT_TAIL = /^[\s.,;:!?"'\u2026-]*(?:(?:#\S+|https?:\/\/\S+)[\s.,;:!?"'\u2026-]*)*$/;

/**
 * Two parts that read as the same post.
 *
 * Not string equality. The markdown's opener and the engine's own copy of it
 * drift — bold, a full stop, an appended hashtag or link, a dash normalized on
 * one side — and any difference that survives this comparison puts the opener
 * on the card twice, once as the post and once as "Reply 1". So the shapes are
 * folded away, and one body may carry a tail the other does not.
 *
 * WHAT THE TAIL MAY BE is the whole guard, because the mistake in the other
 * direction is worse: a genuine reply that opens by echoing the post would be
 * swallowed and the client would never see it. A duplicate is visible; a
 * missing reply is not. So the tail must be nothing a reader would read (and
 * the shared run must be a post's worth of text, not a stub) — a sentence
 * after the shared words means the two are different posts.
 */
function sameBody(a: string, b: string): boolean {
  const x = foldPost(a);
  const y = foldPost(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 16 && long.startsWith(short) && DRIFT_TAIL.test(long.slice(short.length));
}

/**
 * The replies in an engine thread, given the post already on the card.
 *
 * A thread is ONE post with its replies, so the first part is dropped when it
 * is that post restated (the engine sends the whole chain, the markdown holds
 * the opener) — otherwise every part is a reply and nothing is lost. Which of
 * the two `meta.thread` is has never been pinned on the engine side, which is
 * why this reads the parts rather than trusting a position.
 */
export function xThreadReplies(parts: readonly string[], mainText: string): string[] {
  const rest = parts.filter((p) => p.trim().length > 0);
  if (rest.length > 0 && sameBody(rest[0], mainText)) rest.shift();
  return rest;
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
