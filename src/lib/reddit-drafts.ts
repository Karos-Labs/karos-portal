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
 * Pulls the subreddits out of whatever the client typed, as normalized "r/name"
 * entries, deduplicated case-insensitively.
 *
 * People do not type clean lists. The off-limits box in particular invites an
 * explanation ("r/SEO and r/marketing, we got banned in both"), so this reads
 * every `r/<name>` token anywhere in the text rather than requiring each
 * comma-separated piece to be nothing but a name — that earlier rule silently
 * discarded any annotated answer, and callers that treat an empty result as
 * "the client cleared this" would then delete a binding list.
 *
 * Only when no `r/` token appears at all does it fall back to treating the text
 * as bare comma / newline separated names, so "SaaS, marketing" still works
 * while "anywhere political" correctly yields nothing and the caller can ask.
 */
export function parseSubredditList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (name: string): void => {
    if (!/^[A-Za-z0-9_]{2,30}$/.test(name)) return;
    const key = name.toLowerCase();
    if (seen.has(key) || out.length >= MAX_SUBREDDITS) return;
    seen.add(key);
    out.push(`r/${name}`);
  };

  // Any r/<name>, including inside a full URL and regardless of surrounding
  // words or punctuation.
  const tokens = raw.matchAll(/(?:^|[^A-Za-z0-9_])r\/([A-Za-z0-9_]{2,30})/gi);
  for (const token of tokens) push(token[1]);
  if (out.length > 0) return out;

  // No r/ token anywhere: treat it as a plain list of names.
  for (const piece of raw.split(/[\n,;]/)) {
    const name = piece.trim().replace(/\/+$/, "");
    if (name) push(name);
  }
  return out;
}

/**
 * The case-insensitive key a subreddit aggregates under. Subreddit names are
 * case-insensitive on Reddit but arrive as free text, so "r/SaaS" and "r/saas"
 * must land in the same bucket — otherwise a per-subreddit rule that counts
 * outcomes silently splits its tally and never fires.
 */
export function subredditKey(subreddit: string): string {
  return subreddit.trim().replace(/^\/?r\//i, "").toLowerCase();
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
  /**
   * v2 only — the TWO ways the run wrote this reply, in positional order
   * (`approach-1` is the run's `a<nn>-v1`).
   *
   * The reason v2 drafts two at all is economic: finding a thread costs ten to
   * fifteen politely paced Reddit requests, while writing a second reply to a
   * thread already found costs one model call. So the second is nearly free, and
   * WHICH ONE THE CLIENT KEEPS PICKING is the cheapest voice signal available —
   * they had to choose something anyway.
   *
   * Absent on every v1 draft, where `text` is the only reply. When present,
   * `text` holds the first approach so the existing render path still works.
   */
  approaches?: Array<{ id: "approach-1" | "approach-2"; text: string }>;
  /**
   * v2 only — this subreddit BANS AI-written comments, so the reply must be
   * rewritten in the client's own words before it goes anywhere.
   *
   * Rendered as a demand, not a suggestion. In the reference client's roster
   * three of six subreddits ban it and two of those ban permanently, and the
   * consequence of ignoring it is the account, not the comment.
   */
  rewriteRequired?: boolean;
  /** v2 only — the account is at or below the karma/age this subreddit requires. */
  karmaWarning?: string;
  /** v2 only — which approach the run would pick, when `about.txt` says so. */
  recommendedApproach?: "approach-1" | "approach-2";
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
  /**
   * v2 only — how the run ended. Four outcomes, and three of them are NOT errors:
   *
   *  - `delivered`      replies passed every gate and are here
   *  - `held`           nothing was worth this account's name. A correct outcome:
   *                     on Reddit a weak reply costs credibility and sometimes the
   *                     account, so silence is the better product
   *  - `blocked_intake` the client has not nominated a Reddit account yet
   *  - `degraded`       WE could not read Reddit
   *
   * The last one is the reason this field exists at all. Reddit blocks datacenter
   * addresses, so a run from normal cloud infrastructure reads nothing — and
   * showing that as `held` would tell a client their niche had no good threads
   * when the truth is our search never came back. Blaming a client's market for
   * our outage is the specific failure this distinction prevents.
   */
  outcome?: "delivered" | "held" | "blocked_intake" | "degraded";
  /** v2 only — threads the run looked at and passed over, so a thin batch explains itself. */
  consideredCount?: number;
  /** v2 only — why the run held or degraded, in the client's language. */
  outcomeNote?: string;
}

/* ─────────────────── the v2 delivery envelope (one contract) ─────────────────── */

/**
 * What the webhook stores as `asset.content` for a Reddit v2 delivery.
 *
 * WHY AN ENVELOPE AND NOT MARKDOWN. v2 does not write one document. It writes a
 * folder per thread — `client/<nn>-answer/{approach-1.md,approach-2.md,about.txt}`
 * — and the reader is handed a single string (`parseRedditDrafts(asset.content)`),
 * with `asset.meta.artifacts` carrying file names and URLs but no contents. So
 * something has to flatten the folders, and the only place holding the file bytes
 * is the delivery handler, which already fetched them to pick its primary text.
 *
 * JSON rather than a synthesized markdown document, because a round-trip through
 * prose is where structure goes to die: two approaches per thread, a boolean
 * rewrite demand and an outcome enum would each need a marker to write and a
 * regex to read, and every one of those is a place for the two sides to drift.
 *
 * THE TYPE IS DEFINED HERE, in the module the READER imports, and the webhook
 * imports it from here too. One declaration, so a field the writer adds is a
 * field the reader compiles against.
 */
export const REDDIT_V2_ENVELOPE_KIND = "reddit-drafts-v2" as const;

export interface RedditV2Thread {
  /** The run's own folder name, e.g. "01-answer" — the join key to the artifacts. */
  folder: string;
  threadTitle?: string;
  threadUrl?: string;
  subreddit?: string;
  verdict?: "value-only" | "mention-ok";
  verdictNote?: string;
  posted?: string;
  whyThread?: string;
  whySafe?: string;
  disclosure?: string;
  rewriteRequired?: boolean;
  karmaWarning?: string;
  /** Which approach the run would pick, when `about.txt` says. */
  recommended?: "approach-1" | "approach-2";
  approaches: Array<{ id: "approach-1" | "approach-2"; text: string }>;
}

export interface RedditV2Envelope {
  kind: typeof REDDIT_V2_ENVELOPE_KIND;
  outcome: "delivered" | "held" | "blocked_intake" | "degraded";
  /** The account this run drafted as, e.g. "u/acme-dev". */
  account?: string;
  mode?: "warming" | "established";
  consideredCount?: number;
  outcomeNote?: string;
  threads: RedditV2Thread[];
}

/** Is this asset content a v2 envelope? Cheap enough to run before parsing. */
export function isRedditV2Envelope(content: string): boolean {
  const head = content.trimStart().slice(0, 200);
  return head.startsWith("{") && head.includes(REDDIT_V2_ENVELOPE_KIND);
}

/**
 * The envelope as the reader's batch shape.
 *
 * Maps onto the SAME `RedditParsedBatch` the v1 markdown parser produces, so the
 * review component has one shape to render and the v2 work is additive rather
 * than a second component. `text` carries the first approach so every existing
 * render path keeps working; `approaches` is what the toggle reads.
 */
function envelopeToBatch(env: RedditV2Envelope): RedditParsedBatch | null {
  const drafts: RedditParsedDraft[] = env.threads.map((t, i) => {
    const approaches = (t.approaches ?? []).filter((a) => a.text?.trim());
    return {
      formula: `Thread ${i + 1}${t.subreddit ? ` · ${t.subreddit}` : ""}`,
      text: approaches[0]?.text ?? "",
      ...(approaches.length > 0 ? { approaches } : {}),
      ...(t.threadTitle ? { threadTitle: t.threadTitle } : {}),
      ...(t.threadUrl ? { threadUrl: t.threadUrl } : {}),
      ...(t.subreddit ? { subreddit: t.subreddit } : {}),
      ...(t.verdict ? { verdict: t.verdict } : {}),
      ...(t.verdictNote ? { verdictNote: t.verdictNote } : {}),
      ...(t.posted ? { posted: t.posted } : {}),
      ...(t.whyThread ? { whyThread: t.whyThread } : {}),
      ...(t.whySafe ? { whySafe: t.whySafe } : {}),
      ...(t.disclosure ? { disclosure: t.disclosure } : {}),
      ...(t.rewriteRequired ? { rewriteRequired: true } : {}),
      ...(t.karmaWarning ? { karmaWarning: t.karmaWarning } : {}),
      ...(t.recommended ? { recommendedApproach: t.recommended } : {}),
      meta: [],
    };
  });
  // An envelope with no drafts is still worth returning when it EXPLAINS itself:
  // "we could not read Reddit" and "nothing was worth your account's name" are
  // both things the client needs to see, and returning null here would collapse
  // them into plain text with no distinction between them.
  const hasSomethingToSay = drafts.some((d) => d.text.trim()) || env.outcome !== "delivered";
  if (!hasSomethingToSay) return null;
  return {
    accounts: [
      {
        title: env.account ?? "Your Reddit account",
        ...(env.account ? { handle: env.account } : {}),
        ...(env.mode ? { mode: env.mode } : {}),
        drafts: drafts.filter((d) => d.text.trim()),
      },
    ],
    outcome: env.outcome,
    ...(env.consideredCount !== undefined ? { consideredCount: env.consideredCount } : {}),
    ...(env.outcomeNote ? { outcomeNote: env.outcomeNote } : {}),
  };
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

export function parseRedditDrafts(content: string): RedditParsedBatch | null {
  // v2 first: a JSON envelope assembled by the delivery handler from the run's
  // per-thread folders.
  if (isRedditV2Envelope(content)) {
    try {
      const parsed = JSON.parse(content) as RedditV2Envelope;
      if (parsed?.kind !== REDDIT_V2_ENVELOPE_KIND || !Array.isArray(parsed.threads)) return null;
      return envelopeToBatch(parsed);
    } catch {
      // Malformed envelope: fall through to the markdown path, then to plain
      // text. A parse error must not blank a deliverable the client can still
      // read as text.
    }
  }
  return parseRedditDraftsMarkdown(content);
}

/**
 * The v1 markdown parser, KEPT rather than replaced.
 *
 * The spec said to abandon the DRAFTS.md expectation, and for new deliveries it
 * is abandoned — nothing writes that shape any more. But assets already in a
 * client's archive still hold it, and a reader that only understands the new
 * envelope would render every one of them as plain text: the pick/skip actions
 * gone, the thread links gone, on work a client may still be part-way through.
 * Deleting the old path is a migration nobody asked for; keeping it costs one
 * function.
 */
export function parseRedditDraftsMarkdown(markdown: string): RedditParsedBatch | null {
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
