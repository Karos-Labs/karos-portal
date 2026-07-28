"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

const TABS = ["performance", "visibility"] as const;
type Tab = (typeof TABS)[number];

function parseTab(value: string | null): Tab {
  return TABS.includes(value as Tab) ? (value as Tab) : "performance";
}

/**
 * QA F99 — the two heavy halves of the client dashboard (Performance, Search &
 * AI visibility) behind one segmented control instead of both rendered at full
 * detail on a single five-screen scroll.
 *
 * Same pattern as the Workspace's ProgressView toggle: the active tab lives in
 * `?tab=` so it's linkable, seeded from the URL into local state and written
 * back with the native history API rather than router.replace — this route
 * fetches its data server-side, and router.replace would re-run every one of
 * those fetches on each click. `?tab=` on /clients/[id] is independent of the
 * one ProgressView claimed on /tasks.
 *
 * Both halves are rendered on the server and passed in as nodes, so switching
 * tabs is instant and neither half is re-fetched.
 *
 * Invariant for callers: everything a tab shows must be passed IN, not also
 * rendered above this component. Hoisting a slice of one half out to the page
 * (the visibility scores and action plan were, briefly) strands the control
 * below content it claims to switch and shows the client the same subject twice.
 */
export function ClientDashboardTabs({
  performance,
  visibility,
}: {
  performance: React.ReactNode;
  visibility: React.ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => parseTab(searchParams.get("tab")));

  function selectTab(next: Tab) {
    setTab(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === "performance") params.delete("tab");
    else params.set("tab", next);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }

  return (
    <>
      <div className="mb-5 inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-1">
        {(
          [
            { id: "performance", label: "Performance", icon: "TrendingUp" },
            { id: "visibility", label: "Search & AI visibility", icon: "Radar" },
          ] as { id: Tab; label: string; icon: string }[]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => selectTab(t.id)}
            className={cn(
              "flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all duration-150",
              tab === t.id
                ? "bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.3)] text-foreground"
                : "text-muted hover:text-foreground",
            )}
          >
            <Icon name={t.icon} className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "performance" ? performance : visibility}
    </>
  );
}
