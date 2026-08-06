/**
 * Which of a Reddit v2 run's artifacts are DURABLE STATE, and how they map onto
 * `redditAgentState` rows.
 *
 * The same ephemeral-workspace problem `linkedin-state-capture.ts` solves, and a
 * more dangerous one. The v2 run appends to a ledger of every thread already
 * answered, a rejection blocklist, a per-account learning log and agent memory,
 * and a **dated** rules audit recording whether a product may be named in each
 * subreddit and whether AI-written comments are banned there. The runner clones
 * the lab repo fresh for every run and the container is destroyed, so all of it
 * is discarded.
 *
 * WHY THE RULES AUDIT IS THE ONE THAT MATTERS MOST. Losing a LinkedIn ledger
 * costs a repeated subject. Losing this audit means the next run holds no reading
 * at all, or worse re-reads a stale one, and names a product in a subreddit that
 * bans it — which gets the client's account banned, and Reddit bans rarely
 * reverse. The DATE is the load-bearing field: the run re-verifies a reading it
 * cannot trust, but only if it receives the date to judge.
 *
 * These are INTERNAL artifacts, so the delivery handler does not re-host them — a
 * client has no business reading a rules audit. It fetches the few named here for
 * their text alone; nothing here becomes an asset or reaches a client surface.
 *
 * Pure and dependency-free so the matching is testable without a webhook.
 */

import type { RedditAgentState } from "@/lib/types";
import {
  REDDIT_V2_ENVELOPE_KIND,
  type RedditV2Envelope,
  type RedditV2Thread,
} from "@/lib/reddit-drafts";

/** A state artifact's kind and the account it belongs to, or null if not state. */
export interface RedditStateMatch {
  kind: RedditAgentState["kind"];
  /** The account handle for a per-account file, null for a client-wide one. */
  account: string | null;
}

/**
 * The per-account files. v2 keeps one of each PER REDDIT ACCOUNT under
 * `skills/reddit-agent-v2/accounts/<handle>/`, and mixing them is a real failure
 * rather than an untidiness: one account's earned voice rules steering another
 * account's replies is exactly the "does not sound like me" the learning log
 * exists to prevent.
 */
const PER_ACCOUNT: Record<string, RedditAgentState["kind"]> = {
  "agent-memory.md": "agent-memory",
  "learning-log.md": "learning-log",
};

/** The client-wide files. */
const CLIENT_WIDE: Record<string, RedditAgentState["kind"]> = {
  "rules-audit.json": "rules-audit",
  "reddit-ledger.json": "ledger",
  "question-pools.json": "question-pools",
  "scan-config.json": "scan-config",
  "foundation.md": "foundation",
};

/**
 * The account a per-account path belongs to.
 *
 * Read from the path rather than from the run header, because the path is what
 * the file IS: `skills/reddit-agent-v2/accounts/acme_dev/learning-log.md` belongs
 * to `acme_dev` whatever the run thinks it was doing. Falls back to the segment
 * before the file name, which is the shape the contract uses.
 */
function accountFrom(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  const i = parts.lastIndexOf("accounts");
  if (i > -1 && parts.length > i + 1) return parts[i + 1] || null;
  // No `accounts/` segment: the directory holding the file, when it is not the
  // product folder itself. Better than guessing the run's account and attaching
  // one account's memory to another.
  const parent = parts[parts.length - 2];
  if (!parent || parent === "reddit-agent-v2" || parent === "_shared") return null;
  return parent;
}

/** The state kind an artifact path carries, or null if it is not state. */
export function redditStateKindFor(artifactPath: string): RedditStateMatch | null {
  const path = artifactPath.split("\\").join("/");
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? "";

  // A run's PINNED COPY of a state file is what the run READ, not what it wrote.
  // Capturing one would write the pre-run state back over the post-run state —
  // silently reverting the ledger append or, far worse, the re-verified rules row
  // this run just earned. Step 02 is where v2 photocopies its inputs.
  if (lower.includes("/02-inputs/") || lower.includes("/02-pinned/")) return null;

  if (PER_ACCOUNT[base]) return { kind: PER_ACCOUNT[base], account: accountFrom(path) };
  if (CLIENT_WIDE[base]) return { kind: CLIENT_WIDE[base], account: null };

  // The paced scan's durable results, under a dated cache directory.
  if (lower.includes("/reddit-research-cache/") && base.endsWith(".json")) {
    return { kind: "research-cache", account: null };
  }
  return null;
}

/**
 * The `YYYY-MM-DD` a state artifact belongs to, from its own path when it has one.
 *
 * Load-bearing for two kinds. `research-cache`: v2 reuses a scan only if it is
 * from TODAY, and a scan costs ten to fifteen minutes of paced requests, so a
 * wrong date either re-buys it or reuses yesterday's as today's. `rules-audit`:
 * the run decides whether a reading is too old to trust, and dating it by when
 * the webhook happened to fire is wrong exactly when a delivery is retried across
 * midnight.
 */
export function redditStateDateFor(artifactPath: string, fallbackMs: number): string {
  const match = artifactPath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date(fallbackMs).toISOString().slice(0, 10);
}

/** How many bytes of one state file we keep. Past any real one. */
export const REDDIT_STATE_MAX_CHARS = 200_000;

/** The content type to re-attach a captured file with. */
export function redditStateContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".jsonl")) return "application/x-ndjson";
  return "text/markdown";
}

/* ─────────── assembling the v2 folders into the reader's envelope ─────────── */

/** One client-facing text file from the run, as the delivery handler has it. */
export interface RedditClientFile {
  /** The artifact path, e.g. "clients/acme/outputs/.../client/01-answer/about.txt". */
  path: string;
  text: string;
}

/** The thread folder a client-facing path belongs to, or null. */
function threadFolderOf(path: string): string | null {
  const parts = path.split("\\").join("/").split("/");
  const i = parts.findIndex((p) => /^\d+-answer$/i.test(p));
  return i > -1 ? parts[i] : null;
}

/** `- **Key:** value` / `Key: value` lines from about.txt, lowercased keys. */
function aboutFields(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\*\*/g, "").replace(/^\s*[-*]\s*/, "").trim();
    const at = line.indexOf(":");
    if (at < 1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key && value && !out.has(key)) out.set(key, value);
  }
  return out;
}

const FIRST_URL = /https?:\/\/[^\s)\]]+/;

/**
 * Build the reader's envelope from a Reddit v2 run's client-facing text files.
 *
 * Pure, so the whole transformation is testable without a webhook — which
 * matters, because this is the one place the agent's folder layout and the
 * reader's expectations meet, and a silent mismatch here blanks a deliverable.
 *
 * `outcome` is passed in rather than inferred from the files, and that is the
 * important argument of the two. An empty `threads` array is ambiguous on its
 * own: it means "nothing was worth your account's name" (a correct, honest run)
 * OR "we could not read Reddit at all" (our datacenter IP is blocked). Guessing
 * would eventually tell a client their niche was thin when our search simply
 * never came back.
 */
export function buildRedditV2Envelope(args: {
  files: readonly RedditClientFile[];
  outcome: RedditV2Envelope["outcome"];
  account?: string | null;
  mode?: "warming" | "established" | null;
  consideredCount?: number;
  outcomeNote?: string;
}): RedditV2Envelope {
  const byFolder = new Map<string, RedditClientFile[]>();
  for (const file of args.files) {
    const folder = threadFolderOf(file.path);
    if (!folder) continue;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
  }

  const threads: RedditV2Thread[] = [...byFolder.entries()]
    // Numeric, so 10-answer sorts after 2-answer rather than between 1 and 2.
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([folder, files]) => {
      const base = (f: RedditClientFile) => (f.path.split("/").pop() ?? "").toLowerCase();
      const approaches: RedditV2Thread["approaches"] = [];
      for (const id of ["approach-1", "approach-2"] as const) {
        const hit = files.find((f) => base(f) === `${id}.md`);
        if (hit?.text.trim()) approaches.push({ id, text: hit.text.trim() });
      }
      const about = files.find((f) => base(f) === "about.txt");
      const fields = about ? aboutFields(about.text) : new Map<string, string>();
      const aboutText = about?.text ?? "";

      const threadUrl =
        fields.get("thread")?.match(FIRST_URL)?.[0] ??
        fields.get("thread url")?.match(FIRST_URL)?.[0] ??
        fields.get("link")?.match(FIRST_URL)?.[0] ??
        aboutText.match(FIRST_URL)?.[0];
      const subredditRaw = fields.get("subreddit") ?? "";
      const subreddit = subredditRaw.match(/r\/[A-Za-z0-9_]+/)?.[0];
      const verdictSource = `${subredditRaw} ${fields.get("mentions") ?? ""}`.toLowerCase();
      const verdict = /value[\s-]?only|no product mention|no mentions/.test(verdictSource)
        ? ("value-only" as const)
        : /mention[\s-]?ok|mention allowed|mentions allowed/.test(verdictSource)
          ? ("mention-ok" as const)
          : undefined;
      // The two warnings are read off the WHOLE file, not one field: they are the
      // lines whose absence risks the account, and the run may put either in
      // prose. Over-detecting a rewrite demand is safe; missing one is not.
      const rewriteRequired = /REWRITE REQUIRED/i.test(aboutText) || /bans? ai[\s-]?written/i.test(aboutText);
      const karmaWarning = fields.get("karma") ?? fields.get("karma warning") ?? undefined;
      const recommendedRaw = (fields.get("recommended") ?? fields.get("we would pick") ?? "").toLowerCase();
      const recommended = recommendedRaw.includes("2")
        ? ("approach-2" as const)
        : recommendedRaw.includes("1")
          ? ("approach-1" as const)
          : undefined;

      return {
        folder,
        approaches,
        ...(fields.get("thread title") ? { threadTitle: fields.get("thread title")! } : {}),
        ...(threadUrl ? { threadUrl } : {}),
        ...(subreddit ? { subreddit } : {}),
        ...(verdict ? { verdict } : {}),
        ...(subredditRaw ? { verdictNote: subredditRaw } : {}),
        ...(fields.get("thread posted") ? { posted: fields.get("thread posted")! } : {}),
        ...(fields.get("why this thread") ? { whyThread: fields.get("why this thread")! } : {}),
        ...(fields.get("why this is safe here")
          ? { whySafe: fields.get("why this is safe here")! }
          : {}),
        ...(fields.get("disclosure") ? { disclosure: fields.get("disclosure")! } : {}),
        ...(rewriteRequired ? { rewriteRequired: true } : {}),
        ...(karmaWarning ? { karmaWarning } : {}),
        ...(recommended ? { recommended } : {}),
      };
    })
    .filter((t) => t.approaches.length > 0);

  return {
    kind: REDDIT_V2_ENVELOPE_KIND,
    outcome: args.outcome,
    ...(args.account ? { account: args.account } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.consideredCount !== undefined ? { consideredCount: args.consideredCount } : {}),
    ...(args.outcomeNote ? { outcomeNote: args.outcomeNote } : {}),
    threads,
  };
}

/**
 * The run's own outcome, read from its `13-commit.json` (or `01-run.json`).
 *
 * Defaults to `degraded` ONLY when the file says so — an unreadable or absent
 * record yields null and the caller decides, because inventing `degraded` would
 * tell a client our search failed when it may simply have held.
 */
export function redditOutcomeFrom(commitJson: string): {
  outcome: RedditV2Envelope["outcome"] | null;
  consideredCount?: number;
  outcomeNote?: string;
} {
  try {
    const parsed = JSON.parse(commitJson) as Record<string, unknown>;
    const raw = String(parsed.outcome ?? "").toLowerCase();
    const outcome = (["delivered", "held", "blocked_intake", "degraded"] as const).find(
      (o) => o === raw,
    );
    const considered = parsed.considered_count ?? parsed.threads_considered;
    const note = parsed.outcome_reason ?? parsed.reason;
    return {
      outcome: outcome ?? null,
      ...(typeof considered === "number" ? { consideredCount: considered } : {}),
      ...(typeof note === "string" && note.trim() ? { outcomeNote: note.trim() } : {}),
    };
  } catch {
    return { outcome: null };
  }
}

/** The run record an outcome can be read from. */
export function isRedditRunRecordArtifact(artifactPath: string): boolean {
  const lower = artifactPath.split("\\").join("/").toLowerCase();
  if (lower.includes("/02-inputs/")) return false;
  const base = lower.split("/").pop() ?? "";
  return base === "13-commit.json" || base === "01-run.json";
}
