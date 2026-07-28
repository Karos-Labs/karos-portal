"use client";

import { useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

function fileNameFromUrl(url: string): string {
  try {
    const decoded = decodeURIComponent(new URL(url).pathname);
    const last = decoded.split("/").pop() ?? "resume";
    return last.replace(/^[0-9a-f-]{36}-/, "");
  } catch {
    return "Resume uploaded";
  }
}

/**
 * Shared resume/CV drag-and-drop uploader — used by both the onboarding wizard
 * (step 1) and the account settings profile tab. Uploads immediately; the URL
 * powers the employee-advocacy LLM voice (execution-engine.ts).
 */
export function ResumeUploader({
  value,
  onChange,
}: {
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
      const res = await fetch("/api/users/resume", { method: "POST", body });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Upload failed");
      }
      const { url } = (await res.json()) as { url: string };
      onChange(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resume upload failed");
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
      const res = await fetch("/api/users/resume", { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove resume");
      onChange(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove resume");
    } finally {
      setRemoving(false);
    }
  }

  if (value) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-3 rounded-[10px] border border-border bg-surface-2 p-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] bg-surface-3">
            <Icon name="FileText" className="h-5 w-5 text-neon" />
          </div>
          <div className="min-w-0 flex-1">
            <a
              href={value}
              target="_blank"
              rel="noreferrer"
              className="truncate text-xs font-medium hover:text-neon"
            >
              {fileNameFromUrl(value)}
            </a>
            <p className="text-[10px] text-muted-2">Stored for your Karos team</p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || removing}
              className="rounded-[6px] border border-border px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-neon/50 hover:text-neon disabled:pointer-events-none disabled:opacity-50"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={uploading || removing}
              className="flex items-center justify-center rounded-[6px] border border-border p-1.5 text-muted-2 transition-colors hover:border-danger/50 hover:text-danger disabled:pointer-events-none disabled:opacity-50"
              aria-label="Remove resume"
            >
              {removing ? (
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Icon name="Trash2" className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          className="sr-only"
          onChange={(e) => { if (e.target.files?.[0]) upload(e.target.files[0]); }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-[10px] border-2 border-dashed py-6 text-center transition-colors",
          isDragging ? "border-neon bg-neon/5" : "border-border hover:border-neon/40",
          uploading && "pointer-events-none opacity-60",
        )}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) upload(file);
        }}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
      >
        {uploading ? (
          <>
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-neon border-t-transparent" />
            <span className="text-xs text-muted-2">Uploading…</span>
          </>
        ) : (
          <>
            <Icon name="Upload" className="h-5 w-5 text-muted-2" />
            <div>
              <p className="text-sm font-medium">Click or drag your resume here</p>
              <p className="text-xs text-muted-2">PDF, DOC, DOCX, or TXT · max 8 MB</p>
            </div>
          </>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
        className="sr-only"
        onChange={(e) => { if (e.target.files?.[0]) upload(e.target.files[0]); }}
      />
    </div>
  );
}
