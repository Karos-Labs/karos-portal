"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { taskMapRefreshPrice } from "@/lib/credits";
import { StrategyWarRoom } from "@/components/strategy-war-room";

/**
 * Opens the Strategy War Room - the multi-agent Task Map debate that used to
 * be reachable only from the copilot's "Refresh Task Map" chip. Moved onto the
 * Task Map itself: it rebuilds the board this page shows, and reads oddly
 * homed inside a general-purpose chat assistant.
 *
 * Exported standalone (not folded into TasksBoard) so its price can be
 * asserted as RENDERED MARKUP, same precedent the copilot's ActionChips set -
 * a component can import a price function and never render its result, or
 * hardcode the wrong number beside it, and a string-level assertion over the
 * helper alone would stay green through both.
 */
export function RefreshTaskMapButton({
  clientId,
  isAiProcessing,
  viewerIsBilled,
  className,
  label = "Refresh Task Map",
}: {
  clientId: string;
  /** True while a background AI generation cycle is running - locks the button. */
  isAiProcessing?: boolean;
  /** `isBillableClientActor()` for this session — decides whether a price is quoted. */
  viewerIsBilled: boolean;
  className?: string;
  /** Override the button's own words for a call site with different framing (e.g. the
   *  sparse-calendar banner) — the press still does exactly the same thing. */
  label?: string;
}) {
  const router = useRouter();
  const [warRoomOpen, setWarRoomOpen] = useState(false);
  const openWarRoom = useCallback(() => setWarRoomOpen(true), []);
  const locked = !!isAiProcessing;
  // THE ANNOUNCE. Pressing this control does not open a confirmation — the War
  // Room mounts and the debate (six model calls) starts immediately, so the
  // charge is committed by the press itself. Quoted from the same constant
  // /api/tasks/generate-swarm charges from.
  const price = taskMapRefreshPrice(viewerIsBilled);
  // PARITY PASS (2026-09). Staff (and an admin in "View as Client") used to
  // get a SHORTER button than the client does — the price suffix simply
  // vanished — so the one control this page leans on measured differently in
  // the two views and nobody previewing an account could see the number the
  // client is quoted. The suffix now paints for both readers at the same
  // length; what changes is the tooltip, which says whose money it is. Asked
  // of the same helper with `true` so the figure still moves with a reprice —
  // this is the CLIENT's price, quoted to staff as information.
  const clientPrice = taskMapRefreshPrice(true);

  // ONE TITLE, ON THE BUTTON (review wave, 2026-09). The price suffix carried a
  // `title` of its own inside the button's, so hovering the number and hovering
  // the words gave two different tooltips and neither told an unbilled reader
  // both facts. The button says everything now, in the register of whoever is
  // reading it, and the suffix says the rest in RENDERED words — which is the
  // half a touch device can actually see.
  const description = locked
    ? "Locked. A workspace build is already running"
    : viewerIsBilled
      ? `Rebuild your task map from calendar gaps and past performance${price ? ` · costs ${price} a press` : ""}`
      : `Rebuild this client's task map from calendar gaps and past performance${clientPrice ? ` · ${clientPrice} a press for the client, free for staff` : ""}`;

  return (
    <>
      {/* Same shape as QuickAddTaskBar's own pill (h-7 icon chip, px-3 py-2.5,
          single line) - a sibling row control, not a stacked chat-chip card,
          so the two sit at the same height instead of one dwarfing the other. */}
      <button
        type="button"
        onClick={openWarRoom}
        disabled={locked}
        title={description}
        className={cn(
          "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm font-medium text-foreground transition-colors",
          locked ? "cursor-not-allowed opacity-50" : "hover:border-border-strong hover:bg-surface-3",
          className,
        )}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-neon-soft text-neon">
          <Icon name={locked ? "Loader" : "ListTodo"} className={cn("h-3.5 w-3.5", locked && "animate-spin")} />
        </span>
        {label}
        {clientPrice && !locked && (
          <span className="text-xs font-normal text-muted-2">
            {/* The unbilled reader gets the same figure at the same width, and
                a RENDERED word saying whose charge it is - a tooltip is the one
                marker in the parity pass a touch device cannot see. */}
            · {clientPrice}
            {!viewerIsBilled && (
              <span className="ml-1 font-mono text-[9px] uppercase tracking-[0.1em]">client</span>
            )}
          </span>
        )}
      </button>

      {warRoomOpen && (
        <StrategyWarRoom
          clientId={clientId}
          onClose={() => setWarRoomOpen(false)}
          onComplete={() => router.refresh()}
        />
      )}
    </>
  );
}
