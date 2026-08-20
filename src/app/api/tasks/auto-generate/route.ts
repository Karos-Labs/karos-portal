import { type NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import {
  listClients,
  listClientIntegrations,
  listAssets,
  listClientTasks,
  tryAcquireAiProcessingLock,
  releaseAiProcessingLock,
} from "@/lib/data";
import { integrationIsUsable } from "@/lib/integration-status";
import { computePlatformGaps, gapPlatformNames, CONTENT_GAP_HORIZON_DAYS } from "@/lib/calendar-gaps";
import { buildSwarmContext, runSwarmToCompletion } from "@/lib/agent-swarm";
import { logger } from "@/services/logger";

// Each eligible client runs a full multi-round swarm debate (up to ~120s —
// see /api/tasks/generate-swarm's own maxDuration), so this sweep bounds how
// many it actually generates for per invocation (SWEEP_CAP_DEFAULT below)
// rather than bounding wall-clock directly. Same envelope runway/analytics use.
export const maxDuration = 300;

/**
 * Task Map autopilot — the automatic half of "recommended tasks" a client
 * previously only got by someone pressing "Refresh Task Map" by hand. On each
 * run it walks every active client, and for any client whose calendar is
 * sparse (computePlatformGaps/gapPlatformNames — the SAME gap math the swarm
 * itself reasons from and the calendar's own nudge banner reads, so all three
 * can never disagree about "sparse") AND has no pending suggestions already
 * sitting unreviewed, it runs the swarm and persists whatever it proposes.
 *
 * Built 2026-08 after a client ("sitti") went sparse with nobody having
 * pressed the manual button and nothing filling the gap — the staleness/
 * backlog reasoning added earlier that same week made the swarm SMARTER once
 * triggered, but nothing had ever wired up a trigger. This is that trigger.
 *
 * COST MODEL: free, like runway. `runSwarmToCompletion` (agent-swarm.ts) is
 * called directly — NOT the /api/tasks/generate-swarm route — so the route's
 * own chargeClientModelCall is never reached at all; there is no session,
 * billable or otherwise, for this sweep to charge. A client is never billed
 * for a recommendation they never asked for.
 *
 * ELIGIBILITY (all must hold): client.status === "active"; onboarding not
 * pending/running; zero existing pending karos_managed/copilot tasks (a
 * client already sitting on unreviewed suggestions gets nothing new piled on
 * top — same rule the sparse-calendar banner uses to decide which of its two
 * states to show); gapPlatforms.length > 0 (nothing to fix otherwise).
 *
 * SAFETY: gated on TASKMAP_AUTOGEN_ENABLED (off ⇒ measure/report only, same
 * convention as RUNWAY_AUTOGEN_ENABLED). `?dryRun=1` reports intended runs
 * without firing. The per-client AI-processing lock means a sweep can never
 * overlap a manual Refresh Task Map / Regenerate for the same client — it is
 * simply skipped this round and picked up (or already resolved) next time.
 * SWEEP_CAP bounds how many clients actually generate in one invocation, so a
 * day with many simultaneously-sparse clients can't blow the route's own
 * maxDuration; a client not reached this round is reported "skipped: sweep
 * cap reached" and is eligible again on the next scheduled run.
 *
 * Schedule via Cloud Scheduler (daily is the intent; more often just catches
 * up on the cap faster): GET, Authorization: Bearer <CRON_SECRET>.
 */

const SWEEP_CAP_DEFAULT = 3;

function resolveSweepCap(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return SWEEP_CAP_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return SWEEP_CAP_DEFAULT;
  return parsed;
}

// A synthetic uid, never a real user — mirrors runway's SYSTEM_USER.uid.
// ClientTask.createdBy is only ever compared for equality (e.g. "is this the
// viewer's own task"), never looked up as a user doc, so a string nobody owns
// is safe here: it simply never matches any real viewer.
const SYSTEM_CREATED_BY = "system-taskmap-autogen";

type ClientResult = {
  clientId: string;
  clientName: string;
  status: "generated" | "skipped" | "failed";
  gapPlatforms: string[];
  created?: number;
  detail?: string;
};

export async function GET(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const enabled = process.env.TASKMAP_AUTOGEN_ENABLED === "1";
  const sweepCap = resolveSweepCap(process.env.TASKMAP_AUTOGEN_SWEEP_CAP);
  const now = Date.now();

  const clients = await listClients();
  const results: ClientResult[] = [];
  let generated = 0;

  for (const client of clients) {
    const base = { clientId: client.id, clientName: client.name };
    try {
      // Only established, active accounts — same filter runway's sweep uses.
      if (client.status !== "active") {
        results.push({ ...base, status: "skipped", gapPlatforms: [], detail: `client status: ${client.status}` });
        continue;
      }
      if (client.onboardingStatus === "pending" || client.onboardingStatus === "running") {
        results.push({ ...base, status: "skipped", gapPlatforms: [], detail: `onboarding: ${client.onboardingStatus}` });
        continue;
      }

      // A client already sitting on unreviewed proposals gets nothing piled
      // on top — the same rule CalendarSparseBanner uses to pick its state.
      const pendingTasks = await listClientTasks({ clientId: client.id, status: "pending" });
      const hasPendingSuggestions = pendingTasks.some(
        (t) => t.owner === "karos_managed" && t.source === "copilot",
      );
      if (hasPendingSuggestions) {
        results.push({ ...base, status: "skipped", gapPlatforms: [], detail: "already has pending suggestions" });
        continue;
      }

      const [integrations, assets] = await Promise.all([
        listClientIntegrations(client.id),
        listAssets({ clientId: client.id }),
      ]);
      const connectedPlatforms = integrations
        .filter((i) => i.platform !== "google" && integrationIsUsable(i))
        .map((i) => i.platform);
      const gapPlatforms = gapPlatformNames(computePlatformGaps(assets, connectedPlatforms, now));

      if (gapPlatforms.length === 0) {
        results.push({ ...base, status: "skipped", gapPlatforms: [], detail: "calendar not sparse" });
        continue;
      }

      if (!enabled) {
        results.push({ ...base, status: "skipped", gapPlatforms, detail: "TASKMAP_AUTOGEN_ENABLED not set — report only" });
        continue;
      }
      if (dryRun) {
        results.push({ ...base, status: "skipped", gapPlatforms, detail: "dryRun" });
        continue;
      }
      if (generated >= sweepCap) {
        results.push({ ...base, status: "skipped", gapPlatforms, detail: "sweep cap reached — eligible again next run" });
        continue;
      }

      if (!(await tryAcquireAiProcessingLock(client.id))) {
        results.push({ ...base, status: "skipped", gapPlatforms, detail: "AI generation already running for this client" });
        continue;
      }

      let failure: string | undefined;
      try {
        const context = await buildSwarmContext(client.id);
        const { created } = await runSwarmToCompletion({
          clientId: client.id,
          createdBy: SYSTEM_CREATED_BY,
          context,
        });
        if (created > 0) generated++;
        results.push({ ...base, status: "generated", gapPlatforms, created });
      } catch (e) {
        failure = e instanceof Error ? e.message : "unknown";
        results.push({ ...base, status: "failed", gapPlatforms, detail: failure });
      } finally {
        await releaseAiProcessingLock(client.id, failure);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      logger.logError({
        clientId: client.id,
        agentId: null,
        operation: "taskmap_autogen",
        errorMessage: `Task Map autogen sweep failed for ${client.name}: ${message}`,
        severity: "WARN",
      });
      results.push({ ...base, status: "skipped", gapPlatforms: [], detail: `error: ${message}` });
    }
  }

  return NextResponse.json({
    horizonDays: CONTENT_GAP_HORIZON_DAYS,
    dryRun,
    enabled,
    sweepCap,
    checked: clients.length,
    generated,
    results,
  });
}
