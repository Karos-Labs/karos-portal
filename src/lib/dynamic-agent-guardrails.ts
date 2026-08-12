/**
 * Topic guardrails — the pure half.
 *
 * A client's `forbiddenTopics` are the topics that company does not engage
 * with. They are injected into every AI step of every dynamic-agent run for
 * that client, and verified against the finished deliverable — see
 * `docs/dynamic-agent-guardrails.md` for the full contract.
 *
 * No Firestore, no auth, no "server-only": same pure/transactional split as
 * `dynamic-agent-validation.ts` and `credits.ts`, so the parsing rules are
 * unit-testable on their own AND importable from the client component that
 * renders the editor.
 *
 * // DECISION: the list lives on the CLIENT, not on the agent. "Topics the
 * company does not engage with" is a property of the company — a client that
 * will not discuss a pending legal matter must be protected on every agent it
 * runs, including agents authored after the policy was set. Putting it on the
 * agent would mean re-entering it per agent and silently losing the protection
 * the moment someone builds a new one.
 */

/** Cap chosen to match the Studio's own MAX_INPUT_FIELDS/MAX_STEPS order of magnitude. */
export const MAX_FORBIDDEN_TOPICS = 40;
export const MAX_FORBIDDEN_TOPIC_CHARS = 120;

/**
 * Parses the editor's textarea (one topic per line) into the stored array.
 *
 * Blank lines are dropped and entries are de-duplicated case-insensitively —
 * "Competitor pricing" and "competitor pricing" are one rule, and storing both
 * would inject the same constraint twice. The FIRST spelling wins, so the
 * casing staff typed is what an operator later reads back.
 *
 * Over-long entries are truncated rather than rejected: this parses a free-text
 * box on a settings form, and silently losing the last few words of a rule is
 * far better than refusing the whole save. `validateForbiddenTopics` is what
 * rejects, and it runs against the parsed result.
 */
export function parseForbiddenTopics(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().slice(0, MAX_FORBIDDEN_TOPIC_CHARS).trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= MAX_FORBIDDEN_TOPICS) break;
  }
  return out;
}

/** The stored array back into textarea text — the exact inverse of parseForbiddenTopics for any already-parsed list. */
export function formatForbiddenTopics(topics: string[] | undefined): string {
  return (topics ?? []).join("\n");
}

/**
 * Validates an ALREADY-PARSED list. Returns an English message or null.
 *
 * Kept separate from parsing so a caller that built the list some other way
 * (an import, a future API) is held to the same limits as the textarea.
 */
export function validateForbiddenTopics(topics: string[]): string | null {
  if (topics.length > MAX_FORBIDDEN_TOPICS) {
    return `At most ${MAX_FORBIDDEN_TOPICS} forbidden topics per client.`;
  }
  for (const topic of topics) {
    if (!topic.trim()) return "A forbidden topic cannot be blank.";
    if (topic.length > MAX_FORBIDDEN_TOPIC_CHARS) {
      return `Forbidden topic "${topic.slice(0, 30)}…" is too long (max ${MAX_FORBIDDEN_TOPIC_CHARS} characters).`;
    }
  }
  return null;
}

/**
 * Does this client have guardrails configured at all?
 *
 * The single predicate every caller uses to decide whether the feature is
 * active for a run, so "off" means the same thing in the submit path, the
 * runner, and the UI. An absent field and an empty array are identical: both
 * mean no guardrails, and neither costs a run anything.
 */
export function hasForbiddenTopics(topics: string[] | undefined): boolean {
  return Array.isArray(topics) && topics.length > 0;
}
