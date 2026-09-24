"use server";

import { revalidatePath } from "next/cache";
import { getClient, listAssets } from "@/lib/data";
import { requireStaff } from "./_shared";
import { approveAssetAction } from "./asset-actions";
import { preferredPlatform } from "@/lib/asset-platform";
import { MAX_BULK_APPROVE } from "@/lib/bulk-approve-limits";
import { planBulkSchedule, type OccupiedDay } from "@/lib/bulk-schedule";
import { paceLaneFor, resolveDailyPace } from "@/lib/daily-pace";
import { chainFamilyFor, startOfDayMs } from "@/lib/post-chain";
import type { Asset, PublishMode } from "@/lib/types";

/**
 * APPROVING A BACKLOG WITHOUT LIVING THROUGH IT ONE POST AT A TIME.
 *
 * Eight drafts in the queue are eight separate journeys: open, pick a tier,
 * pick a slot, approve, find your place again. §09 of the platform audit asks
 * for one action over the batch — *"with a summary of exactly what will go
 * out"* — and that second clause is the design. A bulk button that only
 * approves is a bulk button nobody presses twice; the reviewer has to see,
 * before it runs, which post lands on which day.
 *
 * So there are two exports and they share one planner: `previewBulkApprove`
 * writes nothing and answers "what would happen", `bulkApproveAssets` does it.
 *
 * ## Nothing here is a second approval
 *
 * Every row goes through `approveAssetAction`. That function is where the Test
 * Run fence lives, where auto-publish is refused unless the client opted in
 * AND the integration is usable, where the producing job is closed, where the
 * event is tracked. A bulk path with its own `updateAsset` would be an
 * approval with none of that, and the two would drift on the first rule
 * somebody adds to one of them.
 *
 * ## Nor is it a second scheduler
 *
 * The slots come from `planBulkSchedule` — the same day-walking, pace-aware,
 * weekend-skipping planner the bulk clip uploader uses. Spacing posts "every
 * two hours" would have been easy and would have contradicted the product's
 * own rules about how much a client publishes in a day.
 *
 * ## One failure does not cost the batch
 *
 * A Test Run in the selection, a client with auto-scheduling off, a draft
 * somebody else approved a second ago — each is recorded against its own row
 * and the rest still land. Sequential rather than `Promise.all`: each row is a
 * write plus a possible platform call, and a fan-out against one client's rate
 * limits is how a bulk button becomes a bulk outage.
 */

export interface BulkApproveRow {
  id: string;
  title: string;
  clientId: string;
  /** Where this one would go, as the card shows it. `null` when nothing is chosen — it will land as a placeholder. */
  platform: string | null;
  /** Epoch millis this asset would be scheduled for. */
  scheduledAt: number;
}

export interface BulkApprovePreview {
  rows: BulkApproveRow[];
  /** Why the preview is empty or short. Shown as the summary, never as an error toast. */
  refusal?: string;
}

export interface BulkApproveOutcome {
  id: string;
  scheduledAt?: number;
  /** Why this one did not go through. The others still did. */
  error?: string;
}

/** Everything both exports need, resolved once: the assets, and each client's pace and booked days. */
async function planFor(ids: string[], startAtMs: number): Promise<BulkApprovePreview> {
  const unique = [...new Set(ids.filter((id) => id.trim().length > 0))];
  if (unique.length === 0) return { rows: [], refusal: "Nothing is selected." };
  if (unique.length > MAX_BULK_APPROVE) {
    return {
      rows: [],
      refusal: `${unique.length} drafts selected; ${MAX_BULK_APPROVE} is the most one approval may cover. Clear some and run it twice.`,
    };
  }

  // Grouped by client because the pace, the booked days and the weekend policy
  // are a CLIENT's, and the staff grid is cross-client: one walk over a mixed
  // selection would book one client's Monday against another's ledger.
  const byClient = new Map<string, Asset[]>();
  const selected: Asset[] = [];
  const all = await listAssets({});
  const wanted = new Map(all.filter((a) => unique.includes(a.id)).map((a) => [a.id, a]));
  for (const id of unique) {
    const asset = wanted.get(id);
    if (!asset) continue;
    selected.push(asset);
    byClient.set(asset.clientId, [...(byClient.get(asset.clientId) ?? []), asset]);
  }
  if (selected.length === 0) return { rows: [], refusal: "None of the selected drafts could be read." };

  const rows: BulkApproveRow[] = [];
  for (const [clientId, assets] of byClient) {
    const [client, clientAssets] = await Promise.all([getClient(clientId).catch(() => null), listAssets({ clientId })]);
    // Each dated social asset books the lane it actually is, exactly as the
    // clip uploader does: a paced client's clip day is not filled by that day's
    // post, and an unpaced client's still is.
    const occupied: OccupiedDay[] = clientAssets
      .filter((a) => a.scheduledAt != null && chainFamilyFor(a.type) === "social")
      .map((a) => ({ lane: paceLaneFor(a), dayStartMs: startOfDayMs(a.scheduledAt as number) }));

    const ordered = assets.slice().sort((a, b) => a.createdAt - b.createdAt);
    const platformById = Object.fromEntries(ordered.map((a) => [a.id, preferredPlatform(a) ?? undefined]));
    const assignments = planBulkSchedule(
      ordered.map((a) => a.id),
      {
        startDayMs: startAtMs,
        platformById,
        pace: resolveDailyPace(client?.dailyPace),
        occupied,
      },
    );
    for (const assignment of assignments) {
      const asset = ordered.find((a) => a.id === assignment.id)!;
      rows.push({
        id: asset.id,
        title: asset.title,
        clientId,
        platform: preferredPlatform(asset) ?? null,
        scheduledAt: assignment.scheduledAt,
      });
    }
  }
  rows.sort((a, b) => a.scheduledAt - b.scheduledAt);
  return { rows };
}

/** What would go out, and when. Writes nothing. */
export async function previewBulkApproveAction(ids: string[], startAtMs: number): Promise<BulkApprovePreview> {
  await requireStaff();
  return planFor(ids, startAtMs);
}

/** The same plan, applied. Each row through the single-asset approval. */
export async function bulkApproveAssetsAction(
  ids: string[],
  startAtMs: number,
  publishMode: PublishMode = "manual",
): Promise<{ results: BulkApproveOutcome[]; refusal?: string }> {
  await requireStaff();
  const plan = await planFor(ids, startAtMs);
  if (plan.rows.length === 0) return { results: [], ...(plan.refusal ? { refusal: plan.refusal } : {}) };

  const results: BulkApproveOutcome[] = [];
  const clients = new Set<string>();
  for (const row of plan.rows) {
    try {
      await approveAssetAction(row.id, {
        scheduledAt: row.scheduledAt,
        publishMode,
        ...(row.platform ? { platforms: [row.platform] } : {}),
      });
      results.push({ id: row.id, scheduledAt: row.scheduledAt });
      clients.add(row.clientId);
    } catch (e) {
      results.push({ id: row.id, error: e instanceof Error ? e.message : "Approval failed." });
    }
  }

  revalidatePath("/assets");
  for (const clientId of clients) {
    revalidatePath(`/clients/${clientId}`);
    revalidatePath(`/clients/${clientId}/assets`);
  }
  return { results };
}
