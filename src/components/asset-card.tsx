"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Badge, Button, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { updateAssetAction } from "@/lib/actions";
import { relativeTime } from "@/lib/utils";
import type { Asset } from "@/lib/types";

const TYPE_ICON: Record<string, string> = {
  instagram_post: "Camera",
  email: "Mail",
  article: "Newspaper",
  social_post: "Share2",
  note: "FileText",
};

export function AssetCard({ asset, canApprove }: { asset: Asset; canApprove?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(asset.content);
  const [busy, setBusy] = useState(false);

  const hashtags = (asset.meta?.hashtags as string[] | undefined) ?? [];
  const imageConcept = asset.meta?.imageConcept as string | undefined;

  async function setStatus(status: Asset["status"]) {
    setBusy(true);
    try {
      await updateAssetAction(asset.id, { status });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    setBusy(true);
    try {
      await updateAssetAction(asset.id, { content });
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-neon-soft text-neon">
          <Icon name={TYPE_ICON[asset.type] ?? "FileText"} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium">{asset.title}</p>
            <Badge tone={asset.status === "draft" ? "warning" : asset.status === "approved" ? "neon" : "info"}>{asset.status}</Badge>
          </div>
          <p className={`mt-1 whitespace-pre-wrap text-sm text-muted ${open ? "" : "line-clamp-2"}`}>{asset.content}</p>

          {asset.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={asset.imageUrl}
              alt={asset.title}
              className="mt-2 w-full max-w-sm rounded-lg border border-border"
            />
          )}

          {open && (
            <>
              {hashtags.length > 0 && (
                <p className="mt-2 text-xs text-neon-dim">{hashtags.map((h) => "#" + h).join(" ")}</p>
              )}
              {imageConcept && (
                <p className="mt-2 rounded-lg bg-surface-2 p-2 text-xs text-muted">
                  <span className="font-medium text-foreground">Visual: </span>
                  {imageConcept}
                </p>
              )}
              {editing && (
                <div className="mt-3 space-y-2">
                  <Textarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-[120px]" />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveEdit} loading={busy}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setContent(asset.content); }}>Cancel</Button>
                  </div>
                </div>
              )}
            </>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => setOpen((o) => !o)} className="text-xs text-muted hover:text-foreground">
              {open ? "Collapse" : "Expand"}
            </button>
            <span className="text-xs text-muted-2">· {relativeTime(asset.createdAt)}</span>
            <div className="ml-auto flex gap-1.5">
              {canApprove && !editing && (
                <Button size="sm" variant="outline" onClick={() => { setOpen(true); setEditing(true); }}>
                  <Icon name="Pencil" className="h-3.5 w-3.5" />
                </Button>
              )}
              {canApprove && asset.status === "draft" && (
                <Button size="sm" onClick={() => setStatus("approved")} loading={busy}>
                  <Icon name="Check" className="h-3.5 w-3.5" /> Approve
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
