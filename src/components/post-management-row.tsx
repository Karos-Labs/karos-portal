"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { unpublishAssetAction, deleteAssetAction } from "@/lib/actions";
import type { Asset } from "@/lib/types";

const DELETE_CONFIRM =
  "Delete this post? Karos's record of it is removed permanently. If it already went out on the platform, that live post is untouched and stays up.";

/**
 * Staff controls for managing a post's lifecycle: delete it outright (remove
 * Karos's record entirely, whatever its status — draft, scheduled, published,
 * anything) and, for a post that has already gone out, unpublish it (revert
 * to draft so it can be reworked and pushed again).
 *
 * Delete is unconditional on status: Edit and Unschedule already cover
 * reworking a draft or scheduled post, but neither one removes it, so a
 * mistaken or unwanted post at ANY stage had no way to actually go away.
 * Unpublish only makes sense once something is live, so it's gated on
 * `status === "published"`.
 *
 * Staff-only, same gate as PublishNowRow / MarkPostedRow's staff half:
 * `unpublishAssetAction` and `deleteAssetAction` are both `requireStaff()`, so
 * a client-facing control here could only ever error.
 *
 * Neither action reaches the live platform post — see the actions' own
 * comments. Unpublish is reversible (the post re-enters the normal draft
 * pipeline); delete is not, hence the confirm on it.
 *
 * variant mirrors MarkPostedRow: "button" sits as a peer in the asset card's
 * action row, "section" is a titled block for the detail modal.
 */
export function PostManagementRow({
  asset,
  canManage,
  variant = "section",
}: {
  asset: Asset;
  canManage: boolean;
  variant?: "section" | "button";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canManage) return null;
  const showUnpublish = asset.status === "published";

  async function unpublish() {
    setBusy(true);
    setError(null);
    try {
      const result = await unpublishAssetAction(asset.id);
      if (!result.ok) setError(result.error);
      else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't unpublish this post");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(DELETE_CONFIRM)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deleteAssetAction(asset.id);
      if (!result.ok) setError(result.error);
      else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete this post");
    } finally {
      setBusy(false);
    }
  }

  if (variant === "button") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-1.5">
          {showUnpublish && (
            <Button
              size="sm"
              variant="outline"
              onClick={unpublish}
              loading={busy}
              title="Revert to draft so this can be reworked and pushed again"
            >
              <Icon name="RotateCcw" className="h-3.5 w-3.5" />
              Unpublish
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            onClick={remove}
            loading={busy}
            title="Delete Karos's record of this post permanently"
          >
            <Icon name="Trash2" className="h-3.5 w-3.5" />
            Delete
          </Button>
        </div>
        {error && <p className="text-[11px] text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="border-t border-border pt-3">
      <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
        Manage this post
      </p>
      <div className="flex gap-2">
        {showUnpublish && (
          <button
            type="button"
            onClick={unpublish}
            disabled={busy}
            className="inline-flex h-11 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-60"
          >
            <Icon name="RotateCcw" className="h-3.5 w-3.5" />
            {busy ? "Working…" : "Unpublish"}
          </button>
        )}
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="inline-flex h-11 items-center gap-1.5 rounded-md border border-danger/30 px-3 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-60"
        >
          <Icon name="Trash2" className="h-3.5 w-3.5" />
          Delete
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-2">
        {showUnpublish
          ? "Unpublish reverts it to draft so it can be reworked. Delete removes it permanently. Neither touches the post if it's already live on the platform."
          : "Deletes it permanently."}
      </p>
      {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
    </div>
  );
}
