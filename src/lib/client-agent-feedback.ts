/**
 * Two-level client-agent feedback (Phase 3 §5, CD-A2) — the pure half.
 *
 * Two scopes and no third: "agent" shapes everything this agent makes,
 * "template" shapes one stream. The per-draft learning logs (XDraftFeedback /
 * LiDraftFeedback) stay the item-level tier below this and are untouched.
 *
 * CLIENT-SAFE: the modal that writes a row, the action that stores it and the
 * builder that serializes it for a run all share these limits and this
 * rendering, so what the client is told is bounded is what is actually bounded.
 *
 * The caps are the F77 ruling made structural: client text that accumulates
 * without limit and is injected into EVERY future run inflates every prompt
 * forever. 50 active rows × 500 chars is the ceiling, enforced server-side at
 * write time (length) and at injection time (count).
 */

import type { ClientAgentFeedback, ClientAgentTemplate } from "@/lib/types";

/** Hard per-row length. Clamped server-side, not trusted from the browser. */
export const MAX_FEEDBACK_CHARS = 500;

/** Newest N active rows are injected into a run. Older active rows are kept. */
export const MAX_INJECTED_FEEDBACK = 50;

/** The file every live-umbrella run receives (§8.1 context_files). */
export const FEEDBACK_CONTEXT_FILENAME = "agent-feedback.md";

/**
 * Normalize what a client typed into what is stored: no control characters
 * (they survive JSON and reappear inside the markdown the agent reads), no
 * runaway blank lines, hard length cap.
 */
export function clampFeedbackText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // Control characters other than newline survive JSON and reappear inside
    // the markdown the agent reads as literal escapes.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_FEEDBACK_CHARS);
}

export type FeedbackScope = ClientAgentFeedback["scope"];

/**
 * A row's scope must be answerable by the registry. Template feedback pointing
 * at a key that no longer exists would be serialized under a heading naming a
 * stream the agent does not have — instructions about nothing.
 */
export function validateFeedbackScope(input: {
  scope: FeedbackScope;
  templateKey?: string | null;
  templates: Pick<ClientAgentTemplate, "key">[];
}): { ok: true; templateKey: string | null } | { ok: false; error: string } {
  if (input.scope === "agent") return { ok: true, templateKey: null };
  const key = input.templateKey?.trim();
  if (!key) return { ok: false, error: "Pick which format this is about." };
  if (!input.templates.some((t) => t.key === key)) {
    return { ok: false, error: "That format isn't on this agent." };
  }
  return { ok: true, templateKey: key };
}

/**
 * What a run actually receives: active rows only, newest first, capped.
 *
 * `resolved` and `withdrawn` rows are kept in the collection (they are the
 * record of what the client asked for and how it ended) but stop being injected
 * — only `active` reaches a run, which is the whole difference between the
 * statuses. The filter is written as an allowlist for exactly that reason: a
 * new status added later must be opted IN to injection, never default into it.
 */
export function selectInjectedFeedback(rows: ClientAgentFeedback[]): ClientAgentFeedback[] {
  return rows
    .filter((row) => row.status === "active" && row.text.trim().length > 0)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_INJECTED_FEEDBACK);
}

/**
 * D5: the length cap is re-applied HERE, at the injection boundary, not only at
 * write time.
 *
 * `clampFeedbackText` runs in the two actions that accept typed text, which
 * bounds everything written through the modal. It does not bound what is
 * READ: rows predating the cap, rows written by any future path that forgets to
 * clamp, and rows edited directly in Firestore all reach this function
 * unbounded, and this function's output goes verbatim into the prompt of every
 * run the agent makes from here on. A cap enforced only on the way in is a cap
 * on the UI, not on the prompt — so the boundary that actually matters re-does
 * it. Clamping twice is free; clamping once in the wrong place is the bug.
 */
function formatRow(row: ClientAgentFeedback): string {
  const when = new Date(row.createdAt).toISOString().slice(0, 10);
  const who = row.creatorRole === "client" ? "client" : "Karos team";
  return `- ${when} (${who}): ${clampFeedbackText(row.text)}`;
}

/**
 * Serialize the umbrella's active feedback as the markdown attached to a run.
 *
 * Global first, then one section per template that has feedback — the order the
 * agent should apply them in, since template notes narrow what the global ones
 * already said. The preamble uses the same authority framing the lab contract
 * already uses for learning logs: this is the client speaking about their own
 * agent, and it outranks the generic instructions.
 *
 * Returns null when there is nothing active — callers attach nothing rather
 * than an empty file that reads as "the client has no opinions".
 */
export function renderFeedbackMarkdown(input: {
  agentName: string;
  rows: ClientAgentFeedback[];
  templates: Pick<ClientAgentTemplate, "key" | "name">[];
}): string | null {
  const rows = selectInjectedFeedback(input.rows);
  if (rows.length === 0) return null;

  const nameFor = new Map(input.templates.map((t) => [t.key, t.name]));
  const global = rows.filter((row) => row.scope === "agent");
  const scoped = rows.filter((row) => row.scope === "template" && row.templateKey);

  const lines: string[] = [
    `# Client feedback — ${input.agentName}`,
    "",
    "Standing direction from this client about this agent's output. It is not a",
    "one-off request: apply all of it to everything you produce in this run, and",
    "treat it as outranking any generic guidance that contradicts it. Where two",
    "notes conflict, the newer one wins.",
    "",
    "## Applies to everything this agent makes",
  ];
  lines.push(global.length > 0 ? global.map(formatRow).join("\n") : "- Nothing yet.");

  const byTemplate = new Map<string, ClientAgentFeedback[]>();
  for (const row of scoped) {
    const key = row.templateKey as string;
    const bucket = byTemplate.get(key);
    if (bucket) bucket.push(row);
    else byTemplate.set(key, [row]);
  }
  for (const [key, bucket] of byTemplate) {
    lines.push("", `## Applies only to "${nameFor.get(key) ?? key}" (template key: ${key})`);
    lines.push(bucket.map(formatRow).join("\n"));
  }
  return `${lines.join("\n")}\n`;
}
