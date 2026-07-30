/**
 * Best-effort human-readable classification of a job's raw error string.
 *
 * The agent-service reports failures as one free-text `error` field (see
 * `webhookPayloadSchema` in src/app/api/agent-service/webhook/route.ts) — there
 * is no structured error code/kind in the contract. This is a heuristic label
 * over that text, not a trustworthy classification: the raw string is always
 * kept alongside the label so nothing is lost if the guess is wrong.
 */
export interface ClassifiedJobError {
  label: string;
  raw: string;
}

const PATTERNS: Array<{ test: RegExp; label: string }> = [
  { test: /rate.?limit|too many requests|\b429\b/i, label: "Rate limited by provider" },
  {
    // Confirmed against a real production incident (2026-07-30): the Claude
    // Code SDK's actual wording is "Credit balance is too low" — no
    // "insufficient" substring at all, so the original pattern here never
    // matched it and every one of these fell through to "Unexpected error"
    // instead of the label that would have told staff exactly what to check.
    test: /insufficient.*(credit|balance|quota)|credit.?balance.*(low|insufficient)|quota exceeded|billing/i,
    label: "Provider credits exhausted",
  },
  { test: /unauthorized|forbidden|\b401\b|\b403\b|api.?key|auth(entication)?.*(expired|invalid|fail)/i, label: "Provider authentication expired" },
  { test: /time(d)?.?out|etimedout|econnreset|network error/i, label: "Request timed out" },
  { test: /pars(e|ing)|invalid json|schema validation|unexpected token/i, label: "Response parsing error" },
  { test: /cancel/i, label: "Cancelled" },
];

/** Returns null for no error (nothing to classify), never for an unrecognized one. */
export function classifyJobError(raw: string | null | undefined): ClassifiedJobError | null {
  if (!raw) return null;
  const match = PATTERNS.find((p) => p.test.test(raw));
  return { label: match?.label ?? "Unexpected error", raw };
}
