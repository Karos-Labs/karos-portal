/**
 * Who a client is told did the work.
 *
 * Pure and client-safe (no server-only imports) so the projection that redacts
 * an activity row and the cron that writes one read the same names.
 *
 * ActivityLog stores an actor NAME, not a uid — deliberately, so a client's
 * timeline never carries staff uids. But that also means whatever a writer put
 * there reaches the reader verbatim, and the automated writers put internal
 * service names there: the runway sweep dispatches through submitManagedJob,
 * which logs `actor: user.name` from its synthetic admin, so "Runway autopilot"
 * landed in the Activity tab of every client it topped up.
 *
 * That is two problems in one row. It is an internal codename a client has no
 * way to interpret, and it advertises that the work was scheduled by a machine
 * on a surface whose entire job is to narrate steady, attended work (A3/A4 —
 * the same ruling that collapsed per-run rows so a week of posts stops reading
 * as one generation lump).
 *
 * Staff keep the real name: they are the ones who need to know which sweep
 * fired, and the raw row is unchanged on disk.
 */

/**
 * The synthetic actor the runway sweep dispatches as. Exported so the route and
 * this registry cannot drift — a rename in one place would otherwise silently
 * un-redact the name in the other.
 */
export const RUNWAY_ACTOR_NAME = "Runway autopilot";

/** The name the AI-authored rows are signed with (intel, competitor analysis). */
export const SYSTEM_AI_ACTOR_NAME = "System AI";
/** The cron that fires due scheduled runs, agency-billed. */
export const SCHEDULER_ACTOR_NAME = "Scheduler";
/** The same cron when the run is billed to the client's own credits. */
export const CLIENT_SCHEDULE_ACTOR_NAME = "Client schedule";

/**
 * Internal actors that must never reach a client's timeline under their own
 * name. Matched case-insensitively on the stored string, because that is all
 * the row carries.
 *
 * Every writer of one of these names imports it from here rather than typing
 * the string, and a guard test (activity-actors.test.ts) fails on any bare
 * `actor: "…"` literal outside the client-safe display names. A registry that
 * writers can drift away from is a registry that redacts the names nobody uses
 * any more.
 */
export const INTERNAL_ACTOR_NAMES: readonly string[] = [
  RUNWAY_ACTOR_NAME,
  SYSTEM_AI_ACTOR_NAME,
  SCHEDULER_ACTOR_NAME,
  CLIENT_SCHEDULE_ACTOR_NAME,
];

const INTERNAL_ACTORS: ReadonlySet<string> = new Set(
  INTERNAL_ACTOR_NAMES.map((name) => name.toLowerCase()),
);

/** What a client-facing row says instead — the same name the job rows use. */
export const CLIENT_SAFE_ACTOR = "Karos";

export function isInternalActor(actor: string): boolean {
  return INTERNAL_ACTORS.has(actor.trim().toLowerCase());
}

/**
 * The actor and role a CLIENT viewer may be shown. Non-client viewers are
 * handed the row untouched; callers pass `viewerIsClient` rather than a role so
 * the "View as Client" path cannot forget to redact.
 */
export function clientSafeActor(
  actor: string,
  actorRole: "system" | "staff" | "client",
  viewerIsClient: boolean,
): { actor: string; actorRole: "system" | "staff" | "client" } {
  if (!viewerIsClient || !isInternalActor(actor)) return { actor, actorRole };
  // Role moves with the name ON THIS BRANCH, and only here. What is being
  // renamed is one of the four INTERNAL_ACTOR_NAMES — a cron or a synthetic
  // dispatcher — so the event really was automated, and leaving a "staff" claim
  // on it would put a person behind a machine's work.
  //
  // That is a fact about THESE FOUR NAMES, not a ban on the pairing:
  // `sessionSafeActor` below deliberately writes {"Karos", "staff"} for an
  // impersonated session, where a Karos staff member genuinely did the work and
  // "staff" is the true half of the row. The two are consistent because the
  // rename here is triggered by an automated actor and the rename there is
  // triggered by a human one. "Karos" is a display name for the agency, not a
  // synonym for automation.
  return { actor: CLIENT_SAFE_ACTOR, actorRole: "system" };
}

/**
 * WHO A ROW MAY SAY DID IT, given the session that wrote it.
 *
 * "View as Client" swaps the session: `getCurrentUser` returns the TARGET user
 * carrying `impersonatedBy`, so `user.name` is the client contact's name and
 * `user.role` is CLIENT_USER. Every writer that stamps a row with
 * `actor: user.name, actorRole: user.role === "CLIENT_USER" ? "client" : "staff"`
 * therefore signed a staff member's work with the client's own name — on the
 * timeline both of them read. The trail could not answer "did the client do
 * this, or did we do it for them", which is the question it exists for.
 *
 * WHAT IS CORRECTED, and nothing else: a row that claims `actorRole: "client"`
 * written under an impersonated session. That claim is only ever DERIVED from
 * the session — no writer in this codebase passes the literal `"client"`; every
 * one of them tests the session user's role — so a "client" claim during an
 * impersonated request is exactly the false one. A `"system"` row is left alone
 * (the automation really did fire), and so is a `"staff"` row (already true).
 *
 * WHY THE NAME BECOMES "Karos" rather than the admin's: ActivityLog stores a
 * display NAME and this row reaches the client's own timeline. `CLIENT_SAFE_ACTOR`
 * is true of it — a Karos staff member did the work — and it is the same word
 * the client already sees for agency-side events, so nothing new has to be
 * explained to them. WHICH staff member is the debugging half, and it rides in
 * `impersonatedBy` (a uid), which stays server-side: the timeline's RSC
 * projection is a whitelist of seven fields and this is not one of them.
 *
 * THE ROLE STAYS "staff", and that is not the pairing clientSafeActor forbids.
 * A person did this work, so "system" would be a second false claim replacing
 * the first. clientSafeActor moves an internal name to `"system"` because the
 * four names it rewrites belong to crons and synthetic dispatchers; the rule is
 * about those names, not about the word "Karos", which is simply what a client
 * is told the agency is called. `isInternalActor("Karos")` is false, so a row
 * written here passes back through that function untouched on the client's own
 * timeline — {"Karos", "staff"} is what they see, and both halves are true.
 *
 * NOT RETROACTIVE, checked: nothing filters, groups or matches on `actor` other
 * than `isInternalActor` (and "Karos" is not one of those four names), and
 * nothing matches on `actorRole` at all — the timeline's three role branches
 * resolve to the same class. Rows already on disk keep reading exactly as they
 * did. `impersonatedBy` is absent from all of them, and absent is NOT read as
 * "the client definitely did this" anywhere — it cannot be, because history
 * never recorded the difference.
 *
 * Job and asset `createdBy` are deliberately untouched by this: four surfaces
 * match `createdBy === user.uid` to decide whether a run is the viewer's own,
 * so moving it to the admin's uid would change what a client sees of rows
 * written years apart. That is the retroactive half, and this is not it.
 */
export function sessionSafeActor<
  T extends { actor: string; actorRole: "system" | "staff" | "client" },
>(row: T, session: { impersonatedBy?: string } | null | undefined): T & { impersonatedBy?: string } {
  if (row.actorRole !== "client" || !session?.impersonatedBy) return row;
  return {
    ...row,
    actor: CLIENT_SAFE_ACTOR,
    actorRole: "staff",
    impersonatedBy: session.impersonatedBy,
  };
}
