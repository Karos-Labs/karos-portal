"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import type { AgentAttachmentProfile } from "@/lib/custom-agent-launch";
import type { ContextItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const MAX_BYTES = 4 * 1024 * 1024;

function fileIcon(item: Pick<ContextItem, "kind" | "mimeType">): string {
  if (item.mimeType.startsWith("video/")) return "Video";
  if (item.mimeType.startsWith("audio/")) return "AudioLines";
  if (item.kind === "image") return "Image";
  return "FileText";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface UploadResponse {
  id: string;
  url: string;
  name: string;
}

export function AgentInputFiles({
  clientId,
  agentName,
  items,
  selectedIds,
  onChange,
  profile,
  canUpload,
}: {
  clientId: string;
  agentName: string;
  items: ContextItem[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  profile: AgentAttachmentProfile;
  canUpload: boolean;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [localItems, setLocalItems] = useState(items);
  const [loadingLibrary, setLoadingLibrary] = useState(canUpload && items.length === 0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canUpload || !clientId || items.length > 0) return;
    const controller = new AbortController();
    let active = true;
    void fetch(`/api/clients/${clientId}/context`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as {
          items?: ContextItem[];
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error || "Could not load the client file library.");
        if (active) setLocalItems(payload.items ?? []);
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Could not load the client file library.");
        }
      })
      .finally(() => {
        if (active) setLoadingLibrary(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [canUpload, clientId, items.length]);

  function toggle(id: string) {
    onChange(selectedIds.includes(id) ? selectedIds.filter((itemId) => itemId !== id) : [...selectedIds, id]);
  }

  async function upload(files: FileList) {
    setError(null);
    const selectedFiles = Array.from(files);
    const tooLarge = selectedFiles.find((file) => file.size > MAX_BYTES);
    if (tooLarge) {
      setError(`“${tooLarge.name}” is larger than 4 MB. Add a shareable link in the brief instead.`);
      return;
    }

    setUploading(true);
    try {
      const uploaded = await Promise.all(
        selectedFiles.map(async (file): Promise<ContextItem> => {
          const body = new FormData();
          body.append("file", file);
          body.append("note", `Uploaded for ${agentName}`);
          const response = await fetch(`/api/clients/${clientId}/context`, { method: "POST", body });
          const payload = (await response.json().catch(() => ({}))) as Partial<UploadResponse> & {
            error?: string;
          };
          if (!response.ok || !payload.id || !payload.url) {
            throw new Error(payload.error || `Upload failed for ${file.name}`);
          }
          return {
            id: payload.id,
            clientId,
            kind: file.type.startsWith("image/")
              ? "image"
              : file.type === "application/pdf"
                ? "document"
                : file.type.startsWith("text/")
                  ? "text"
                  : "other",
            name: payload.name || file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            storagePath: "",
            url: payload.url,
            note: `Uploaded for ${agentName}`,
            createdBy: "",
            createdAt: Date.now(),
          };
        }),
      );
      setLocalItems((current) => [...uploaded, ...current]);
      onChange([...new Set([...selectedIds, ...uploaded.map((item) => item.id)])]);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <fieldset className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <legend className="text-xs font-medium text-muted">
            {profile.label}
            {profile.required ? <span className="ml-1 text-danger">*</span> : null}
          </legend>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-2">{profile.hint}</p>
        </div>
        {canUpload && clientId ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => inputRef.current?.click()}
            loading={uploading}
          >
            <Icon name="Upload" className="h-3.5 w-3.5" />
            {uploading ? "Uploading…" : "Upload files"}
          </Button>
        ) : null}
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept={profile.accept}
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files?.length) void upload(event.target.files);
          }}
        />
      </div>

      {loadingLibrary ? (
        <div className="rounded-md border border-border px-3 py-3 text-xs text-muted-2" aria-live="polite">
          Loading this client’s file library…
        </div>
      ) : localItems.length > 0 ? (
        <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-border bg-foreground/[0.02] p-2">
          {localItems.map((item) => {
            const selected = selectedIds.includes(item.id);
            return (
              <label
                key={item.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-2 text-xs transition-colors",
                  selected
                    ? "border-neon/40 bg-neon/[0.07] text-foreground"
                    : "border-transparent text-muted hover:border-border hover:bg-surface-2",
                )}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggle(item.id)}
                  className="accent-neon"
                />
                <Icon name={fileIcon(item)} className="h-4 w-4 shrink-0 text-muted-2" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-foreground">{item.name}</span>
                  {item.note ? <span className="text-muted-2"> · {item.note}</span> : null}
                </span>
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.06em] text-muted-2">
                  {formatBytes(item.sizeBytes)}
                </span>
              </label>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-2">
          {canUpload
            ? "No files are in this client’s context yet. Upload the source material for this run."
            : "No reference files are available. Your Karos team can add source material to the client context."}
        </div>
      )}

      {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
      {uploading ? <p className="text-xs text-muted-2" aria-live="polite">Uploading input files…</p> : null}
    </fieldset>
  );
}
