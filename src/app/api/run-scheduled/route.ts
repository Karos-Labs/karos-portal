import { type NextRequest, NextResponse } from "next/server";
import {
  claimPlannedScheduledRun,
  getClient,
  getUser,
  listDuePlannedScheduledRuns,
  updatePlannedScheduledRun,
} from "@/lib/data";
import { getAgentSlot } from "@/lib/data-client-agents";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { computeNextRun } from "@/lib/scheduled-runs";
import { agentSlotDocId, dateKeyInZone } from "@/lib/client-agents";
import { isValidTimeZone, runtimeTimeZone } from "@/lib/run-cadence";
import { requireCronSecret } from "@/lib/cron-auth";
import { notifyScheduleFireFailure } from "@/lib/job-alerts";
import type { AppUser, PlannedScheduledRun } from "@/lib/types";

import { CLIENT_SCHEDULE_ACTOR_NAME, SCHEDULER_ACTOR_NAME } from "@/lib/activity-actors";
export const maxDuration = 120;

/** A stored refusal is one readable sentence on the schedule row, not a log. */
const MAX_ERROR_CHARS = 400;

/**
 * Why this fire produced nothing on purpose — the day it would have produced
 * for is already spoken for.
 *
 * THE ASKED QUESTION, narrowly: "this fire is about to produce ONE post for ONE
 * day; does that day's slot already hold one?" The 2026-07-30 product rule is
 * that a filled slot must not keep its run armed, and until now no code asked at
 * all: the cron read the schedule row and nothing else — no slot read, no asset
 * read, no per-day check — before claiming and submitting. A day whose post
 * already existed got a second one generated, and the client was charged for it.
 *
 * WHAT COUNTS AS FILLED, named by the write that produces each state: an asset
 * linked to the day (`assetId` — the options-batch slicer and the option pick
 * both write it), a generation job already holding it (`jobId`), a day already
 * published (`posted`), and a day someone removed from the plan (`skipped` — a
 * removed day is not a day to produce for either).
 *
 * THREE FIRES THIS DOES NOT SPEAK FOR, each because it is not a one-post-for-
 * this-day fire, and each dangerous to get wrong in the other direction — a
 * check that swallowed one of these would silently stop the product:
 *
 *  · A SCHEDULE WITH NO UMBRELLA (`clientAgentId` absent — every row written
 *    before the slot model). There is no plan to consult.
 *  · A BATCH FIRE (`outputsPerRun > 1`). It produces several posts across
 *    several days; today's slot being taken says nothing about the other four.
 *  · AN OPTIONS DAY (`slot.kind === "options"` — the X pick-of-three model).
 *    Those days are filled by the weekly batch slicer, not by the fire, and the
 *    schedule that fires is the batch's producer: reading last week's refs on
 *    today's slot as "already done" would stop the batch that fills next week.
 *    Same `kind` boundary matchAssetsToSlots draws for the same reason.
 *    RESIDUAL, therefore: per-day duplication on an options umbrella is not
 *    covered here.
 *
 * A day with no slot doc is not evidence of a fill either, and treating it as
 * one would stop every schedule whose horizon has not been generated — an
 * outage dressed as a safety rule. The fail-closed direction that DOES matter
 * here is money, and it holds: a Firestore error throws into the caller's
 * catch, which records the refusal and alerts, and never submits.
 */
async function filledSlotReason(
  run: PlannedScheduledRun,
  at: number,
): Promise<string | null> {
  if (!run.clientAgentId) return null;
  if ((run.outputsPerRun ?? 1) > 1) return null;
  const zone = isValidTimeZone(run.timeZone) ? run.timeZone : runtimeTimeZone();
  const slot = await getAgentSlot(agentSlotDocId(run.clientAgentId, dateKeyInZone(at, zone)));
  if (!slot) return null;
  if ((slot.kind ?? "single") !== "single") return null;
  if (slot.status === "skipped") return "This day was removed from the plan.";
  if (slot.status === "posted") return "This day's post is already published.";
  if (slot.assetId) return "This day's post already exists.";
  if (slot.jobId) return "This day's post is already being produced.";
  return null;
}

/**
 * Scheduled-run cron. Every tick it drains active ScheduledRuns whose nextRunAt
 * has passed and fires the custom agent via the same core the web action uses
 * (submitCustomAgentJob) — so a scheduled run is indistinguishable from a manual
 * one once it fires. One-off runs complete; recurring runs advance to their next
 * slot.
 *
 * TWO SEPARATE QUESTIONS, deliberately answered by two different fields:
 *  · WHO ACTS is `createdBy` — provenance for the activity log and the
 *    CLIENT_USER allowlist gate. Frozen at creation; never rewritten.
 *  · WHO PAYS is `billClientCredits`, handed to the submit core as `bill`. A
 *    schedule a client switched on charges that client's credits on every fire,
 *    outputsPerRun included; a staff-set pace fires free.
 * These used to collapse into one — the actor decided both — so an edit that
 * rewrote the flag without touching createdBy moved money the wrong way.
 *
 * A fire that produces nothing IN THIS PROCESS — a credit refusal, a spend cap,
 * missing intake, the agent service being unreachable, a throw — is refused by
 * the submit core before a job row exists, leaving no job, no failed status and
 * no charge behind, and is recorded on the schedule row as
 * lastError/lastErrorAt; a fire that succeeds clears them. The agent card reads
 * those fields, so a schedule that can never fire is visible instead of
 * silently green.
 *
 * A fire that ENDS WITH THE PROCESS records none of that, and cannot: the
 * claim below advances the cursor and stamps lastRunAt before the submit, so a
 * Cloud Run timeout or a container recycle in that window leaves a row with a
 * fresh lastRunAt, a null lastError, an advanced nextRunAt and no job. The
 * ordering is deliberate and stays — reversing it trades a silent miss for a
 * double fire, which costs money — so the window is made OBSERVABLE instead:
 * the claim opens `fireInFlightSince`, every settlement path below closes it,
 * and a row that still has one open at its next claim gets a fire-failure
 * alert naming the vanished fire. The residual is a delay, not a hole: the
 * report waits for that row's next due tick, since nothing else visits the row.
 *
 * Idempotent under redelivery/overlap: `claimPlannedScheduledRun` is a
 * compare-and-set on nextRunAt (same shape as the legacy scheduler's
 * `claimScheduledRun`), claimed BEFORE submission — so a concurrent tick, or a
 * submit that throws, can't fire the same window twice. This used to be a
 * plain read-then-write (`listDuePlannedScheduledRuns` +
 * `updatePlannedScheduledRun`, no transaction), which let an overlapping
 * invocation re-read and double-fire the same due row.
 *
 * ONE FIRE PER CALENDAR DAY, the other half of "can't fire the same window
 * twice": the advance passes `lastRunAt` so no recomputed cursor lands on a day
 * this schedule already produced for (see computeNextRun), and a day whose slot
 * is already filled is skipped before the submit rather than duplicated
 * (filledSlotReason).
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

  // The run's creator is the acting user (for provenance / activity logs, and
  // the submit core's CLIENT_USER allowlist gate). It no longer decides who
  // pays — `bill` below does — so a resolved actor whose role disagrees with the
  // stored flag can't move money any more.
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
    /** Why a skip happened — the two kinds are not the same event. */
    reason?: string;
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
            // The day this tick is firing is spent. Normally that changes
            // nothing — today's slot is at or before `now`, so the walk skips it
            // anyway — but a CATCH-UP fire does not have that property: a cursor
            // stranded on last Friday, drained at 08:00 on a Monday, used to
            // advance to Monday 09:00 and fire again an hour later. Two posts
            // and two charges on one day, from one backlog.
            lastRunAt: now,
          });
    const claimed = await claimPlannedScheduledRun(
      run.id,
      run.nextRunAt,
      nextRunAt == null ? { completed: true } : { nextRunAt },
    );
    if (!claimed) {
      // Another tick already claimed this row this window (overlap), or it was
      // paused/completed between the list read and here — not an error.
      results.push({ runId: run.id, status: "skipped", reason: "Already claimed by another tick." });
      continue;
    }

    try {
      // The claim we just won is the ONLY moment this row's previous fire can
      // be audited: `fireInFlightSince` is opened by every claim and closed by
      // every settle below, so finding one still open on the row we READ means
      // the fire before this one never settled — the process died between
      // claiming the slot and submitting. That fire left a fresh lastRunAt, a
      // null lastError and an advanced nextRunAt, i.e. nothing else on the row
      // tells it apart from a clean one. Reported, not repaired: the slot it
      // held is gone, and re-firing it here would be a charge for a window
      // nobody can reconstruct. Inside the try so a failure to REPORT a lost
      // fire cannot cost the rest of the batch its own fires.
      if (typeof run.fireInFlightSince === "number") {
        const client = await getClient(run.clientId).catch(() => null);
        await notifyScheduleFireFailure({
          clientId: run.clientId,
          ...(client?.name ? { clientName: client.name } : {}),
          agentLabel: run.agentName,
          scheduleId: run.id,
          error: `A previous fire claimed its slot at ${new Date(
            run.fireInFlightSince,
          ).toISOString()} and never completed — no job was recorded for it.`,
        });
      }

      // Nothing has been submitted or charged yet, so a day that is already
      // spoken for costs only the cursor advance the claim already made.
      const filled = await filledSlotReason(run, now);
      if (filled) {
        await updatePlannedScheduledRun(run.id, {
          fireInFlightSince: null,
          updatedAt: Date.now(),
        });
        results.push({ runId: run.id, status: "skipped", reason: filled });
        continue;
      }

      const actor = await actorFor(run);
      const { jobId, error } = await submitCustomAgentJob(actor, {
        clientId: run.clientId,
        agentId: run.customAgentId,
        prompt:
          (run.outputsPerRun ?? 1) > 1
            ? `Create exactly ${run.outputsPerRun} distinct outputs for this scheduled run.\n\n${run.prompt}`
            : run.prompt,
        // WHO PAYS: the STORED flag, not the resolved actor.
        //
        // `billClientCredits` is documented as the switch for whether each fire
        // spends the client's credits, and until now it decided nothing of the
        // kind — the submit core charged purely on isBillableClientActor(actor),
        // and the actor comes from `createdBy`, which an edit never rewrites
        // while the flag was recomputed on every save. The two drifted and money
        // moved the wrong way in both directions (staff-created + client-saved
        // fired free against a quoted price; a "View as Client" creation charged
        // the client the flag said not to charge). Passing it as `bill` makes the
        // documented field the decision.
        //
        // LEGACY ROWS: `billClientCredits` is optional, and rows written before
        // it existed have it undefined. `=== true` would silently make every one
        // of those free — a fleet of schedules quietly stopping charging is the
        // worst outcome available here — so an absent flag omits `bill`
        // entirely and the core falls back to the actor test, i.e. that row
        // keeps doing exactly what it does today. Only a row that actually
        // recorded an intent gets to override the actor.
        ...(typeof run.billClientCredits === "boolean" ? { bill: run.billClientCredits } : {}),
        // Unconditional now that billing is explicit: the multiplier prices the
        // batch, it does not decide whether to charge. A billed fire lands on
        // the same figure as before (flag true ⇒ outputsPerRun either way), and
        // an unbilled one never reaches the charge at all. Safe for legacy rows
        // too: outputsPerRun and billClientCredits were added in the same commit
        // and are written together by the only action that writes either, so no
        // row can carry outputsPerRun > 1 with the flag unset.
        chargeMultiplier: run.outputsPerRun ?? 1,
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
        // The fire settled — submitted or refused, either way it reached an
        // end the row records. Closing the window here is what makes an
        // UNCLOSED one at the next claim mean something.
        fireInFlightSince: null,
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
          // A throw is a settled fire too — it left a recorded refusal and an
          // alert. Leaving the window open would report it twice, once here and
          // again as a vanished fire at the next claim.
          fireInFlightSince: null,
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
