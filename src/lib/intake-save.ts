/**
 * The one funnel every write on an intake surface goes through.
 *
 * WHAT IT IS FOR. A server action is a network call, and it can REJECT rather
 * than return: `requireClientAccess` THROWS on a lapsed session and on a
 * foreign client id, `getCurrentUser` throws when the session cookie cannot be
 * verified, and a cold container or a dropped connection throws before the
 * action body runs at all. The shape every intake save was written in —
 *
 *     start(async () => {
 *       const result = await saveXCompanyIntakeAction(...);
 *       if (result.error) { setError(result.error); return; }
 *       …
 *     });
 *
 * — has no answer for that: the rejection escapes the transition instead of
 * producing a `result`, `setError` is never reached, and there is no error.tsx
 * anywhere in this tree to render a recovery. What the user gets is a dropped
 * click. The codebase already knew the hazard — the employee-seat remove in
 * linkedin-seats-workspace.tsx carries the comment "an authorization failure
 * (requireSeatAccess THROWS) refreshed the row back into place with no message
 * at all" — but the lesson reached exactly one control.
 *
 * WHY A FUNNEL RATHER THAN A TRY/CATCH AT EACH SITE. Fifteen try/catch blocks
 * are fifteen chances to forget the sixteenth. This is one function, every site
 * calls it, and `intake-save-funnel.test.ts` reads the intake sources and fails
 * if any action call reaches a browser without passing through it.
 *
 * WHAT IT DOES NOT DO, because both are easy to assume:
 *
 *  • It does NOT tell the caller whether the write landed. A throw AFTER a
 *    partial write (an intake doc saved, the seat's takes not) still reports
 *    failure, because from here the two are indistinguishable. Actions that
 *    must be all-or-nothing have to say so on the server.
 *  • It does NOT retry, and it does not refresh the router. The caller keeps
 *    both, because only the caller knows what its own success path was.
 */

/**
 * The lapsed-session / dropped-request sentence, for a form whose fields are
 * still on screen.
 *
 * Client copy, and deliberately not the thrown message: "Unauthorized",
 * "Forbidden" and a provider stack line are all internal strings, and one of
 * them in an error banner is a leak whatever it happens to say. It names the
 * one recovery that actually works for the common cause (the session went
 * stale while the form sat open) without asserting that IS the cause.
 */
export const INTAKE_SAVE_FAILED =
  "We couldn't save that. Your answers are still on screen — refresh the page to check you're still signed in, then try again.";

/**
 * The upload sibling. A file input has ALREADY been consumed by the time the
 * action rejects, so "your answers are still on screen" is false there and the
 * only honest instruction is to choose the file again. (The callers also clear
 * the input on failure — a file input that still holds the same file fires no
 * second change event, so without that the retry the copy asks for is
 * impossible.)
 */
export const INTAKE_UPLOAD_FAILED =
  "We couldn't upload that file. Refresh the page to check you're still signed in, then choose the file again.";

/**
 * The sibling for a write that is not a SAVE at all — a removal, a pause, a
 * "suggest accounts" press. Four of this funnel's callers are these.
 *
 * The same reasoning that mints `INTAKE_UPLOAD_FAILED` applies here and the
 * consolidation missed it: "your answers are still on screen" is FALSE for a
 * client who pressed "Yes, remove seat" — there are no answers, nothing was
 * being saved, and the instruction points at a form that does not exist. The
 * employee-seat remove already read "Couldn't remove this seat. Please try
 * again." and the one-sentence funnel replaced it with the save copy, which is
 * a fix taking a remedy with it.
 *
 * So the funnel keeps its single default and gains a second honest one, rather
 * than one sentence stretched over two situations. Callers that are neither a
 * save nor an upload pass this; a caller with a better sentence of its own
 * still passes that.
 */
export const INTAKE_ACTION_FAILED =
  "We couldn't do that. Refresh the page to check you're still signed in, then try again.";

/**
 * Run one intake write. Never rejects.
 *
 * `run` is a thunk rather than a promise so that a throw INSIDE the call
 * expression — building the FormData, reading a field off a null — is caught
 * here too, not only a rejected promise.
 *
 * Returns the action's own result untouched on the happy path, so every
 * existing `if (result.error)` branch keeps its exact meaning; the failure
 * branch is `{ error }` beside it.
 *
 * THE RESULT IS A UNION and the caller must handle both arms. `T` is
 * constrained to `object` rather than to `{ error?: string }` on purpose: the
 * employee-seat actions answer with a discriminated `{ ok: true … } | { ok:
 * false; error … }` whose success arm has no `error` field at all, and
 * constraining it away would have shut the funnel out of exactly the three
 * writes whose own file taught this lesson. Callers whose action already
 * carries `error?: string` read `result.error` straight off the union; the
 * discriminated one narrows first (`seatFailure` in
 * linkedin-seats-workspace.tsx).
 */
export async function intakeSave<T extends object>(
  run: () => Promise<T>,
  failure: string = INTAKE_SAVE_FAILED,
): Promise<T | { error: string }> {
  try {
    return await run();
  } catch {
    return { error: failure };
  }
}
