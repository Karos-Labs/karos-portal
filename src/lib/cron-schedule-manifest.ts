/**
 * Every route in this app that only a scheduler may call, and whether anything
 * is scheduled to call it.
 *
 * ## Why this file exists
 *
 * A route guarded by `requireCronSecret` cannot be reached by a user, a client
 * or the UI. If no Cloud Scheduler job points at it, it never runs — and
 * nothing anywhere says so. The code is present, its tests pass, its doc
 * comment describes what it does every tick, and it has never ticked.
 *
 * Measured on 2026-09-23: **ten of the fourteen** routes below had no scheduler
 * job in production. Two of those ten say so in their own doc comments —
 * `followers/sync` opens *"all built, all tested, all unreachable, because
 * nothing"* — which is precisely how invisible this is: the author knew, wrote
 * it down, and the sentence went where no checklist could read it.
 *
 * The damage was not evenly spread, and guessing would have got it backwards.
 * `publish` looked like the worst case — no auto-publish cron means scheduled
 * posts never go out — and its real impact was zero, because every scheduled
 * asset in both databases is `publishMode: "manual"`, which that cron
 * deliberately never touches. The one with actual victims was
 * `agent-engine/reconcile`: five runs that the engine finished sat in the
 * portal as `queued`, with no deliverable, because the only other completion
 * channel is a human opening the Job page.
 *
 * ## What this file is, and what it is not
 *
 * It is a statement of INTENT, checked for completeness by
 * `cron-schedule-manifest.test.ts`: every `requireCronSecret` route on disk
 * appears here exactly once, and every route here exists on disk. Add a cron
 * route and the test fails until you say what should call it.
 *
 * It is NOT a report of what GCP currently has — nothing in this repo can read
 * that, and a field claiming to would go stale the first time somebody paused a
 * job. `productionSchedule` says what the route needs; verifying it against the
 * project is one command, and it belongs in a deploy checklist rather than in a
 * unit test:
 *
 *     gcloud scheduler jobs list --project=karoscmo --location=europe-west1
 *     gcloud scheduler jobs list --project=karoscmo --location=us-central1
 *
 * ## Prep is meant to have none of these
 *
 * `DEPLOY_ENVIRONMENTS.md` says it twice: *"No Cloud Scheduler job should point
 * at prep's `/api/publish`, `/api/analytics/sync`, `/api/*​/reconcile`, etc.
 * Only wire Cloud Scheduler to production."* Prep's `CRON_SECRET` exists so
 * these routes answer 401 rather than 503, not so anything calls them. So the
 * unreconciled jobs sitting in prep are that policy working, and are not
 * evidence of a defect here.
 *
 * ## Creating one
 *
 *     gcloud scheduler jobs create http <name> \
 *       --project=karoscmo --location=europe-west1 \
 *       --schedule="<productionSchedule>" --http-method=GET \
 *       --uri="https://app.karoslabs.com<path>" \
 *       --headers="Authorization=Bearer $(gcloud secrets versions access latest \
 *           --secret=CRON_SECRET --project=karoscmo)"
 */

export interface CronRoute {
  /** Path under `src/app/api`, exactly as the directory is named. */
  readonly path: string;
  /**
   * The cron expression production needs, or `null` when production should
   * deliberately NOT schedule it — which then requires `whyNot`.
   */
  readonly productionSchedule: string | null;
  /** What the route does per tick, in one line — the reason a reader cares that it runs. */
  readonly does: string;
  /** Required when `productionSchedule` is null: why nothing should call it. */
  readonly whyNot?: string;
}

export const CRON_ROUTES: readonly CronRoute[] = [
  {
    path: "agent-engine/project-context",
    productionSchedule: null,
    does: "Backfills each client's projected context docs into the engine workspace.",
    whyNot:
      "A backfill, not a sweep. It is a route only because the projection modules " +
      "import `server-only` and cannot run under tsx; it is invoked by hand when a " +
      "projection changes shape. A schedule would re-walk every client forever to " +
      "no end.",
  },
  {
    path: "agent-engine/reconcile",
    productionSchedule: "*/10 * * * *",
    does:
      "Syncs engine runs into portal jobs and attaches the deliverable — both the " +
      "in-flight sweep and the already-terminal-but-unmaterialized one.",
  },
  {
    path: "agent-service/reconcile",
    productionSchedule: null,
    does: "Polls agent-service for jobs stuck queued/running past a threshold.",
    whyNot:
      "agent-service was torn down on 2026-09-02. This polls a service that no " +
      "longer answers, so a schedule would spend a tick every few minutes " +
      "producing timeouts. It stays on disk because a handful of clients were " +
      "still routed at it when it went; it must not be wired.",
  },
  {
    path: "analytics/sync",
    productionSchedule: "0 */6 * * *",
    does:
      "Pulls per-asset performance from every connected integration into " +
      "`clientMarketingAnalytics` — the rows the Task Map reads back to bias new " +
      "content toward what worked.",
  },
  {
    path: "cleanup-logs",
    productionSchedule: "0 3 * * *",
    does: "Batch-deletes log documents older than the cutoff.",
  },
  {
    path: "credits/reconcile",
    productionSchedule: "*/15 * * * *",
    does:
      "Refunds client charges whose work died mid-flight. The charge is taken " +
      "before the run is queued, so without this a client pays for a run an " +
      "instance recycle killed.",
  },
  {
    path: "daily-digest",
    productionSchedule: "0 * * * *",
    does: "Mails each opted-in client their own calendar day, gated on their timezone.",
  },
  {
    path: "followers/sync",
    productionSchedule: "0 4 * * *",
    does:
      "Writes one follower-count row per client per platform per day — the series " +
      "behind the Home audience KPI.",
  },
  {
    path: "intel-report-schedule",
    productionSchedule: "*/10 * * * *",
    does: "Fires each client's due intel-report run.",
  },
  {
    path: "publish",
    productionSchedule: "*/5 * * * *",
    does:
      "Publishes scheduled assets whose time has passed and whose publishMode is " +
      "`auto`. Manual and placeholder items are never touched here.",
  },
  {
    path: "run-scheduled",
    productionSchedule: "*/10 * * * *",
    does: "Drains `plannedScheduledRuns`, with an explicit bill decision per row.",
  },
  {
    path: "runway",
    productionSchedule: "0 8 * * 1",
    does:
      "Tops up each client's content runway: measures how many days of scheduled " +
      "posts are left against the horizon and dispatches the jobs needed to refill it.",
  },
  {
    path: "scheduler",
    productionSchedule: "*/5 * * * *",
    does: "Fires legacy `scheduledRuns` rows. The unbilled second scheduling system.",
  },
  {
    path: "tasks/auto-generate",
    productionSchedule: "0 */12 * * *",
    does:
      "Runs the Task Map swarm for any active client whose calendar is sparse and " +
      "who has no unreviewed suggestions waiting.",
  },
];

/** Routes production is expected to schedule. The deploy checklist's list. */
export function scheduledCronRoutes(): readonly CronRoute[] {
  return CRON_ROUTES.filter((r) => r.productionSchedule !== null);
}
