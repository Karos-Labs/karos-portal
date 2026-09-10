/**
 * The three ways a client can steer an agent, and what each one's scope is
 * (pure, client-safe: imports nothing).
 *
 * WHAT LOLA REPORTED (SCRUM-411). "The second 'direction for this run' box is
 * repetitive and confusing, clashing with the first one."
 *
 * WHAT IS ACTUALLY THERE. Three inputs that all read as "tell the agent what to
 * write about", and not one of them stated its scope:
 *
 *   1. "What should we cover next?"  - LinkedIn, per person or page, standing
 *      until a run covers it and then closed.
 *   2. "What happened this week"     - company FACTS, one shared drop, fanned
 *      out to every agent that consumes news.
 *   3. "Anything to lean into this run?" - this one run, then gone.
 *
 * Two of them sit one above the other on the intake page and the third told the
 * reader to go and use the first instead. That redirect is most of what she read
 * as "clashing": a field whose own helper text says another box is the real one
 * has admitted it is a duplicate.
 *
 * THE MERGE THE TICKET ASKED FOR IS REFUSED, and this is the load-bearing
 * finding. It said to fold "What happened this week" into "What should we cover
 * next", and to check that box's consumers before deleting it. Checked:
 *
 *   - `CompanyNewsBox` is mounted on BOTH the X and the LinkedIn intake and
 *     writes to ONE collection (SCRUM-51, and its own docstring says "do not
 *     build a per-platform copy of this box").
 *   - Both `x-agent-context.ts` and `linkedin-agent-context.ts` read that
 *     collection - X as whats-new.json, LinkedIn as company-updates.md
 *     Section A.
 *   - It is not free text. It is title / date / type / url / detail / sourceUrl
 *     / consent, and `type` comes from a fixed pick-list the lab skill ROUTES
 *     by.
 *
 * So folding it into a LinkedIn-only, per-identity, free-text box would cut the
 * X agent off from company news and throw away the schema its skill routes on.
 * `DirectionRequestsBox`'s comment already said exactly this; the ticket's
 * heuristic - "two boxes that need a comment explaining why they are two boxes
 * are one box" - is a good one, and here the comment happens to be right.
 *
 * WHAT IS DONE INSTEAD. Each input states its own scope in one line, from this
 * module so the three cannot drift into describing each other again, and the
 * cross-reference is deleted. The distinction is real; it was simply never
 * written down where the reader is.
 */

/**
 * "What should we cover next?" - the standing, per-identity steer.
 *
 * WHAT IT USED TO SAY, and the actual clash: "a subject you want covered,
 * INFORMATION TO WORK IN, or just what you want next." The middle clause is the
 * news box's job, invited in the box above it. Meanwhile the news box said "we
 * turn it into the post", which is this box's job. Each paragraph claimed the
 * other's, on one screen, a few hundred pixels apart - so no reader could sort
 * them out, and Lola read them as one repeated box.
 *
 * It now says SUBJECT, who it is for, and the closing behaviour. That last part
 * is what separates it from a run note: the row survives until a run uses it,
 * so a reader who knows that stops re-typing it into the run dialog every time.
 */
export const STEER_STANDING_BODY =
  "This is the steering wheel. Add a line any day: a subject you want the next post to be about, and who it is for. It stays here until a run covers it, then closes itself. Leave it empty and the agent picks the subject.";

/**
 * "What happened this week" - the shared company-news drop.
 *
 * Says FACTS, and says every agent, which are the two things that make it not a
 * topic request. It already said the second; what it did not say is the first,
 * and it opened with "we turn it into the post", which reads as a request for
 * coverage rather than a place to file what is true.
 */
export const STEER_NEWS_BODY =
  "Facts about the company, not a topic request: one or two lines on what is new. Type it once and every agent that mentions your news works it in. Empty weeks are fine; the agents keep posting their regular content either way.";

/**
 * The run dialog's per-run field, renamed from "Anything to lean into this
 * run?" to the wording the rest of the product already uses (see
 * `engine-agent-card.tsx` and the dynamic profile in custom-agent-launch).
 *
 * The label now states the scope, which is why the helper no longer has to
 * point anywhere.
 */
export const STEER_RUN_LABEL = "Direction for this run (optional)";

/**
 * The per-run helper, with the redirect gone.
 *
 * It still says what the field does NOT do - Kind of post chooses the shape -
 * because that is SCRUM-409's correction and it is a fact about the engine
 * rather than about the other boxes. What it no longer does is tell the reader
 * that another box is the real one. A field whose own helper says that has
 * admitted it is a duplicate, and it is most of what "clashing" meant.
 *
 * NOT "above" (2026-09-10). The launch profile DECLARES Kind of post before this
 * field, but the form paints the primary field first and folds the rest into
 * "More options" underneath, so on screen Kind of post is below this helper and
 * hidden until opened.
 */
export const STEER_RUN_HELPER_WITH_KIND =
  "Steers this run only. Kind of post still decides the shape.";

/** The same field on a profile with no "Kind of post" select to defer to. */
export const STEER_RUN_HELPER =
  "Steers this run only. The agent works from your stored agent data either way.";
