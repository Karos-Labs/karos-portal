import type { ClientTask, TaskStatus } from "@/lib/types";

/**
 * Copy for a TASK's state — the task-status register (pure and client-safe: this
 * module imports nothing but types, so any surface may import it).
 *
 * WHY IT EXISTS. One value, `in_progress`, was named three times on ONE SCREEN
 * and the three did not agree. The board card's badge said "Running Agent"
 * (tasks-board's `STATUS_META`); the column above that card and the ticket
 * modal's header both said "In Progress" (`BOARD_COLUMNS` and the modal's
 * `STATUS_LABEL`); and the status filter beside them re-typed all four words a
 * third time as hand-written `<option>` text. Agreement between two of the three
 * is what made the split look harmless.
 *
 * THE BADGE WAS ALSO A LIE, which is what made it worth fixing rather than
 * tidying. `STATUS_META[task.status]` is not conditioned on who owns the task, so
 * "Running Agent" painted on the board's "Depending on you" tab — where by
 * construction every row is `client_managed` work that no agent will ever touch.
 * A client reading their own to-do list was told an agent was running it.
 *
 * The state's name is now one word per state, and the claim that AN AGENT IS
 * RUNNING is keyed to the only fact that can answer it — `metadata.executing`,
 * asked through `taskIsExecuting` below. Status implies nothing about a run.
 *
 * WORDS ONLY, and that split is deliberate rather than tidy: `tasks-board`'s dot
 * colours and the two files' status ICON maps stay with their components,
 * because presentation is theirs and the two icon maps DISAGREE for
 * `in_progress` (the board column draws "CirclePlay", the ticket header
 * "Clock"). Folding them together here would have changed a rendered glyph to
 * satisfy a consolidation — a design decision smuggled in as a refactor. Same
 * split `asset-status-copy.ts` made when it left the analytics chart's colours
 * behind.
 *
 * SCOPE — stated, not counted. This module owns the `TaskStatus` → words map and
 * the running-now label. It does NOT own:
 *
 *  • `task-outcome-copy.ts`'s `ranWithoutDeliverable` — that answers "did this
 *    task's run deliver anything", which is a fact about a RUN's result and not a
 *    name for a state;
 *  • `constants.ts`'s `ACTION_ITEM_STATUS_LABELS` — a different key domain
 *    (`open`/`in_review`/`done` are nobody's `TaskStatus`), so a word shared with
 *    it is a coincidence of English rather than a drifted copy;
 *  • the two `TaskOwner` tab names ("Automated", "Depending on you"), which name
 *    a board tab rather than a task state.
 *
 * Enforced by shape, not asserted: task-status-copy.test.ts sweeps src/ for any
 * other object keyed by two or more task statuses whose values carry words, and
 * pins the three call sites at the call. Read that file for what the sweep can
 * and cannot see.
 */

/**
 * The one register. Lifted VERBATIM from the two maps that already agreed —
 * `BOARD_COLUMNS` and the ticket modal's `STATUS_LABEL`, which were byte for byte
 * identical on all four board states — so the column headings, the filter options
 * and the ticket header read exactly as they did before.
 *
 * ONE rendered byte moved, and it is the whole point: the card badge's
 * "Running Agent" is gone. No new word was invented for it — the badge converged
 * on the word its own column header was already using.
 *
 * `archived` comes from the ticket modal's map (the board drops archived tasks
 * before it paints a column, so `BOARD_COLUMNS` never had a fifth entry). Keeping
 * it here makes this a `Record` over the whole union, which is what lets tsc
 * refuse a new `TaskStatus` with no word.
 */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  review_pending: "Review Pending",
  completed: "Done",
  archived: "Archived",
};

/**
 * The rendered word for one task state.
 *
 * NO `??` FALLBACK, and that is a decision rather than an omission. The parameter
 * is `TaskStatus`, not `string`, because every caller in the app reads
 * `ClientTask["status"]` — which is that union — so an unrecognised value cannot
 * arrive without tsc saying so first. The sibling registers take `string` because
 * theirs genuinely can: `asset-status-copy` is asked by the analytics chart,
 * which derives its rows from stored data, and `job-status-copy` by surfaces
 * reading a Firestore field the union has outgrown. Neither is true here.
 *
 * THE RESIDUAL, written down rather than implied away: a Firestore document
 * holding a status outside the union resolves to `undefined`, which React renders
 * as nothing. That is a blank word, not a leaked enum — the fail-closed
 * direction, and strictly better than what it replaces (`STATUS_META[task.status
 * as BoardStatus].dot` threw on the same input).
 */
export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABEL[status];
}

/**
 * The one sentence for "an agent is working on this task right now".
 *
 * Written twice before, differently, for the same fact: the board card's chip
 * said "Agent running" and the ticket header said "AI Working…". Both are
 * rendered from `metadata.executing`, so the two spellings were one rule with two
 * answers — and a client who opened the card they had just read got a second name
 * for what they were already looking at.
 *
 * The card's wording won because it names the actor a client already has a word
 * for ("your agents" is what the Calendar and the AI Agents page call them),
 * where "AI Working…" names a technology and an ellipsis.
 */
export const TASK_RUNNING_LABEL = "Agent running";

/**
 * Is an agent executing this task RIGHT NOW?
 *
 * THE test for it, asked by the card's chip and the ticket's header, so a card
 * and the ticket it opens cannot disagree about whether something is happening.
 * Both spelled `task.metadata?.executing === true` for themselves before, which
 * is the same duplicate one indirection down.
 *
 * KEYED TO THE FLAG, never to the status. `in_progress` is where a task sits
 * while it waits to be run, while it runs, and after a run has come back with
 * nothing (`ranWithoutDeliverable` — the task is dropped back to `pending`, but
 * a managed task dragged into the column and never dispatched stays put), and on
 * the client-owned tab it is where a person's own unfinished work sits. So the
 * status cannot answer this question, and reading it as though it could is
 * exactly the defect this module was cut for.
 */
export function taskIsExecuting(task: Pick<ClientTask, "metadata">): boolean {
  return task.metadata?.executing === true;
}
