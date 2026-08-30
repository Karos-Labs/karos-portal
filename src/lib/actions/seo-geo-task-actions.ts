"use server";

import { revalidatePath } from "next/cache";
import { listAssets, listClientTasks, createClientTask } from "@/lib/data";
import { requireClientAccess } from "./_shared";
import { toRoutableRecommendation } from "@/lib/agent-engine/routable-recommendation";
import { routableRecommendationsToTaskInputs } from "@/lib/agent-engine/routable-recommendation-tasks";
import type { AppUser } from "@/lib/types";

/**
 * [SCRUM-259/T-B14] THE NEW CALL PATH: turn a client's most recent SEO/GEO
 * report into task-board rows.
 *
 * Neither `clientReports` (`getClientReport`) nor `clientSeoGeo`
 * (`getClientSeoGeo`) is the read path here — traced both, per this ticket's
 * own instruction not to assume. `clientReports`/`clientSeoGeo` are the
 * onboarding-lab SEO/GEO pipeline's own tables (`intel-actions.ts`'s
 * `approveSeoGeoRecommendationAction`, `seo-geo.ts`'s `VisibilityGap`-based
 * client action plan) — a different producer, with no `RoutableRecommendation`
 * or `owner`/`fixAction` anywhere in it. The actual source is the Asset
 * `materializeSeoGeoReport` (agent-engine/materialize.ts) writes for a
 * completed `seo-geo-agent` run: `meta.agentEngineProductId ===
 * "seo-geo-agent"` and `meta.routableRecommendations`, the parsed,
 * fail-safe array `toRoutableRecommendation` already produces (C2/T-A4).
 *
 * IDEMPOTENCY. A client's SEO/GEO report re-runs on a schedule, and every
 * run re-fires the SAME finite set of catalog recIds — nothing here should
 * create a second task for a finding the board already has. Guarded by recId
 * (`ClientTaskMetadata.recId`, T-B10), not by title text: a recId is stable
 * catalog identity, a title is client-facing copy that can change under
 * `resolveRecCopy` without meaning a different finding. This is narrower than
 * the swarm/chat-route pipeline's own `findDuplicateReason` (title-fuzzy) +
 * `queueCapacitySkipNote` (karos-queue-capacity) pair — deliberately: those
 * exist for free-text, AI-authored task titles from an unbounded topic space,
 * while this source is a closed, stable id space where "already has a task
 * for this recId" is itself the correct and sufficient dedup rule. Not
 * wiring the karos-queue capacity cap here is a real, separate finding (see
 * this ticket's report) — a run that fires many `karos_agent`-owned
 * recommendations at once could push the karos_managed active-task count
 * past `MAX_ACTIVE_TASKS` with nothing here to notice.
 */
export async function createTasksFromSeoGeoReportAction(
  clientId: string,
): Promise<{ ok: true; created: number; skipped: number } | { ok?: never; error: string }> {
  let user: AppUser;
  try {
    user = await requireClientAccess(clientId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Forbidden" };
  }

  const assets = await listAssets({ clientId });
  // Latest first: listAssets already sorts by createdAt desc.
  const reportAsset = assets.find(
    (a) => a.meta?.agentEngineProductId === "seo-geo-agent" && Array.isArray(a.meta?.routableRecommendations),
  );
  if (!reportAsset) {
    return { error: "No SEO/GEO visibility report found for this client yet." };
  }

  const raw = reportAsset.meta?.routableRecommendations;
  const recommendations = Array.isArray(raw)
    ? raw.map(toRoutableRecommendation).filter((r): r is NonNullable<typeof r> => r !== undefined)
    : [];
  if (recommendations.length === 0) {
    return { ok: true, created: 0, skipped: 0 };
  }

  const existingTasks = await listClientTasks({ clientId, includeArchived: true });
  const existingRecIds = new Set(
    existingTasks
      .map((t) => t.metadata?.recId)
      .filter((recId): recId is string => typeof recId === "string"),
  );

  const taskInputs = routableRecommendationsToTaskInputs(
    recommendations,
    { clientId, createdBy: user.uid },
    existingRecIds,
  );

  await Promise.all(taskInputs.map((input) => createClientTask(input)));

  revalidatePath(`/clients/${clientId}`);
  return { ok: true, created: taskInputs.length, skipped: recommendations.length - taskInputs.length };
}
