/**
 * The two field bits every agent intake form draws, in one place.
 *
 * WHAT WAS WRONG. `fieldError` was declared SIX times — once in each
 * `*-agent-intake.tsx` — and `RequiredMark` twice, and the six copies of
 * `fieldError` did not agree:
 *
 *   linkedin / reddit / x        text-danger    (the theme token)
 *   blog / newsletter / reputation  text-red-400  (a fixed palette colour)
 *
 * That is not a style nit. `--danger` is defined twice in globals.css — #d65a52
 * on the light theme and #b04a43 on the dark one — so `text-danger` follows the
 * theme and `text-red-400` does not. Three of the six intake forms therefore
 * printed their validation errors in a colour that ignores the theme the rest of
 * the page is painted in, and no one could have noticed by reading one file.
 *
 * WHY A MODULE AND NOT SIX FIXED COPIES. Six copies were how they drifted. This
 * is the house shape — one place writes it down, every caller asks — and
 * `intake-shared-sections.test.ts` reads the intake sources and fails if a
 * seventh copy appears.
 *
 * SCOPE. Presentational leaves only: no state, no actions, no copy that names a
 * platform. The feedback box is a section rather than a field and lives in
 * `intake-feedback-box.tsx`; the save funnel is `lib/intake-save.ts`.
 */

/**
 * The marker for a field the server refuses to save empty.
 *
 * The seat forms rejected a blank "must never post" answer while marking nothing
 * required, so the only way to learn the rule was to fail the save.
 */
export function RequiredMark() {
  return <span className="ml-1 text-danger">*</span>;
}

/**
 * The validation line under a field, or nothing when there is no error.
 *
 * A function rather than a component because all six call sites already read
 * `{fieldError(error)}` inline, and changing that shape at 40-odd sites would be
 * churn with no reader.
 */
export function fieldError(error: string | null) {
  return error ? <p className="mt-2 text-xs text-danger">{error}</p> : null;
}
