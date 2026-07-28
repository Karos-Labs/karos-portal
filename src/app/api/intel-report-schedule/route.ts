import { type NextRequest, NextResponse } from "next/server";
import {
  listClients,
  updateClient,
  tryAcquireAiProcessingLock,
  releaseAiProcessingLock,
} from "@/lib/data";
import { logActivity, logGenerationFailure } from "@/lib/actions/_shared";
import { requireCronSecret } from "@/lib/cron-auth";
import { computeNextIntelScheduleRun } from "@/lib/intel-schedule";

import { SYSTEM_AI_ACTOR_NAME } from "@/lib/activity-actors";
export const maxDuration = 300;

/**
 * Recurring Intel Report + SEO/GEO regeneration cron. This is the THIRD and
 * only automatic re-trigger of runIntelReportPipeline besides client creation
 * (createClientAction, completeOnboardingAction) — the other trigger being the
 * admin's manual Regenerate button (generateIntelReportAction). It fires ONLY
 * for clients with an admin-configured schedule (intelScheduleEnabled) whose
 * intelScheduleNextRunAt has passed; nothing else calls this pipeline.
 *
 * nextRunAt always advances from the slot that just fired (not "now"), so the
 * admin's configured cadence stays on a fixed calendar grid regardless of cron
 * tick frequency or processing delay.
 */
export async function GET(req: NextRequest) {
  const unauthorized = requireCronSecret(req);
  if (unauthorized) return unauthorized;

  const now = Date.now();
  const due = (await listClients())
    .filter((c) => c.intelScheduleEnabled && (c.intelScheduleNextRunAt ?? Infinity) <= now)
    .sort((a, b) => (a.intelScheduleNextRunAt ?? 0) - (b.intelScheduleNextRunAt ?? 0))
    .slice(0, 10);

  if (due.length === 0) {
    return NextResponse.json({ processed: 0, results: [] });
  }

  type RunResult = { clientId: string; status: "ran" | "skipped" | "failed"; error?: string };
  const results: RunResult[] = [];

  // Sequential: each run is a long multi-agent pipeline call, and the batch is
  // capped at 10, so this keeps behavior predictable rather than firing ten
  // Sonnet pipelines at once (mirrors /api/run-scheduled's sequential loop).
  for (const client of due) {
    const intervalMonths = client.intelScheduleIntervalMonths ?? 1;
    const dayOfMonth = client.intelScheduleDayOfMonth ?? 1;
    const dueAt = client.intelScheduleNextRunAt ?? now;

    if (!(await tryAcquireAiProcessingLock(client.id))) {
      // Already processing (a manual Regenerate landed first) — leave nextRunAt
      // untouched so this slot is retried on the next tick.
      results.push({ clientId: client.id, status: "skipped" });
      continue;
    }

    let failure: string | undefined;
    try {
      const { runIntelReportPipeline } = await import("@/lib/intel");
      await runIntelReportPipeline(client.id);
      await logActivity({
        clientId: client.id,
        timestamp: now,
        type: "INTEL_GENERATION",
        title: "Intel Report generated (scheduled)",
        description: "Full competitive intelligence pipeline completed (5 core research agents + SEO/GEO multi-model vertical) - recurring schedule",
        actor: SYSTEM_AI_ACTOR_NAME,
        actorRole: "system",
      });
      results.push({ clientId: client.id, status: "ran" });
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      results.push({ clientId: client.id, status: "failed", error: failure });
    } finally {
      await releaseAiProcessingLock(client.id, failure);
      await logGenerationFailure(client.id, failure);
      await updateClient(client.id, {
        ...(failure ? {} : { lastIntelReportAt: now }),
        intelScheduleNextRunAt: computeNextIntelScheduleRun({ intervalMonths, dayOfMonth, from: dueAt }),
      });
    }
  }

  return NextResponse.json({
    processed: due.length,
    ran: results.filter((r) => r.status === "ran").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    results,
  });
}
