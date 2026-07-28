"use client";

import { useEffect, useRef, useState } from "react";
import { ChatbotWidget } from "@/components/chatbot-widget";
import { Icon } from "@/components/icon";
import { MOBILE_TAB_BAR_OFFSET_CLASS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { Client, ClientReport } from "@/lib/types";

/**
 * Rail + sheet open/closed state, remembered across reloads. In-app navigation
 * already preserves it (the dock lives in the (app) layout); a hard reload used
 * to re-expand a rail the user had deliberately collapsed (QA F88).
 */
const DOCK_STATE_KEY = "karos.copilot.dock";

/**
 * Which app shell hosts the dock. The two differ only in the width of their
 * left nav column — ClientRail is `w-72`, the staff Sidebar is `w-64` — but the
 * strip has to start exactly at that column's right edge, and both numbers used
 * to be hardcoded to the client portal's geometry (CD-G8).
 */
export type CopilotShell = "client" | "staff";

/**
 * Where the strip and the expanded sheet pin themselves, below `lg`.
 *
 * The bottom is the same in both shells: every shell that shows the client
 * 4-tab nav renders the mobile bottom bar below `md` (CD-G9a), so the strip
 * parks directly above it and drops to the viewport edge from `md` up, where
 * that nav is a left column instead. `right-0` is unconditional — running to
 * the viewport's right edge is the whole point of the contract.
 */
const SHELL_ANCHOR: Record<CopilotShell, string> = {
  client: `left-0 right-0 ${MOBILE_TAB_BAR_OFFSET_CLASS} md:bottom-0 md:left-72`,
  staff: `left-0 right-0 ${MOBILE_TAB_BAR_OFFSET_CLASS} md:bottom-0 md:left-64`,
};

/**
 * Whether an element is actually painted. The shell swaps its two dock surfaces
 * with `lg:hidden` / `hidden lg:block`, and a `display:none` element still holds
 * a live ref — so the outside-click pass below has to skip the surface that
 * isn't on screen, or browsing at phone width would quietly persist a collapsed
 * desktop rail (and vice versa) through DOCK_STATE_KEY.
 *
 * `getClientRects()` rather than `offsetParent`: the sheet is `position: fixed`,
 * whose offsetParent is null even when it is perfectly visible.
 */
function isPainted(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.getClientRects().length > 0;
}

interface Props {
  clientId: string;
  /** Signed-in viewer — scopes the persisted copilot transcript. */
  viewerUid: string;
  clientName: string;
  userName?: string;
  hasGoogleIntegration?: boolean;
  client?: Pick<Client, "name" | "website" | "industry" | "isAiProcessing">;
  report?: Pick<ClientReport, "overallGrade" | "overallScore"> | null;
  /** Host shell — sets the left offset of the pinned strip. Defaults to the client portal. */
  shell?: CopilotShell;
}

/**
 * Right-rail wrapper for the docked copilot. The rail width animates between
 * expanded and a slim strip; a single fixed-size handle on the left edge toggles
 * it, so nothing jumps or resizes. The chat stays mounted (state preserved) and
 * is simply clipped when collapsed. Desktop (lg+) only.
 */
export function CopilotDock({ clientId, viewerUid, clientName, userName, hasGoogleIntegration, client, report, shell = "client" }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** Blocks the write-back below until the restore pass has run. */
  const hydratedRef = useRef(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const anchor = SHELL_ANCHOR[shell];

  useEffect(() => {
    hydratedRef.current = false;
    try {
      const raw = localStorage.getItem(DOCK_STATE_KEY);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object") {
        const s = saved as Record<string, unknown>;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring persisted state on mount is the point
        if (typeof s.collapsed === "boolean") setCollapsed(s.collapsed);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring persisted state on mount is the point
        if (typeof s.sheetOpen === "boolean") setSheetOpen(s.sheetOpen);
      }
    } catch {
      /* unreadable / disabled storage — keep the defaults */
    }
    hydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      localStorage.setItem(DOCK_STATE_KEY, JSON.stringify({ collapsed, sheetOpen }));
    } catch {
      /* quota or private mode — state stays in memory */
    }
  }, [collapsed, sheetOpen]);

  /**
   * Dismiss on any click outside the copilot (CD-G9b): it stays open only while
   * the viewer is working inside it. Same idiom as the export menu in
   * client-documents.tsx — a document `mousedown` plus a ref containment test —
   * rather than the full-screen click-catcher some menus use, because a catcher
   * would swallow the first click on every page while the copilot is open.
   *
   * Neither surface is unmounted: the sheet is hidden with `display:none` and
   * the rail is clipped, so a half-typed message and the restored transcript
   * both survive an accidental dismissal (QA F88).
   *
   * The Strategy War Room renders inside ChatbotWidget with no portal, so its
   * DOM is inside these refs and clicking it does not count as "outside".
   */
  useEffect(() => {
    if (!sheetOpen && collapsed) return;
    function handleOutside(e: MouseEvent) {
      const target = e.target as Node;
      const sheet = sheetRef.current;
      const rail = railRef.current;
      if (sheetOpen && isPainted(sheet) && !sheet.contains(target)) setSheetOpen(false);
      if (!collapsed && isPainted(rail) && !rail.contains(target)) setCollapsed(true);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [sheetOpen, collapsed]);

  const widgetProps = {
    clientId,
    viewerUid,
    clientName,
    userName,
    hasGoogleIntegration,
    client,
    report,
  };

  return (
    <>
      {/* Below lg: a strip pinned to the bottom of the viewport that pops up
          into a sheet. Both states share one anchor so the sheet opens exactly
          where the strip was, and neither ever floats mid-flow (CD-G8).

          The sheet is capped rather than fixed at 70dvh: a fixed box left a
          dead region between the sparse welcome content and the input row. It
          now grows with the transcript up to the cap, and only then scrolls.
          (The cap itself is QA F94 — at 35vh the greeting filled the sheet and
          the four AI actions sat below the fold on first open.)

          Both surfaces stay mounted and swap with `hidden`, so dismissing the
          sheet keeps a half-typed message alive (CD-G9b). */}
      <div className="lg:hidden">
        <div
          ref={sheetRef}
          className={cn(
            "fixed z-40 flex max-h-[70dvh] flex-col border-t border-border bg-background shadow-[0_-8px_30px_rgba(0,0,0,0.5)]",
            anchor,
            !sheetOpen && "hidden",
          )}
        >
          <ChatbotWidget docked defaultOpen onCollapse={() => setSheetOpen(false)} {...widgetProps} />
        </div>

        <button
          onClick={() => setSheetOpen(true)}
          className={cn(
            "fixed z-40 flex items-center justify-center gap-2 border-t border-border bg-background/95 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground backdrop-blur-sm transition-colors hover:bg-surface-2",
            anchor,
            sheetOpen && "hidden",
          )}
          aria-label="Open AI Copilot"
          aria-expanded={sheetOpen}
        >
          <Icon name="MessageCircle" className="h-4 w-4 text-muted" />
          AI Copilot
          <Icon name="ChevronUp" className="h-4 w-4 text-muted-2" />
        </button>
      </div>

      <aside
        ref={railRef}
        className={cn(
          // min-w-0 beats the flex automatic minimum — without it the fixed-width
          // chat inside keeps the rail at 380px and w-12 never takes effect.
          "relative hidden min-w-0 shrink-0 border-l border-border bg-background transition-[width] duration-300 ease-in-out lg:block",
          collapsed ? "w-12" : "w-[380px]",
        )}
      >
      {/* z-40: sticky always forms its own stacking context, so the handle's
          z-index can't beat the z-30 page header from inside — the frame
          itself must sit above it or the header covers the handle's left half. */}
      <div className="sticky top-0 z-40 h-screen">
        {/* Edge handle — inside the sticky frame so it pins to the viewport
            near the top (never scrolls away), and above the sticky page
            header so the full circle always shows. */}
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="absolute left-0 top-4 z-40 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-muted-2 shadow-md transition-colors hover:text-foreground"
          aria-label={collapsed ? "Expand AI Copilot" : "Collapse AI Copilot"}
          title={collapsed ? "Expand AI Copilot" : "Collapse AI Copilot"}
        >
          <Icon name={collapsed ? "ChevronLeft" : "ChevronRight"} className="h-4 w-4" />
        </button>

        {/* Clip lives on this inner frame — not the sticky one — so the
            handle can hang past the border without being cut off. */}
        <div className="relative h-full overflow-hidden">
          {/* Fixed-width chat — clipped by the parent as the rail narrows (no reflow) */}
          <div className="h-full w-[380px]">
            <ChatbotWidget docked defaultOpen {...widgetProps} />
          </div>

          {/* Collapsed strip overlay */}
          <div
            className={cn(
              "absolute inset-0 flex flex-col items-center gap-3 bg-background pt-16 transition-opacity duration-200",
              collapsed ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            <Icon name="MessageCircle" className="h-4 w-4 text-muted" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-2 [writing-mode:vertical-rl]">
              AI Copilot
            </span>
          </div>
        </div>
      </div>
      </aside>
    </>
  );
}
