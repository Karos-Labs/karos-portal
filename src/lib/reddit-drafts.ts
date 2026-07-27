/**
 * Parser for the Reddit agent's drafts deliverable (structure pinned in the
 * agent instructions — see docs/reddit-agent-portal.md): a "# Reddit answer
 * drafts" title, "## Account N · <name>" sections, "### Draft N · <formula>"
 * blocks, the reply text as a "> " blockquote, an optional `NNN chars` line,
 * and "- **" meta bullets (Thread / Subreddit / Thread posted / Why this
 * thread / Disclosure / Why this is safe here / Gates / Source).
 *
 * Reddit's deliverable differs from X's and LinkedIn's in a way the reader
 * depends on: every draft is a REPLY TO AN EXISTING THREAD, so each draft
 * carries the target thread's title and URL, the subreddit, and that
 * subreddit's promo verdict. The hand-off opens that thread — there is no
 * compose deep link, because a reply is typed in the thread itself.
 *
 * Pure and client-safe; returns null when the shape isn't there so callers
 * fall back to plain text. The intake normalizers live here for the same
 * reason: a "use server" module may only export async functions, so the pure
 * Reddit helpers all sit in this one testable, importable place.
 *
 * The h1 marker is distinct from LinkedIn's ("# LinkedIn drafts") and from
 * X's ("# Account " at h1) so no sniff can claim another agent's batch. The
 * h2 account headings DO contain X's "# Account " substring, so this format
 * must be sniffed BEFORE X — see the ordered chain in asset-card.tsx.
 */

/** Reddit's comment cap. */
export const REDDIT_COMMENT_CAP = 10_000;

/** Most subreddits we keep from one pasted list. */
const MAX_SUBREDDITS = 30;

/**
 * Normalizes a Reddit account identity to "u/name"; empty / "none" / "pending"
 * stays null (no account nominated yet — the agent then drafts in warming mode
 * and nothing can be posted). Accepts "u/name", "/u/name", "@name", a bare
 * name, or a pasted reddit.com/user/name URL.
 *
 * Reddit usernames are 3-20 characters of letters, digits, underscore and
 * hyphen. Rejecting a malformed one matters: the handle is what the drafts are
 * attributed to, and a wrong one attributes a client's answers to a stranger.
 *
 * Lives here rather than beside the action that calls it because a "use server"
 * module may only export async functions — the same reason the thread-URL
 * parser below is here.
 */
export function parseRedditUsername(raw: string): string | null | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed || /^(none|none yet|pending)$/i.test(trimmed)) return null;
  let name = trimmed;
  const fromUrl = trimmed.match(/reddit\.com\/(?:u|user)\/([^/?#\s]+)/i);
  if (fromUrl) name = fromUrl[1];
  else name = name.replace(/^\/?(?:u\/|@)/i, "");
  name = name.replace(/\/+$/, "");
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) {
    return {
      error:
        "That does not look like a Reddit username. Use the account name, like u/your-name (3 to 20 letters, numbers, hyphens or underscores).",
    };
  }
  return `u/${name}`;
}

/**
 * Splits a comma / newline separated subreddit list into normalized "r/name"
 * entries, deduplicated. Tolerates "r/x", "/r/x", bare "x" and full URLs
 * because clients paste all four. Unparseable pieces are dropped rather than
 * failing the whole save — a stray line should not block the form.
 */
export function parseSubredditList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/[\n,]/)) {
    let name = piece.trim();
    if (!name) continue;
    const fromUrl = name.match(/reddit\.com\/r\/([^/?#\s]+)/i);
    name = (fromUrl ? fromUrl[1] : name.replace(/^\/?r\//i, "")).replace(/\/+$/, "");
    if (!/^[A-Za-z0-9_]{2,30}$/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`r/${name}`);
    if (out.length >= MAX_SUBREDDITS) break;
  }
  return out;
}

export interface RedditParsedDraft {
  /** e.g. "Draft 1 · Thorough value answer". */
  formula: string;
  /** The italic note under the heading. */
  laneNote?: string;
  /** The reply text to post as a comment. */
  text: string;
  /** "742 chars" style note when present. */
  chars?: string;
  /** The target thread's title. */
  threadTitle?: string;
  /** The target thread's URL, validated to a reddit.com host. */
  threadUrl?: string;
  /** e.g. "r/SaaS". */
  subreddit?: string;
  /**
   * The subreddit's promo verdict, normalized: "value-only" (never mention
   * the product) or "mention-ok" (a disclosed mention is allowed). Undefined
   * when the bullet names no verdict — the reader then shows no badge rather
   * than guessing the permissive one.
   */
  verdict?: "value-only" | "mention-ok";
  /** The verdict text as written, for the tooltip. */
  verdictNote?: string;
  /** When the thread was posted / how fresh it is. */
  posted?: string;
  /** Why this thread is worth answering — the whitespace this reply fills. */
  whyThread?: string;
  /** The disclosure line to include, when the draft carries a mention. */
  disclosure?: string;
  /** The "why this is safe here" note. */
  whySafe?: string;
  /** The gate results line. */
  gates?: string;
  /** Every meta bullet, markdown bold stripped, for display. */
  meta: string[];
}

export interface RedditParsedAccount {
  /** e.g. "Karos Labs — company account (u/karos-al) · warming". */
  title: string;
  /** The italic account note under the heading. */
  note?: string;
  /** The u/handle parsed out of the title, when present. */
  handle?: string;
  /**
   * Program mode parsed out of the title. Warming = pure-value answers only,
   * no product mentions, until the account has genuine history.
   */
  mode?: "warming" | "established";
  drafts: RedditParsedDraft[];
}

export interface RedditParsedBatch {
  accounts: RedditParsedAccount[];
}

const stripBold = (s: string) => s.replace(/\*\*/g, "");

/**
 * A reddit.com thread URL, normalized — or null.
 *
 * The URL arrives from model output and the reader opens it in a new tab, so
 * the host is checked rather than trusted: anything not on reddit.com yields
 * null and the reader shows no link. Query and fragment are dropped (a
 * tracking suffix on a client deliverable is noise), and the path is kept as
 * written so both /r/<sub>/comments/<id>/<slug> and a share link resolve.
 */
export function parseRedditThreadUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return null;
  // Normalize old./new./sh. hosts to the canonical one so the link opens the
  // same place the agent read, and a logged-in client lands on their own UI.
  return `https://www.reddit.com${url.pathname.replace(/\/+$/, "")}`;
}

/** The first markdown link's [text](url) pair, else the first bare URL. */
function linkParts(meta: string): { text?: string; url?: string } {
  const md = meta.match(/\[([^\]]+)\]\(([^)]+)\)/);
  if (md) return { text: md[1].trim(), url: md[2].trim() };
  const bare = meta.match(/https?:\/\/\S+/);
  return bare ? { url: bare[0] } : {};
}

/** "r/SaaS — mention-ok when relevant" → subreddit + normalized verdict. */
function parseSubreddit(value: string): {
  subreddit?: string;
  verdict?: "value-only" | "mention-ok";
  verdictNote?: string;
} {
  const out: ReturnType<typeof parseSubreddit> = {};
  const sub = value.match(/\br\/([A-Za-z0-9_]{1,30})\b/);
  if (sub) out.subreddit = `r/${sub[1]}`;
  // Strip the subreddit name before reading the verdict so a sub literally
  // named something like r/valueonly cannot masquerade as a verdict.
  const rest = (sub ? value.replace(sub[0], " ") : value).toLowerCase();
  // value-only is tested first: "value-only, never mention" contains "mention".
  if (/value[\s-]*only|no mention|never mention/.test(rest)) out.verdict = "value-only";
  else if (/mention[\s-]*ok|mention allowed|mention when relevant/.test(rest)) out.verdict = "mention-ok";
  const note = value.replace(/^r\/[A-Za-z0-9_]{1,30}\s*[—–-]?\s*/, "").trim();
  if (note) out.verdictNote = note;
  return out;
}

/** Pulls the u/handle and program mode out of an account section title. */
function parseAccountTitle(title: string): { handle?: string; mode?: "warming" | "established" } {
  const out: { handle?: string; mode?: "warming" | "established" } = {};
  const handle = title.match(/\bu\/([A-Za-z0-9_-]{1,20})\b/);
  if (handle) out.handle = `u/${handle[1]}`;
  const lower = title.toLowerCase();
  if (/\bwarming\b/.test(lower)) out.mode = "warming";
  else if (/\bestablished\b/.test(lower)) out.mode = "established";
  return out;
}

/** Meta bullet label → the draft field it fills. */
function applyMetaBullet(draft: RedditParsedDraft, label: string, value: string): void {
  const key = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (key === "thread") {
    const { text, url } = linkParts(value);
    if (text && !draft.threadTitle) draft.threadTitle = text;
    if (url && !draft.threadUrl) {
      const clean = parseRedditThreadUrl(url);
      if (clean) draft.threadUrl = clean;
    }
    // A "Thread:" bullet with no link still names the thread.
    if (!draft.threadTitle && !text && value.trim() && !url) draft.threadTitle = value.trim();
    return;
  }
  if (key === "url" || key === "thread url") {
    if (!draft.threadUrl) {
      const clean = parseRedditThreadUrl(linkParts(value).url ?? value);
      if (clean) draft.threadUrl = clean;
    }
    return;
  }
  if (key === "subreddit") {
    const parsed = parseSubreddit(value);
    if (parsed.subreddit && !draft.subreddit) draft.subreddit = parsed.subreddit;
    if (parsed.verdict && !draft.verdict) draft.verdict = parsed.verdict;
    if (parsed.verdictNote && !draft.verdictNote) draft.verdictNote = parsed.verdictNote;
    return;
  }
  if ((key === "thread posted" || key === "posted") && !draft.posted) {
    draft.posted = value;
    return;
  }
  if ((key === "why this thread" || key === "why it fits") && !draft.whyThread) {
    draft.whyThread = value;
    return;
  }
  if (key === "disclosure" && !draft.disclosure) {
    // "none needed" is a real answer, but it is not a disclosure LINE — the
    // reader must not render it as one.
    if (!/^\(?\s*(none|n\/a|not needed|none needed)\b/i.test(value)) draft.disclosure = value;
    return;
  }
  if ((key === "why this is safe here" || key === "why safe" || key === "why this is safe") && !draft.whySafe) {
    draft.whySafe = value;
    return;
  }
  if ((key === "gates" || key === "gates run") && !draft.gates) {
    draft.gates = value;
    return;
  }
}

export function parseRedditDrafts(markdown: string): RedditParsedBatch | null {
  if (!/^# Reddit answer drafts/m.test(markdown)) return null;
  const lines = markdown.split("\n");
  const accounts: RedditParsedAccount[] = [];
  let account: RedditParsedAccount | null = null;
  let draft: RedditParsedDraft | null = null;

  const flushDraft = () => {
    if (draft && account && draft.text.trim().length > 0) account.drafts.push(draft);
    draft = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const accountHead = line.match(/^## Account \d+\s*·\s*(.+)$/);
    if (accountHead) {
      flushDraft();
      const title = stripBold(accountHead[1]).trim();
      account = { title, drafts: [], ...parseAccountTitle(title) };
      accounts.push(account);
      continue;
    }

    const draftHead = line.match(/^### (.+)$/);
    if (draftHead && account) {
      flushDraft();
      draft = { formula: stripBold(draftHead[1]).trim(), text: "", meta: [] };
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

    // Italic note directly under an account or draft heading.
    const italic = line.match(/^\*([^*].*)\*$/);
    if (italic) {
      const text = italic[1].trim();
      if (draft && !draft.laneNote && draft.text.length === 0) draft.laneNote = text;
      else if (!draft && !account.note && account.drafts.length === 0) account.note = text;
      continue;
    }

    // A blockquote group = the reply text.
    if (/^>\s?/.test(line) && draft) {
      const reply: string[] = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j])) {
        reply.push(lines[j].replace(/^>\s?/, ""));
        j++;
      }
      i = j - 1;
      const text = stripBold(reply.join("\n")).trim();
      draft.text = draft.text ? `${draft.text}\n\n${text}` : text;
      continue;
    }

    // `NNN chars` note (tolerates a "/ 10,000" suffix).
    const chars = line.match(/`(\d+(?:[,.]\d{3})?)\s*(?:\/\s*10[,.]?000)?\s*chars?`/);
    if (chars && draft && !draft.chars) {
      draft.chars = `${chars[1].replace(/[,.]/g, "")} chars`;
      continue;
    }

    // Meta bullets. Thread/Subreddit/etc. are read BEFORE the reply text
    // exists too: the pinned structure puts the thread bullets above the
    // blockquote (you need to know the thread before reading the reply).
    if (/^-\s+/.test(line) && draft) {
      const meta = stripBold(line.replace(/^-\s+/, "")).trim();
      const labelled = meta.match(/^([^:]{1,40}):\s*(.*)$/);
      if (labelled) applyMetaBullet(draft, labelled[1], labelled[2].trim());
      draft.meta.push(meta);
      continue;
    }
  }
  flushDraft();

  if (accounts.length === 0 || accounts.every((a) => a.drafts.length === 0)) return null;
  return { accounts };
}
