"use client";

import { useId } from "react";
import { RunAttachments, type RunAttachment } from "@/components/agents/run-attachments";
import { cn } from "@/lib/utils";
import {
  attachmentModeForEngineProduct,
  effectiveMediaSource,
  engineProductSourcesItsOwnMedia,
  mediaSourceHint,
  MEDIA_SOURCE_AUTO_WITH_UPLOADS,
  type MediaSource,
} from "@/lib/custom-agent-launch";

/**
 * "Media for this run": the one media block every media agent's run form
 * paints (the client run dialog and the admin engine card).
 *
 * The owner, 2026-09-25: the block used to open on a select asking where the
 * visuals come from BEFORE anything was uploaded, which is a question with no
 * meaning yet. It is smart now:
 *
 *  - Nothing uploaded: nothing to decide. The agent finds or makes its own
 *    visuals, and the sentence under the button says so.
 *  - Something uploaded: ONE switch, "Use only my media", OFF by default. Off
 *    means the agent uses the uploads first and adds its own only if the post
 *    needs more (it may not). On means the uploads and nothing else.
 *
 * Removing the last upload turns the switch back off, so a run can never go
 * out as "only my media" with no media: the choice cannot outlive the files it
 * was about. `toEngineRunInput` applies the same rule on the server
 * (`effectiveMediaSource`), for a brief that arrives some other way.
 *
 * X is the one product with no switch: it never sources a picture, so "only
 * mine" is the only behaviour it has (`engineProductSourcesItsOwnMedia`).
 */
export function RunMediaBlock({
  clientId,
  engineProductId,
  attachments,
  onAttachmentsChange,
  mediaSource,
  onMediaSourceChange,
  disabled,
}: {
  clientId: string;
  engineProductId: string | undefined;
  attachments: RunAttachment[];
  onAttachmentsChange: (next: RunAttachment[]) => void;
  mediaSource: MediaSource;
  onMediaSourceChange: (next: MediaSource) => void;
  disabled?: boolean;
}) {
  const switchId = useId();
  const source = effectiveMediaSource(mediaSource, attachments.length);
  const offersSwitch = engineProductSourcesItsOwnMedia(engineProductId) && attachments.length > 0;
  const onlyMine = source === "client";
  const required = engineProductId === "tiktok-editing-agent";

  function changeAttachments(next: RunAttachment[]) {
    onAttachmentsChange(next);
    if (next.length === 0 && mediaSource !== "system") onMediaSourceChange("system");
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-1 p-3">
      <div>
        <span className="text-xs font-medium text-muted">
          {required ? "Media for this run" : "Media for this run (optional)"}
        </span>
        <RunAttachments
          clientId={clientId}
          attachments={attachments}
          onChange={changeAttachments}
          disabled={disabled}
          mode={attachmentModeForEngineProduct(engineProductId) ?? "slides"}
          hint={mediaSourceHint(engineProductId, source)}
        />
      </div>
      {offersSwitch && (
        <div className="flex items-start gap-3 border-t border-border pt-3">
          <div className="min-w-0 flex-1">
            <label htmlFor={switchId} className="text-sm font-medium text-foreground">
              Use only my media
            </label>
            <p className="text-xs text-muted-2">
              {onlyMine ? mediaSourceHint(engineProductId, "client") : MEDIA_SOURCE_AUTO_WITH_UPLOADS}
            </p>
          </div>
          <button
            id={switchId}
            type="button"
            role="switch"
            aria-checked={onlyMine}
            disabled={disabled}
            onClick={() => onMediaSourceChange(onlyMine ? "system" : "client")}
            className={cn(
              "focus-ring relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 disabled:opacity-50",
              onlyMine ? "bg-neon" : "bg-surface-3",
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-primary shadow-md transition-transform duration-200",
                onlyMine ? "translate-x-5" : "translate-x-0",
              )}
            />
          </button>
        </div>
      )}
    </div>
  );
}
