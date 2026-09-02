"use client";

import { useEffect, useRef, useState } from "react";
import { ChatbotWidget } from "@/components/chatbot-widget";
import { Icon } from "@/components/icon";
import { MOBILE_TAB_BAR_OFFSET_CLASS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { ClientReport } from "@/lib/types";

/**
 * Rail + sheet open/closed state, remembered across reloads. In-app navigation
 * already preserves it (the dock lives in the (app) layout); a hard reload used
 * to re-expand a rail the user had deliberately collapsed (QA F88).
 */
const DOCK_STATE_KEY = "karos.copilot.dock";

/**
 * Which app shell hosts the dock. They used to differ in the width of their
 * left nav column (ClientRail `w-72`, staff Sidebar `w-64`), and the strip has
 * to start exactly at that column's right edge (CD-G8). Since the parity pass
 * (2026-09) the staff rail is `w-72` whenever this dock is mounted, so the two
 * anchors are the same string - the key survives because each layout still
 * declares which shell it is.
 */
export type CopilotShell = "client" | "staff";

/**
 * Where the strip and the expanded sheet pin themselves, below `lg`.
 *
 * The bottom is the same in both shells: every shell that shows the client
 * 4-tab nav renders the mobile bottom bar below `md` (CD-G9a), so the strip
 * parks directly above it and drops to the viewport edge from `md` up, where
 * that nav is a left column instead. `right-0` is unconditional - running to
 * the viewport's right edge is the whole point of the contract.
 */
const SHELL_ANCHOR: Record<CopilotShell, string> = {
  client: `left-0 right-0 ${MOBILE_TAB_BAR_OFFSET_CLASS} md:bottom-0 md:left-72`,
  /* IDENTICAL TO THE CLIENT'S, and that is not a copy-paste slip (parity pass
     2026-09, ruling D22). The staff dock is mounted by StaffCopilotDock, which
     returns null unless a client context is active — so the only staff shell it
     ever anchors to is the client-context one, whose rail is `w-72` like the
     client's. `md:left-64` was the AGENCY rail's width, i.e. the width of a
     shell this dock is never painted in, and it left a 32px strip of page
     showing under the rail's right edge. The two keys stay separate because the
     `shell` prop is still what the two layouts declare. */
  staff: `left-0 right-0 ${MOBILE_TAB_BAR_OFFSET_CLASS} md:bottom-0 md:left-72`,
};

/**
 * Whether an element is actually painted. The shell swaps its two dock surfaces
 * with `lg:hidden` / `hidden lg:block`, and a `display:none` element still holds
 * a live ref - so this is how the outside-click pass below tells "the sheet is
 * the surface on screen" from "we are at lg+ and the rail is".
 *
 * `getClientRects()` rather than `offsetParent`: the sheet is `position: fixed`,
 * whose offsetParent is null even when it is perfectly visible.
 */
function isPainted(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.getClientRects().length > 0;
}

interface Props {
  clientId: string;
  /** Signed-in viewer - scopes the persisted copilot transcript. */
  viewerUid: string;
  clientName: string;
  userName?: string;
  hasGoogleIntegration?: boolean;
  report?: Pick<ClientReport, "overallGrade" | "overallScore"> | null;
  /** Host shell - sets the left offset of the pinned strip. Defaults to the client portal. */
  shell?: CopilotShell;
}

/**
 * Right-rail wrapper for the docked copilot. The rail width animates between
 * expanded and a slim strip; a single fixed-size handle on the left edge toggles
 * it, so nothing jumps or resizes. The chat stays mounted (state preserved) and
 * is simply clipped when collapsed. Desktop (lg+) only.
 */
export function CopilotDock({ clientId, viewerUid, clientName, userName, hasGoogleIntegration, report, shell = "client" }: Props) {
  // Closed by default (client-zero feedback, ship-Sunday ask): a first-time
  // viewer gets the collapsed w-12 strip, not the full 380px panel claiming
  // screen real estate before they've asked for it. The localStorage restore
  // below still wins for a returning viewer who chose to keep it open — this
  // default only governs the very first render, before that effect runs.
  const [collapsed, setCollapsed] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** Blocks the write-back below until the restore pass has run. */
  const hydratedRef = useRef(false);
  const sheetRef = useRef<HTMLDivElement>(null);
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
        if (typeof s.sheetOpen === "boolean") setSheetOpen(s.sheetOpen);
      }
    } catch {
      /* unreadable / disabled storage - keep the defaults */
    }
    hydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      localStorage.setItem(DOCK_STATE_KEY, JSON.stringify({ collapsed, sheetOpen }));
    } catch {
      /* quota or private mode - state stays in memory */
    }
  }, [collapsed, sheetOpen]);

  /**
   * Dismiss the sheet on any click outside it (CD-G9b): it stays open only
   * while the viewer is working inside it. Same idiom as the export menu in
   * client-documents.tsx - a document `mousedown` plus a ref containment test -
   * rather than the full-screen click-catcher some menus use, because a catcher
   * would swallow the first click on every page while the copilot is open.
   *
   * Scoped to the OVERLAY presentation below `lg` on purpose. The lg+ surface
   * is a persistent side rail that owns a column of the layout, not a pop-up:
   * collapsing it on a stray page click would reflow the whole content column
   * and then persist that through DOCK_STATE_KEY. It keeps its explicit handle
   * as the only way to collapse it.
   *
   * The sheet is not unmounted either - it is hidden with `display:none`, so a
   * half-typed message and the restored transcript both survive an accidental
   * dismissal (QA F88).
   *
   * The Strategy War Room used to open FROM this sheet (it has since moved to
   * the Task Map's own Refresh Task Map button) but did not render inside it:
   * it went through Modal, which portals to document.body. Its DOM was
   * therefore outside this ref, so every mousedown in the dialog - backdrop,
   * "Keep running", the console - used to count as an outside click and close
   * the sheet behind it. On a phone that made the copilot vanish the moment you
   * touched the War Room. Overlays carry `data-overlay-root` for exactly this
   * test (modal.tsx), so any portaled dialog counts as inside - kept as the
   * standing guard for whatever the sheet opens through Modal next.
   */
  useEffect(() => {
    if (!sheetOpen) return;
    function handleOutside(e: MouseEvent) {
      const sheet = sheetRef.current;
      // `isPainted` is the breakpoint test: above lg the shell sets the sheet's
      // wrapper to `display:none`, and a persisted sheetOpen would otherwise let
      // an lg+ page click rewrite state for a surface that is not even on screen.
      if (!isPainted(sheet)) return;
      const target = e.target as Node | null;
      if (!target || sheet.contains(target)) return;
      // Text nodes have no closest(); walk up to the nearest element first.
      const el = target instanceof Element ? target : target.parentElement;
      if (el?.closest("[data-overlay-root]")) return;
      setSheetOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [sheetOpen]);

  const widgetProps = {
    clientId,
    viewerUid,
    clientName,
    userName,
    hasGoogleIntegration,
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
          (The cap itself is QA F94 - at 35vh the greeting filled the sheet and
          the four AI actions sat below the fold on first open.)

          Both states stay mounted and swap with `hidden`, so dismissing the
          sheet - by the close control or by clicking outside it - keeps a
          half-typed message alive (CD-G9b). */}
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
        className={cn(
          // min-w-0 beats the flex automatic minimum - without it the fixed-width
          // chat inside keeps the rail at 380px and w-12 never takes effect.
          "relative hidden min-w-0 shrink-0 border-l border-border bg-background transition-[width] duration-300 ease-in-out lg:block",
          collapsed ? "w-12" : "w-[380px]",
        )}
      >
      {/* z-40: sticky always forms its own stacking context, so the handle's
          own z-index cannot lift it above sibling chrome from in here - the
          frame itself has to outrank anything sticky in the column it borders,
          or that chrome clips the handle's left half. Stays above the z-30 band
          the shells use for their rails and any sticky page chrome. */}
      <div className="sticky top-0 z-40 h-screen">
        {/* Edge handle - inside the sticky frame so it pins to the viewport
            near the top (never scrolls away), and above the column's own
            chrome so the full circle always shows. */}
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="absolute left-0 top-4 z-40 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-muted-2 shadow-md transition-colors hover:text-foreground"
          aria-label={collapsed ? "Expand AI Copilot" : "Collapse AI Copilot"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand AI Copilot" : "Collapse AI Copilot"}
        >
          <Icon name={collapsed ? "ChevronLeft" : "ChevronRight"} className="h-4 w-4" />
        </button>

        {/* Clip lives on this inner frame - not the sticky one - so the
            handle can hang past the border without being cut off.

            `overflow-clip`, NOT `overflow-hidden` (QA 2026-09, "collapsed
            rail shows a slice of the chat"). `hidden` still makes this frame
            a SCROLL CONTAINER - one with no scrollbar, but one the browser
            will happily scroll programmatically. The chat inside is 380px
            wide in a 48px frame, and it calls `scrollIntoView()` on its
            last message and `focus()` on its input (chatbot-widget.tsx), both
            of which scroll every scrollable ancestor sideways to reveal the
            target. That dragged this frame ~330px to the left, and because
            the collapsed overlay below is `absolute inset-0` it rode along
            with the content - so the strip showed the RIGHT edge of the chat
            ("opilot", "BY DEE", the greeting) with the overlay parked
            off-screen. `clip` is a pure paint clip: not a scroll container,
            so nothing can move it, and the overlay stays where it is drawn. */}
        <div className="relative h-full overflow-clip">
          {/* Fixed-width chat - clipped by the parent as the rail narrows (no
              reflow). `inert` while collapsed: the widget focuses its input on
              mount and after every send, and a focused control inside a
              48px strip is both invisible and a keyboard trap. Inert also
              takes the whole chat out of the tab order and out of the
              accessibility tree, which is what "collapsed" should mean. */}
          <div className="h-full w-[380px]" inert={collapsed}>
            <ChatbotWidget docked defaultOpen {...widgetProps} />
          </div>

          {/* Collapsed strip. The WHOLE strip is the expand control (product
              owner, 2026-09: "when we click on the button, or actually
              anywhere on this sidebar, it should pop out") - the round handle
              above stays as the visible affordance and still toggles both
              ways. Rendered only while collapsed so it can never intercept a
              click meant for the open chat; the width transition on the
              aside still animates the rail itself. */}
          {collapsed && (
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              // Anchored to the LEFT at the strip's own width, not `inset-0`:
              // the aside animates 380px -> 48px, and a full-width overlay
              // would centre the icon in the still-wide box and slide it
              // across. Pinned at w-12 it stands still while the chat is
              // clipped away behind it - the rail closes over the chat.
              className="absolute inset-y-0 left-0 flex w-12 flex-col items-center gap-3 bg-background pt-16 text-muted-2 transition-colors hover:bg-surface hover:text-foreground"
              // A pointer convenience over the same action as the handle;
              // the handle is the one control assistive tech should hear.
              aria-hidden="true"
              tabIndex={-1}
              title="Expand AI Copilot"
            >
              <Icon name="MessageCircle" className="h-4 w-4 text-muted" />
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] [writing-mode:vertical-rl]">
                AI Copilot
              </span>
            </button>
          )}
        </div>
      </div>
      </aside>
    </>
  );
}
