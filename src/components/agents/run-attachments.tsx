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
 * WHERE THE CONTROL SITS.
 *
 * `block` is the agent run card's arrangement, unchanged: a labelled button on
 * its own row with the mode's hint sentence beside it, above the file list.
 *
 * `composer` is the chat input bar (2026-09). The product owner's report was
 * that a standalone "Attach a file" button with an explanatory sentence, in its
 * own bordered strip above the message box, "feels clunky and out of place" —
 * and it was: a full-width band of chrome, permanently present, for something
 * most messages do not use. In `composer` the trigger is a `+` on the input line
 * itself, the hint moves to its tooltip and accessible name, and the staged
 * files appear above the line only once there are some. The text input and the
 * send button are passed in as `children` so all three share one row.
 */
export type AttachmentLayout = "block" | "composer";

/**
 * The attach-media control on an agent run card, and the chat composer's `+`.
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
  layout = "block",
  children,
}: {
  clientId: string;
  attachments: RunAttachment[];
  onChange: (next: RunAttachment[]) => void;
  disabled?: boolean;
  mode?: AttachmentMode;
  /** Where this control sits — see `AttachmentLayout`. */
  layout?: AttachmentLayout;
  /**
   * `composer` only: the rest of the input line (the text field and the send
   * button), so the `+` sits beside them rather than in a strip of its own.
   *
   * Taken as children rather than rendered here because the chat owns that
   * input's state, its keyboard handling and its slash-command list; this
   * component owns only the upload.
   */
  children?: React.ReactNode;
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

  /** The hidden picker, shared by both layouts. */
  const picker = (
    <input
      ref={inputRef}
      type="file"
      multiple={spec.max > 1}
      accept={spec.accept}
      className="hidden"
      onChange={(e) => void onPick(e.target.files)}
    />
  );

  if (layout === "composer") {
    return (
      <div className="w-full">
        {/* The tray, and ONLY when there is something in it. A permanently
            visible strip for a thing most messages do not use is the clutter
            this layout exists to remove. */}
        {(attachments.length > 0 || error) && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {attachments.map((a) => (
              <span
                key={a.uri}
                className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-full border border-border bg-surface-2 py-1 pl-2.5 pr-1.5 text-[11px] text-foreground"
              >
                <Icon name="Paperclip" className="h-3 w-3 shrink-0 text-muted-2" />
                <span className="truncate">{a.label ?? a.uri}</span>
                <button
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => onChange(attachments.filter((x) => x.uri !== a.uri))}
                  className="shrink-0 rounded-full p-0.5 text-muted transition-colors hover:bg-surface-3 hover:text-foreground disabled:opacity-50"
                  aria-label={`Remove ${a.label ?? a.uri}`}
                >
                  <Icon name="X" className="h-3 w-3" />
                </button>
              </span>
            ))}
            {error && <span className="text-[11px] text-danger">{error}</span>}
          </div>
        )}

        <div className="flex items-center gap-2">
          {/* The `+`. `spec.hint` is the tooltip AND the accessible name, so
              the sentence that used to occupy a line of the panel is still
              available to a mouse and to a screen reader. `full` disables it at
              the cap, which is why the label says which is which. */}
          <button
            type="button"
            disabled={disabled || busy || full}
            onClick={() => inputRef.current?.click()}
            title={full ? `That is the maximum (${spec.max}).` : spec.hint}
            aria-label={full ? `Attachment limit of ${spec.max} reached` : spec.addLabel}
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-surface-2 text-muted transition-colors hover:border-neon/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25 disabled:cursor-default disabled:opacity-40"
          >
            <Icon
              name={busy ? "Loader" : "Plus"}
              className={`h-4 w-4 ${busy ? "animate-spin text-neon" : ""}`}
            />
          </button>
          {children}
        </div>

        {picker}
      </div>
    );
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

      {picker}

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
