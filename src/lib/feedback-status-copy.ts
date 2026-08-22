/**
 * Human labels for the control plane's reviewer verdicts.
 *
 * Same rule as `job-status-copy.ts` and `asset-status-copy.ts`, enforced by
 * `status-render-sweep.test.ts`: a surface renders a label, never the stored
 * enum. `needs_changes` is the one that makes the case on its own.
 *
 * The values come from agent-middleware's `FeedbackStatus`
 * (`app/core/enums.py`), so this is a boundary translation and belongs next to
 * the other two rather than inside a component.
 */

export type FeedbackStatusLike = "approved" | "rejected" | "needs_changes" | (string & {});

const FEEDBACK_STATUS_LABEL: Record<string, string> = {
  approved: "Approved",
  rejected: "Rejected",
  needs_changes: "Needs changes",
};

/**
 * Falls back to the raw value rather than to a guess: an unknown verdict means
 * the middleware gained a state this portal has not been taught, and showing
 * it is more useful to whoever has to fix that than quietly calling it
 * something else.
 */
export function feedbackStatusLabel(status: FeedbackStatusLike): string {
  return FEEDBACK_STATUS_LABEL[status] ?? status;
}
