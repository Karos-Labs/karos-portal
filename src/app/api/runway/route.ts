import { type NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { listClients, listClientIntegrations, listAssets, listJobs } from "@/lib/data";
import { integrationIsUsable } from "@/lib/integration-status";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { submitManagedJob } from "@/lib/jobs/submit-managed";
import {
  computeRunway,
  dispatchesFor,
  FAMILY_PRODUCT,
  resolveMaxJobs,
  RUNWAY_HORIZON_DAYS,
  type RunwayProduct,
} from "@/lib/runway";
import { RUNWAY_ACTOR_NAME } from "@/lib/activity-actors";
import type { AppUser } from "@/lib/types";
import type { ChainFamily } from "@/lib/post-chain";
import { logger } from "@/services/logger";

// Long-running all-clients sweep — Cloud Scheduler triggers it; the Cloud Run
// container timeout governs. Same envelope as analytics/sync.
export const maxDuration = 300;

/**
 * Runway autopilot — the generation half of "every client always has a visible
 * runway of posts." On each run it walks every ACTIVE client, measures how far
 * their content calendar is filled against the RUNWAY_HORIZON_DAYS (14) horizon,
 * and — for any short family — fires one managed product run PER MISSING DAY to
 * refill it. The webhook turns those into draft assets and reflowClientChain
 * dates them onto the empty upcoming days, so the calendar never silently runs
 * dry (the Karos Labs "nothing after Friday" gap).
 *
 * Fill policy: the first sweep fills the whole 14-day buffer, and weekly sweeps
 * after it top back up to the same horizon (~7 once a week has passed), so every
 * client keeps at least a week of runway in hand. One run yields one asset, so
 * a deficit of 10 is 10 dispatches — dispatching one per family per sweep meant
 * a client who started empty never caught up.
 *
 * This replaces per-client manual "Refresh Task Map" clicks with a single
 * all-clients sweep — the missing orchestration that let generation scale past
 * a handful of clients.
 *
 * Cost model: dispatch goes through submitManagedJob with a SYSTEM actor, which
 * — exactly like a staff run — is agency overhead and never charges a client's
 * credits or spend caps. The only guardrail is the operational per-client cap
 * below (bounds the agency's own agent-service spend).
 *
 * Safety: gated on RUNWAY_AUTOGEN_ENABLED (off ⇒ measure/report only), the agent
 * service being configured, and client.status === "active". `?dryRun=1` reports
 * intended dispatches without firing. Idempotent — deficit-based, and a family
 * with an in-flight managed job is skipped so runs never stack.
 *
 * Schedule via Cloud Scheduler (weekly is enough; more often is harmless):
 * GET, Authorization: Bearer <CRON_SECRET>.
 */


/**
 * Families the autopilot may auto-dispatch. social_post and newsletter_issue
 * take no required brief fields, so a runway top-up needs no human input.
 * blog_article requires a real `topic` — left to the Task Map / manual flow —
 * so its deficit is reported but never auto-fired.
 */
const AUTOGEN_FAMILIES: ChainFamily[] = ["social", "email"];

const IN_FLIGHT: ReadonlySet<string> = new Set(["queued", "running"]);

// System actor: makes every dispatch free agency overhead, like a staff run.
// The name is a STAFF-facing codename — submitManagedJob logs it as the
// activity actor, and the client timeline redacts it through
// clientSafeActor (activity-actors.ts), which reads this same constant.
const SYSTEM_USER: AppUser = {
  uid: "system-runway",
  email: "runway@karoslabs.internal",
  name: RUNWAY_ACTOR_NAME,
  role: "KAROS_ADMIN",
  createdAt: 0,
};

type ClientResult = {
  clientId: string;
  clientName: string;
  status: "topped_up" | "on_track" | "skipped" | "failed";
  coveredThroughMs: number | null;
  deficit: Partial<Record<ChainFamily, number>>;
  dispatched: Array<{ family: ChainFamily; product: RunwayProduct; jobId?: string; error?: string }>;
  detail?: string;
};

export async function GET(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const enabled = process.env.RUNWAY_AUTOGEN_ENABLED === "1";
  const serviceReady = isAgentServiceConfigured();
  // Explicit undefined check, not `||`: RUNWAY_MAX_JOBS_PER_CLIENT=0 is how an
  // operator says "dispatch nothing this sweep" while leaving the report on,
  // and `|| HARD_CAP_DEFAULT` turned that into the default — the one value
  // whose meaning is exactly inverted. A non-numeric or negative value falls
  // back to the default; zero is honoured.
  const maxJobsPerClient = resolveMaxJobs(process.env.RUNWAY_MAX_JOBS_PER_CLIENT);
  const now = Date.now();

  const clients = await listClients();
  const results: ClientResult[] = [];
  let toppedUp = 0;
  let jobsDispatched = 0;

  for (const client of clients) {
    const base = { clientId: client.id, clientName: client.name };
    try {
      // Only established, active accounts. Paused/archived and still-onboarding
      // clients are left alone.
      if (client.status !== "active") {
        results.push({ ...base, status: "skipped", coveredThroughMs: null, deficit: {}, dispatched: [], detail: `client status: ${client.status}` });
        continue;
      }
      // "failed" here means the one-time intel/context-doc research run
      // degraded (pipeline.ts's research-agent quality gate) — it is NOT a
      // content-generation readiness signal (agent-swarm / submitManagedJob
      // never check it), so it must not block the autopilot. Only "pending"/
      // "running" — genuinely still mid-setup — are skipped.
      if (client.onboardingStatus === "pending" || client.onboardingStatus === "running") {
        results.push({ ...base, status: "skipped", coveredThroughMs: null, deficit: {}, dispatched: [], detail: `onboarding: ${client.onboardingStatus}` });
        continue;
      }

      const [integrations, assets] = await Promise.all([
        listClientIntegrations(client.id),
        listAssets({ clientId: client.id }),
      ]);
      const connectedPlatforms = integrations
        .filter((i) => i.platform !== "google" && integrationIsUsable(i))
        .map((i) => i.platform);

      const runway = computeRunway(assets, connectedPlatforms, now);
      const deficit: Partial<Record<ChainFamily, number>> = {};
      for (const f of runway.shortFamilies) deficit[f] = runway.deficitByFamily[f];

      if (runway.shortFamilies.length === 0) {
        results.push({ ...base, status: "on_track", coveredThroughMs: runway.coveredThroughMs, deficit, dispatched: [] });
        continue;
      }

      // Which short families we may actually top up, minus those already generating.
      const inFlightProducts = new Set(
        (await listJobs({ clientId: client.id }))
          .filter((j) => j.agentId === "agent-service" && IN_FLIGHT.has(j.status) && j.external?.taskType)
          .map((j) => j.external!.taskType),
      );
      const candidates = runway.shortFamilies
        .filter((f) => AUTOGEN_FAMILIES.includes(f))
        .filter((f) => !inFlightProducts.has(FAMILY_PRODUCT[f]));

      // Explain every short family this run does NOT dispatch for, so a
      // deficit alongside "skipped" never reads as unexplained inaction: a
      // family the autopilot never auto-fires (blog_article — needs a real
      // topic) vs. one already generating from a prior run (idempotency).
      const notAutoFired = runway.shortFamilies.filter((f) => !AUTOGEN_FAMILIES.includes(f));
      const alreadyInFlight = runway.shortFamilies.filter(
        (f) => AUTOGEN_FAMILIES.includes(f) && inFlightProducts.has(FAMILY_PRODUCT[f]),
      );
      const skipReasons = [
        ...notAutoFired.map((f) => `${f}: needs manual input, not auto-generated`),
        ...alreadyInFlight.map((f) => `${f}: already generating (job in flight)`),
      ];

      const dispatched: ClientResult["dispatched"] = [];
      // Fill the deficit, not one job per family. The budget is shared across
      // the short families in the order computeRunway reports them, so a client
      // short on both does not spend the whole cap on the first.
      let remaining = maxJobsPerClient;
      for (const family of candidates) {
        const product = FAMILY_PRODUCT[family];
        const wanted = dispatchesFor(runway.deficitByFamily[family] ?? 0, remaining);
        for (let i = 0; i < wanted; i++) {
          remaining--;
          if (!enabled || !serviceReady || dryRun) {
            dispatched.push({ family, product }); // intended only
            continue;
          }
          const res = await submitManagedJob(SYSTEM_USER, {
            clientId: client.id,
            taskType: product,
            // "notes" (plural) is the only free-text field either schema
            // recognizes (both are additionalProperties:false) — a "note" or
            // any other unrecognized key gets the whole request 422'd.
            //
            // The brief is MODEL INPUT, and a model repeats what it is given.
            // An agent told this is an "automated weekly runway top-up"
            // covering "the next two weeks" can echo either phrase into a
            // caption, a subject line or a sign-off — internal operations
            // vocabulary, on the client's own post. Say what to write, not why
            // we are asking for it.
            brief: {
              notes: "Create on-brand content for this client's upcoming schedule.",
            },
          });
          if (res.jobId && !res.error) jobsDispatched++;
          dispatched.push({ family, product, jobId: res.jobId, error: res.error });
        }
      }

      // submitManagedJob returns a jobId even when the agent-service rejects the
      // submission (the mirrored Firestore job doc is created either way, then
      // marked failed) — so "did this actually work" must check for the absence
      // of an error, not just the presence of a jobId.
      const succeeded = dispatched.some((d) => d.jobId && !d.error);
      const attemptedButFailed = !succeeded && dispatched.some((d) => d.error);
      if (succeeded) toppedUp++;

      const detailParts: string[] = [];
      if (!enabled) detailParts.push("RUNWAY_AUTOGEN_ENABLED not set — report only");
      if (enabled && !serviceReady) detailParts.push("agent service not configured");
      if (dryRun) detailParts.push("dryRun");
      detailParts.push(...skipReasons);

      results.push({
        ...base,
        status: succeeded ? "topped_up" : attemptedButFailed ? "failed" : "skipped",
        coveredThroughMs: runway.coveredThroughMs,
        deficit,
        dispatched,
        ...(detailParts.length > 0 ? { detail: detailParts.join("; ") } : {}),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      logger.logError({
        clientId: client.id,
        agentId: null,
        operation: "runway_autopilot",
        errorMessage: `Runway sweep failed for ${client.name}: ${message}`,
        severity: "WARN",
      });
      results.push({ ...base, status: "skipped", coveredThroughMs: null, deficit: {}, dispatched: [], detail: `error: ${message}` });
    }
  }

  return NextResponse.json({
    horizonDays: RUNWAY_HORIZON_DAYS,
    dryRun,
    enabled,
    serviceReady,
    checked: clients.length,
    toppedUp,
    jobsDispatched,
    results,
  });
}
