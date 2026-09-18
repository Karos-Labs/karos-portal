/**
 * D11's goal line, recovered from the drafts string the asset already carries.
 *
 * ## Why this exists
 *
 * The line travels in THREE shapes, and `docs/contracts/C7-run-context.md` §3
 * in the engine repo is explicit that only one of them is deliverable fields:
 *
 * - **Instagram and the three TikTok agents** put a structured object on the
 *   deliverable, because a rendered PNG or mp4 has no markdown to hang a
 *   `- **Label:** value` bullet on. `materialize.ts`'s `goalLineMeta` reads it.
 * - **X and LinkedIn** put it in the drafts markdown as those bullets.
 *   `resolveGoalLine` runs once per run and `goalLineBullets` writes the result
 *   in. The deliverable's own `goal`/`audience`/`whyNow` are `optional()` on
 *   the draft schema and hold whatever the MODEL happened to state — which is
 *   the case `resolveGoalLine`'s fallback exists precisely to cover.
 * - **Reddit** puts `whyThread` in the v2 envelope. Its deliverable carries the
 *   same fact under a different name (`whyThisThread`), which nothing in this
 *   repo reads.
 *
 * So `metaFields` listing `goal`/`audience`/`whyNow` for X and LinkedIn, and
 * `whyThread` for Reddit, was reading keys the contract does not promise: the
 * modal's block was populated by luck on two agents and never on the third,
 * while the card beside it — which parses the same bullets and the same
 * envelope — showed the line correctly. Two renderers, two different answers,
 * from one run that resolved the line exactly once.
 *
 * ## What this does instead
 *
 * Reads the line from the string the asset is ALREADY storing. `content` on a
 * draft-batch asset IS the `draftsMarkdown` / `draftsEnvelope` the engine
 * wrote, so nothing new is fetched, no contract moves, and there is one source
 * per agent: whatever the card shows, the modal shows.
 *
 * The deliverable still wins where it has a value. A model that stated its own
 * goal said something the resolver only defaulted, and this is a fallback for
 * the fields it left empty rather than a replacement for the ones it filled.
 */

/** The three funnel words, and the sentences `GOAL_LINE` renders them as in the bullet. */
const GOAL_SENTENCES: Record<string, string> = {
  "earn attention": "attention",
  "show expertise": "expertise",
  "help them decide": "decide",
};

export interface GoalLineFromDrafts {
  goal?: string;
  audience?: string;
  whyNow?: string;
  whyThread?: string;
}

/**
 * The FUNNEL WORD behind a bullet's sentence, so what is stored is the same
 * vocabulary a structured deliverable stores.
 *
 * The bullet reads "earn attention"; `goalLineMeta` on an Instagram deliverable
 * stores `"attention"`; the modal maps the word to "Earn attention". Storing
 * the sentence here would put two vocabularies in one field and render one of
 * them uncapitalised, so the sentence is mapped back. Anything that is not one
 * of the three is stored verbatim — the modal passes an unknown value through,
 * which is the right answer for a line a future prompt words differently.
 */
function funnelWord(sentence: string): string {
  return GOAL_SENTENCES[sentence.trim().toLowerCase()] ?? sentence.trim();
}

/**
 * The value of the FIRST `- **Label:** value` bullet with this label.
 *
 * First, not last: one run drafts one post, and a markdown carrying more than
 * one is a batch whose first draft is the one this asset is about. The label
 * match is anchored and case-insensitive; the bold markers are optional so a
 * prompt that drops them still parses.
 */
function bulletValue(markdown: string, label: string): string | undefined {
  const pattern = new RegExp(String.raw`^\s*[-*]\s+\*{0,2}${label}\s*:\*{0,2}\s*(.+?)\s*$`, "im");
  const value = pattern.exec(markdown)?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** X and LinkedIn: the goal line as `goalLineBullets` wrote it into the drafts markdown. */
export function goalLineFromDraftsMarkdown(markdown: string): GoalLineFromDrafts {
  const line: GoalLineFromDrafts = {};
  const goal = bulletValue(markdown, "Goal");
  if (goal !== undefined) line.goal = funnelWord(goal);
  const audience = bulletValue(markdown, "For");
  if (audience !== undefined) line.audience = audience;
  const whyNow = bulletValue(markdown, "Why now");
  if (whyNow !== undefined) line.whyNow = whyNow;
  return line;
}

/**
 * Reddit: `whyThread` out of the v2 envelope.
 *
 * Parsed leniently and never thrown from — an envelope this portal cannot read
 * is already handled by `reddit-drafts.ts`'s own parser, and a materializer
 * that threw on it would lose the whole asset over one label.
 */
export function goalLineFromDraftsEnvelope(envelope: string): GoalLineFromDrafts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    return {};
  }
  const found = firstWhyThread(parsed, 0);
  return found !== undefined ? { whyThread: found } : {};
}

/**
 * The first `whyThread` anywhere in the envelope, breadth-first by depth.
 *
 * The slot is on a thread object inside the envelope rather than at its root,
 * and the envelope's exact nesting is the engine's to change — it has already
 * moved once. A bounded walk finds the value wherever it sits without this
 * module having to know the shape, and the depth cap keeps a malformed or
 * hostile payload from costing anything.
 */
function firstWhyThread(node: unknown, depth: number): string | undefined {
  if (depth > 6 || typeof node !== "object" || node === null) return undefined;
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = firstWhyThread(entry, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const own = record["whyThread"];
  if (typeof own === "string" && own.trim().length > 0) return own.trim();
  for (const value of Object.values(record)) {
    const found = firstWhyThread(value, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
