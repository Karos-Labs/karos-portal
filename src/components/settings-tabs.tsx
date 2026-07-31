"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

export interface SettingsTab {
  id: string;
  label: string;
  icon: string;
  /**
   * Server-rendered section markup. Tabs with no content are dropped by the
   * page. Absent on an `href` entry, which owns no panel.
   */
  content?: ReactNode;
  /**
   * Set instead of `content` for a row entry that NAVIGATES rather than
   * switching panels — account settings is its own route (/settings), but it is
   * still one of the settings a person is choosing between, so it belongs on
   * this row rather than stranded beside it as a header link.
   *
   * It renders as a link styled like an inactive tab and can never become
   * current. Deliberately NOT `role="tab"`: a tab must control a panel in this
   * tablist, and this one leaves the page.
   */
  href?: string;
}

/** Shared by both row entries so the link cannot drift from the tabs beside it. */
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
  // Link entries sit on the row but own no panel, so every selection decision
  // below — the default, `?tab=`, the current panel — is made over panels only.
  const panels = tabs.filter((t) => !t.href);
  const fallback = panels[0]?.id ?? "";
  const [active, setActive] = useState(() =>
    panels.some((t) => t.id === initialTab) ? (initialTab as string) : fallback,
  );

  function select(next: string) {
    setActive(next);
    // The first tab is the default, so it stays out of the URL.
    const url = next === fallback ? pathname : `${pathname}?tab=${encodeURIComponent(next)}`;
    window.history.replaceState(null, "", url);
  }

  const links = tabs.filter((t) => t.href);
  if (panels.length === 0 && links.length === 0) return null;
  const current = panels.find((t) => t.id === active) ?? panels[0];

  return (
    <>
      {/* Scrolls rather than wrapping or squeezing: the tab count varies by role
          (a client sees fewer than an admin) and this sits above a mobile view. */}
      <div className="-mx-1 mb-6 max-w-full overflow-x-auto px-1">
        <div className="inline-flex w-max items-center gap-1 rounded-lg border border-border bg-surface-2 p-1">
          {/* role="tablist" wraps ONLY the real tabs: a tablist's owned children
              must all be tabs, so the account link sits beside it as a sibling
              rather than inside it. Visually one row either way. */}
          <div role="tablist" aria-label="Settings sections" className="flex items-center gap-1">
            {panels.map((tab) => (
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
          {links.map((tab) => (
            <Link
              key={tab.id}
              href={tab.href as string}
              className={cn(ENTRY, "text-muted hover:text-foreground")}
            >
              <Icon name={tab.icon} className="h-3.5 w-3.5" />
              {tab.label}
            </Link>
          ))}
        </div>
      </div>

      {current ? <div role="tabpanel">{current.content}</div> : null}
    </>
  );
}
