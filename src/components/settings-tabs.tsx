"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

export interface SettingsTab {
  id: string;
  label: string;
  icon: string;
  /**
   * Server-rendered section markup. Tabs with no content are dropped by the
   * page before they reach this component.
   */
  content?: ReactNode;
}

/**
 * EVERY ENTRY ON THIS ROW IS A TAB (AF-2).
 *
 * There used to be one that was not: an `href` entry that rendered as a link
 * and navigated to /settings, sitting outside the `role="tablist"` element
 * because a tablist's owned children must all be tabs. It carried the account
 * settings, which are ordinary tabs now — so the exception, its ARIA carve-out
 * and the panel-vs-link split that ran through every selection decision below
 * are all gone with it.
 */
const ENTRY =
  "flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-all duration-150";

/**
 * Task grouping for the client settings page, which was a nine-section
 * single-column stack with no tabs, anchors or index — so "where do I top up
 * credits" or "where do I disconnect LinkedIn" was a scroll-and-scan exercise.
 *
 * The active tab lives in `?tab=` so a link can point at one (support can send
 * "your credits are here"). It is seeded from the server, which reads the search
 * param, and updated with the native history API rather than router.replace:
 * every section is already rendered and held by the browser, so navigating would
 * re-run this page's server fetches only to show markup it already has. Same
 * reasoning as the Workspace's segmented control, whose markup this mirrors.
 */
export function SettingsTabs({ tabs, initialTab }: { tabs: SettingsTab[]; initialTab?: string }) {
  const pathname = usePathname();
  const fallback = tabs[0]?.id ?? "";
  const [active, setActive] = useState(() =>
    tabs.some((t) => t.id === initialTab) ? (initialTab as string) : fallback,
  );

  function select(next: string) {
    setActive(next);
    // The first tab is the default, so it stays out of the URL.
    const url = next === fallback ? pathname : `${pathname}?tab=${encodeURIComponent(next)}`;
    window.history.replaceState(null, "", url);
  }

  if (tabs.length === 0) return null;
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <>
      {/* Scrolls rather than wrapping or squeezing: the tab count varies by role
          (a client sees fewer than an admin) and this sits above a mobile view. */}
      <div className="-mx-1 mb-6 max-w-full overflow-x-auto px-1">
        <div
          role="tablist"
          aria-label="Settings sections"
          className="inline-flex w-max items-center gap-1 rounded-lg border border-border bg-surface-2 p-1"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={current?.id === tab.id}
              onClick={() => select(tab.id)}
              className={cn(
                ENTRY,
                current?.id === tab.id
                  ? "bg-surface text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.3)]"
                  : "text-muted hover:text-foreground",
              )}
            >
              <Icon name={tab.icon} className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {current ? <div role="tabpanel">{current.content}</div> : null}
    </>
  );
}
