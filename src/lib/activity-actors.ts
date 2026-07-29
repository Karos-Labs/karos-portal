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
  // Role moves with the name: a row labelled "Karos" that still claims a staff
  // actor would put a person behind an automated event.
  return { actor: CLIENT_SAFE_ACTOR, actorRole: "system" };
}
