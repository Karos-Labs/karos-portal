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
import { ClientDocuments } from "@/components/client-documents";
import { clientIntelSchedule } from "@/lib/intel-schedule";
import { CompetitorTrack, BrandColorsSection } from "@/components/client-context-sections";
import { BrandFavicon } from "@/components/brand-favicon";
import { ClientProfilePanel } from "@/components/client-profile-panel";
import {
  NotificationBell,
  useNotificationDismissals,
  type NotificationDismissals,
} from "@/components/notification-bell";
import {
  unreadNotificationCount,
  type NotificationFeeds,
} from "@/lib/notification-rows";
import { ThemeSwitch } from "@/components/theme-switch";
import { ContactUsButton } from "@/components/contact-us-modal";
import { LogoutButton } from "@/components/logout-button";
import { MobileCompanySheet, MobileTabBar, useCompanySheet } from "@/components/mobile-shell";
import { isAiProcessingLockActive } from "@/lib/constants";
import { hasAiProcessingFailure, type StaffShellClientView } from "@/lib/client-visibility";
import type {
  ActionItemNotification,
  AgentReviewNotification,
  AppUser,
  ClientTask,
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

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/clients", label: "Clients", icon: "Building2", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/agents", label: "Agents", icon: "Bot", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/jobs", label: "Jobs", icon: "ListChecks", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/transcripts", label: "Meetings", icon: "Mic", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/assets", label: "Assets", icon: "FolderOpen", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/calendar", label: "Calendar", icon: "CalendarClock", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/tasks", label: "Workspace", icon: "SquareCheck", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/team", label: "Team", icon: "Users", roles: ["KAROS_ADMIN"] },
  { href: "/connect", label: "Connect", icon: "Plug", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/admin/analytics", label: "Analytics", icon: "TrendingUp", roles: ["KAROS_ADMIN"] },
  { href: "/admin/ops", label: "Ops Import", icon: "Inbox", roles: ["KAROS_ADMIN"] },
];

// The client-facing tabs shown to staff when in Client View mode. The Library
// merged into the Workspace's Archive tab (2026-07); staff review drafts via
// the global Assets page.
function clientViewNav(clientId: string): NavItem[] {
  return [
    { href: `/clients/${clientId}`, label: "Dashboard", icon: "LayoutDashboard", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"], exact: true },
    { href: `/clients/${clientId}/agents`, label: "AI Agents", icon: "Bot", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
    { href: `/clients/${clientId}/calendar`, label: "Calendar", icon: "CalendarClock", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
    { href: `/clients/${clientId}/tasks`, label: "Workspace", icon: "ListChecks", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
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
  clients: StaffShellClientView[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const { activeClient, setActiveClient } = useActiveClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? clients.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    : clients;

  function selectClient(client: StaffShellClientView) {
    setOpen(false);
    setQuery("");
    // Optimistically switch the nav immediately; ClientContextSync fills in docs/competitors on load.
    // isAdmin carries the VIEWER's real role rather than a hardcoded true: the
    // picker renders for every staff member, so an EMPLOYEE who picked a client
    // got the admin-only Schedule and Regenerate controls in their rail for the
    // whole navigation, until ClientContextSync reconciled the flag from the
    // server. That was a REAL escalation window, not a dead control: at the
    // time, generateIntelReportAction gated on requireStaff, so the employee's
    // click would have fired a full pipeline run (the action is requireAdmin
    // now — CD-G5 hardening — closing the server side too). The flag starting
    // out honest closes the UI side.
    setActiveClient({ client, contextDocs: [], competitors: [], isAdmin });
    router.push(`/clients/${client.id}`);
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
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-sm transition-colors",
          open
            ? "bg-surface-2 text-foreground"
            : "text-muted hover:bg-surface-2 hover:text-foreground",
        )}
      >
        <Icon name="Eye" className="h-4 w-4 shrink-0 text-muted-2" />
        <span className="min-w-0 flex-1 truncate text-left">
          {activeClient ? activeClient.client.name : "Client context"}
        </span>
        {activeClient ? (
          <span
            role="button"
            tabIndex={0}
            onClick={clearClient}
            onKeyDown={(e) => e.key === "Enter" && clearClient(e as never)}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-2 transition-colors hover:text-foreground"
            aria-label="Clear client context"
          >
            <Icon name="X" className="h-3 w-3" />
          </span>
        ) : (
          <Icon
            name="ChevronDown"
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-2 transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </button>

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
                  const logoUrl = client.logoUrl || client.brandingGuidelines?.logoUrl;
                  const accentColor = client.accentColor ?? "#2dff9e";
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
 * The staff account zone. CD-G9c moved the floating top-right cluster —
 * support, light/dark, notifications — in here, so the workspace no longer
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
   * level up — the menu is itself a tap deep there, so nesting them would put
   * support and the bell three taps from a page.
   */
  showChrome?: boolean;
  /** Passed straight to the bell — see the Sidebar's own binding. */
  allowJobDeepLinks?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
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
        onClick={() => setOpen((o) => !o)}
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
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-neon">
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
        {unread > 0 && <span className="sr-only">{unread} unread notifications</span>}
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
              erased it — the row opened onto nothing. The rounding needs no
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
                     ran off the TOP of the viewport at 1280x800 — measured
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
  clients?: StaffShellClientView[];
  /**
   * Bell feeds. They used to be handed to AppHeader, the floating top-right
   * strip; CD-G9c retired that strip and the bell now lives in the account
   * menu (and, at narrow width in client context, in the Company sheet).
   */
  actionItems?: ActionItemNotification[];
  reviewJobs?: AgentReviewNotification[];
  taskAlerts?: (ClientTask & { _clientName?: string })[];
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

  const clientHomePath =
    user.role === "CLIENT_USER" && user.clientId ? `/clients/${user.clientId}` : null;

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";

  const adminItems: NavItem[] = NAV.filter((n) => {
    if (n.roles.includes(user.role)) return true;
    if (n.href === "/team" && user.role === "CLIENT_USER" && user.isGroupAdmin) return true;
    return false;
  }).map((n) => {
    // exact — otherwise Dashboard stays lit on the AI Agents page below it.
    if (n.href === "/dashboard" && clientHomePath) return { ...n, href: clientHomePath, exact: true };
    return n;
  });
  if (clientHomePath) {
    // Client users run their granted custom agents from their own agents page.
    adminItems.splice(1, 0, {
      href: `${clientHomePath}/agents`,
      label: "AI Agents",
      icon: "Bot",
      roles: ["CLIENT_USER"],
    });
  }

  // In Client View mode show the 4 client-facing tabs; otherwise show the full admin nav.
  // Using (isStaff && activeClient) so TS narrows activeClient to non-null in the truthy branch.
  const items: NavItem[] = (isStaff && activeClient) ? clientViewNav(activeClient.client.id) : adminItems;

  // Narrow-width contract (CD-G9a): with a client context active the staff
  // shell drops the top bar + hamburger and renders the SAME bottom tab bar and
  // full-screen Company sheet the client shell uses. Staff WITHOUT a context
  // keep the drawer — the full admin nav is more tabs than a bar can hold
  // (flagged, not ruled). Bound once so TS narrows it inside the JSX below.
  const clientCtx = isStaff && activeClient ? activeClient : null;

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
  // the nav was redundant — three controls for one action, and one more row
  // competing for the rail's fixed height (CD-E3).
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
              active
                ? "bg-neon-soft text-neon shadow-[inset_0_0_0_1px_rgba(255,107,44,0.15)]"
                : "text-muted hover:bg-surface-2 hover:text-foreground",
            )}
          >
            <Icon
              name={item.icon}
              className={cn(
                "h-4 w-4",
                active ? "text-neon" : "text-muted-2 group-hover:text-foreground",
              )}
            />
            <span className="flex-1">{item.label}</span>
            {badge !== null && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-neon px-1.5 text-[11px] font-semibold text-[#03110b]">
                {badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  // CD-G4: the chip's ↗ opens the client's REAL website, not /clients/[id] —
  // the nav's Dashboard tab already goes there in client view, so the internal
  // link was a duplicate. Same protocol normalisation the Competitor Track rows
  // use for their own ↗. Null when the client has no website on file, and the
  // chip falls back to the internal link rather than rendering a dead control.
  const clientWebsite = activeClient?.client.website?.trim();
  const clientSiteHref = clientWebsite
    ? clientWebsite.startsWith("http")
      ? clientWebsite
      : `https://${clientWebsite}`
    : null;

  // Client-context sections appended below core nav when a client is active.
  // CD-G4: the top block — logo, nav, client chip, and the rule above the
  // Documents header — is back to the 36a5200 baseline measurement-for-
  // measurement; Documents and everything under it keeps the approved
  // compaction. `space-y` is the one class that straddles that boundary (it
  // sets the chip→Documents gap AND the Documents→Competitors→Brand Colors
  // gaps), so it stays at the compact 1.5; the baseline air above Documents is
  // restored through the two wrappers' own pt-4 instead.
  const clientSections = activeClient ? (
    <div className="mt-2 space-y-1.5">
      {/* Client header. pb-1.5 exists to BLOCK margin collapsing, not for its
          own 6px: space-y compiles to a child margin on this wrapper, and the
          inner row's mb-1 collapses into it — leaving 6px above DOCUMENTS vs
          the baseline's 16px (shell2-lens measurement). Padding interrupts the
          collapse, so mb-1(4) + pb-1.5(6) + space-y(6) = the baseline 16px. */}
      <div className="border-t border-border pb-1.5 pt-4">
        <div className="mb-1 flex items-center gap-2 px-1">
          <BrandFavicon
            src={activeClient.client.logoUrl || activeClient.client.brandingGuidelines?.logoUrl}
            website={activeClient.client.website}
            name={activeClient.client.name}
            accentColor={activeClient.client.accentColor ?? "#2dff9e"}
            faviconSize={64}
            className="h-6 w-6 rounded-[5px] text-[10px]"
            imgClassName="border border-border bg-surface-2 object-contain"
          />
          <span className="flex-1 truncate text-sm font-semibold text-foreground">
            {activeClient.client.name}
          </span>
          {clientSiteHref ? (
            <a
              href={clientSiteHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
              title="Open client website"
            >
              <Icon name="ArrowUpRight" className="h-3 w-3" />
            </a>
          ) : (
            <Link
              href={`/clients/${activeClient.client.id}`}
              onClick={() => setOpen(false)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
              title="Go to client dashboard"
            >
              <Icon name="ArrowUpRight" className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <ClientDocuments
          contextDocs={activeClient.contextDocs}
          isAdmin={activeClient.isAdmin}
          clientId={activeClient.client.id}
          isAiProcessing={isAiProcessingLockActive(activeClient.client)}
          aiProcessingFailed={hasAiProcessingFailure(activeClient.client)}
          intelSchedule={clientIntelSchedule(activeClient.client)}
          /* Staff-only shell: internal-tier documents are readable here. */
          allowInternalFallback
        />
      </div>

      {/* key: switching client context must reset the panel's local state —
          an optimistically added row otherwise stayed on screen for the NEXT
          client's rail until a reload (QA F62 flag). */}
      <CompetitorTrack
        key={activeClient.client.id}
        competitors={activeClient.competitors}
        clientId={activeClient.client.id}
        isStaff={true}
      />

      <BrandColorsSection
        guidelines={activeClient.client.brandingGuidelines}
        clientId={activeClient.client.id}
        hasWebsite={!!activeClient.client.website}
        /* Staff shell — internal usage percentages are visible and editable here. */
        isStaff
      />
    </div>
  ) : null;

  // `inDrawer` — the same tree serves the desktop rail and the narrow-width
  // drawer, but the drawer is itself one tap deep, so the chrome CD-G9c moved
  // into the account menu is surfaced a level higher there (see the footer).
  const shellContent = (inDrawer: boolean) => (
    <div className="flex h-full flex-col">
      {/* Logo — fixed top */}
      <div className="shrink-0 px-4 pb-2 pt-4">
        <Link href="/dashboard" className="flex items-center gap-2.5 px-2 py-1">
          <Image
            src="/brand/kairos-head-disc-dark.svg"
            alt=""
            width={26}
            height={26}
            className="h-[26px] w-[26px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(242,241,236,0.14)]"
            unoptimized
          />
          <span className="font-serif text-xl font-normal leading-none text-foreground">
            Karos Labs
          </span>
        </Link>
      </div>

      {/* Body. NOT a scroll container by contract (CD-E3): nav + client chip +
          Documents + Competitor Track + Brand Colors + footer must fit the
          viewport at common laptop heights. The content set is bounded — 4
          client tabs, ≤6 documents, ≤5 tracked competitors, ≤4 swatches — so
          the compacted stack fits; overflow-y-auto stays as the safety valve
          for genuinely short windows rather than clipping a section away. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-0 pt-2">
        {nav}
        {clientSections}
      </div>

      {/* Bottom — fixed */}
      <div className="shrink-0 space-y-1.5 border-t border-border px-4 py-2">
        {/* QA F113: employees get the same context switcher as admins — the
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
                overflow-y-auto, which forces overflow-x to auto — a 320px
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
    </div>
  );

  return (
    <>
      {clientCtx ? (
        /* ── Narrow width, client context: bottom tab bar + Company sheet.
             Twin of the client shell's own mount (components/client-rail.tsx)
             — same bar, same sheet frame, staff-flavoured contents. ── */
        <>
          <MobileTabBar
            items={items}
            companyOpen={companyOpen}
            onOpenCompany={() => setCompanyOpen(true)}
            companyUnread={unread}
          />

          <MobileCompanySheet open={companyOpen} onClose={() => setCompanyOpen(false)}>
            <ClientProfilePanel client={clientCtx.client} compact />

            <div className="border-t border-border pt-4">
              <ClientDocuments
                contextDocs={clientCtx.contextDocs}
                isAdmin={clientCtx.isAdmin}
                clientId={clientCtx.client.id}
                isAiProcessing={isAiProcessingLockActive(clientCtx.client)}
                aiProcessingFailed={hasAiProcessingFailure(clientCtx.client)}
                intelSchedule={clientIntelSchedule(clientCtx.client)}
                /* Staff-only shell: internal-tier documents are readable here. */
                allowInternalFallback
              />
            </div>

            {/* key: see the desktop mount — switching client must reset the
                panel's optimistic rows (QA F62). */}
            <CompetitorTrack
              key={clientCtx.client.id}
              competitors={clientCtx.competitors}
              clientId={clientCtx.client.id}
              isStaff={true}
            />

            <BrandColorsSection
              guidelines={clientCtx.client.brandingGuidelines}
              clientId={clientCtx.client.id}
              hasWebsite={!!clientCtx.client.website}
              /* Staff shell — internal usage percentages are visible here. */
              isStaff
            />

            {/* Tail mirrors the client sheet's, plus the chrome CD-G9c moved off
                the retired top bar and the sign-out the drawer used to carry. */}
            <div className="space-y-0.5 border-t border-border pt-4">
              {/* Explicit close: the sheet otherwise closes on navigation, and
                  tapping Settings while already ON /settings routes nowhere —
                  the sheet just sat there over the page it had reached. */}
              <Link
                href="/settings"
                onClick={() => setCompanyOpen(false)}
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Icon name="Settings" className="h-4 w-4 text-muted-2" />
                Settings
              </Link>
              {/* onNavigate: same explicit close as the Settings row above —
                  a bell row pointing at the route already open navigates
                  nowhere, so the sheet's on-navigation effect never fires. */}
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
              <ContactUsButton variant="row" userName={user.name} userEmail={user.email} />
              <ThemeSwitch />
              {/* The staff escape hatch, and STAFF-ONLY — this branch never
                  renders for a client. At phone width in client context the
                  nav is five client tabs and nothing else, so the only way
                  back to the agency workspace was the F60 strip at the top of
                  the page, which scrolls away. The bar always reaches this.
                  Same body as the strip's exit: clear the context, then leave
                  so ClientContextSync cannot re-set it on refresh. */}
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
            <Link href="/dashboard" className="flex items-center gap-2.5">
              <Image
                src="/brand/kairos-head-disc-dark.svg"
                alt=""
                width={26}
                height={26}
                className="h-[26px] w-[26px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(242,241,236,0.14)]"
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

      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-border bg-background md:block">
        <div className="sticky top-0 h-screen">{shellContent(false)}</div>
      </aside>
    </>
  );
}
