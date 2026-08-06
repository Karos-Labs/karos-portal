/**
 * Dash normalization for Dynamic Agent Studio AI output.
 *
 * // DECISION (Phase 7, "pick one home for it and state which"): the home is
 * HERE, in the runner's dynamic path — NOT the Portal's artifact-write path.
 *
 * The reason is a hard constraint one line up in the same spec: "No hardcoded
 * agent path is modified." The Portal's artifact-write path (the
 * agent-service webhook handler) is shared by X / LinkedIn / Reddit and every
 * managed agent; normalizing there would silently change what those agents
 * deliver, which is exactly the regression this epic is forbidden to cause.
 * A dynamic AI step's text, by contrast, is produced and persisted right
 * here, so this is the only seam that reaches dynamic output and nothing else.
 *
 * The spec's "rather than duplicating the utility in the runner" preference
 * assumes the Portal seam is available; it isn't, for the reason above. So
 * this file mirrors `src/lib/text-utils.ts`'s `normalizeDashes` under the
 * SAME mirroring rule the spec already sets for types in Phase 1 ("Mirror the
 * same types in agent-service (its own local type file — do not cross-import
 * from the Portal) and keep the two definitions structurally identical").
 * `test/dynamic-text-normalize.test.ts` re-runs the Portal's own
 * text-utils.test.ts cases verbatim against this copy, so the two can't drift
 * without a red test.
 *
 * Rules (identical to the Portal's, which documents the why):
 *   - Applied only OUTSIDE code spans / fenced blocks, because a spaced `--`
 *     is a real shell separator (`npm run test -- --watch`) and collapsing it
 *     would break the command, not just its looks.
 *   - An em dash is always replaced.
 *   - A double hyphen is replaced ONLY when it stands alone, bounded by
 *     whitespace or a string edge on both sides — leaving `--verbose` and a
 *     markdown rule `---` untouched.
 *   - Idempotent.
 */

const CODE_SPAN_OR_FENCE = /(```[\s\S]*?```|`[^`\n]*`)/g;

export function normalizeDashes(text: string): string {
  if (!text) return text;
  return text
    .split(CODE_SPAN_OR_FENCE)
    .map((segment, i) =>
      i % 2 === 1
        ? segment // odd indices are the captured code spans/fences — untouched
        : segment.replace(/—/g, "-").replace(/(^|\s)--(?!-)(?=\s|$)/g, "$1-"),
    )
    .join("");
}

/**
 * Applies `normalizeDashes` to AI-generated text wherever it appears in a
 * step's output, whether that output is a bare string or a JSON structure a
 * code step produced downstream of one. Object KEYS are never rewritten —
 * they are context variable names (and `stepId`s), not prose, and rewriting
 * one would break `{{outputs.<stepId>}}` resolution.
 */
export function normalizeDashesDeep(value: unknown): unknown {
  if (typeof value === "string") return normalizeDashes(value);
  if (Array.isArray(value)) return value.map(normalizeDashesDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeDashesDeep(v);
    }
    return out;
  }
  return value;
}
