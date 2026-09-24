"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AssetCard } from "@/components/asset-card";
import { Badge, Button, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { indexAfterListChange, keyEventIsForQueue, queueKeyAction, queuePosition, stepIndex } from "@/lib/review-queue";
import type { Asset } from "@/lib/types";

/**
 * ONE DRAFT AT A TIME, WITH A COUNTER AND A KEYBOARD.
 *
 * The grid is the right shape for "what do we have" and the wrong one for
 * "decide on all of these": a reviewer working a backlog of fourteen drafts in
 * a two-column grid has to find their place again after every approval, and
 * the page re-sorts under them each time one leaves. What that costs is not
 * clicks, it is attention — and the drafts at the bottom get the least of it.
 *
 * So this is the same card, alone, with the two things a queue needs and a grid
 * cannot have: a POSITION ("4 of 14", which is what makes it finishable) and
 * keys, so a decision costs a keystroke rather than a hunt for a button.
 *
 * ## What it deliberately is not
 *
 * **Not a second approve path.** The card inside is `AssetCard` with its own
 * `ApprovePanel`, the same component the grid renders and the same server
 * action it calls. A queue that grew its own approve button would be a second
 * place for the publish tier, the schedule and the platform list to drift.
 *
 * **Not a mode you can get stuck in.** Escape leaves, the button says so, and
 * an emptied queue closes itself rather than showing "1 of 0".
 *
 * **Not the owner of what is in it.** The list comes from the page's own
 * filters. Filter to Drafts and the queue is the drafts; filter to one channel
 * and it is that channel's. One list, one set of controls.
 *
 * Where the reviewer LANDS after each change is `@/lib/review-queue`, pure and
 * tested there — every teleport bug in a queue like this is index arithmetic.
 */
export function ReviewQueue({
  assets,
  canApprove,
  clientNames,
  connectedPlatformsByClient,
  agentDraftPublishPlatformsByClient,
  onClose,
}: {
  /** The queue, in the order the page decided. Shrinks as drafts are decided. */
  assets: Asset[];
  canApprove?: boolean;
  clientNames?: Record<string, string>;
  connectedPlatformsByClient?: Record<string, string[]>;
  agentDraftPublishPlatformsByClient?: Record<string, string[]>;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  /**
   * The ids as they were on the last render, so a change can be read as "what
   * happened to the draft they were ON" rather than as a new array. Without
   * this the queue can only clamp, and clamping teleports a reviewer whenever
   * something above them is decided in another tab.
   */
  const previousIds = useRef<string[]>(assets.map((a) => a.id));
  const approveRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const nextIds = assets.map((a) => a.id);
    const same = nextIds.length === previousIds.current.length && nextIds.every((id, i) => id === previousIds.current[i]);
    if (same) return;
    const landed = indexAfterListChange(previousIds.current, nextIds, index);
    previousIds.current = nextIds;
    if (landed === null) {
      onClose();
      return;
    }
    setIndex(landed);
  }, [assets, index, onClose]);

  const move = useCallback((direction: 1 | -1) => setIndex((i) => stepIndex(assets.length, i, direction)), [assets.length]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!keyEventIsForQueue(event.target as HTMLElement | null)) return;
      const action = queueKeyAction(event.key, { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey });
      if (!action) return;
      event.preventDefault();
      if (action === "next") move(1);
      else if (action === "previous") move(-1);
      else if (action === "close") onClose();
      else if (action === "approve") {
        // The card owns approving; "a" reaches for its control rather than
        // calling the action, so the tier and the slot are still chosen by a
        // person. A card that has none (already decided, or this reviewer
        // cannot approve) simply gets nothing.
        const button = approveRef.current?.querySelector<HTMLButtonElement>('button[data-approve-trigger="true"]');
        button?.click();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [move, onClose]);

  const asset = assets[Math.min(index, Math.max(assets.length - 1, 0))];
  if (!asset) {
    return (
      <EmptyState
        icon={<Icon name="CheckCheck" className="h-7 w-7" />}
        title="Queue finished"
        description="Every draft in this filter has been decided."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 p-2">
        <span className="px-1 text-[10px] font-label font-medium uppercase tracking-[0.12em] text-muted-2">Review queue</span>
        <Badge tone="info">{queuePosition(assets.length, index)}</Badge>
        {clientNames?.[asset.clientId] && <Badge tone="neutral">{clientNames[asset.clientId]}</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" onClick={() => move(-1)} disabled={index === 0} aria-label="Previous draft">
            <Icon name="ChevronLeft" className="h-4 w-4" />
          </Button>
          <Button variant="ghost" onClick={() => move(1)} disabled={index >= assets.length - 1} aria-label="Next draft">
            <Icon name="ChevronRight" className="h-4 w-4" />
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Exit queue
          </Button>
        </div>
      </div>

      {/* The shortcuts, written down. A keyboard affordance nobody is told
          about is a keyboard affordance nobody uses, and this is the one line
          that makes the queue faster than the grid. */}
      <p className="px-1 text-[11px] text-muted-2">
        <kbd className="rounded border border-border px-1">J</kbd> / <kbd className="rounded border border-border px-1">→</kbd> next ·{" "}
        <kbd className="rounded border border-border px-1">K</kbd> / <kbd className="rounded border border-border px-1">←</kbd> previous ·{" "}
        <kbd className="rounded border border-border px-1">A</kbd> approve · <kbd className="rounded border border-border px-1">Esc</kbd> exit
      </p>

      <div ref={approveRef}>
        <AssetCard
          key={asset.id}
          asset={asset}
          canApprove={canApprove}
          {...(connectedPlatformsByClient?.[asset.clientId] ? { connectedPlatforms: connectedPlatformsByClient[asset.clientId] } : {})}
          {...(agentDraftPublishPlatformsByClient?.[asset.clientId]
            ? { agentDraftPublishPlatforms: agentDraftPublishPlatformsByClient[asset.clientId] }
            : {})}
        />
      </div>
    </div>
  );
}
