/**
 * Parser for the X agent's DRAFTS.md deliverable (structure pinned in the
 * agent instructions — see docs/x-agent-portal.md): "# Account N · <name>"
 * sections, "## Avenue N · <lane>" blocks, posts as "> " blockquotes (threads
 * carry **1/3**-style markers), a `NNN chars` line per post, and "- **" meta
 * bullets. Pure and client-safe; returns null when the shape isn't there so
 * callers can fall back to plain rendering.
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
  /** For replies: the x.com status URL this draft answers (from the meta). */
  replyToUrl?: string;
  /** For quote-comments: the x.com status URL being quoted (from the meta). */
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
      const statusUrl = meta.match(/https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+/)?.[0];
      if (statusUrl && /in reply to/i.test(meta)) draft.replyToUrl = statusUrl;
      else if (statusUrl && /quote source/i.test(meta)) draft.quoteUrl = statusUrl;
      continue;
    }
  }
  flushDraft();

  if (accounts.length === 0 || accounts.every((a) => a.drafts.length === 0)) return null;
  return { accounts };
}
