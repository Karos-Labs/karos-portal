/**
 * Competitor row view-model — pure + client-safe (portal feedback round 4, 2026-09).
 *
 * "Since it's only competitors now we can show all of them right off the bat,
 * and make it more interactive if we have data on these competitors that we
 * collected anyway, like how close they are, or what they each do in short,
 * without more research."
 *
 * The last four words are the whole constraint: NOTHING in here fetches, and
 * nothing derives a fact we did not already store. Every field below is read
 * off `ClientCompetitor` (written by the report import, the quick-add analysis
 * and `syncCompetitorsFromVisibility`) plus one number the SEO/GEO snapshot
 * already carries, so a row can go from a name to a profile without a single
 * extra call.
 *
 * Lives in `lib/` rather than inside the component so the ordering and the
 * mapping are testable without a DOM — the component renders these rows and
 * decides nothing.
 */
import { domainFromName } from "@/lib/favicon";
import type { ClientCompetitor } from "@/lib/types";

/**
 * What the most recent SEO/GEO capture contributes to the rows.
 *
 * Only the CLIENT's side: each competitor's own count is already on its row
 * (`llmMentions`, written back after every capture by
 * `lib/intel/competitor-sync.ts`), and re-deriving it here from the snapshot
 * roster would give two numbers for one measurement that could disagree
 * whenever a row was named under a spelling the roster does not use.
 */
export interface CompetitorAiVisibility {
  /**
   * Answers in which the engines named the client, over the same category
   * probes and the same run that produced every row's `llmMentions`.
   */
  clientMentions: number;
  /** Measured answers behind both counts, for the "of N answers" denominator. */
  answersMeasured: number;
  /**
   * `capturedAt` of the snapshot both numbers came from, and the reason the
   * "same run" in the sentence above is now a fact rather than a hope (review
   * wave, 2026-09).
   *
   * A row's `llmMentions` is written back by `lib/intel/competitor-sync.ts`
   * with the capture's own `llmMentionsAt` beside it, and only the rows in the
   * measurement roster get one. So a competitor added after the last capture,
   * or one sitting past TRACKED_COMPETITOR_LIMIT, still carries whatever an
   * OLDER run measured — and putting that count next to this run's client
   * figure, on a shared denominator, is a comparison of two different
   * measurements presented as one.
   */
  capturedAt: number;
}

export interface CompetitorFact {
  label: string;
  value: string;
}

export interface CompetitorRow {
  id: string;
  company: string;
  /** Stored website, passed through to the favicon exactly as the row holds it. */
  url?: string;
  /** Absolute link, or null when there is neither a url nor a domain-shaped name. */
  href: string | null;
  /**
   * A row somebody put on the list on purpose ("manual"), as against one the
   * report or a capture seeded. These sort first: they are the answer to "who
   * am I losing to?" that a person already gave.
   */
  tracked: boolean;
  /** One line of "what they do", from stored positioning. Null when we have none. */
  summary: string | null;
  /** Overlap and market tier, in that order, as short chips. */
  chips: string[];
  /**
   * Answers this brand was named in ON THE RUN `ai` describes; null when there
   * is no count for that run (see `notMeasuredThisRun`). With no snapshot at
   * all, the stored count is passed through as-is: there is no run for it to
   * disagree with.
   */
  mentions: number | null;
  /**
   * True when there IS a current capture and this row has no count from it, so
   * the component can say "not measured this run" rather than either printing
   * an older run's number beside this run's client figure or silently showing
   * nothing (review wave, 2026-09).
   */
  notMeasuredThisRun: boolean;
  /**
   * Bar width 0..100 for the share-of-conversation meter: this row's count
   * against the LARGER of it and the client's own, so the bar reads as "how
   * they stand next to you" rather than as a share of some invisible total.
   * Null whenever there is no snapshot or no measurement for this row.
   */
  barPct: number | null;
  /** The client's own count for the same run, so the row can say "you: N". */
  clientMentions: number | null;
  /** Denominator for both counts. */
  answersMeasured: number | null;
  strengths: string[];
  weaknesses: string[];
  /** Founded / scale / threat, only where stored. */
  facts: CompetitorFact[];
  /** False when the disclosure would open onto nothing, so it is not rendered. */
  hasDetail: boolean;
}

/** Longest one-line "what they do" before it is cut at a word boundary. */
const SUMMARY_MAX = 140;

/**
 * First sentence of the stored positioning, clamped. Positioning is analyst
 * prose of any length; the row wants one line and the disclosure carries the
 * rest of what we know, so this trims rather than wraps.
 */
export function oneLineSummary(positioning: string | undefined | null): string | null {
  const raw = positioning?.trim();
  if (!raw) return null;
  const firstSentence = raw.split(/(?<=[.!?])\s+/)[0].trim() || raw;
  const flat = firstSentence.replace(/\s+/g, " ");
  if (flat.length <= SUMMARY_MAX) return flat.replace(/[.]$/, "");
  const cut = flat.slice(0, SUMMARY_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/**
 * Absolute link for a row. Same derivation the favicon beside it already uses
 * (CD-H3): a stored url wins, and a row whose NAME is a domain is just as
 * linkable. Neither present still means no anchor rather than a dead one.
 */
export function competitorHref(c: Pick<ClientCompetitor, "company" | "url">): string | null {
  const stored = c.url?.trim();
  if (stored) return stored.startsWith("http") ? stored : `https://${stored}`;
  const derived = domainFromName(c.company);
  return derived ? `https://${derived}` : null;
}

/**
 * Display order: the rows a person chose, then the rivals the engines actually
 * name most, then alphabetically.
 *
 * Deliberately NOT `computeTrackedCompetitors`'s order, and the two are doing
 * different jobs: that one decides which rows SURVIVE a cap (and backfills by a
 * blended analyst score when nothing has been measured), this one decides how
 * the surviving rows READ. A never-measured row sorts below every measured one
 * rather than above a zero, because "we have not asked yet" is not "the engines
 * did not name them".
 */
function compareRows(ai?: CompetitorAiVisibility | null) {
  return (a: ClientCompetitor, b: ClientCompetitor): number => {
    const trackedDelta = Number(b.source === "manual") - Number(a.source === "manual");
    if (trackedDelta !== 0) return trackedDelta;
    // The SHOWN count, not the stored one (review wave, 2026-09): a row whose
    // number belongs to an older capture reads "not measured this run", and a
    // row that says nothing must not outrank one that says zero.
    const mentionDelta = (measuredMentions(b, ai) ?? -1) - (measuredMentions(a, ai) ?? -1);
    if (mentionDelta !== 0) return mentionDelta;
    return a.company.localeCompare(b.company);
  };
}

/**
 * The count this row is allowed to show against `ai`'s run.
 *
 * With a snapshot in hand the row's stamp has to match it, or the number came
 * from a different measurement and is not comparable with the client's own (see
 * `CompetitorAiVisibility.capturedAt`). With no snapshot there is no run to
 * disagree with, so the stored count passes through exactly as it always did —
 * as a bare "named in N AI answers", with no bar and no denominator.
 */
function measuredMentions(
  c: ClientCompetitor,
  ai?: CompetitorAiVisibility | null,
): number | null {
  if (typeof c.llmMentions !== "number") return null;
  if (!ai) return c.llmMentions;
  return c.llmMentionsAt === ai.capturedAt ? c.llmMentions : null;
}

const TIER_CHIP: Record<ClientCompetitor["marketTier"], string | null> = {
  Leader: "Market leader",
  Challenger: "Challenger",
  Niche: "Niche player",
  // "Other" is the import's fallback for a tier the report did not state. A
  // chip reading "Other" tells a client nothing they did not already know.
  Other: null,
};

const THREAT_FACT: Record<string, string> = {
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

/**
 * Map stored competitors to display rows, in display order.
 *
 * `ai` is the SEO/GEO half and is optional throughout: a workspace with no
 * capture yet gets every other field and simply no meter, which is the same
 * rule the rest of the portal follows for an unmeasured snapshot.
 */
export function buildCompetitorRows(
  competitors: ClientCompetitor[],
  ai?: CompetitorAiVisibility | null,
): CompetitorRow[] {
  const clientMentions = ai ? ai.clientMentions : null;
  const answersMeasured = ai ? ai.answersMeasured : null;

  return [...competitors].sort(compareRows(ai)).map((c): CompetitorRow => {
    const mentions = measuredMentions(c, ai);
    // Only ever true when there is a run to be absent from.
    const notMeasuredThisRun = !!ai && mentions === null;
    const chips = [
      c.overlap ? `${c.overlap} overlap` : null,
      TIER_CHIP[c.marketTier] ?? null,
    ].filter((s): s is string => Boolean(s));

    const facts: CompetitorFact[] = [
      c.founded ? { label: "Founded", value: c.founded } : null,
      c.scale ? { label: "Scale", value: c.scale } : null,
      c.threatLevel && THREAT_FACT[c.threatLevel]
        ? { label: "Threat", value: THREAT_FACT[c.threatLevel] }
        : null,
    ].filter((f): f is CompetitorFact => f !== null);

    const strengths = c.keyStrengths ?? [];
    const weaknesses = c.keyWeaknesses ?? [];
    const href = competitorHref(c);

    // The meter needs BOTH numbers to mean anything. A row measured at 3 next
    // to no client figure is a bar with no scale, so it renders as the plain
    // count instead.
    const barPct =
      mentions !== null && clientMentions !== null
        ? Math.round((mentions / Math.max(1, mentions, clientMentions)) * 100)
        : null;

    return {
      id: c.id,
      company: c.company,
      ...(c.url ? { url: c.url } : {}),
      href,
      tracked: c.source === "manual",
      summary: oneLineSummary(c.positioning),
      chips,
      mentions,
      notMeasuredThisRun,
      barPct,
      clientMentions,
      answersMeasured,
      strengths,
      weaknesses,
      facts,
      // The website link lives inside the disclosure too, so a row with only a
      // link still has something to open.
      hasDetail: strengths.length > 0 || weaknesses.length > 0 || facts.length > 0 || href !== null,
    };
  });
}
