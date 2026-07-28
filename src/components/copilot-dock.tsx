"use client";

import { useEffect, useRef, useState } from "react";
import { ChatbotWidget } from "@/components/chatbot-widget";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import type { Client, ClientReport } from "@/lib/types";

/**
 * Rail + sheet open/closed state, remembered across reloads. In-app navigation
 * already preserves it (the dock lives in the (app) layout); a hard reload used
 * to re-expand a rail the user had deliberately collapsed (QA F88).
 */
const DOCK_STATE_KEY = "karos.copilot.dock";

interface Props {
  clientId: string;
  /** Signed-in viewer — scopes the persisted copilot transcript. */
  viewerUid: string;
  clientName: string;
  userName?: string;
  hasGoogleIntegration?: boolean;
  client?: Pick<Client, "name" | "website" | "industry" | "isAiProcessing">;
  report?: Pick<ClientReport, "overallGrade" | "overallScore"> | null;
}

/**
 * Right-rail wrapper for the docked copilot. The rail width animates between
 * expanded and a slim strip; a single fixed-size handle on the left edge toggles
 * it, so nothing jumps or resizes. The chat stays mounted (state preserved) and
 * is simply clipped when collapsed. Desktop (lg+) only.
 */
export function CopilotDock({ clientId, viewerUid, clientName, userName, hasGoogleIntegration, client, report }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** Blocks the write-back below until the restore pass has run. */
  const hydratedRef = useRef(false);

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
      {/* Below lg: docked bottom sheet — a tab that expands to the bottom ~70%
          and stays pinned (sits above the mobile bottom tab bar on phones).
          At 35vh the header and the greeting filled the whole sheet and the
          four AI actions sat below the fold on first open (QA F94). */}
      <div className="lg:hidden">
        {sheetOpen ? (
          <div className="fixed left-0 right-0 bottom-[54px] z-40 h-[70dvh] border-t border-border bg-background shadow-[0_-8px_30px_rgba(0,0,0,0.5)] md:bottom-0 md:left-72">
            <ChatbotWidget docked defaultOpen onCollapse={() => setSheetOpen(false)} {...widgetProps} />
          </div>
        ) : (
          <button
            onClick={() => setSheetOpen(true)}
            className="fixed left-0 right-0 bottom-[54px] z-40 flex items-center justify-center gap-2 border-t border-border bg-background/95 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground backdrop-blur-sm transition-colors hover:bg-surface-2 md:bottom-0 md:left-72"
            aria-label="Open AI Copilot"
          >
            <Icon name="MessageCircle" className="h-4 w-4 text-muted" />
            AI Copilot
            <Icon name="ChevronUp" className="h-4 w-4 text-muted-2" />
          </button>
        )}
      </div>

      <aside
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
