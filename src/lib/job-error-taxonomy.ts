/**
 * Best-effort human-readable classification of a job's raw error string.
 *
 * The agent-service reports failures as one free-text `error` field (see
 * `webhookPayloadSchema` in src/app/api/agent-service/webhook/route.ts) — there
 * is no structured error code/kind in the contract. This is a heuristic label
 * over that text, not a trustworthy classification: the raw string is always
 * kept alongside the label so nothing is lost if the guess is wrong.
 *
 * Two other things land in the same `job.error` field and are NOT free text:
 * the portal's own submit-time refusals (the literal strings thrown by
 * agent-service/client.ts), and the bare service status when a webhook carries
 * no message at all ("failed", "cancelled", "dead_letter"). The first group is
 * matched by exact shape at the top of the list, because the heuristics below
 * read their HTTP status codes as if they came from the model provider.
 *
 * STAFF-FACING ONLY. These labels render on /jobs, in the Control Room's run
 * history and in the admin failure alert; `toRunRows` drops `job.error` for a
 * client viewer, so no client ever receives a raw error or a label over one.
 */
export interface ClassifiedJobError {
  label: string;
  raw: string;
}

const PATTERNS: Array<{ test: RegExp; label: string }> = [
  // ── The PORTAL's own submit-time refusals, first and by exact shape ──
  // These are not provider errors at all: they are the two strings
  // `agent-service/client.ts` throws when this app cannot hand the run over,
  // and submit-custom / submit-managed / run-custom-agent store them verbatim
  // as `job.error` before flipping the job to failed.
  //
  // They lead the list because the generic rules below MISREAD them. A rotated
  // AGENT_SERVICE_TOKEN produces "Agent service request failed (401)", which
  // matched `\b401\b` and reported "Provider authentication expired" — sending
  // whoever read it to check the model provider's API key when the thing that
  // is actually wrong is this portal's own token. A wrong reason costs more
  // than no reason, and the status code is the whole diagnosis here, so each
  // class gets the label that names the right system.
  { test: /^Agent service is not configured/i, label: "Agent service not configured" },
  {
    test: /^Agent service request failed \((401|403)\)/i,
    label: "Agent service credentials rejected",
  },
  { test: /^Agent service request failed \(429\)/i, label: "Rate limited by agent service" },
  { test: /^Agent service request failed \(5\d\d\)/i, label: "Agent service unavailable" },
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
