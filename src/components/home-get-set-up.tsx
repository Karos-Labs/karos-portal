"use client";

import { useState, useTransition } from "react";
import { Card, CardTitle } from "@/components/ui";
import { HomeTaskRow } from "@/components/home-task-row";
import { dismissActionAction } from "@/lib/actions";
import {
  nextSetupStep,
  setupLadderComplete,
  setupLadderProgress,
  SETUP_LADDER_HIDDEN_ACTION_ID,
} from "@/lib/setup-ladder";
import type { SetupStepView } from "@/lib/setup-ladder";

/**
 * Home's ONE list: "Get set up" (portal feedback round 4, 2026-09).
 *
 * It replaces both of the lists that stood here. "Next actions"
 * (home-action-list.tsx, deleted) rendered lib/action-list.ts's 24 rows — three
 * at a time behind a "See all 24" expander that opened onto a wall of greyed
 * done rows, and several of whose steps only Karos staff can complete.
 * "Recommended tasks" (home-recommended-tasks.tsx, deleted) rendered the
 * onboarding swarm's CONTENT IDEAS, which are not setup steps and are not
 * linked to an agent by construction. The product owner's ruling: the
 * recommended set is a fixed, small number of setup steps that get the client
 * to a first result with our agents, ordered per client at onboarding, with a
 * progress bar.
 *
 * The content ideas did not die with the widget — they still render on the
 * Calendar with their inferred dates, and the `?task=` kickoff strip still
 * turns one into a run. They left HOME, not the product.
 *
 * WHAT THIS COMPONENT DECIDES: nothing. Every row arrives resolved
 * (lib/setup-ladder.ts's `resolveSetupLadder`, called on the server because
 * step 3 needs `buildAgentSetup`'s Firestore reads). This narrates the answer
 * and fires exactly one write, the "Hide this" at the end.
 *
 * ── THE THREE RULES THE ROWS KEEP ────────────────────────────────────────
 *
 *  1. DONE ROWS STAY. Checked, muted, no controls — GOV.UK's task-list
 *     pattern: "the status should show as Completed and be black text with no
 *     background colour. This will draw more attention to tasks that require
 *     action." Removing them would also delete the progress the bar is
 *     counting.
 *  2. ONLY THE NEXT STEP CARRIES A BUTTON AND A REASON. Every row is a
 *     legitimate destination and the client may do them in any order (GOV.UK),
 *     but six primary buttons stacked on Home is six things competing for one
 *     press. The affordance is ordered; the links are not.
 *  3. NO X, ANYWHERE. `HomeTaskRow`'s dismiss is simply never passed. None of
 *     the six is optional — each is a real gate the server refuses on — so
 *     "Not for us" would offer a client a way to skip the thing that is
 *     stopping them, and then quietly stop asking. The undo window
 *     (`useUndoableDismiss`) exists for lists that HAVE a skip; this one does
 *     not, so it does not import it.
 *
 * Completion is never a manual tick: every `done` here came from a signal the
 * app already stores (Chameleon: "mark items completed based on user activity
 * within the app rather than just by clicking or starting the items").
 *
 * ── "HIDE THIS" IS THE CLIENT'S, AND IT IS NOT PERMANENT (review wave,
 * 2026-09) ───────────────────────────────────────────────────────────────
 *
 * Two things were wrong with the one control on this card. It wrote
 * `not_relevant` — the portal's ONE irreversible skip, with no un-mark action on
 * the client's side — for a card the client will legitimately want back the
 * moment a new agent is granted and the ladder reopens. And it rendered on the
 * staff branch too, where pressing it writes that permanent flag against
 * somebody else's account from a page staff read for their own reasons.
 *
 * So the write is now `dismissed` (a cooldown, `dismissActionAction`), the page
 * re-shows the card whenever the ladder is no longer complete, and `canHide` is
 * false for staff — the control is simply not rendered rather than gated inside
 * the handler, because a control you can see and must not press is worse than
 * one that is not there.
 */
export function GetSetUpWidget({
  clientId,
  steps,
  hidden = false,
  canHide = false,
}: {
  clientId: string;
  /** The six, in order, already resolved server-side. */
  steps: SetupStepView[];
  /**
   * The client already pressed "Hide this" on a finished ladder and the cooldown
   * has not run out — a stored `ClientActionState` row under
   * `SETUP_LADDER_HIDDEN_ACTION_ID`. Resolved on the page from the same state set
   * the checklist signals come from, together with the completion test: a ladder
   * that has reopened is shown again whatever this row says.
   */
  hidden?: boolean;
  /**
   * Whether THIS viewer may hide the card. False for staff: the row is written
   * against the client's account and hiding a client's onboarding card is the
   * client's call, not an operator's.
   */
  canHide?: boolean;
}) {
  const [, startTransition] = useTransition();
  // Optimistic: the card goes the moment it is pressed, and the write catches
  // the server up on the next load. A failure puts it back and says so (R-L7)
  // rather than leaving the client with a card that returns unexplained on the
  // next navigation.
  const [dismissed, setDismissed] = useState(false);
  const [hideError, setHideError] = useState<string | null>(null);

  // No `steps.length === 0` guard: `resolveSetupLadder` returns the six rows
  // unconditionally, so the branch was unreachable (review wave, 2026-09).
  if (hidden || dismissed) return null;

  // The count, the bar and the one row that carries the press all come from the
  // SAME resolved array, through the same pure helpers — so they cannot
  // disagree about how far along this client is or about which step they are on.
  const { done: doneCount, total, percent } = setupLadderProgress(steps);
  const next = nextSetupStep(steps);
  // ASKED SEPARATELY FROM `next` (review wave, 2026-09). A ladder waiting on
  // Karos has no pressable step left, and `next === null` used to be the whole
  // test for "You are all set up" — which would now congratulate a client whose
  // agent we have not stood up yet, and offer them a Hide on it.
  const complete = setupLadderComplete(steps);

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <CardTitle className="min-w-0 truncate">Get set up</CardTitle>
        <span className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
          {doneCount} of {total}
        </span>
      </div>
      {/* The bar and the count above it are computed from the SAME array the
          rows are, so they cannot disagree about how far along this client is.
          NN/g on progress indicators: where a percentage is uncertain, show the
          number of steps — hence both, the count in words and the bar for the
          shape of it. `aria-hidden` because the count beside it already says
          this in text. */}
      <div
        aria-hidden
        className="mb-4 h-1 w-full overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full rounded-full bg-neon transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      {complete ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">You are all set up. Your agents are running.</p>
            {hideError && <p className="mt-1 text-xs text-danger">{hideError}</p>}
          </div>
          {canHide && (
            <button
              type="button"
              onClick={() => {
                setDismissed(true);
                setHideError(null);
                startTransition(() => {
                  void dismissActionAction(clientId, SETUP_LADDER_HIDDEN_ACTION_ID).then((res) => {
                    // The write is what makes the card stay gone; if it did not
                    // land, the card comes back on the next navigation with no
                    // explanation, so it comes back NOW with one.
                    if (!res.ok) {
                      setDismissed(false);
                      setHideError("We could not hide this. Please try again.");
                    }
                  });
                });
              }}
              className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-neon/50 hover:text-neon focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon"
            >
              Hide this
            </button>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {steps.map((step) => (
            <li key={step.id}>
              <HomeTaskRow
                // The disc is the check state: a filled Check on what is done,
                // an empty Circle on what is not, and a Clock on a step that is
                // outstanding but ours rather than theirs. Same disc, one glyph
                // each, so the column reads as one checklist.
                icon={step.done ? "Check" : step.waiting ? "Clock" : "Circle"}
                title={step.label}
                muted={step.done}
                {...(step === next
                  ? { description: step.why, ...(step.href ? { start: { href: step.href } } : {}) }
                  : // A waiting row explains itself wherever it sits in the
                    // list: it is the only row whose title alone does not say
                    // why nothing is happening, and it never carries a press.
                    step.waiting
                    ? { description: step.why }
                    : {})}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
