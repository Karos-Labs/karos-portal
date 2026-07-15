/**
 * Creative Entropy Guard — a pre-generation freshness check.
 *
 * Before the engine commits to a new campaign theme, this compares it against
 * the client's recent text output (past ~30 days) using a lightweight token /
 * keyword overlap matrix. When the proposed theme overlaps too heavily with what
 * the client has already been saying, it flags repetition and emits strict
 * stylistic/layout constraints to fold into the generation system context — so
 * the model is pushed toward a genuinely fresh angle instead of echoing itself.
 *
 * Pure and client-safe (no I/O): callers fetch the recent texts and pass them in,
 * which keeps the matching logic trivially unit-testable.
 */

/** Overlap at or above this ⇒ the theme is too repetitive; constraints kick in. */
export const REPETITION_THRESHOLD = 0.5;

/** Very common words carry no thematic signal — excluded from the overlap matrix. */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "to", "of", "in", "on", "at", "by",
  "with", "from", "as", "is", "are", "was", "were", "be", "been", "being", "this",
  "that", "these", "those", "it", "its", "we", "our", "you", "your", "they", "their",
  "how", "what", "why", "when", "where", "which", "who", "will", "can", "your", "new",
  "get", "make", "more", "best", "top", "guide", "ways", "tips", "us", "about", "into",
]);

/** Tokenize text into a set of significant lowercased keyword stems (length ≥ 3). */
export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return new Set(tokens);
}

/**
 * Overlap coefficient of two token sets: |A ∩ B| / min(|A|, |B|). Chosen over
 * Jaccard so a short proposed theme fully contained in a long past post scores
 * ~1 (genuine repetition) rather than being diluted by the post's length.
 */
export function overlapSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) shared++;
  return shared / small.size;
}

export interface FreshnessAssessment {
  /** Highest overlap against any single past text (0–1). */
  maxSimilarity: number;
  /** Mean overlap across all past texts (0–1). */
  meanSimilarity: number;
  /** True when maxSimilarity ≥ REPETITION_THRESHOLD. */
  isRepetitive: boolean;
  /** The past texts (by index) that tripped the threshold. */
  collidingIndexes: number[];
  /** Overlapping keywords driving the highest match — surfaced in the constraints. */
  echoedKeywords: string[];
}

/**
 * Score a proposed theme against a corpus of recent client texts. Builds the
 * per-text overlap matrix row and summarizes it. Empty corpus ⇒ always fresh.
 */
export function assessThemeFreshness(
  proposedTheme: string,
  recentTexts: string[],
  threshold: number = REPETITION_THRESHOLD,
): FreshnessAssessment {
  const themeTokens = tokenize(proposedTheme);
  if (recentTexts.length === 0 || themeTokens.size === 0) {
    return { maxSimilarity: 0, meanSimilarity: 0, isRepetitive: false, collidingIndexes: [], echoedKeywords: [] };
  }

  const sims = recentTexts.map((t) => overlapSimilarity(themeTokens, tokenize(t)));
  const maxSimilarity = Math.max(...sims);
  const meanSimilarity = sims.reduce((s, n) => s + n, 0) / sims.length;
  const collidingIndexes = sims
    .map((s, i) => (s >= threshold ? i : -1))
    .filter((i) => i >= 0);

  // Keywords shared with the single closest past text drive the "avoid these" list.
  const closestIdx = sims.indexOf(maxSimilarity);
  const pastTokens = tokenize(recentTexts[closestIdx] ?? "");
  const echoedKeywords = [...themeTokens].filter((t) => pastTokens.has(t)).slice(0, 12);

  return {
    maxSimilarity,
    meanSimilarity,
    isRepetitive: maxSimilarity >= threshold,
    collidingIndexes,
    echoedKeywords,
  };
}

/**
 * Strict stylistic/layout constraints to append to the generation system context
 * when a theme is flagged repetitive. Names the echoed keywords so the model can
 * consciously steer around them.
 */
export function buildFreshnessConstraints(assessment: FreshnessAssessment): string {
  if (!assessment.isRepetitive) return "";
  const echoed = assessment.echoedKeywords.length
    ? assessment.echoedKeywords.join(", ")
    : "the recurring themes above";
  return `### CREATIVE ENTROPY GUARD — BRAND FRESHNESS ENFORCEMENT
This theme overlaps ${Math.round(assessment.maxSimilarity * 100)}% with content this client has already published in the last 30 days — it risks reading as repetitive. You MUST enforce freshness:
- Do NOT reuse the overworked angle or these echoed keywords as the hook: ${echoed}.
- Choose a distinctly different structural format from recent output (e.g. if recent posts were listicles, use a narrative case study, a contrarian take, a data teardown, or a how-to — not another list).
- Open with a novel hook and a fresh vocabulary; vary sentence rhythm and section layout.
- Bring a genuinely new sub-angle, audience segment, or format to the same topic — never restate what's already been said.`;
}

/**
 * Convenience: assess + build constraints in one call. Returns the (possibly
 * empty) constraint block plus the assessment for logging/telemetry.
 */
export function freshnessGuard(
  proposedTheme: string,
  recentTexts: string[],
  threshold: number = REPETITION_THRESHOLD,
): { constraints: string; assessment: FreshnessAssessment } {
  const assessment = assessThemeFreshness(proposedTheme, recentTexts, threshold);
  return { constraints: buildFreshnessConstraints(assessment), assessment };
}
