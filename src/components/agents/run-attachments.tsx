"use client";

import { useRef, useState } from "react";
import { Icon } from "@/components/icon";

/** One attachment, in the shape the engine's `mediaAssets` expects. */
export interface RunAttachment {
  uri: string;
  role: "source" | "reference";
  contentType?: string;
  label?: string;
}

/**
 * How the agent under this control consumes what it is given.
 *
 * Three modes because three surfaces read `mediaAssets` differently:
 * `instagram-agent` fills carousel slides in upload order, `tiktok-agent`
 * takes ONE episode to cut a clip out of, and the copilot chat (T-B5) has no
 * agent picked yet when the file is attached — a run may not even happen this
 * turn — so it can only promise "source media for whichever agent runs next",
 * not a slide number or an episode role. A single mode would have to lie to
 * one of them — offering "slide 3" on an agent that ignores everything after
 * the first file, or hiding the slide order from the agent whose whole
 * contract is that order.
 */
export type AttachmentMode = "slides" | "source-video" | "chat";

const MODES: Record<
  AttachmentMode,
  { accept: string; max: number; chip: (index: number) => string; hint: string; addLabel: string }
> = {
  slides: {
    accept: "image/jpeg,image/png,image/webp",
    // One per slide, and a carousel is ten at the very most.
    max: 10,
    chip: (index) => `slide ${index + 1}`,
    hint: "Placed in upload order, first file on slide 1. Any slide you leave uncovered is sourced or generated as usual.",
    addLabel: "Attach images",
  },
  "source-video": {
    accept: "video/mp4,video/quicktime",
    // The workflow reads the first source asset and ignores the rest, so
    // accepting more would be collecting files to throw away.
    max: 1,
    chip: () => "source",
    hint: "The episode this run cuts its clip from.",
    addLabel: "Attach source video",
  },
  chat: {
    // Same set the signed-URL route (`/api/agent-engine/run-media`) itself
    // enforces server-side — offering a picker for a type the upload would
    // 415 on is a control that lies.
    accept: "image/jpeg,image/png,image/webp,video/mp4,video/quicktime",
    // No slide grid or clip role to fill here — just "don't let one message
    // silently balloon into a dozen uploads". Matches MAX_CHAT_ATTACHMENTS
    // (lib/chat/chat-attachments.ts), the server-side backstop for this cap.
    max: 4,
    chip: () => "attached",
    hint: "Sent with your next message as source media, if you ask an agent to run.",
    addLabel: "Attach a file",
  },
};

/**
 * The attach-media control on an agent run card.
 *
 * ## Upload order is the contract, not a detail
 *
 * In `slides` mode the engine places attachments as Tier 0 — above every
 * sourcing tier — by upload order: first file to slide 1, second to slide 2. So
 * the list below shows each file's position explicitly. Someone choosing which
 * photo goes on which slide needs to see the order they are creating, and
 * "slide 1" beside the filename is the whole of that affordance.
 *
 * ## The upload goes browser → GCS
 *
 * `/api/agent-engine/run-media` returns a signed PUT URL and the `gs://` URI
 * the engine will read. The file never passes through our server, and the URI
 * outlives any signed link, so a replayed run days later still resolves it.
 */
export function RunAttachments({
  clientId,
  attachments,
  onChange,
  disabled,
  mode = "slides",
}: {
  clientId: string;
  attachments: RunAttachment[];
  onChange: (next: RunAttachment[]) => void;
  disabled?: boolean;
  mode?: AttachmentMode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spec = MODES[mode];
  const full = attachments.length >= spec.max;

  async function uploadOne(file: File): Promise<RunAttachment> {
    const signed = await fetch("/api/agent-engine/run-media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, filename: file.name, contentType: file.type }),
    });
    if (!signed.ok) {
      const body = (await signed.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Could not start the upload.");
    }
    const { uploadUrl, uri, contentType } = (await signed.json()) as {
      uploadUrl: string;
      uri: string;
      contentType: string;
    };

    const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
    if (!put.ok) throw new Error(`Upload failed (${put.status}).`);

    return { uri, role: "source", contentType, label: file.name };
  }

  async function onPick(files: FileList | null) {
    if (!files || files.length === 0 || busy) return;
    if (!clientId) {
      setError("Pick a client first. An attachment is stored against their media.");
      return;
    }
    // Refused before uploading, not trimmed after: a file that has already cost
    // an upload and then vanishes from the list is indistinguishable from a bug.
    const room = spec.max - attachments.length;
    if (files.length > room) {
      setError(room === 0 ? `That is the maximum (${spec.max}).` : `Only ${room} more can be attached here.`);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const uploaded: RunAttachment[] = [];
      // Sequential, so the resulting order matches the order chosen. A
      // Promise.all here would resolve in completion order and silently
      // reshuffle which photo lands on which slide.
      for (const file of Array.from(files)) {
        uploaded.push(await uploadOne(file));
      }
      onChange([...attachments, ...uploaded]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled || busy || full}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-foreground transition-colors hover:border-border-strong hover:bg-surface-3 disabled:opacity-50"
        >
          <Icon
            name={busy ? "Loader" : "Paperclip"}
            className={`h-3 w-3 ${busy ? "animate-spin text-neon" : "text-muted"}`}
          />
          {busy ? "Uploading…" : spec.addLabel}
        </button>
        <span className="text-xs text-muted">{spec.hint}</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple={spec.max > 1}
        accept={spec.accept}
        className="hidden"
        onChange={(e) => void onPick(e.target.files)}
      />

      {attachments.length > 0 && (
        <ul className="mt-2 space-y-1">
          {attachments.map((a, index) => (
            <li key={a.uri} className="flex items-center gap-2 text-xs">
              <span className="rounded bg-surface-3 px-1.5 py-0.5 text-muted">{spec.chip(index)}</span>
              <span className="truncate text-foreground">{a.label ?? a.uri}</span>
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => onChange(attachments.filter((x) => x.uri !== a.uri))}
                className="ml-auto text-muted transition-colors hover:text-foreground disabled:opacity-50"
                aria-label={`Remove ${a.label ?? a.uri}`}
              >
                <Icon name="X" className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
