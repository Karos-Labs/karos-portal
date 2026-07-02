"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { deleteContextItemAction, updateContextItemNoteAction } from "@/lib/actions";
import type { ContextItem } from "@/lib/types";

const MAX_BYTES = 4 * 1024 * 1024;

const KIND_ICON: Record<ContextItem["kind"], string> = {
  image: "Image",
  document: "FileText",
  text: "FileText",
  other: "Paperclip",
};

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ClientContext({ clientId, items }: { clientId: string; items: ContextItem[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList) {
    setError(null);
    const list = Array.from(files);
    const tooBig = list.find((f) => f.size > MAX_BYTES);
    if (tooBig) {
      setError(`“${tooBig.name}” is larger than 4 MB.`);
      return;
    }
    setUploading(true);
    try {
      for (const file of list) {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch(`/api/clients/${clientId}/context`, { method: "POST", body });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `Upload failed for ${file.name}`);
        }
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function editNote(item: ContextItem) {
    const note = window.prompt("Describe this for the agent (optional):", item.note ?? "");
    if (note === null) return;
    await updateContextItemNoteAction(item.id, note);
    router.refresh();
  }

  async function remove(item: ContextItem) {
    if (!confirm(`Remove “${item.name}” from this client's context?`)) return;
    await deleteContextItemAction(item.id);
    router.refresh();
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <CardTitle>Context library</CardTitle>
        <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} loading={uploading}>
          <Icon name="Upload" className="h-3.5 w-3.5" />
          Add files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => e.target.files && e.target.files.length > 0 && upload(e.target.files)}
        />
      </div>
      <p className="text-xs text-muted-2">
        Files & images agents use automatically for this client — brand guidelines, product
        photos, references. Images and PDFs are read by the model; up to 4 MB each.
      </p>

      {error && <p className="text-xs text-danger">{error}</p>}

      {items.length === 0 ? (
        <p className="text-sm text-muted-2">Nothing yet. Add brand assets or reference docs above.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((it) => (
            <div key={it.id} className="group relative overflow-hidden rounded-md border border-border bg-surface-2">
              {it.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.url} alt={it.name} className="h-24 w-full object-cover" />
              ) : (
                <a href={it.url} target="_blank" rel="noopener noreferrer" className="flex h-24 w-full items-center justify-center text-muted hover:text-foreground">
                  <Icon name={KIND_ICON[it.kind]} className="h-8 w-8" />
                </a>
              )}
              <div className="space-y-1 p-2">
                <p className="truncate text-xs font-medium" title={it.name}>{it.name}</p>
                <div className="flex items-center justify-between gap-1">
                  <Badge tone="neutral">{fmtSize(it.sizeBytes)}</Badge>
                  <div className="flex items-center gap-1">
                    <button onClick={() => editNote(it)} className="text-muted-2 hover:text-foreground" aria-label="Edit note" title="Describe for the agent">
                      <Icon name="Pencil" className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => remove(it)} className="text-muted-2 hover:text-danger" aria-label="Remove">
                      <Icon name="Trash2" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {it.note && <p className="line-clamp-2 text-[11px] text-muted-2" title={it.note}>{it.note}</p>}
                {it.kind === "other" && <p className="text-[11px] text-muted-2">Stored — not read by the model</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
