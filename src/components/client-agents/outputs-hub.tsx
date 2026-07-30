"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import { assetImages } from "@/lib/asset-images";
import { promoteTestAssetAction, dismissTestAssetAction } from "@/lib/actions/asset-actions";
import { relativeTime, cn } from "@/lib/utils";
import type { Asset } from "@/lib/types";

/**
 * The Control Room's Outputs & Artifacts Hub — this agent's FULL output list
 * (staff only, uncapped, unlike the client-facing archive summary which caps
 * at 8 rows), with 1-click preview via the existing AssetDetailModal instead
 * of building a second preview surface. Test-run assets (meta.testRun) get a
 * TEST badge plus Promote/Dismiss — the only two things that can happen to
 * one (asset-actions.ts's promoteTestAssetAction / dismissTestAssetAction).
 */
export function OutputsHub({
  assets,
  initialOpenAssetId,
}: {
  assets: Asset[];
  /**
   * Copilot chat's `find_output`/`inspect_job` deep link (`?asset=` on the
   * agent detail page) — auto-opens this asset the same as clicking its row.
   * Staff-only surface, so this carries no churn-rule risk the client detail
   * page's archive rows are deliberately built to avoid (client-agent-rows.ts).
   */
  initialOpenAssetId?: string;
}) {
  const router = useRouter();
  const [openAssetId, setOpenAssetId] = useState<string | null>(initialOpenAssetId ?? null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const openAsset = assets.find((a) => a.id === openAssetId) ?? null;

  function run(id: string, action: (id: string) => Promise<{ error?: string }>) {
    setPendingId(id);
    action(id)
      .then((result) => {
        if (!result.error) router.refresh();
      })
      .finally(() => setPendingId(null));
  }

  if (assets.length === 0) {
    return <p className="text-xs text-muted-2">Nothing generated yet.</p>;
  }

  return (
    <>
      <ul className="space-y-1.5">
        {assets.map((asset) => {
          const images = assetImages(asset);
          const isTest = asset.meta?.testRun === true;
          const dismissed = asset.meta?.testDismissed === true;
          return (
            <li
              key={asset.id}
              className={cn(
                "flex items-center gap-3 rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2",
                dismissed && "opacity-50",
              )}
            >
              {images[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={images[0].url} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
              ) : (
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-surface-3 text-muted-2">
                  <Icon name="FileText" className="h-4 w-4" />
                </div>
              )}
              <button
                type="button"
                onClick={() => setOpenAssetId(asset.id)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate text-xs text-foreground">{asset.title || "Untitled"}</p>
                <p className="text-[11px] text-muted-2">
                  {relativeTime(asset.updatedAt ?? asset.createdAt)}
                </p>
              </button>
              {isTest && <Badge tone="warning">TEST</Badge>}
              <Badge tone="neutral" className="capitalize">
                {asset.status}
              </Badge>
              {isTest && !dismissed && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pendingId === asset.id}
                    onClick={() => run(asset.id, promoteTestAssetAction)}
                  >
                    Promote
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pendingId === asset.id}
                    onClick={() => run(asset.id, dismissTestAssetAction)}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <AssetDetailModal
        asset={openAsset}
        open={openAsset != null}
        onClose={() => setOpenAssetId(null)}
      />
    </>
  );
}
