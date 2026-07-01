"use client";

import { useState } from "react";
import { ChatbotWidget } from "@/components/chatbot-widget";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import type { Agent, Client, ClientReport } from "@/lib/types";

interface Props {
  clientId: string;
  clientName: string;
  agents: Agent[];
  userName?: string;
  hasGoogleIntegration?: boolean;
  client?: Pick<Client, "name" | "website" | "industry">;
  report?: Pick<ClientReport, "overallGrade" | "overallScore"> | null;
}

/**
 * Right-rail wrapper for the docked copilot. The rail width animates between
 * expanded and a slim strip; a single fixed-size handle on the left edge toggles
 * it, so nothing jumps or resizes. The chat stays mounted (state preserved) and
 * is simply clipped when collapsed. Desktop (lg+) only.
 */
export function CopilotDock({ clientId, clientName, agents, userName, hasGoogleIntegration, client, report }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const widgetProps = {
    clientId,
    clientName,
    agents,
    userName,
    hasGoogleIntegration,
    client,
    report,
  };

  return (
    <>
      {/* Below lg: docked bottom sheet — a tab that expands to the bottom ~35% and
          stays pinned (sits above the mobile bottom tab bar on phones). */}
      <div className="lg:hidden">
        {sheetOpen ? (
          <div className="fixed left-0 right-0 bottom-[54px] z-40 h-[35vh] border-t border-border bg-surface shadow-[0_-8px_30px_rgba(0,0,0,0.5)] md:bottom-0 md:left-72">
            <ChatbotWidget docked defaultOpen onCollapse={() => setSheetOpen(false)} {...widgetProps} />
          </div>
        ) : (
          <button
            onClick={() => setSheetOpen(true)}
            className="fixed left-0 right-0 bottom-[54px] z-40 flex items-center justify-center gap-2 border-t border-border bg-surface/95 py-2.5 text-sm font-medium text-foreground backdrop-blur-sm transition-colors hover:bg-surface-2 md:bottom-0 md:left-72"
            aria-label="Open AI Copilot"
          >
            <Icon name="MessageCircle" className="h-4 w-4 text-neon" />
            AI Copilot
            <Icon name="ChevronUp" className="h-4 w-4 text-muted-2" />
          </button>
        )}
      </div>

      <aside
        className={cn(
          "relative hidden shrink-0 border-l border-border bg-surface/60 transition-[width] duration-300 ease-in-out lg:block",
          collapsed ? "w-12" : "w-[380px]",
        )}
      >
      {/* Edge handle — constant size & position, on the border */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="absolute left-0 top-4 z-20 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-muted-2 shadow-md transition-colors hover:text-foreground"
        aria-label={collapsed ? "Expand AI Copilot" : "Collapse AI Copilot"}
        title={collapsed ? "Expand AI Copilot" : "Collapse AI Copilot"}
      >
        <Icon name={collapsed ? "ChevronLeft" : "ChevronRight"} className="h-4 w-4" />
      </button>

      <div className="sticky top-0 h-screen overflow-hidden">
        {/* Fixed-width chat — clipped by the parent as the rail narrows (no reflow) */}
        <div className="h-full w-[380px]">
          <ChatbotWidget docked defaultOpen {...widgetProps} />
        </div>

        {/* Collapsed strip overlay */}
        <div
          className={cn(
            "absolute inset-0 flex flex-col items-center gap-3 bg-surface pt-16 transition-opacity duration-200",
            collapsed ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <Icon name="MessageCircle" className="h-4 w-4 text-neon" />
          <span className="text-[11px] font-medium tracking-wide text-muted-2 [writing-mode:vertical-rl]">
            AI Copilot
          </span>
        </div>
      </div>
      </aside>
    </>
  );
}
