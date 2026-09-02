"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { bulkScheduleClipsAction } from "@/lib/actions";
// `lib/media-kinds`, NOT `lib/gcs-media`: that module is `server-only` and
// constructs a Storage client, so importing it from a "use client" component
// fails the build outright. The pure half lives in its own module for exactly
// this reason - see its header.
import {
  ALLOWED_MEDIA_EXTENSIONS,
  ALLOWED_MEDIA_MIME_TYPES,
  MAX_IMAGE_BYTES,
  maxBytesFor,
  mediaKindFor,
  mediaMimeFor,
} from "@/lib/media-kinds";
import { cn } from "@/lib/utils";

/**
 * IMAGES AND VIDEOS (2026-09). This was video-only and the control was called
 * "Bulk upload clips"; the product owner asked for one general media upload so
 * a client's photos and clips go in through the same door.
 *
 * Derived from `lib/media-kinds`, never re-typed: the picker's accept list and
 * the size ceilings are the SAME values the sign step enforces server-side, so
 * this control cannot offer a file the upload would then reject.
 */
const ACCEPT = [...ALLOWED_MEDIA_MIME_TYPES, ...ALLOWED_MEDIA_EXTENSIONS].join(",");

interface UploadItem {
  key: string;
  name: string;
  status: "pending" | "uploading" | "registering" | "done" | "error";
  error?: string;
}

/**
 * Best-effort local duration probe - never blocks the upload if it fails.
 *
 * VIDEO ONLY, and the caller checks the kind before calling. Handed an image
 * this resolves `undefined` via `onerror` anyway — but only after the browser
 * has tried to decode the file as a video, which on a 20 MB photo is a real
 * pause with nothing to show for it.
 */
function probeDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    const url = URL.createObjectURL(file);
    const done = (seconds?: number) => {
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? Math.round(video.duration) : undefined);
    video.onerror = () => done(undefined);
    video.src = url;
  });
}

async function uploadOne(clientId: string, file: File): Promise<void> {
  // The kind decides two things below: which fallback content type is sent when
  // the browser gives none, and whether the duration probe runs at all. Asked
  // once, through the same helper the server registers by, so the two ends
  // cannot classify one file differently.
  const kind = mediaKindFor(file.type, file.name) ?? "video";
  // Same resolution the server stores by, so the type the signed URL is minted
  // for, the type the PUT declares, and the type on the asset are one answer.
  const contentType = mediaMimeFor(file.type, file.name);

  const signRes = await fetch("/api/assets/bulk-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      step: "sign",
      clientId,
      filename: file.name,
      contentType,
      sizeBytes: file.size,
    }),
  });
  const signPayload = (await signRes.json().catch(() => ({}))) as {
    uploadUrl?: string;
    gcsPath?: string;
    error?: string;
  };
  if (!signRes.ok || !signPayload.uploadUrl || !signPayload.gcsPath) {
    throw new Error(signPayload.error || `Could not get an upload URL for ${file.name}`);
  }

  // Must match the content type the signed URL was minted for, or GCS rejects
  // the PUT — so it is the same `contentType` computed above, not a second
  // `file.type || …` expression that could disagree with it.
  const putRes = await fetch(signPayload.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!putRes.ok) throw new Error(`Upload to storage failed for ${file.name}`);

  const durationSeconds = kind === "video" ? await probeDuration(file) : undefined;

  const completeRes = await fetch("/api/assets/bulk-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      step: "complete",
      clientId,
      gcsPath: signPayload.gcsPath,
      filename: file.name,
      contentType,
      ...(durationSeconds != null ? { durationSeconds } : {}),
    }),
  });
  if (!completeRes.ok) {
    const payload = (await completeRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `Could not register ${file.name}`);
  }
}

/** How many uploads run at once - enough to use available bandwidth without
 *  opening 100 concurrent PUTs when a whole media batch is dropped at once. */
const CONCURRENCY = 3;

/**
 * Staff-only: upload a client's media straight to GCS and register each file as
 * a draft asset - trigger-button + modal, matching LabImportButton's pattern
 * (lab-import.tsx).
 *
 * ── IT WAS "Bulk upload clips" (2026-09) ─────────────────────────────────
 *
 * Video only, named after the one workflow it was built for (podcast cuts).
 * The product owner asked for a general media upload so images and videos go
 * in through the same door, so the accept list, the size cap, the duration
 * probe and the default channel are all kind-aware now, and the control reads
 * "Upload media".
 *
 * WHAT DID NOT GET RENAMED, and why. The route is still
 * `/api/assets/bulk-upload`, the server action still `bulkScheduleClipsAction`,
 * the bucket prefix still `clients/<id>/podcast-clips/`, and the marker on
 * every registered asset still `meta.bulkUpload`. Those four are STORED or
 * WIRE names: every object in production lives under that prefix, every
 * registered asset's `meta.gcsPath` points into it, and the route's ownership
 * check reads it. Renaming them is an object migration and a Firestore
 * backfill, not a rename, and it would buy nicer strings and nothing else.
 * This file's own name and export moved because they are neither.
 */
export function MediaUploadButton({
  clientId,
  bucketName,
  menuItem = false,
}: {
  clientId: string;
  bucketName?: string;
  /**
   * Render the trigger as a row in a "More actions" menu rather than as a
   * standalone header button (2026-09). Ghost over subtle: inside a popover the
   * subtle variant's own fill and border draw a second card around every row.
   */
  menuItem?: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [scheduleResult, setScheduleResult] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const destinationPath = bucketName ? `gs://${bucketName}/clients/${clientId}/podcast-clips/` : null;

  async function copyDestinationPath() {
    if (!destinationPath) return;
    await navigator.clipboard.writeText(destinationPath);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleFiles(fileList: FileList) {
    const files = Array.from(fileList);
    // PER KIND, matching the sign step's own ceilings: a 900 MB "image" is
    // never a file anyone meant to attach, and refusing it here saves the
    // round trip the server would refuse anyway.
    const oversized = files.find(
      (f) => f.size > maxBytesFor(mediaKindFor(f.type, f.name) ?? "video"),
    );
    if (oversized) {
      const kind = mediaKindFor(oversized.type, oversized.name) ?? "video";
      setItems((prev) => [
        ...prev,
        {
          key: `${oversized.name}-${Date.now()}`,
          name: oversized.name,
          status: "error",
          error:
            kind === "image"
              ? `Larger than ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB`
              : "Larger than 2 GB",
        },
      ]);
      return;
    }

    const queued: UploadItem[] = files.map((f) => ({
      key: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`,
      name: f.name,
      status: "pending",
    }));
    setItems((prev) => [...prev, ...queued]);
    setBusy(true);

    let cursor = 0;
    async function worker() {
      while (cursor < files.length) {
        const index = cursor++;
        const file = files[index];
        const key = queued[index].key;
        setItems((prev) => prev.map((it) => (it.key === key ? { ...it, status: "uploading" } : it)));
        try {
          await uploadOne(clientId, file);
          setItems((prev) => prev.map((it) => (it.key === key ? { ...it, status: "done" } : it)));
        } catch (e) {
          setItems((prev) =>
            prev.map((it) =>
              it.key === key
                ? { ...it, status: "error", error: e instanceof Error ? e.message : "Upload failed" }
                : it,
            ),
          );
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));
    setBusy(false);
    router.refresh();
  }

  async function importFromStorage() {
    setImporting(true);
    setImportResult(null);
    try {
      const res = await fetch("/api/assets/bulk-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "import-bucket", clientId }),
      });
      const payload = (await res.json().catch(() => ({}))) as { imported?: number; skipped?: number; error?: string };
      if (!res.ok) throw new Error(payload.error || "Import failed");
      setImportResult(
        `Imported ${payload.imported ?? 0} file(s) from storage${payload.skipped ? ` (${payload.skipped} already registered)` : ""}.`,
      );
      router.refresh();
    } catch (e) {
      setImportResult(e instanceof Error ? e.message : "Could not import from storage.");
    } finally {
      setImporting(false);
    }
  }

  async function runAutoSchedule() {
    if (!scheduleDate) return;
    setScheduling(true);
    setScheduleResult(null);
    try {
      const startAtMs = new Date(`${scheduleDate}T00:00:00`).getTime();
      const { scheduled } = await bulkScheduleClipsAction(clientId, startAtMs);
      setScheduleResult(
        scheduled > 0
          ? `Scheduled ${scheduled} post${scheduled === 1 ? "" : "s"} from ${scheduleDate}, at this client's clip pace. Each one books the channel it is filed under.`
          : "No unscheduled uploads to schedule.",
      );
      router.refresh();
    } catch (e) {
      setScheduleResult(e instanceof Error ? e.message : "Could not auto-schedule the batch.");
    } finally {
      setScheduling(false);
    }
  }

  const doneCount = items.filter((i) => i.status === "done").length;
  const errorCount = items.filter((i) => i.status === "error").length;

  return (
    <>
      <Button size="sm" variant={menuItem ? "ghost" : "subtle"} onClick={() => setOpen(true)}>
        <Icon name="Upload" className="h-3.5 w-3.5" /> Upload media
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Upload media"
        description="Images and video, uploaded straight to storage and registered as draft social posts for review."
        className="max-w-xl"
      >
        <div className="space-y-3">
          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed px-4 py-6 text-center transition-colors",
              isDragging ? "border-neon bg-neon/[0.05]" : "border-border hover:border-neon/40",
            )}
          >
            <Icon name="Upload" className="h-5 w-5 text-muted-2" />
            <p className="text-xs text-muted">
              {busy ? "Uploading…" : "Click or drag images or video here"}
            </p>
            <p className="text-[11px] text-muted-2">
              JPG, PNG, WebP up to {Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB · MP4, MOV up
              to 2 GB · registered as draft social posts
            </p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="sr-only"
            onChange={(e) => {
              if (e.target.files?.length) void handleFiles(e.target.files);
              if (inputRef.current) inputRef.current.value = "";
            }}
          />

          {items.length > 0 ? (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-foreground/[0.02] p-2">
              {items.map((item) => (
                <div key={item.key} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs">
                  {item.status === "done" ? (
                    <Icon name="CheckCircle2" className="h-3.5 w-3.5 shrink-0 text-neon" />
                  ) : item.status === "error" ? (
                    <Icon name="AlertCircle" className="h-3.5 w-3.5 shrink-0 text-danger" />
                  ) : (
                    <div className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-2 border-t-transparent" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-foreground">{item.name}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-[0.06em] text-muted-2">
                    {item.status === "error" ? item.error : item.status}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {(doneCount > 0 || errorCount > 0) && !busy ? (
            <p className="text-xs text-muted-2">
              {doneCount} uploaded{errorCount > 0 ? `, ${errorCount} failed` : ""}.
            </p>
          ) : null}

          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-2">Already copied files straight into the bucket (gcloud/Console)?</p>
              <Button type="button" size="sm" variant="outline" loading={importing} onClick={importFromStorage}>
                <Icon name="RefreshCcw" className="h-3.5 w-3.5" />
                Import from Storage
              </Button>
            </div>
            {destinationPath ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md bg-surface-2 px-2.5 py-1.5 text-[11px] font-mono text-muted-2">
                  {destinationPath}
                </code>
                <button
                  type="button"
                  onClick={copyDestinationPath}
                  title={copied ? "Copied!" : "Copy this client's exact destination path"}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-2 transition-colors hover:border-foreground/30 hover:text-foreground"
                >
                  <Icon name={copied ? "Check" : "Copy"} className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : null}
            <p className="text-[11px] text-muted-2">
              {destinationPath
                ? "Copy this exact path. A different client's id here would land these files (or nothing, if Import from Storage can't find them) somewhere else."
                : "Set GCS_MEDIA_BUCKET to show this client's exact gcloud destination path."}
            </p>
          </div>
          {importResult ? <p className="text-xs text-muted-2">{importResult}</p> : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <label className="text-xs text-muted" htmlFor="bulk-schedule-start">
              Auto-Schedule Bulk Batch from
            </label>
            <input
              id="bulk-schedule-start"
              type="date"
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.target.value)}
              className="rounded-md border border-border bg-surface-3 px-2 py-1 text-xs text-foreground"
            />
            <Button type="button" size="sm" variant="outline" disabled={!scheduleDate} loading={scheduling} onClick={runAutoSchedule}>
              <Icon name="CalendarClock" className="h-3.5 w-3.5" />
              Schedule
            </Button>
          </div>
          {scheduleResult ? <p className="text-xs text-muted-2">{scheduleResult}</p> : null}
        </div>
      </Modal>
    </>
  );
}
