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
 * ── COLLAPSED OFF ITS OWN ROUTE (Albert, 2026-09-11) ──────────────────────
 *
 * "This should be collapsable." Five section rows under Home, AI agents and
 * Calendar made the rail read as eight peers, on every page, for a group whose
 * whole description is "everything that is not daily use". The sections now
 * show only while the reader is IN Account Center, and the parent row folds
 * them away everywhere else.
 *
 * NO TOGGLE CONTROL, on purpose. The parent row navigates; it does not also
 * open and close. A row that both goes somewhere and toggles is two controls
 * that look like one — the exact confusion the account menu's own identity
 * row was un-split to remove (portal feedback round 2, 2026-09), and the
 * reason the agents list above lost its disclosure. Opening the group is one
 * click: the click that goes there. The chevron at the row's end says it is a
 * group and whether it is open, and nothing else.
 *
 * ITS OWN ICON. It shared the gear with its Settings section, so the parent
 * and one child looked like the same destination. `ACCOUNT_CENTER_ICON` is
 * the one spelling; the mobile sheets and the staff shell read it from here.
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
/** Not the Settings gear: the group and its Settings section are two things. */
export const ACCOUNT_CENTER_ICON = "Briefcase";

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
        <Icon
          name={ACCOUNT_CENTER_ICON}
          className={cn(
            "h-4 w-4 shrink-0",
            onSettings ? "text-foreground" : "text-muted-2 group-hover:text-foreground",
          )}
        />
        <span className="flex-1 text-left">Account Center</span>
        {/* A group's chevron, not a link's: it points down while the group is
            open and right while it is folded, and it is static either way. */}
        <Icon
          name="ChevronDown"
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-2 transition-transform motion-reduce:transition-none",
            !onSettings && "-rotate-90",
          )}
        />
      </Link>

      {/* Indented and rule-led, matching the agent roster directly above it, so
          the rail reads as two groups with children rather than eight peers.
          Only while the reader is in Account Center (see the docblock). */}
      {onSettings && (
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
      )}
    </div>
  );
}
