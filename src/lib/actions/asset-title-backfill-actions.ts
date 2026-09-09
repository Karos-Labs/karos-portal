"use server";

import { requireAdmin } from "./_shared";
import { listAssets, listClients, updateAsset } from "@/lib/data";
import { generateAssetTitle } from "@/lib/asset-titles";
import { isGenericXTitle, looksLikeXDrafts, xDraftCount } from "@/lib/asset-title-core";

/**
 * Retitles the EXISTING X deliverable archive with natural, topic-first names
 * — the operator's titling spec of 2026-08-11 applied to rows that predate
 * the webhook titler (lib/asset-titles.ts names everything new at delivery).
 *
 * Runs INSIDE the deployed portal on purpose: the model key and the database
 * credentials live in the service's own environment, so an admin presses a
 * button instead of anyone shipping secrets to a laptop. The standalone
 * script (scripts/backfill-x-asset-titles.ts) does the same work over the
 * same shared filters for whoever prefers a terminal.
 *
 * Guarantees:
 *   - Only assets still wearing the generic agent-name placeholder qualify;
 *     a hand-typed title is never touched. Launch deliverables, test runs and
 *     already-titled assets are skipped.
 *   - Honest about legacy batches: a delivery holding N drafts is titled
 *     "<topic> · N drafts", so a row cannot promise one post and open onto
 *     twenty.
 *   - Reversible: the old title is kept in meta.titlePrevious.
 *   - Idempotent and chunked: at most BATCH_PER_PRESS assets per invocation
 *     (each needs its own model call, and one press must stay comfortably
 *     inside a request window). `remaining` tells the admin to press again.
 */

const BATCH_PER_PRESS = 25;

export interface TitleBackfillRow {
  assetId: string;
  clientName: string;
  from: string;
  to: string;
}

export interface TitleBackfillResult {
  ok: boolean;
  error?: string;
  /** Rows processed this press — proposed (dry run) or written. */
  rows?: TitleBackfillRow[];
  /** Candidates the titler could not name this press; left untouched. */
  untitled?: number;
  /** Qualifying assets still waiting after this press. */
  remaining?: number;
  wrote?: boolean;
}

export async function backfillXAssetTitlesAction(input: { write: boolean }): Promise<TitleBackfillResult> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false, error: "Only an admin can retitle the archive." };
  }
  try {
    const [assets, clients] = await Promise.all([listAssets(), listClients()]);
    const clientName = new Map(clients.map((c) => [c.id, c.name]));

    const candidates = assets.filter((asset) => {
      const meta = (asset.meta ?? {}) as Record<string, unknown>;
      return (
        asset.agentId === "agent-service" &&
        meta.titleGenerated !== true &&
        meta.launchDeliverable !== true &&
        meta.testRun !== true &&
        looksLikeXDrafts(asset.content ?? "") &&
        isGenericXTitle(asset.title ?? "")
      );
    });

    const batch = candidates.slice(0, BATCH_PER_PRESS);
    const rows: TitleBackfillRow[] = [];
    let untitled = 0;

    for (const asset of batch) {
      const content = asset.content ?? "";
      const topic = await generateAssetTitle({
        content,
        clientId: asset.clientId,
        agentName: "X Agent",
      });
      if (!topic) {
        untitled += 1;
        continue;
      }
      const n = xDraftCount(content);
      const title = n > 1 ? `${topic} · ${n} drafts` : topic;
      if (input.write) {
        await updateAsset(asset.id, {
          title,
          // set(..., {merge: true}) underneath — merges these keys into the
          // existing meta map without touching artifacts/slides/etc.
          meta: {
            titleGenerated: true,
            titleBackfilled: true,
            titlePrevious: asset.title ?? "",
          },
          updatedAt: Date.now(),
        });
      }
      rows.push({
        assetId: asset.id,
        clientName: clientName.get(asset.clientId) ?? asset.clientId,
        from: asset.title ?? "",
        to: title,
      });
    }

    return {
      ok: true,
      rows,
      untitled,
      remaining: candidates.length - batch.length,
      wrote: input.write,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Retitling failed." };
  }
}
