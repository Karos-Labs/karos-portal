"use client";

import { useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { cn, initials } from "@/lib/utils";

/**
 * Shared avatar drag-and-drop uploader - used by both the onboarding wizard
 * (step 1) and the account settings profile tab. Uploads immediately (mirrors
 * the client logo uploader convention) so the value is never lost across a
 * full-page navigation (e.g. the LinkedIn OAuth round trip in onboarding).
 */
export function AvatarUploader({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string | null;
  onChange: (url: string | null) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    if (uploading) return;
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/users/avatar", { method: "POST", body });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Upload failed");
      }
      const { url } = (await res.json()) as { url: string };
      onChange(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Avatar upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function remove() {
    if (removing) return;
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch("/api/users/avatar", { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove avatar");
      onChange(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove avatar");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div
        role="button"
        tabIndex={0}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) upload(file);
        }}
        className={cn(
          "group relative flex h-20 w-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full ring-2 ring-border transition-colors",
          isDragging ? "ring-neon" : "hover:ring-neon/50",
        )}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt={name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-surface-3 text-2xl font-semibold text-neon">
            {initials(name)}
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
          {uploading ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
          ) : (
            <Icon name="Camera" className="h-5 w-5 text-white" />
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || removing}
            className="rounded-[6px] border border-border px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-neon/50 hover:text-neon disabled:pointer-events-none disabled:opacity-50"
          >
            {value ? "Change photo" : "Upload photo"}
          </button>
          {value && (
            <button
              type="button"
              onClick={remove}
              disabled={uploading || removing}
              className="rounded-[6px] border border-border px-2.5 py-1.5 text-xs font-medium text-muted-2 transition-colors hover:border-danger/50 hover:text-danger disabled:pointer-events-none disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted-2">PNG, JPG, or WEBP · max 4 MB</p>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg"
        className="sr-only"
        onChange={(e) => { if (e.target.files?.[0]) upload(e.target.files[0]); }}
      />
    </div>
  );
}
