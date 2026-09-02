"use client";

import { useEffect, useState, type ReactNode } from "react";
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
  /**
   * The heading this section sits under in the side navigation ("Company",
   * "Workspace", "Your account"). Consecutive tabs with the same group share
   * one heading; tabs with none render ungrouped.
   */
  group?: string;
}

/**
 * A SIDE NAVIGATION, NOT A TAB STRIP (portal feedback round 2, 2026-09).
 *
 * Account Center has eight sections for a client. A single horizontal row of
 * eight iconed pills either scrolls (the first version, "I don't like this
 * menu with the slide bar") or wraps onto a second line (the second version,
 * "still don't like the display here"). The research is unambiguous about
 * why both feel wrong: NN/g's "Tabs, Used Right" says a tab row should never
 * become a carousel and that tab lists should not stack into multiple rows —
 * stacked rows break the reader's spatial memory of where a section lives —
 * and its "Left-Side Vertical Navigation on Desktop" says a vertical list is
 * the right shape for navigation that is broad and will keep growing, with
 * text labels (never icons alone), keyword-first, less-important entries at
 * the bottom, and no duplicate horizontal copy. That is the settings layout
 * every mature SaaS product converged on (Stripe, GitHub, Linear): a quiet
 * list on the left, grouped under a few headings, and the section on the
 * right.
 *
 * Below `md` the list would eat the whole viewport, so it becomes one native
 * `<select>` — every section visible in one tap, nothing to scroll or drag,
 * and the platform's own picker on a phone.
 *
 * The active section still lives in `?tab=` (so support can send "your
 * credits are here"), is seeded from the server, and is updated with the
 * native history API rather than router.replace: every section is already
 * rendered and held by the browser, so navigating would re-run this page's
 * server fetches only to show markup it already has.
 */
export function SettingsTabs({ tabs, initialTab }: { tabs: SettingsTab[]; initialTab?: string }) {
  const pathname = usePathname();
  const fallback = tabs[0]?.id ?? "";
  const [active, setActive] = useState(() =>
    tabs.some((t) => t.id === initialTab) ? (initialTab as string) : fallback,
  );

  /**
   * `?tab=settings#meetings` — a sub-section deep link (portal feedback round
   * 2, 2026-09), which is how the retired `?tab=meetings` now resolves.
   *
   * Only the ACTIVE tab's panel is in the DOM, so the browser's own anchor jump
   * can miss it: the element exists in the server-rendered markup for the tab
   * the URL names, but the jump happens before React has hydrated this strip
   * and there is nothing to re-run it afterwards. One scroll on mount, only
   * when a hash was given and only when it names something that is actually
   * rendered — never a jump to the top when it names nothing.
   */
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    // Mount only: a later hash change is the browser's own to handle.
    document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, []);

  function select(next: string) {
    setActive(next);
    // The first tab is the default, so it stays out of the URL.
    const url = next === fallback ? pathname : `${pathname}?tab=${encodeURIComponent(next)}`;
    window.history.replaceState(null, "", url);
  }

  if (tabs.length === 0) return null;
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  // Consecutive tabs under one heading form a group; the page decides the
  // order, so grouping never re-sorts what it was handed.
  const groups: { name: string | undefined; tabs: SettingsTab[] }[] = [];
  for (const tab of tabs) {
    const last = groups[groups.length - 1];
    if (last && last.name === tab.group) last.tabs.push(tab);
    else groups.push({ name: tab.group, tabs: [tab] });
  }

  return (
    <div className="md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-10">
      {/* Phone: one native picker, every section in it. */}
      <label className="mb-5 block md:hidden">
        <span className="sr-only">Section</span>
        <select
          value={current?.id}
          onChange={(e) => select(e.target.value)}
          className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground outline-none focus:border-foreground/25"
        >
          {groups.map((g) =>
            g.name ? (
              <optgroup key={g.name} label={g.name}>
                {g.tabs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            ) : (
              g.tabs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))
            ),
          )}
        </select>
      </label>

      {/* Desktop: the side list. Sticky so a long section (Documents, the
          ledger) keeps its map in view; text labels carry the meaning and
          the icon is a secondary cue, same as the app rail. */}
      <nav
        role="tablist"
        aria-orientation="vertical"
        aria-label="Settings sections"
        className="hidden self-start md:sticky md:top-6 md:block"
      >
        {groups.map((g, gi) => (
          <div key={g.name ?? `group-${gi}`} className={cn(gi > 0 && "mt-5")}>
            {g.name && (
              <p className="mb-1.5 px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-2">
                {g.name}
              </p>
            )}
            <div className="flex flex-col gap-0.5">
              {g.tabs.map((tab) => {
                const selected = current?.id === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => select(tab.id)}
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
                      selected
                        ? "bg-surface-2 text-foreground"
                        : "text-muted hover:bg-surface-2 hover:text-foreground",
                    )}
                  >
                    <Icon
                      name={tab.icon}
                      className={cn(
                        "h-4 w-4 shrink-0",
                        selected ? "text-foreground" : "text-muted-2 group-hover:text-foreground",
                      )}
                    />
                    <span className="flex-1 truncate">{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {current ? (
        <div role="tabpanel" className="min-w-0">
          {current.content}
        </div>
      ) : null}
    </div>
  );
}
