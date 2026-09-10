"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/**
 * Account Center in the client's rail, with its sections under it.
 *
 * ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────
 *
 * Reported from outside (SCRUM-419): "have the account center as a button on
 * the left sidebar under the AI agents, with profile, competitor reporting,
 * settings and credits — this widget should just open a report, to limit
 * confusion."
 *
 * She was right, and the second half of that sentence is the tell. On the
 * DESKTOP rail, Account Center was not a row at all: `client-rail.tsx` built a
 * `settingsItem` and used it for the avatar dropdown's `settingsHref`, for a
 * `?tab=credits` deep link on the credits pill, and for a row in the MOBILE
 * company sheet — but never rendered it as a `NavLink` beside Home, AI agents
 * and Calendar. So a client at a desktop width had no navigation entry to their
 * own profile, competitors, settings or credits, and the only signposted routes
 * in were an avatar menu and whatever a Home widget happened to link to. That is
 * why the metrics widgets became the way in, which is the complaint she filed
 * separately.
 *
 * ── EVERY SECTION, NOT THE FOUR THAT WERE NAMED ──────────────────────────
 *
 * Lola listed four ("profile, competitor reporting, settings and credits") and
 * the page has five: Profile, Competitors, Reporting, Settings, Credits. Her
 * "competitor reporting" is not the name of either tab, so it is one phrase
 * covering two of them. All five render here rather than a four-item guess:
 * inventing a subset whose names do not match the page is the same class of
 * defect as the rest of this epic — a navigation that describes a surface it
 * does not actually mirror. `rail-account-tabs.test.ts` holds the two lists
 * together.
 *
 * ── WHY NO SUB-ROW IS EVER MARKED ACTIVE ─────────────────────────────────
 *
 * Deliberate, and it would be a bug to add. `SettingsTabs` moves between
 * sections with `history.replaceState` (see its own note: a press "only
 * rewrites the URL with `history.replaceState`, which delivers no new prop, so a
 * choice survives every re-render that follows it"). `useSearchParams` does not
 * observe a `replaceState`, so a `?tab=`-derived active row would keep pointing
 * at the section the reader arrived on and contradict the page as soon as they
 * pressed anything. The parent row carries the current state for the whole
 * route; the children are routes in, not a mirror of where you are.
 */

/**
 * The Account Center sections, in the order the settings page lists them.
 *
 * `id` is the `?tab=` value, and it has to be one the page actually serves —
 * which is what the test asserts, because these ids live in two files and only
 * one of them can be the source. Exported for that test.
 */
export const ACCOUNT_CENTER_SECTIONS: readonly { id: string; label: string; icon: string }[] = [
  { id: "profile", label: "Profile", icon: "Building2" },
  { id: "competitors", label: "Competitors", icon: "Users" },
  { id: "reporting", label: "Reporting", icon: "Radar" },
  { id: "settings", label: "Settings", icon: "Settings" },
  { id: "credits", label: "Credits", icon: "Coins" },
];

export function ClientRailAccountNav({ home }: { home: string }) {
  const pathname = usePathname();
  const settingsRoot = `${home}/settings`;
  // ONE CURRENT ROW, the same rule ClientRailAgentsNav states: the parent is
  // filled while the reader is on this route, and nothing below it competes.
  const onSettings = pathname === settingsRoot || pathname.startsWith(settingsRoot + "/");

  return (
    <div className="flex flex-col gap-0.5">
      <Link
        href={settingsRoot}
        {...(onSettings ? { "aria-current": "page" as const } : {})}
        className={cn(
          "focus-ring group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
          onSettings
            ? "bg-surface-2 text-foreground"
            : "text-muted hover:bg-surface-2 hover:text-foreground",
        )}
      >
        <Icon name="Settings" className="h-4 w-4 shrink-0 text-muted-2 group-hover:text-foreground" />
        <span className="flex-1 text-left">Account Center</span>
      </Link>

      {/* Indented and rule-led, matching the agent roster directly above it, so
          the rail reads as two groups with children rather than eight peers. */}
      <div className="ml-3 flex flex-col gap-0.5 border-l border-border pl-2">
        {ACCOUNT_CENTER_SECTIONS.map((section) => (
          <Link
            key={section.id}
            href={`${settingsRoot}?tab=${section.id}`}
            className="focus-ring group flex items-center gap-3 rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Icon
              name={section.icon}
              className="h-4 w-4 shrink-0 text-muted-2 group-hover:text-foreground"
            />
            <span className="flex-1 text-left">{section.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
