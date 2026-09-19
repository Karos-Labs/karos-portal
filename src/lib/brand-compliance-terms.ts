/**
 * Brand compliance terms — the producer `gate.brandCompliance` never had.
 *
 * T-A11 / SCRUM-240. `gate.brandCompliance` runs in every publishing workflow
 * and reads `clientContext.brand.forbiddenTerms`. Nothing in this repo has ever
 * written that field, so every run passed it `[]` — and the seeder refused to
 * synthesize one, correctly: a wrong forbidden-terms list causes action toward
 * an external party, and a guessed one is worse than none.
 *
 * So the gate was not broken. It was unconfigured, everywhere, permanently, and
 * this file is the missing half.
 *
 * ── WHY THIS IS NOT `forbiddenTopics` ───────────────────────────────────────
 *
 * They read alike and they are not the same rule, which is exactly why they get
 * two fields and two editors rather than one list doing double duty:
 *
 *   forbiddenTopics  SUBJECTS this company does not engage with — "a pending
 *                    legal matter", "competitor pricing". Enforced by injecting
 *                    them into the drafting prompt and by a verification pass
 *                    that asks a model whether the deliverable went there.
 *                    Semantic: a post about a lawsuit violates it without ever
 *                    containing the word. See `dynamic-agent-guardrails.ts`.
 *
 *   forbiddenTerms   STRINGS that must not appear in the copy — "revolutionary",
 *                    "best-in-class", a competitor's trademark, a product name
 *                    the client retired. Enforced by a case-insensitive
 *                    SUBSTRING scan in `gate.brandCompliance`. Mechanical: the
 *                    word is present or it is not, and no model is asked.
 *
 * Merging them would break both. A substring scan for "a pending legal matter"
 * matches nothing a draft would ever literally say, and handing "revolutionary"
 * to a topic-vetting model invites it to reason about whether the post is ABOUT
 * revolution. Each rule needs the enforcement it was written for.
 *
 * ── WHAT AN EMPTY LIST MEANS, AND WHY THAT IS ALREADY HANDLED ───────────────
 *
 * The obvious worry with shipping this field is that a client who never fills
 * it in goes back to a gate that always passes. That was fixed on the engine
 * side ahead of this: `gate.brandCompliance` returns
 * `configStatus: "configured" | "unconfigured"` precisely so that "nothing was
 * verified" and "verified and clean" stop producing identical pass evidence.
 * An empty list here is therefore honest rather than silent, and this file does
 * not need to invent a second signal for it.
 *
 * Note also that the gate's `DEFAULT_BANNED_PROMISE_PHRASES` bank ("guaranteed
 * returns", "risk-free", …) is always active and independent of this list. It
 * is a platform-owned legal floor, not something a client configures, so an
 * empty `forbiddenTerms` never means "nothing is checked".
 *
 * PURE and client-safe: no Firestore, no `server-only`, no React — the same
 * split `dynamic-agent-guardrails.ts` uses, so the rules are unit-testable on
 * their own AND importable from the client component that renders the editor.
 */

/**
 * Parses a one-per-line textarea into a stored list.
 *
 * Extracted from `parseForbiddenTopics`, which now delegates to it, because
 * this file needed the same five rules under different limits and a second
 * hand-rolled copy is how the two quietly drift apart. The rules:
 *
 * - blank lines dropped;
 * - entries de-duplicated case-insensitively, FIRST spelling wins, so the
 *   casing staff typed is what an operator later reads back;
 * - over-long entries truncated rather than rejected — this parses a free-text
 *   box on a settings form, and silently losing the tail of one rule beats
 *   refusing the whole save. The `validate*` functions are what reject, and
 *   they run against the parsed result;
 * - the list is capped, and parsing stops at the cap rather than trimming
 *   afterwards.
 */
export function parseLineList(text: string, limits: { maxEntries: number; maxChars: number }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().slice(0, limits.maxChars).trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= limits.maxEntries) break;
  }
  return out;
}

/**
 * Cap. Higher than `MAX_FORBIDDEN_TOPICS` (40) on purpose: a topic is a subject
 * area and a company has few of them, while terms are individual words and a
 * brand-voice document routinely bans dozens — the "words we never use" section
 * of a real style guide is a long list of single adjectives.
 */
export const MAX_FORBIDDEN_TERMS = 120;

/**
 * Per-entry cap. Short, because a forbidden TERM is a word or a short phrase
 * matched as a substring; anything approaching sentence length is a topic rule
 * that has been entered in the wrong box, and a 200-character "term" would
 * never match a draft anyway.
 */
export const MAX_FORBIDDEN_TERM_CHARS = 60;

/**
 * The shortest string we will scan for. A one- or two-character "term" matches
 * as a substring inside ordinary words — "ai" is inside "said", "detail" and
 * "campaign" — so accepting one would fail every draft the client ever sees and
 * read to them as the gate being broken. Three is the first length at which an
 * accidental match stops being the common case.
 */
export const MIN_FORBIDDEN_TERM_CHARS = 3;

/** The editor's textarea (one term per line) into the stored array. */
export function parseForbiddenTerms(text: string): string[] {
  return parseLineList(text, { maxEntries: MAX_FORBIDDEN_TERMS, maxChars: MAX_FORBIDDEN_TERM_CHARS });
}

/** The stored array back into textarea text — the exact inverse for any already-parsed list. */
export function formatForbiddenTerms(terms: string[] | undefined): string {
  return (terms ?? []).join("\n");
}

/**
 * Validates an ALREADY-PARSED list. Returns an English message or null.
 *
 * Separate from parsing so a caller that built the list some other way — an
 * import, a future API, the brand-voice research step — is held to the same
 * limits as the textarea.
 */
export function validateForbiddenTerms(terms: string[]): string | null {
  if (terms.length > MAX_FORBIDDEN_TERMS) {
    return `At most ${MAX_FORBIDDEN_TERMS} forbidden terms per client.`;
  }
  for (const term of terms) {
    const trimmed = term.trim();
    if (!trimmed) return "A forbidden term cannot be blank.";
    if (trimmed.length < MIN_FORBIDDEN_TERM_CHARS) {
      // Named rather than described: someone who typed "AI" needs to know why
      // it was refused, not that a threshold exists.
      return `"${trimmed}" is too short to match safely (min ${MIN_FORBIDDEN_TERM_CHARS} characters) — a two-letter term matches inside ordinary words and would fail every draft.`;
    }
    if (term.length > MAX_FORBIDDEN_TERM_CHARS) {
      return `Forbidden term "${term.slice(0, 30)}…" is too long (max ${MAX_FORBIDDEN_TERM_CHARS} characters). A whole sentence belongs in "Topics we do not cover".`;
    }
  }
  return null;
}
