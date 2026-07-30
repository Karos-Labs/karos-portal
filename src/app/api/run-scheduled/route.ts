import { type NextRequest, NextResponse } from "next/server";
import {
  claimPlannedScheduledRun,
  getClient,
  getUser,
  listDuePlannedScheduledRuns,
  updatePlannedScheduledRun,
} from "@/lib/data";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { computeNextRun } from "@/lib/scheduled-runs";
import { requireCronSecret } from "@/lib/cron-auth";
import { notifyScheduleFireFailure } from "@/lib/job-alerts";
import type { AppUser, PlannedScheduledRun } from "@/lib/types";

import { CLIENT_SCHEDULE_ACTOR_NAME, SCHEDULER_ACTOR_NAME } from "@/lib/activity-actors";
export const maxDuration = 120;

/** A stored refusal is one readable sentence on the schedule row, not a log. */
const MAX_ERROR_CHARS = 400;

/**
 * Scheduled-run cron. Every tick it drains active ScheduledRuns whose nextRunAt
 * has passed and fires the custom agent via the same core the web action uses
 * (submitCustomAgentJob) — so a scheduled run is indistinguishable from a manual
 * one once it fires. One-off runs complete; recurring runs advance to their next
 * slot. The actor is the run's creator: a staff-created schedule fires free,
 * while a schedule a client switched on (billClientCredits) charges that
 * client's credits on every fire, outputsPerRun included.
 *
 * Every fire that produces nothing — a credit refusal, a spend cap, missing
 * intake, the agent service being unreachable — is refused by the submit core
 * before a job row exists, leaving no job, no failed status and no charge
 * behind. Every such refusal is recorded on the schedule row as
 * lastError/lastErrorAt, and a fire that succeeds clears them. The agent card
 * reads those fields, so a schedule that can never fire is visible instead of
 * silently green.
 *
 * Idempotent under redelivery/overlap: `claimPlannedScheduledRun` is a
 * compare-and-set on nextRunAt (same shape as the legacy scheduler's
 * `claimScheduledRun`), claimed BEFORE submission — so a concurrent tick, or a
 * submit that throws, can't fire the same window twice. This used to be a
 * plain read-then-write (`listDuePlannedScheduledRuns` +
 * `updatePlannedScheduledRun`, no transaction), which let an overlapping
 * invocation re-read and double-fire the same due row.
 */
export async function GET(req: NextRequest) {
  // Fails closed in production when CRON_SECRET is unset — this route used to
  // hand-roll its own check that only enforced the header when the secret
  // happened to be set, i.e. failed OPEN if it was ever misconfigured/unset.
  const unauthorized = requireCronSecret(req);
  if (unauthorized) return unauthorized;

  const now = Date.now();
  const due = await listDuePlannedScheduledRuns(now, 25);
  if (due.length === 0) {
    return NextResponse.json({ processed: 0, results: [] });
  }

  // The run's creator is the acting user (for provenance / activity logs).
  // Fall back to a synthetic system actor if that account is gone.
  const actorCache = new Map<string, AppUser>();
  async function actorFor(run: PlannedScheduledRun): Promise<AppUser> {
    const cached = actorCache.get(run.createdBy);
    if (cached) return cached;
    const stored = await getUser(run.createdBy);
    const user = stored ?? ({
      uid: run.createdBy || "scheduler",
      name: run.billClientCredits ? CLIENT_SCHEDULE_ACTOR_NAME : SCHEDULER_ACTOR_NAME,
      ...(run.billClientCredits
        ? { role: "CLIENT_USER", clientId: run.clientId }
        : { role: "KAROS_ADMIN" }),
    } as AppUser);
    actorCache.set(run.createdBy, user);
    return user;
  }

  type RunResult = {
    runId: string;
    status: "submitted" | "failed" | "skipped";
    jobId?: string;
    error?: string;
  };

  // Sequential (not concurrent) — each submission is a network round-trip to the
  // agent service, and a tick's batch is capped at 25, so ordering keeps the
  // service's queue predictable without risking a timeout.
  const results: RunResult[] = [];
  for (const run of due) {
    // Claim first — advances nextRunAt (or completes a one-off) — so a
    // concurrent tick, or this same submit throwing below, can't fire the same
    // window twice. Computed before the claim since the transaction needs the
    // resolved value either way.
    const nextRunAt =
      run.cadence === "once"
        ? null
        : computeNextRun({
            cadence: run.cadence,
            hour: run.hour,
            minute: run.minute,
            weekday: run.weekday,
            weekdays: run.weekdays,
            dayOfMonth: run.dayOfMonth,
            from: now,
            // Advance in the zone the schedule's wall clock was set in. Without
            // it every recurrence drifts to this container's zone (UTC in prod).
            ...(run.timeZone ? { timeZone: run.timeZone } : {}),
          });
    const claimed = await claimPlannedScheduledRun(
      run.id,
      run.nextRunAt,
      nextRunAt == null ? { completed: true } : { nextRunAt },
    );
    if (!claimed) {
      // Another tick already claimed this row this window (overlap), or it was
      // paused/completed between the list read and here — not an error.
      results.push({ runId: run.id, status: "skipped" });
      continue;
    }

    try {
      const actor = await actorFor(run);
      const { jobId, error } = await submitCustomAgentJob(actor, {
        clientId: run.clientId,
        agentId: run.customAgentId,
        prompt:
          (run.outputsPerRun ?? 1) > 1
            ? `Create exactly ${run.outputsPerRun} distinct outputs for this scheduled run.\n\n${run.prompt}`
            : run.prompt,
        chargeMultiplier: run.billClientCredits ? (run.outputsPerRun ?? 1) : 1,
        // A scheduled fire is a run TYPE, and until now it was the only one
        // that never said so — launches and manual template runs both stamp
        // themselves, so every recurring fire landed in the untyped bucket.
        // Everything §6 reports splits on this field: the client's ledger
        // breakdown separates scheduled from manual by it, and §6.3's
        // launch-price calibration uses scheduled+manual runs as the very
        // denominator it measures a launch against. Without the stamp both
        // are computed over a hole.
        runType: "scheduled",
        ...(run.clientAgentId ? { clientAgentId: run.clientAgentId } : {}),
      });

      // The claim already owns nextRunAt/status/lastRunAt — this follow-up
      // only records what the submission itself produced.
      await updatePlannedScheduledRun(run.id, {
        ...(jobId ? { lastJobId: jobId } : {}),
        // Refusals are surfaced on the client's agent card; a clean fire clears
        // the previous one so the card stops nagging once it recovers. Written
        // as null rather than omitted: Firestore is configured to ignore
        // undefined values, so an omitted key would leave the previous refusal
        // in place forever.
        lastError: error ? error.slice(0, MAX_ERROR_CHARS) : null,
        lastErrorAt: error ? Date.now() : null,
        updatedAt: Date.now(),
      });

      // A refusal here means no Job doc ever got created (the submit core
      // refused before writing one) — the literal "scheduled agent output did
      // not trigger" incident this alert exists for, with no job to link to.
      if (error) {
        const client = await getClient(run.clientId).catch(() => null);
        await notifyScheduleFireFailure({
          clientId: run.clientId,
          ...(client?.name ? { clientName: client.name } : {}),
          agentLabel: run.agentName,
          scheduleId: run.id,
          error,
        });
      }

      results.push(error ? { runId: run.id, status: "failed", error, jobId } : { runId: run.id, status: "submitted", jobId });
    } catch (e) {
      // The claim already advanced the cursor for this slot — a throw here
      // can't leave it double-fireable, only unrecorded, so just annotate the
      // refusal for the card rather than trying to preserve a cursor that has
      // already moved on.
      const message = e instanceof Error ? e.message : "Unknown error";
      try {
        await updatePlannedScheduledRun(run.id, {
          lastError: message.slice(0, MAX_ERROR_CHARS),
          lastErrorAt: Date.now(),
          updatedAt: Date.now(),
        });
      } catch {
        // The row may be gone — nothing left to annotate; the response below
        // still reports it.
      }
      const client = await getClient(run.clientId).catch(() => null);
      await notifyScheduleFireFailure({
        clientId: run.clientId,
        ...(client?.name ? { clientName: client.name } : {}),
        agentLabel: run.agentName,
        scheduleId: run.id,
        error: message,
      });
      results.push({ runId: run.id, status: "failed", error: message });
    }
  }

  return NextResponse.json({
    processed: due.length,
    submitted: results.filter((r) => r.status === "submitted").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    results,
  });
}
