"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { Icon } from "@/components/icon";
import Image from "next/image";
import { cn, initials } from "@/lib/utils";
import { useActiveClient } from "@/lib/active-client-context";
import { BrandFavicon } from "@/components/brand-favicon";
import { ClientProfilePanel } from "@/components/client-profile-panel";
import { BrandColorsSection } from "@/components/client-context-sections";
import { ClientRailAgentsNav } from "@/components/client-rail-agents-nav";
import { AccountMenu } from "@/components/account-menu";
import { useMenuDismiss } from "@/components/use-menu-dismiss";
import { NavLink } from "@/components/rail-nav-link";
import {
  NotificationBell,
  useNotificationDismissals,
  type NotificationDismissals,
} from "@/components/notification-bell";
import {
  unreadNotificationCount,
  type NotificationFeeds,
  type TaskAlert,
} from "@/lib/notification-rows";
import { ThemeSwitch } from "@/components/theme-switch";
import { ContactUsButton } from "@/components/contact-us-modal";
import { LogoutButton } from "@/components/logout-button";
import { MobileCompanySheet, MobileTabBar, useCompanySheet } from "@/components/mobile-shell";
import type { StaffPickerClientView } from "@/lib/client-visibility";
import type {
  ActionItemNotification,
  AgentReviewNotification,
  AppUser,
  Role,
} from "@/lib/types";

/* The three feeds the bell renders — threaded down from the app layout — and
   the count derived from them both live in @/lib/notification-rows. This file
   used to declare the shape and add the three lengths up itself, which is how
   the avatar dot and the hamburger dot came to disagree with the panel they
   open: only the panel subtracted the viewer's dismissals (#105). */

interface NavItem {
  href: string;
  label: string;
  icon: string;
  roles: Role[];
  exact?: boolean;
}

/**
 * The staff workspace nav — and, for the `CLIENT_USER` rows, the nav of the ONE
 * client this shell ever serves.
 *
 * THAT VIEWER IS REAL AND THIS TABLE USED TO LIE TO THEM (#137). The app layout
 * hands every CLIENT_USER the ClientRail — but only after `getClient(clientId)`
 * RESOLVES. A client whose id is unset, or whose client document has gone,
 * falls through to this shell, and the rows below are the whole of their
 * navigation.
 *
 * Two of those rows were then REWRITTEN from `user.clientId`, on the assumption
 * that the fallthrough could not happen: `/dashboard` was remapped to
 * `/clients/${user.clientId}` and an `AI Agents` row was spliced in pointing at
 * the same subtree. Both of those routes call `requireVisibleClient`, which
 * `notFound()`s the instant the document does not load — the second half of the
 * very condition that sent this viewer here. So the only two rows written FOR
 * them were the only two that could 404 ON them. Nothing in this file reads
 * `user.clientId` any more, and client-shell-nav.test.ts holds it to that.
 *
 * A CLIENT_USER ROW MUST NOT LEAD TO A PAGE THAT TURNS A CLIENT AWAY, which is
 * the other half of the same rule and is derived rather than declared: the same
 * test resolves each row below to its route and rejects any whose page
 * redirects a CLIENT_USER. That is what dropped `/dashboard` (it redirects them
 * to `/clients/<id>`, or to `/assets` with no id) and `/assets` (it redirects
 * them onward, ultimately to `/calendar` with no id).
 *
 * The two that survive both serve a client with no company context on purpose:
 * /transcripts scopes and redacts to their client and renders empty without
 * one, /calendar has an explicit no-clientId empty state. Their real nav —
 * Dashboard, AI agents, Meetings, Calendar — is client-rail.tsx, which is the
 * only place a resolvable client's shell is built. The Workspace board (`/tasks`)
 * that used to be a third survivor is gone entirely (2026-08, locked: "The Board
 * is replaced by the action list on Home"); `/connect` (Claude Code MCP setup)
 * was removed the same pass as an unused staff-only page.
 */
const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/clients", label: "Clients", icon: "Building2", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/agents", label: "Agents", icon: "Bot", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/jobs", label: "Jobs", icon: "ListChecks", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/transcripts", label: "Meetings", icon: "Mic", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/assets", label: "Assets", icon: "FolderOpen", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/calendar", label: "Calendar", icon: "CalendarClock", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/team", label: "Team", icon: "Users", roles: ["KAROS_ADMIN"] },
  { href: "/admin/analytics", label: "Analytics", icon: "TrendingUp", roles: ["KAROS_ADMIN"] },
  { href: "/admin/ops", label: "Ops Import", icon: "Inbox", roles: ["KAROS_ADMIN"] },
  { href: "/admin/integrations", label: "Integrations", icon: "Cable", roles: ["KAROS_ADMIN"] },
  { href: "/admin/agents/builder", label: "Agent Studio", icon: "Sparkles", roles: ["KAROS_ADMIN"] },
];

// The client-facing tabs shown to staff when in Client View mode. The Library
// merged into the Workspace's Archive tab (2026-07); staff review drafts via
// the global Assets page.
//
// Portal revamp Surface 01: "Home" replaces "Dashboard" (same destination),
// matching client-rail.tsx's tabNav. Workspace is gone from both shells — the
// locked decision list retires it ("The Board is replaced by the action list
// on Home"); the /tasks route itself is untouched, only its nav entry.
//
// "AI AGENTS" IS NOT IN THIS TABLE ANY MORE (parity pass 2026-09, ruling D3).
// It used to be a plain row here on the reasoning that the staff shell is a
// "quick-preview strip, not the client's own nav" — the product owner ruled the
// opposite: the client-context shell IS the client's nav, so this arm mounts
// the client's real ClientRailAgentsNav between Home and Calendar, exactly
// where client-rail.tsx puts it (round 6 took the stars off it; Pin lives on
// the agent's own page and the nav reads the order it sets). Same reason its absence
// from `tabNav` is deliberate over there.
//
// Calendar keeps the CLIENT-SCOPED route, and that href difference from the
// client's own `/calendar` is legitimate rather than drift: the flat route is
// staff's cross-client calendar, and a staff member in client context wants
// this client's.
function clientViewNav(clientId: string): NavItem[] {
  return [
    { href: `/clients/${clientId}`, label: "Home", icon: "LayoutDashboard", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"], exact: true },
    { href: `/clients/${clientId}/calendar`, label: "Calendar", icon: "CalendarClock", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  ];
}

const ROLE_LABEL: Record<Role, string> = {
  KAROS_ADMIN: "Admin",
  KAROS_EMPLOYEE: "Employee",
  CLIENT_USER: "Client",
};

/* ── View-as-Client picker ───────────────────────────────────────────── */

function ClientContextPicker({
  clients,
  isAdmin,
}: {
  clients: StaffPickerClientView[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const { activeClient, setActiveClient } = useActiveClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useMenuDismiss(open, setOpen);

  const filtered = query.trim()
    ? clients.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    : clients;

  function selectClient(client: StaffPickerClientView) {
    setOpen(false);
    setQuery("");
    // THE GUARD SKIPS THE SEED, NOT THE NAVIGATION (review wave, 2026-09).
    //
    // Re-picking the client that is already active must not RE-SEED: the
    // optimistic seed below starts the roster empty and the balance unknown,
    // and ClientContextSync only re-fills them when one of its dependency
    // signatures changes - which, on the same client's own page, nothing does.
    // So the credits pill vanished and the AI-agents dropdown emptied until the
    // next navigation (alignment review, parity pass 2026-09).
    //
    // It used to `return` outright, which also swallowed the push - so picking
    // the active client from `/jobs` or `/assets` closed the dropdown and left
    // the reader exactly where they were, with no feedback at all. Picking a
    // client from this control means "take me to that client".
    if (activeClient?.client.id !== client.id) {
      seedContext(client);
    }
    router.push(`/clients/${client.id}`);
  }

  function seedContext(client: StaffPickerClientView) {
    // Optimistically switch the nav immediately; ClientContextSync fills in docs/competitors on load.
    // isAdmin carries the VIEWER's real role rather than a hardcoded true: the
    // picker renders for every staff member, so an EMPLOYEE who picked a client
    // got the admin-only Schedule and Regenerate controls in their rail for the
    // whole navigation, until ClientContextSync reconciled the flag from the
    // server. That was a REAL escalation window, not a dead control: at the
    // time, generateIntelReportAction gated on requireStaff, so the employee's
    // click would have fired a full pipeline run (the action is requireAdmin
    // now - CD-G5 hardening - closing the server side too). The flag starting
    // out honest closes the UI side.
    // railAgents/spendableCredits start empty and unknown for the same honesty
    // reason isAdmin starts from the real role: the picker knows neither, and
    // ClientContextSync fills both in on the very next render. An empty roster
    // paints an empty dropdown for one frame; a `null` balance hides the
    // credits pill rather than flashing a wrong number at a staff member who is
    // about to read it as the client's (parity pass 2026-09).
    // `client` is the PICKER's row, a narrower projection than the one the
    // context finally holds (StaffPickerClientView — see client-visibility.ts).
    // Same one-frame honesty as the two fields above it: the missing profile
    // fields paint as absent for one render and ClientContextSync replaces the
    // whole projection the moment the client's own layout mounts, which the
    // push below guarantees happens next.
    setActiveClient({
      client,
      contextDocs: [],
      competitors: [],
      railAgents: [],
      spendableCredits: null,
      isAdmin,
    });
  }

  function clearClient(e: React.MouseEvent) {
    e.stopPropagation();
    setActiveClient(null);
    setOpen(false);
    // Navigate away so ClientContextSync unmounts and cannot re-set the context on refresh
    router.push("/clients");
  }

  return (
    <div className="relative">
      {/* TWO CONTROLS, TWO ELEMENTS (review wave, 2026-09). The clear-context ✕
          used to be a `role="button" tabIndex={0}` SPAN nested inside the
          trigger button — invalid markup (interactive content inside a button),
          which browsers and assistive tech resolve inconsistently, and it hand-
          rolled only the Enter half of a button's keyboard contract, so Space
          fell through to the trigger and re-opened the dropdown instead of
          clearing the context. It is a sibling `<button>` now, absolutely
          positioned over the trigger's right padding — the same shape
          `AgentRow` uses in client-rail-agents-nav.tsx — so Enter, Space and
          the focus ring all come from the platform rather than from here. */}
      <div className="relative flex items-center">
        <button
          ref={triggerRef}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          /* D12 (parity pass 2026-09): in client context this rail is the
             client's rail, and this control is the one thing on it a client has
             no equivalent of. It stays — it is the only way in and out of the
             context — but it says so, in a word and in a tooltip, so nobody
             reads it as part of what the client sees. */
          title={
            activeClient
              ? "Internal · you are viewing this client's workspace. Clients never see this control."
              : "Internal · pick a client to view their workspace."
          }
          className={cn(
            "flex w-full items-center gap-2 rounded-[10px] py-2 pl-3 text-sm transition-colors",
            // Room for the ✕ that sits over this padding when a context is open.
            activeClient ? "pr-8" : "pr-3",
            open
              ? "bg-surface-2 text-foreground"
              : "text-muted hover:bg-surface-2 hover:text-foreground",
          )}
        >
          <Icon name="Eye" className="h-4 w-4 shrink-0 text-muted-2" />
          <span className="min-w-0 flex-1 truncate text-left">
            {activeClient ? activeClient.client.name : "Client context"}
          </span>
          {/* One row, not a caption line above it: the rail's height is a fixed
              budget (CD-E3) and this control has to fit the client's footer. */}
          {activeClient && (
            <span
              aria-hidden="true"
              className="shrink-0 rounded border border-border px-1 font-mono text-[9px] uppercase leading-[1.4] tracking-[0.12em] text-muted-2"
            >
              Internal
            </span>
          )}
          {!activeClient && (
            <Icon
              name="ChevronDown"
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-2 transition-transform",
                open && "rotate-180",
              )}
            />
          )}
        </button>
        {activeClient && (
          <button
            type="button"
            onClick={clearClient}
            className="absolute right-2 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-2 transition-colors hover:text-foreground"
            aria-label="Clear client context"
            title="Clear client context"
          >
            <Icon name="X" className="h-3 w-3" />
          </button>
        )}
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-50 mb-1.5 w-72 overflow-hidden rounded-[12px] border border-border bg-surface shadow-xl">
            <div className="border-b border-border p-2">
              <input
                type="text"
                placeholder="Search clients…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-[8px] bg-surface-2 px-3 py-1.5 text-xs outline-none placeholder:text-muted-2"
                autoFocus
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-muted-2">No clients found</p>
              ) : (
                filtered.map((client) => {
                  const isActive = activeClient?.client.id === client.id;
                  // `logoUrl` already IS `logoUrl || brandingGuidelines.logoUrl`
                  // — the picker's projection resolves that fallback so a whole
                  // BrandingGuidelines object per client no longer rides into
                  // every staff page's payload for one nested string (review
                  // wave, 2026-09; see toStaffPickerView).
                  const logoUrl = client.logoUrl;
                  const accentColor = client.accentColor ?? "#ff6b2c";
                  return (
                    <button
                      key={client.id}
                      onClick={() => selectClient(client)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-[8px] px-3 py-2 text-left transition-colors",
                        isActive ? "bg-neon-soft" : "hover:bg-surface-2",
                      )}
                    >
                      <BrandFavicon
                        src={logoUrl}
                        website={client.website}
                        name={client.name}
                        accentColor={accentColor}
                        faviconSize={64}
                        className="h-6 w-6 rounded-[5px] text-[10px]"
                        imgClassName="border border-border bg-surface-2 object-contain"
                      />
                      <span
                        className={cn(
                          "text-sm font-medium",
                          isActive ? "text-neon" : "text-foreground",
                        )}
                      >
                        {client.name}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ── User menu ───────────────────────────────────────────────────────── */

/**
 * The staff account zone. CD-G9c moved the floating top-right cluster -
 * support, light/dark, notifications - in here, so the workspace no longer
 * carries a header bar whose only job was three icons. That consciously
 * overrules F116's "a badge behind a dropdown is not a badge": the trigger
 * keeps an unread DOT so the signal survives the move, and the full panel is
 * two clicks away (open menu → Notifications).
 */
function UserMenu({
  user,
  realAdmin,
  feeds,
  dismissals,
  viewerIsClient,
  unreadWithChrome,
  showChrome = true,
  allowJobDeepLinks = true,
}: {
  user: AppUser;
  realAdmin?: AppUser;
  feeds: NotificationFeeds;
  /** The shell's dismissal set — threaded so this bell and the dots agree (#105). */
  dismissals: NotificationDismissals;
  /** Passed straight to the bell — see the Sidebar's own binding. */
  viewerIsClient: boolean;
  /**
   * The Sidebar's own `unread`, handed down rather than recomputed here: this
   * dot and the hamburger dot are the same number, and adding a second call
   * site for the sum is how they drifted apart in the first place (#105).
   */
  unreadWithChrome: number;
  /**
   * False inside the mobile drawer, which already surfaces the three rows one
   * level up - the menu is itself a tap deep there, so nesting them would put
   * support and the bell three taps from a page.
   */
  showChrome?: boolean;
  /** Passed straight to the bell — see the Sidebar's own binding. */
  allowJobDeepLinks?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const triggerRef = useMenuDismiss(open, setOpen);
  // No bell in this menu inside the drawer, so no dot on its trigger either.
  const unread = showChrome ? unreadWithChrome : 0;

  async function handleLogout() {
    setLoggingOut(true);
    setOpen(false);
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
      await signOut(auth).catch(() => {});
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        /* NAMES THE PERSON, not just the control (review wave, 2026-09). The
           visible row already carries the name and the role; a screen reader
           was told only "button", and in an impersonated session ("Viewing as
           Client") knowing WHOSE account this menu belongs to is the whole
           point of the row. The unread count rides in the SAME string, because
           an aria-label replaces the element's contents outright — the sr-only
           span that used to carry it inside the button stopped being announced
           the moment this label existed. */
        aria-label={
          unread > 0
            ? `Open account menu for ${user.name}, ${unread} unread notifications`
            : `Open account menu for ${user.name}`
        }
        className={cn(
          "flex w-full items-center gap-3 rounded-[10px] px-2 py-1.5 text-left transition-colors",
          open ? "bg-surface-2" : "hover:bg-surface-2",
        )}
      >
        <span className="relative shrink-0">
          {user.photoURL ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={user.photoURL}
                alt=""
                className="h-8 w-8 shrink-0 rounded-full object-cover"
              />
            </>
          ) : (
            /* Paper, not orange (parity pass 2026-09, ruling D10). Ember
               rations the accent to one CTA and an avatar fallback is not it —
               the client's own AccountMenu already paints its initials
               `text-foreground`, so this was also the last thing making the two
               footers look like different products. */
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-foreground">
              {initials(user.name)}
            </div>
          )}
          {unread > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-neon ring-2 ring-background"
              aria-hidden="true"
            />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{user.name}</p>
          <p className="truncate text-[11px] text-muted-2">
            {realAdmin ? `Viewing as ${ROLE_LABEL[user.role]}` : ROLE_LABEL[user.role]}
          </p>
        </div>
        <Icon
          name="ChevronsUpDown"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-2 transition-opacity",
            open ? "opacity-100" : "opacity-50",
          )}
        />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* NOT overflow-hidden: the notification panel below is `absolute
              bottom-full`, i.e. entirely outside this box, so an ancestor clip
              erased it - the row opened onto nothing. The rounding needs no
              clip of its own, every child row is rounded-[8px] inside p-1 and
              nothing reaches the corners. */}
          <div className="absolute bottom-full left-0 right-0 z-50 mb-1.5 rounded-[12px] border border-border bg-surface shadow-xl">
            <div className="p-1">
              {/* Panel opens UPWARD out of the menu: the menu itself already
                  hangs off the foot of the rail, and "right" would push a
                  320px panel off-screen at narrow width. */}
              {showChrome && (
                <NotificationBell
                  actionItems={feeds.actionItems}
                  reviewJobs={feeds.reviewJobs}
                  taskAlerts={feeds.taskAlerts}
                  variant="row"
                  panelPlacement="up"
                  /* The anchor sits ~300px off the bottom of the rail, so a
                     full-height panel (header + 480px feed + footer = 561px)
                     ran off the TOP of the viewport at 1280x800 - measured
                     -21px. 45vh keeps it clear down to ~600px of viewport. */
                  panelClassName="max-h-[45vh]"
                  allowJobDeepLinks={allowJobDeepLinks}
                  viewerIsClient={viewerIsClient}
                  dismissals={dismissals}
                />
              )}
              <Link
                href="/settings"
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-[8px] px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Icon name="Settings" className="h-4 w-4" />
                Settings
              </Link>
              {showChrome && (
                <>
                  <ContactUsButton variant="row" userName={user.name} userEmail={user.email} />
                  <ThemeSwitch />
                </>
              )}
              <div className="my-1 h-px bg-border" />
              <button
                onClick={handleLogout}
                disabled={loggingOut}
                className="flex w-full items-center gap-3 rounded-[8px] px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-danger disabled:opacity-50"
              >
                <Icon name="LogOut" className="h-4 w-4" />
                {loggingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Sidebar ─────────────────────────────────────────────────────────── */

export function Sidebar({
  user,
  pendingCount = 0,
  realAdmin,
  clients = [],
  actionItems = [],
  reviewJobs = [],
  taskAlerts = [],
}: {
  user: AppUser;
  pendingCount?: number;
  realAdmin?: AppUser;
  /** Picker ROWS — the narrow projection, not the active client's. */
  clients?: StaffPickerClientView[];
  /**
   * Bell feeds. They used to be handed to AppHeader, the floating top-right
   * strip; CD-G9c retired that strip and the bell now lives in the account
   * menu (and, at narrow width in client context, in the Company sheet).
   *
   * `TaskAlert`, not `ClientTask`: this shell is also what a CLIENT_USER with an
   * unresolvable client falls through to, and a full task document handed to a
   * "use client" component is in that viewer's RSC payload whether or not a row
   * paints it. Staff rows satisfy this Pick structurally and keep their
   * `_clientName` (review wave, 2026-09; see notification-rows.ts).
   */
  actionItems?: ActionItemNotification[];
  reviewJobs?: AgentReviewNotification[];
  taskAlerts?: TaskAlert[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { activeClient, setActiveClient } = useActiveClient();
  const [companyOpen, setCompanyOpen] = useCompanySheet();

  const feeds: NotificationFeeds = { actionItems, reviewJobs, taskAlerts };
  // Asked of the ROLE, not of the shell. This shell is the staff workspace, but
  // it is also what a CLIENT_USER with no clientId falls through to (see the app
  // layout), and that viewer must get the client's feed grain and the client's
  // words — not "Waiting for your review" and a /jobs link they cannot open.
  const viewerIsClient = user.role === "CLIENT_USER";
  // The dismissal set every bell in this shell shares with both dots below,
  // and the ONE derivation of "how many unread" (#105, #118).
  const dismissals = useNotificationDismissals();
  const unread = unreadNotificationCount(feeds, {
    viewerIsClient,
    dismissed: dismissals.dismissed,
  });

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";

  // The nav table, filtered by role and nothing else. It used to be filtered and
  // then REWRITTEN for a client — a /dashboard remap and a spliced AI Agents
  // row, both built from `user.clientId` — see the note above NAV for why those
  // two rows could only ever 404 for the one viewer they rendered for (#137).
  const adminItems: NavItem[] = NAV.filter((n) => {
    if (n.roles.includes(user.role)) return true;
    if (n.href === "/team" && user.role === "CLIENT_USER" && user.isGroupAdmin) return true;
    return false;
  });

  // In Client View mode show the client-facing tabs; otherwise show the full admin nav.
  // Using (isStaff && activeClient) so TS narrows activeClient to non-null in the truthy branch.
  const items: NavItem[] = (isStaff && activeClient) ? clientViewNav(activeClient.client.id) : adminItems;

  // Narrow-width contract (CD-G9a): with a client context active the staff
  // shell drops the top bar + hamburger and renders the SAME bottom tab bar and
  // full-screen Company sheet the client shell uses. Staff WITHOUT a context
  // keep the drawer - the full admin nav is more tabs than a bar can hold
  // (flagged, not ruled). Bound once so TS narrows it inside the JSX below.
  const clientCtx = isStaff && activeClient ? activeClient : null;

  // The client-context shell's own routes, built from the ACTIVE CLIENT's id and
  // never from `user.clientId` — see the note above NAV for why that field is
  // banned in this file (#137).
  const clientHome = clientCtx ? `/clients/${clientCtx.client.id}` : null;
  const clientSettingsHref = clientHome ? `${clientHome}/settings` : null;

  // Where the wordmark goes — the same question the nav table above answers,
  // asked of the one control that is not in it. /dashboard is the STAFF home:
  // it redirects a CLIENT_USER to /clients/<clientId>, or to /assets when they
  // have no id. Neither ends anywhere for the client who reaches this shell —
  // the first is the notFound() described above, and the second now bounces on
  // to /calendar (the Workspace board /assets used to land on is gone). So the
  // mark goes to /calendar directly: it already has its own no-clientId empty
  // state, same as the nav row above.
  //
  // In client context it goes where the CLIENT'S mark goes — their own Home
  // (parity pass 2026-09, ruling D23). Sending a staff member previewing a
  // client back to the agency dashboard from the client's own wordmark is the
  // one navigation in this shell that silently leaves the context behind.
  const homeHref = clientHome ?? (isStaff ? "/dashboard" : "/calendar");

  // The bell has to agree with the nav it sits inside. `clientViewNav` above
  // deliberately drops the Jobs tab, so a review row that deep-linked to
  // /jobs/[id] threw a staff member in Client View onto the one admin page
  // this very shell had just taken away — reported live as "I don't know why
  // it brought me here in Jobs… I'm on the View as client app". Derived from
  // the same condition that picks `items`, so the two cannot drift apart.
  const allowJobDeepLinks = clientCtx === null;

  // QA F113 (staff stranded in client view) is answered by the ClientContextPicker
  // at the foot of the rail: its ✕ clears the context AND routes to /clients, and
  // it renders for every staff member, not just admins. A second labelled exit in
  // the nav was redundant - three controls for one action, and one more row
  // competing for the rail's fixed height (CD-E3).
  /**
   * The AGENCY nav's active treatment, and nothing else.
   *
   * V4 held this binding to a ternary — paper in client context, orange in the
   * agency workspace — because both navs were built by the loop below. The
   * parity pass 2026-09 finished the job the other way round: in client context
   * the rows are literally the client's rows now (components/rail-nav-link.tsx,
   * mounted by both shells), so there is no second copy of the active treatment
   * left to keep in step, and this loop only ever renders the agency nav — the
   * one nav a client never sees, and the one this ruling leaves alone.
   */
  const activeRowClass = "bg-neon-soft text-neon shadow-[inset_0_0_0_1px_rgba(255,107,44,0.15)]";
  const activeIconClass = "text-neon";

  const nav = (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const itemPath = item.href.split("?")[0];
        const active = item.exact
          ? pathname === itemPath
          : pathname === itemPath || pathname.startsWith(itemPath + "/");
        const badge = item.href === "/team" && pendingCount > 0 ? pendingCount : null;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={cn(
              "group flex items-center gap-3 rounded-[10px] px-3 py-2 text-sm transition-all duration-150 active:scale-[0.97]",
              active ? activeRowClass : "text-muted hover:bg-surface-2 hover:text-foreground",
            )}
          >
            <Icon
              name={item.icon}
              className={cn(
                "h-4 w-4",
                active ? activeIconClass : "text-muted-2 group-hover:text-foreground",
              )}
            />
            <span className="flex-1">{item.label}</span>
            {badge !== null && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-neon px-1.5 text-[11px] font-semibold text-accent-ink">
                {badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  /**
   * The staff-only rows the client's AccountMenu has no equivalent of (parity
   * pass 2026-09, ruling D10). They ride INSIDE that menu, in its own fenced
   * "STAFF" group, rather than as extra rail rows: the ruling is that the rail
   * itself is the client's rail, and every additive staff control has to be
   * both present and unmistakably marked.
   *
   * "Exit client view" is the same body as ClientContextBar's exit — clear the
   * context, then leave, so ClientContextSync unmounts and cannot re-set it on
   * the next refresh.
   */
  const staffExtras = (
    <>
      <Link
        href="/settings"
        className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        <Icon name="Settings" className="h-4 w-4 text-muted-2" />
        Your settings
      </Link>
      <button
        onClick={() => {
          setActiveClient(null);
          router.push("/clients");
        }}
        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        <Icon name="LogOut" className="h-4 w-4 text-muted-2" />
        Exit client view
      </button>
    </>
  );

  /**
   * The client's own credits pill, on the staff rail (ruling D7). Same link,
   * same shape, same number — `spendableCredits`, the balance clipped by the
   * caps, which is what a run actually costs against.
   *
   * The `title` is the one thing the client's copy does not carry, and it is
   * the whole reason the pill is safe to show here: a staff run is FREE
   * (`isBillableClientActor()` charges only a real client session), so a staff
   * member watching this number must know it is the CLIENT'S balance and not a
   * budget they are spending.
   */
  const creditsPill = clientCtx && clientCtx.spendableCredits != null && (
    <Link
      href={`${clientSettingsHref}?tab=credits`}
      title="Client balance · staff runs are free"
      className="flex min-w-0 flex-1 items-center justify-between rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground"
    >
      <span className="flex items-center gap-1.5">
        <Icon name="Coins" className="h-3.5 w-3.5 text-neon" />
        Credits
      </span>
      <span className="stat-number font-medium text-foreground">{clientCtx.spendableCredits}</span>
    </Link>
  );

  // `inDrawer` - the same tree serves the desktop rail and the narrow-width
  // drawer, but the drawer is itself one tap deep, so the chrome CD-G9c moved
  // into the account menu is surfaced a level higher there (see the footer).
  // The drawer is never reached in client context — that arm renders the tab
  // bar and the Company sheet instead — so every `inDrawer` branch below is
  // agency chrome by construction.
  const shellContent = (inDrawer: boolean) => (
    <div className="flex h-full flex-col">
      {/* Logo - fixed top. No `pb-2` in client context: the client's rail
          spends that space on the body's own `pt-4`, and the two marks have to
          sit at the same height or the whole rail reads as shifted. */}
      <div className={cn("shrink-0 px-4 pt-4", !clientCtx && "pb-2")}>
        <Link href={homeHref} className="flex items-center gap-2.5 px-2 py-1">
          <Image
            src="/brand/kairos-head-disc-dark.svg"
            alt=""
            width={26}
            height={26}
            className="h-[26px] w-[26px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--border)]"
            unoptimized
          />
          <span className="font-serif text-xl font-normal leading-none text-foreground">
            Karos Labs
          </span>
        </Link>
      </div>

      {/* Body. Documents/Competitor Track left this rail with the client's own
          (portal revamp, Surface 01/06) — the full brand card
          (ClientProfilePanel) stays, on explicit direction, mirroring
          client-rail.tsx so a staff member's client-context preview matches
          what the client actually sees (AF-3 parity). Brand Colors came back
          for the same reason it came back there, and the parity rule is why it
          is here too: this rail is the staff PREVIEW of that one.

          PINNED ABOVE the nav (2026-08, client-zero feedback) — same reorder as
          client-rail.tsx, for the same parity reason: if a client sees their own
          brand before their nav, staff previewing that client must see the
          identical order, not nav-then-brand.

          The whole block is client-rail.tsx's body VERBATIM now (parity pass
          2026-09, rulings D3/D5/D6/D11) — wrapper spacing, section order, the
          `border-t pt-4` nav and the roster between Home and Calendar. It reads
          as a duplicate on purpose: the two shells serve different data
          (clientCtx vs. the client's own props) through the same markup, and
          the shared pieces that CAN be one thing — the nav row, the agents nav,
          the account menu — are imported rather than copied. */}
      {clientCtx ? (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 pb-0 pt-4">
          <ClientProfilePanel client={clientCtx.client} compact hideDescription />
          {/* isStaff: this rail is staff-only, and the swatch tooltips carry
              the internal mix percentage for them (CD-E2, ruling D14). */}
          <BrandColorsSection
            guidelines={clientCtx.client.brandingGuidelines}
            clientId={clientCtx.client.id}
            hasWebsite={!!clientCtx.client.website}
            isStaff
          />
          <nav className="flex flex-col gap-0.5 border-t border-border pt-4">
            <NavLink item={items[0]} pathname={pathname} />
            <ClientRailAgentsNav
              home={clientHome!}
              agents={clientCtx.railAgents}
              starredIds={clientCtx.client.starredAgentIds ?? []}
            />
            {items.slice(1).map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} />
            ))}
          </nav>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-0 pt-2">{nav}</div>
      )}

      {/* Bottom - fixed. Two footers, because the two shells' footers are two
          different objects: in client context this is the CLIENT'S footer
          (`p-3`, credits pill + bell, then their AccountMenu — rulings
          D7/D8/D9), with the picker and the staff rows as the only additions. */}
      {clientCtx ? (
        <div className="shrink-0 border-t border-border p-3">
          {/* ABOVE the credits row (ruling D12): the client's footer starts at
              the pill, so anything that is not theirs sits outside that block
              rather than between its two halves. QA F113 — employees get the
              same switcher as admins, and its X is what clears the context. */}
          <div className="mb-2">
            <ClientContextPicker clients={clients} isAdmin={user.role === "KAROS_ADMIN"} />
          </div>
          {/* The bell sits ON the rail beside the pill, exactly as it does in
              client-rail.tsx — a badge only signals if it is visible without
              opening a menu (QA F116). `viewerIsClient` stays FALSE: a staff
              member IS the Karos team, and the client's reassurance copy would
              hide work they own. `allowJobDeepLinks` is false here for the
              opposite reason — this nav has no Jobs tab. */}
          <div className="mb-2 flex items-center gap-2">
            {creditsPill}
            <NotificationBell
              actionItems={actionItems}
              reviewJobs={reviewJobs}
              taskAlerts={taskAlerts}
              variant="icon"
              panelPlacement="up"
              allowJobDeepLinks={allowJobDeepLinks}
              viewerIsClient={viewerIsClient}
              dismissals={dismissals}
            />
          </div>
          {/* The client's own identity row, so the sub-line reads
              "{client} · Account Center" and the two affordances (name →
              Account Center, chevron → menu) match theirs. UserMenu — and the
              bell inside it — is deliberately NOT mounted in this arm: the bell
              is on the rail above, and a second one behind a dropdown is the
              F116 defect twice over. */}
          <AccountMenu
            user={user}
            client={clientCtx.client}
            settingsHref={clientSettingsHref!}
            staffExtras={staffExtras}
          />
        </div>
      ) : (
        <div className="shrink-0 space-y-1.5 border-t border-border px-4 py-2">
          {/* QA F113: employees get the same context switcher as admins - the
              picker also carries the X that clears the context. `clients` is
              already fenced to their assigned clients by the app layout. The
              LABELLED exit is F60's ClientContextBar, which renders for any
              staff member the moment a client context is active. */}
          {isStaff && (
            <ClientContextPicker clients={clients} isAdmin={user.role === "KAROS_ADMIN"} />
          )}
          {/* Notifications / support / theme inline rather than inside the menu:
              opening the drawer is already one tap, so nesting them would leave
              them three taps from a page and break CD-G9c's ≤2-click floor. */}
          {inDrawer && (
            <div className="space-y-0.5">
              {/* w-full, not the default w-80: the drawer is w-64 with
                  overflow-y-auto, which forces overflow-x to auto - a 320px
                  panel would be clipped and drag in a horizontal scrollbar. */}
              <NotificationBell
                actionItems={actionItems}
                reviewJobs={reviewJobs}
                taskAlerts={taskAlerts}
                variant="row"
                panelPlacement="up"
                panelClassName="w-full max-h-[45vh]"
                allowJobDeepLinks={allowJobDeepLinks}
                viewerIsClient={viewerIsClient}
                dismissals={dismissals}
                /* The drawer is `fixed inset-0` and closes only from explicit
                   handlers, so without this a bell row routes underneath it and
                   leaves the drawer covering the page it just opened — on every
                   navigation, not just a same-route tap. */
                onNavigate={() => setOpen(false)}
              />
              <ContactUsButton variant="row" userName={user.name} userEmail={user.email} />
              <ThemeSwitch />
            </div>
          )}
          <UserMenu
            user={user}
            realAdmin={realAdmin}
            feeds={feeds}
            dismissals={dismissals}
            viewerIsClient={viewerIsClient}
            unreadWithChrome={unread}
            showChrome={!inDrawer}
            allowJobDeepLinks={allowJobDeepLinks}
          />
        </div>
      )}
    </div>
  );

  return (
    <>
      {clientCtx ? (
        /* ── Narrow width, client context: bottom tab bar + Company sheet.
             Twin of the client shell's own mount (components/client-rail.tsx)
             - same bar, same sheet frame, staff-flavoured contents. ── */
        <>
          {/* ── Mobile top bar (ruling D15) ──
               The client's own strip: wordmark → their Home, credits pill, and
               nothing else. The bell lives in the Company sheet at this width
               in both shells (CD-H5). This arm had no top bar at all before —
               the staff shell dropped it with the hamburger — so a staff member
               in client view got a phone layout the client never sees. */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
            <Link href={homeHref} className="flex items-center gap-2.5">
              <Image
                src="/brand/kairos-head-disc-dark.svg"
                alt=""
                width={26}
                height={26}
                className="h-[26px] w-[26px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--border)]"
                unoptimized
              />
              <span className="font-serif text-xl font-normal leading-none text-foreground">
                Karos Labs
              </span>
            </Link>
            <div className="flex items-center gap-2">
              {clientCtx.spendableCredits != null && (
                <Link
                  href={`${clientSettingsHref}?tab=credits`}
                  title="Client balance · staff runs are free"
                  aria-label={`${clientCtx.spendableCredits} client credits remaining, open credits settings`}
                  className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted"
                >
                  <Icon name="Coins" className="h-3.5 w-3.5 text-neon" />
                  <span className="stat-number font-medium text-foreground">
                    {clientCtx.spendableCredits}
                  </span>
                </Link>
              )}
            </div>
          </div>

          <MobileTabBar
            items={items}
            companyOpen={companyOpen}
            onOpenCompany={() => setCompanyOpen(true)}
            companyUnread={unread}
          />

          {/* ── Mobile Company sheet ──
               client-rail.tsx's sheet, section for section (rulings
               D18/D19): brand card → Brand Colors → the agent roster → the
               account group. Grouped with the client's `border-t pt-4`, not
               the `border-b pb-4` this shell used to draw, so the two sheets
               do not put their rules on opposite sides of the same content. */}
          <MobileCompanySheet open={companyOpen} onClose={() => setCompanyOpen(false)}>
            <ClientProfilePanel client={clientCtx.client} hideDescription />
            <BrandColorsSection
              guidelines={clientCtx.client.brandingGuidelines}
              clientId={clientCtx.client.id}
              hasWebsite={!!clientCtx.client.website}
              isStaff
            />

            {/* "AI agents" has no slot in the 2-icon bottom tab bar (Home,
                Calendar fill it), so the roster + star toggles live here on
                mobile — same one-line decision the client's sheet makes. */}
            <div className="border-t border-border pt-4">
              <ClientRailAgentsNav
                home={clientHome!}
                agents={clientCtx.railAgents}
                starredIds={clientCtx.client.starredAgentIds ?? []}
              />
            </div>

            <div className="space-y-0.5 border-t border-border pt-4">
              {/* The CLIENT'S destination and the client's word for it. This
                  row used to be "Settings" → /settings, i.e. the staff
                  member's own account page mounted where the client's Account
                  Center sits. Explicit close: the sheet otherwise closes on
                  navigation, and tapping a row for the route already open
                  routes nowhere - the sheet just sat there over the page. */}
              <Link
                href={clientSettingsHref!}
                onClick={() => setCompanyOpen(false)}
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Icon name="Settings" className="h-4 w-4 text-muted-2" />
                Account Center
              </Link>
              {/* No Team row (ruling D21): /team is the CLIENT's group-admin
                  surface, and a staff member is not in the client's group. */}
              {/* onNavigate: same explicit close as the row above — a bell row
                  pointing at the route already open navigates nowhere, so the
                  sheet's on-navigation effect never fires. */}
              <NotificationBell
                actionItems={actionItems}
                reviewJobs={reviewJobs}
                taskAlerts={taskAlerts}
                variant="row"
                panelPlacement="up"
                panelClassName="max-h-[45vh]"
                allowJobDeepLinks={allowJobDeepLinks}
                viewerIsClient={viewerIsClient}
                dismissals={dismissals}
                onNavigate={() => setCompanyOpen(false)}
              />
              <div className="px-0">
                <ContactUsButton variant="row" userName={user.name} userEmail={user.email} />
              </div>
              <ThemeSwitch />
              {/* The two staff extras, in the same order and with the same
                  bodies as the desktop AccountMenu's "STAFF" group. They are
                  additive rows at the tail rather than a fenced group because
                  the sheet has no dropdown to fence them inside — the group
                  boundary here is the account block they sit at the end of.
                  STAFF-ONLY: this branch never renders for a client. At phone
                  width the nav is the client's tabs and nothing else, so the
                  only way back to the agency workspace was the F60 strip at
                  the top of the page, which scrolls away. The caption is the
                  same mono "STAFF" the desktop group wears, so the rows read
                  as internal here too (alignment review, parity pass 2026-09). */}
              <p className="mt-2 border-t border-border px-2 pb-1 pt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-2">
                Staff
              </p>
              <Link
                href="/settings"
                onClick={() => setCompanyOpen(false)}
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Icon name="Settings" className="h-4 w-4 text-muted-2" />
                Your settings
              </Link>
              <button
                onClick={() => {
                  setCompanyOpen(false);
                  setActiveClient(null);
                  router.push("/clients");
                }}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Icon name="LogOut" className="h-4 w-4 text-muted-2" />
                Exit client view
              </button>
              <LogoutButton compact />
            </div>
          </MobileCompanySheet>
        </>
      ) : (
        <>
          {/* Mobile top bar */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
            <Link href={homeHref} className="flex items-center gap-2.5">
              <Image
                src="/brand/kairos-head-disc-dark.svg"
                alt=""
                width={26}
                height={26}
                className="h-[26px] w-[26px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--border)]"
                unoptimized
              />
              <span className="font-serif text-xl font-normal leading-none text-foreground">Karos Labs</span>
            </Link>
            <button
              onClick={() => setOpen((o) => !o)}
              className="relative text-muted transition-colors hover:text-foreground"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
            >
              <Icon name={open ? "X" : "Menu"} className="h-5 w-5" />
              {/* The bell moved into the drawer's account menu (CD-G9c), so the
                  only thing left on screen has to carry its dot. */}
              {!open && unread > 0 && (
                <span
                  className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-neon ring-2 ring-background"
                  aria-hidden="true"
                />
              )}
            </button>
          </div>

          {/* Mobile drawer */}
          {open && (
            <div className="fixed inset-0 z-40 md:hidden">
              <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={() => setOpen(false)}
              />
              <div className="absolute left-0 top-0 h-full w-64 overflow-y-auto border-r border-border bg-surface">
                {shellContent(true)}
              </div>
            </div>
          )}
        </>
      )}

      {/* Desktop sidebar. In client context it is the CLIENT'S rail, down to
          the width (rulings D1/D2): `w-72` and `relative z-30`, so its menus
          and notification panel sit above the center column exactly as
          client-rail.tsx's do. `w-64` stays the agency width — that shell is
          out of scope, and nothing has to match it: the copilot dock is only
          ever mounted in client context, so it anchors to the `w-72` arm alone
          (one anchor for both shells now — see copilot-dock's DOCK_ANCHOR). */}
      <aside
        className={cn(
          "hidden shrink-0 border-r border-border bg-background md:block",
          clientCtx ? "relative z-30 w-72" : "w-64",
        )}
      >
        <div className="sticky top-0 h-screen">{shellContent(false)}</div>
      </aside>
    </>
  );
}
