import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/ui";
import { AssetCard } from "@/components/asset-card";
import type { Asset } from "@/lib/types";

/**
 * Client-facing asset library — the full grid of deliverables. The delivery
 * calendar lives in its own top-level Calendar tab (/calendar), not here.
 */
export function AssetsView({
  assets,
  canApprove = false,
}: {
  assets: Asset[];
  /** Staff-only: show approve/schedule controls on each card. Clients never approve. */
  canApprove?: boolean;
}) {
  if (assets.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="FolderOpen" className="h-7 w-7" />}
        title="Nothing here yet"
        description="Your deliverables will show up here as your team creates them."
      />
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {assets.map((a) => (
        <AssetCard key={a.id} asset={a} canApprove={canApprove} />
      ))}
    </div>
  );
}
