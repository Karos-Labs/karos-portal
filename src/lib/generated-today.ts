/**
 * What this client's agents produced TODAY, and where it goes next (pure,
 * client-safe: imports the Asset type and one day-key helper).
 *
 * WHY IT IS A MODULE AND NOT A COMPONENT'S FILTER (SCRUM-417/423). Two surfaces
 * ask the same question and Lola hit both: the home widget she asked for ("a
 * widget where you can see everything you have generated that day") and the
 * Assets page's top section ("generations should land in the assets page and
 * there should be clear indication of that upon generating"). Two hand-rolled
 * date filters is how one page says three things were made today and the other
 * says four.
 *
 * WHAT WAS THERE. Nothing named today. Home's nearest card is "Recent activity",
 * and for a CLIENT it is filtered to `isInClientArchive` - approved,
 * non-future, inside the 30-day window. So a client who ran three agents this
 * morning saw NOTHING on that card until a staff member approved the output,
 * which may be tomorrow. The card was not broken; it answers a different
 * question ("what has been delivered") and was standing where the reader's
 * actual question goes.
 *
 * `createdAt`, NOT the delivery stamp. This is the one client-facing list that
 * is deliberately about the GENERATION instant: "what came out today" is a
 * question about when the agent worked. Everywhere else a client reads
 * `clientDeliveryStamp`, because those lists are about when work ARRIVED, and
 * the two must not be confused - which is why this module names its own rule
 * rather than reusing `deliverableStamp`.
 *
 * SERVER-LOCAL CALENDAR DAY, through `runDayKey` - the helper the run-history
 * collapse already uses, and the reason this is not `Date.now() - 86400000`:
 * 23:30 and 00:30 are an hour apart and are two different days, and the label
 * the reader sees is a date, so the grain has to be the date's.
 */

import { runDayKey } from "@/lib/client-run-rows";
import type { Asset } from "@/lib/types";

/**
 * Was this asset generated on the same calendar day as `now`?
 *
 * NO VIEWER SPLIT, and that is the point of the widget. Every other client
 * list gates on `isInClientArchive` (approved, non-future, recent), which is
 * exactly what made today's output invisible to the client who asked for it. A
 * row here can be a draft still in review, and its badge says so through
 * `assetStatusLabel` - what it must not do is claim to be delivered.
 */
export function isGeneratedToday(asset: Pick<Asset, "createdAt">, now: number): boolean {
  return runDayKey(asset.createdAt) === runDayKey(now);
}

/**
 * Today's output, newest first.
 *
 * The caller slices. This returns the whole day so the caller can say how many
 * it is NOT showing - a count is the honest way to report a batch, and a list
 * that silently stops at five states that five is all there was.
 */
export function generatedToday<T extends Pick<Asset, "createdAt">>(
  assets: readonly T[],
  now: number,
): T[] {
  return assets
    .filter((a) => isGeneratedToday(a, now))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The one-line explanation Lola asked for, and the actual fix to her confusion.
 *
 * "A widget on the homepage where you can see everything you have generated
 * that day, after that it goes into the calendar (little explanation)." The
 * sentence is what connects this widget, the calendar widget and the assets
 * page into one story instead of three lists a reader has to reconcile.
 *
 * IT NAMES THE REVIEW STEP, because leaving it out would make the sentence
 * false: nothing reaches a client's calendar until a person has approved it.
 * And it names Calendar rather than "your Workspace" - Workspace is retired
 * from both shells, and Calendar is what the rail actually says.
 */
export const GENERATED_TODAY_EXPLAINER =
  "Everything your agents made today shows up here. Once it has a date, it lives in your Calendar.";

/** The heading, in one place, because two surfaces render it. */
export const GENERATED_TODAY_TITLE = "Generated today";

/**
 * What the card says when the day is empty.
 *
 * "Nothing today", NOT an error and not an empty-state scold. A client whose
 * agents run on a weekly schedule sees this on five days out of seven, and the
 * card has to read as normal on those days.
 */
export const GENERATED_TODAY_EMPTY_TITLE = "Nothing today";
export const GENERATED_TODAY_EMPTY_HINT =
  "Your agents have not produced anything yet today. When they do, it appears here first.";
