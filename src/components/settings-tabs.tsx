"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
  const uid = useId();
  const fallback = tabs[0]?.id ?? "";
  /** The side-navigation buttons, so arrow keys can move focus between them. */
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  /**
   * A CHANGED `?tab=` HAS TO MOVE THE SECTION (review wave, 2026-09).
   *
   * `initialTab` used to seed `useState` and nothing after that, so a navigation
   * to another `?tab=` on the SAME route — the header's "Your account settings"
   * round trip, a support link followed from inside Account Center, a back
   * button — re-rendered this component with a new prop while the strip stayed
   * exactly where it was. The URL and the page disagreed, and the URL was the
   * one that was right.
   *
   * Fixed by DERIVING the active section rather than syncing it: what is held in
   * state is the reader's own press and the `?tab=` it was made against, so a
   * new `?tab=` supersedes it by construction and no effect has to notice. (A
   * press itself only rewrites the URL with `history.replaceState`, which
   * delivers no new prop, so a choice survives every re-render that follows it.)
   */
  const [chosen, setChosen] = useState<{ id: string; against: string | undefined } | null>(null);
  const seeded = tabs.some((t) => t.id === initialTab) ? (initialTab as string) : fallback;
  const active = chosen && chosen.against === initialTab ? chosen.id : seeded;

  /**
   * `?tab=settings#meetings` — a sub-section deep link (portal feedback round
   * 2, 2026-09), which is how the retired `?tab=meetings` now resolves.
   *
   * Only the ACTIVE tab's panel is in the DOM, so the browser's own anchor jump
   * can miss it: the element exists in the server-rendered markup for the tab
   * the URL names, but the jump happens before React has hydrated this strip
   * and there is nothing to re-run it afterwards.
   *
   * RE-RUN WHEN `active` CHANGES, not on mount alone (review wave, 2026-09).
   * The hash names an element inside ONE tab's panel, and a `?tab=` that
   * arrives after mount moves which panel is rendered — so the one moment the
   * anchor exists can be a render this component has already passed, which a
   * mount-only effect misses entirely. Pressing a tab clears the hash from the
   * URL first (see `select`), so this cannot drag a reader who is simply
   * browsing sections down to a stale anchor.
   */
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, [active]);

  function select(next: string) {
    setChosen({ id: next, against: initialTab });
    // The first tab is the default, so it stays out of the URL.
    const url = next === fallback ? pathname : `${pathname}?tab=${encodeURIComponent(next)}`;
    window.history.replaceState(null, "", url);
  }

  if (tabs.length === 0) return null;
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  const tabButtonId = (id: string) => `${uid}-tab-${id}`;
  const panelId = `${uid}-panel-${current?.id ?? fallback}`;

  /**
   * ARROW KEYS, HOME AND END — the half of the tab pattern this list was
   * missing (review wave, 2026-09).
   *
   * It announced itself as a `tablist` of `tab`s, which tells a screen-reader
   * user to expect exactly this: one stop in the tab order, arrows to move
   * between the sections. Without it the promise was false and every section
   * was a separate tab stop. Roving `tabIndex` below is the other half.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    const order = tabs.map((t) => t.id);
    const at = order.indexOf(current?.id ?? fallback);
    let next: string | undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = order[(at + 1) % order.length];
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft")
      next = order[(at - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    select(next);
    buttonRefs.current[next]?.focus();
  }

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
                    id={tabButtonId(tab.id)}
                    aria-selected={selected}
                    aria-controls={selected ? panelId : undefined}
                    // Roving: one stop in the page's tab order for the whole
                    // list, arrows for the rest (see `onKeyDown`).
                    tabIndex={selected ? 0 : -1}
                    ref={(el) => {
                      buttonRefs.current[tab.id] = el;
                    }}
                    onKeyDown={onKeyDown}
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
        // Named by the tab that opened it, and focusable, so the panel is a
        // place the keyboard can land after the arrows have chosen it.
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabButtonId(current.id)}
          tabIndex={0}
          className="min-w-0 focus-visible:outline-none"
        >
          {current.content}
        </div>
      ) : null}
    </div>
  );
}
