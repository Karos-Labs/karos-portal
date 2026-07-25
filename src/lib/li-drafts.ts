/**
 * Parser for the LinkedIn agent's drafts deliverable (structure pinned in the
 * agent instructions — see docs/linkedin-agent-portal.md): a "# LinkedIn
 * drafts" title, "## Account N · <name>" sections, "### Post N · <lane>"
 * blocks, the post text as "> " blockquotes, a `NNN chars` line per post, and
 * "- **" meta bullets (Topic / Media / Source). Media bullets name the run's
 * separate image/PDF artifacts so the reader can offer them for manual attach
 * (LinkedIn's compose deep link cannot carry files). Pure and client-safe;
 * returns null when the shape isn't there so callers fall back to plain text.
 *
 * Deliberately distinct from the X structure (h1 accounts there, h2 here) so
 * one sniff can't claim the other's batches.
 */

export interface LiParsedDraft {
  /** e.g. "Post 1 · Thought-leadership". */
  lane: string;
  /** The italic lane note under the heading. */
  laneNote?: string;
  /** The post text (the LinkedIn caption). */
  text: string;
  /** "1234 chars" style note when present. */
  chars?: string;
  /** Meta bullets (topic, sources, groundings), markdown bold stripped. */
  meta: string[];
  /** File names from the "Media:" bullet — the artifacts to attach when posting. */
  mediaNames: string[];
  /** The recommended posting window from the "Post window:" bullet. */
  postWindow?: string;
}

export interface LiParsedAccount {
  /** e.g. "Karos Labs — Company page" or "Albert Kattan (seat)". */
  title: string;
  /** The italic account note under the heading. */
  note?: string;
  drafts: LiParsedDraft[];
}

export interface LiParsedBatch {
  accounts: LiParsedAccount[];
}

const stripBold = (s: string) => s.replace(/\*\*/g, "");

export function parseLiDrafts(markdown: string): LiParsedBatch | null {
  if (!/^# LinkedIn drafts/m.test(markdown)) return null;
  const lines = markdown.split("\n");
  const accounts: LiParsedAccount[] = [];
  let account: LiParsedAccount | null = null;
  let draft: LiParsedDraft | null = null;

  const flushDraft = () => {
    if (draft && account && draft.text.trim().length > 0) account.drafts.push(draft);
    draft = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const accountHead = line.match(/^## Account \d+\s*·\s*(.+)$/);
    if (accountHead) {
      flushDraft();
      account = { title: stripBold(accountHead[1]).trim(), drafts: [] };
      accounts.push(account);
      continue;
    }

    const postHead = line.match(/^### (.+)$/);
    if (postHead && account) {
      flushDraft();
      draft = { lane: stripBold(postHead[1]).trim(), text: "", meta: [], mediaNames: [] };
      continue;
    }

    // Any other h2 (a non-account section) ends the current draft AND the
    // account scope — otherwise a trailing "## Notes" section's blockquotes
    // would surface as phantom pickable drafts.
    if (/^## /.test(line)) {
      flushDraft();
      account = null;
      continue;
    }

    if (!account) continue;

    // Italic note directly under an account or post heading.
    const italic = line.match(/^\*([^*].*)\*$/);
    if (italic) {
      const text = italic[1].trim();
      if (draft && !draft.laneNote && draft.text.length === 0) draft.laneNote = text;
      else if (!draft && !account.note && account.drafts.length === 0) account.note = text;
      continue;
    }

    // A blockquote group = the post text (LinkedIn: one caption per post).
    if (/^>\s?/.test(line) && draft) {
      const post: string[] = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j])) {
        post.push(lines[j].replace(/^>\s?/, ""));
        j++;
      }
      i = j - 1;
      const text = stripBold(post.join("\n")).trim();
      draft.text = draft.text ? `${draft.text}\n\n${text}` : text;
      continue;
    }

    // `NNN chars` note (tolerates a "/ 3000" suffix).
    const chars = line.match(/`(\d+(?:[,.]\d{3})?)\s*(?:\/\s*3[,.]?000)?\s*chars?`/);
    if (chars && draft && !draft.chars) {
      draft.chars = `${chars[1].replace(/[,.]/g, "")} chars`;
      continue;
    }

    // Meta bullets (topic, media, post window, sources).
    if (/^-\s+/.test(line) && draft && draft.text.length > 0) {
      const meta = stripBold(line.replace(/^-\s+/, "")).trim();
      const media = meta.match(/^Media:\s*(.+)$/i);
      if (media) {
        draft.mediaNames = media[1]
          .split(/\s*[·,]\s*/)
          .map((n) => n.trim())
          .filter(Boolean);
      }
      const window = meta.match(/^Post window:\s*(.+)$/i);
      if (window && !draft.postWindow) draft.postWindow = window[1].trim();
      draft.meta.push(meta);
      continue;
    }
  }
  flushDraft();

  if (accounts.length === 0 || accounts.every((a) => a.drafts.length === 0)) return null;
  return { accounts };
}
