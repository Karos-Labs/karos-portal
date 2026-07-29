/**
 * Turning validator output into sentences a human can act on.
 *
 * The refresh core reports refusals as precise, machine-shaped strings —
 * `competitors.create[0]: duplicates the existing row "Rival Inc" (rival.com)`.
 * That is exactly right for a CLI and exactly wrong for the Ops Import page:
 * Albert hit one, read dev-speak, and could not tell whether he had done
 * something wrong or the tool had. A refusal has to answer two questions
 * immediately — what happened, and what do I do — and keep the precise detail
 * available underneath rather than instead.
 *
 * So this groups raw errors by KIND, counts them, and writes each group as a
 * plain sentence plus advice. The original strings ride along in `details` for
 * the collapsible "technical detail" block; nothing is discarded, and a line
 * that matches no rule still surfaces under a generic heading rather than
 * disappearing.
 *
 * Pure and client-safe — the page renders it, and tests read it.
 */

export interface RefusalGroup {
  /** What happened, as a sentence, with the count folded in. */
  title: string;
  /** What to do about it. */
  advice: string;
  /** The untouched validator lines behind this group. */
  details: string[];
}

interface Rule {
  match: RegExp;
  /** `n` is how many errors landed in this group. */
  title: (n: number) => string;
  advice: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * First match wins, so the specific rules come before the broad ones. Every
 * message is written for the person holding the bundle, not the person who
 * wrote the validator.
 */
const RULES: Rule[] = [
  {
    match: /refusing to cross-apply|^clientId:/,
    title: () => "This bundle is for a different client",
    advice:
      "The clientId or client name in the file does not match the client it resolved to. Check you are importing the right file.",
  },
  {
    match: /matches \d+ existing rows|ambiguous/,
    title: (n) =>
      `${plural(n, "new competitor matches", "new competitors match")} more than one row already in the roster`,
    advice:
      "Ambiguous matches are not merged automatically — the wrong row could be overwritten. Put each one in `update` with the id of the row you mean.",
  },
  {
    match: /which this proposal already updates|already updates/,
    title: (n) => `${plural(n, "competitor appears", "competitors appear")} twice in this bundle`,
    advice: "The same row is listed under both `update` and `create`. Merge the two entries into one.",
  },
  {
    match: /is not a competitor of this client/,
    title: (n) => `${plural(n, "competitor row points", "competitor rows point")} at ids this client does not have`,
    advice:
      "Competitor ids come from the export this proposal was written against. If the export was for another client, or the ids were edited, re-export and rewrite those rows.",
  },
  {
    match: /never blanks data|never blanks a field|would empty a list/,
    title: (n) => `${plural(n, "field", "fields")} would be emptied`,
    advice:
      "A refresh completes data; it never blanks it. Remove those keys from the bundle, or give them a real value.",
  },
  {
    match: /no-leak boundary/,
    title: (n) => `${plural(n, "document", "documents")} would be published to the client portal`,
    advice:
      "Internal-only documents (client guidelines, action plans) cannot be written at the client tier. Change the tier to internal-only, or drop the entry.",
  },
  {
    match: /\[VERIFY\] token\(s\) at tier "client"|must never reach the client portal/,
    title: (n) => `${plural(n, "client-facing document contains", "client-facing documents contain")} unverified markers`,
    advice:
      "Resolve the [VERIFY] claims, or keep them in the internal tier where they belong. They must not reach a client.",
  },
  {
    match: /never removes a section|drops \d+ section/,
    title: (n) => `${plural(n, "document", "documents")} would lose sections`,
    advice:
      "A completion pass only adds. If a section really should go, that is a separate edit — not a refresh.",
  },
  {
    match: /shrinks to \d+%|floor \d+%/,
    title: (n) => `${plural(n, "document is", "documents are")} much shorter than the stored version`,
    advice:
      "Check nothing was truncated. If the shortening is deliberate, add a written `shrinkApproved` reason to that entry.",
  },
  {
    match: /banned placeholder/,
    title: (n) => `${plural(n, "document contains", "documents contain")} placeholder text`,
    advice:
      'Phrases like "data unavailable" must never render to anyone. Replace them with real findings or cut the sentence.',
  },
  {
    match: /YAML frontmatter|`## ` sections|a pipeline document has many more/,
    title: (n) => `${plural(n, "document is", "documents are")} not shaped like a pipeline document`,
    advice: "Every document opens with `---` frontmatter and carries several `## ` sections. Check the template.",
  },
  {
    match: /not a refreshable document type/,
    title: (n) => `${plural(n, "document type is", "document types are")} not something a refresh may write`,
    advice: "Only the standard context documents can be refreshed. Meeting notes and unknown types are out of scope.",
  },
  {
    match: /does not resolve to a real hostname|not a parseable domain|required on a new competitor row/,
    title: (n) => `${plural(n, "competitor is", "competitors are")} missing a usable website`,
    advice: "A new competitor row needs a working domain — without one it renders as a generic glyph.",
  },
  {
    match: /dominantColors|usagePct|dominanceRank|duplicate color|palette and document must agree|branding-guidelines document/,
    title: () => "The brand palette does not pass its checks",
    advice:
      "A palette is 3-4 unique hex colors, ranked in array order, with usagePct summing to exactly 100 — and the branding document in the same bundle has to state the same hexes.",
  },
  {
    match: /unknown key/,
    title: (n) => `The bundle carries ${plural(n, "field", "fields")} this portal does not store`,
    advice:
      "Unknown keys are refused rather than ignored, so nothing is silently dropped. Remove them, or check the bundle came from the right generator.",
  },
  {
    match: /schemaVersion/,
    title: () => "The bundle uses a schema version this portal does not implement",
    advice: "Regenerate it against the current template.",
  },
  {
    match: /too long|too short|expected a string|expected an array|expected an object|expected one of|expected a boolean/,
    title: (n) => `${plural(n, "field has", "fields have")} the wrong shape`,
    advice: "Check these against the bundle template — a value is the wrong type, or outside its allowed set.",
  },
];

const FALLBACK: Omit<Rule, "match"> = {
  title: (n) => `${plural(n, "problem", "problems")} the importer could not categorise`,
  advice: "The technical detail below is the validator's own wording.",
};

/**
 * Group raw validator errors into human-readable blocks.
 *
 * Groups come back in RULES order — the identity and safety problems first,
 * shape nits last — so the first thing read is the thing most likely to matter.
 * Every input line lands in exactly one group.
 */
export function groupRefusals(errors: string[]): RefusalGroup[] {
  const buckets = new Map<number, string[]>();
  const unmatched: string[] = [];

  for (const err of errors) {
    const i = RULES.findIndex((r) => r.match.test(err));
    if (i === -1) unmatched.push(err);
    else buckets.set(i, [...(buckets.get(i) ?? []), err]);
  }

  const groups: RefusalGroup[] = [];
  for (const [i, details] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const rule = RULES[i]!;
    groups.push({ title: rule.title(details.length), advice: rule.advice, details });
  }
  if (unmatched.length) {
    groups.push({ title: FALLBACK.title(unmatched.length), advice: FALLBACK.advice, details: unmatched });
  }
  return groups;
}

/** One-line summary for a collapsed card: "3 problems in 2 areas." */
export function summarizeRefusals(groups: RefusalGroup[]): string {
  const problems = groups.reduce((n, g) => n + g.details.length, 0);
  return `${plural(problems, "problem", "problems")} in ${plural(groups.length, "area", "areas")}. Nothing was written.`;
}
