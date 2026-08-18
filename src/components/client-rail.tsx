"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { MobileCompanySheet, MobileTabBar, useCompanySheet } from "@/components/mobile-shell";
import { AccountMenu } from "@/components/account-menu";
import { LogoutButton } from "@/components/logout-button";
import { ThemeSwitch } from "@/components/theme-switch";
import { NotificationBell, useNotificationDismissals } from "@/components/notification-bell";
import { unreadNotificationCount } from "@/lib/notification-rows";
import { ContactUsButton } from "@/components/contact-us-modal";
import { ClientRailAgentsNav, type RailAgent } from "@/components/client-rail-agents-nav";
import { ClientProfilePanel } from "@/components/client-profile-panel";
import { BrandColorsSection } from "@/components/client-context-sections";
import type {
  ActionItemNotification,
  AgentReviewNotification,
  AppUser,
  Client,
  ClientTask,
} from "@/lib/types";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  exact?: boolean;
}

function isActive(pathname: string, item: NavItem): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(item.href + "/");
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item);
  return (
    <Link
      href={item.href}
      className={cn(
        "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
        active ? "bg-surface-2 text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      <Icon
        name={item.icon}
        className={cn("h-4 w-4 shrink-0", active ? "text-foreground" : "text-muted-2 group-hover:text-foreground")}
      />
      <span className="flex-1">{item.label}</span>
    </Link>
  );
}

export function ClientRail({
  user,
  client,
  agents,
  actionItems,
  reviewJobs,
  taskAlerts,
  spendableCredits,
}: {
  user: AppUser;
  client: Client;
  /** Every agent granted to this client, for the "AI agents" dropdown (Surface 01). */
  agents: RailAgent[];
  actionItems: ActionItemNotification[];
  reviewJobs: AgentReviewNotification[];
  taskAlerts: ClientTask[];
  /**
   * Credits the client can actually SPEND right now - availableCredits(), i.e.
   * the balance clipped by the weekly/monthly caps, not the raw stored balance.
   * The pill is labelled "remaining", so it must be the number the charge
   * transaction would honour. Shown as a pill linking to settings; hidden when null.
   */
  spendableCredits?: number | null;
}) {
  const pathname = usePathname();
  const home = `/clients/${client.id}`;

  // Portal revamp Surface 01: the rail is rebuilt around the agents a client
  // actually uses. "AI agents" is no longer a plain nav row — the roster and
  // its star toggles render inline (ClientRailAgentsNav, between Home and
  // Calendar), so it is deliberately absent from this array. "Home" replaces
  // "Dashboard" as the label (same route); the destination itself is unchanged.
  //
  // Workspace is gone — the locked decision list retires it ("The Board is
  // replaced by the action list on Home"). The /tasks route and its data are
  // untouched by this change: only the sidebar's entry point is removed, and
  // its features are redistributed across the new surfaces as that engine
  // ships (the Next Actions widget on Home, first).
  const tabNav: NavItem[] = [
    { href: home, label: "Home", icon: "LayoutDashboard", exact: true },
    { href: "/calendar", label: "Calendar", icon: "CalendarClock" },
    { href: `${home}/downloads`, label: "Downloads", icon: "Download" },
  ];
  /**
   * MEETINGS IS NOT A RAIL DESTINATION (AF-1).
   *
   * #134 read the /transcripts page — client-scoped, `excludeHiddenFromClient`
   * redacted, with its own client copy — as a page whose absence from the
   * client's nav was a defect, and put a Meetings row here to close it. The
   * product owner ruled the other way: the feature stays ("it doesn't hurt")
   * but it is reached FROM SETTINGS, not from the rail. "I like that in the
   * settings."
   *
   * So the rail and the phone bar render the same four destinations, and the
   * client's route to /transcripts is the Meetings tab on their Settings page,
   * which lists their calls and links to the full page. Nothing about the page
   * or its scoping changed — only which surface offers it.
   */
  const settingsItem: NavItem = {
    href: `${home}/settings`,
    // "Account Center" (Surface 06) — same destination for now; that page's
    // own tab set (Profile/Competitors/Documents/Archive/Credits/Meetings) is
    // a separate follow-up build. The label changes here first since it is
    // the name a client sees everywhere the destination is offered.
    label: "Account Center",
    icon: "Settings",
  };

  // Bar + sheet frame are shared with the staff shell's client-context mode -
  // see components/mobile-shell.tsx (CD-G9a). The hook closes the sheet on
  // navigation.
  const [companyOpen, setCompanyOpen] = useCompanySheet();

  // The dismissal set the bells below share with this count (#105). It used to
  // live inside each bell, so clearing a meeting action item shrank the panel
  // and left this tab's dot counting the row that had just gone.
  const dismissals = useNotificationDismissals();

  // The same three feeds the bell counts, THROUGH THE SAME FUNCTION, so the
  // Company tab's dot and the badge inside the sheet can never disagree
  // (CD-H5, #105). `viewerIsClient` is not a flag this shell chooses: the app
  // layout mounts ClientRail only for a CLIENT_USER, which is also why both
  // bells below are hard-wired to it — so the count and the panel collapse the
  // review queue at the same grain (#118).
  const unread = unreadNotificationCount(
    { actionItems, reviewJobs, taskAlerts },
    { viewerIsClient: true, dismissed: dismissals.dismissed },
  );

  const starredAgentIds = client.starredAgentIds ?? [];

  return (
    <>
      {/* ── Desktop left rail (z-30 so its menus/panels sit above the center column) ── */}
      <aside className="relative z-30 hidden w-72 shrink-0 border-r border-border bg-background md:block">
        <div className="sticky top-0 flex h-screen flex-col">
          {/* Logo */}
          <div className="shrink-0 px-4 pt-4">
            <Link href={home} className="flex items-center gap-2.5 px-2 py-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/kairos-head-disc-dark.svg"
                alt=""
                className="h-[26px] w-[26px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(242,241,236,0.14)]"
              />
              <span className="font-serif text-xl font-normal leading-none text-foreground">
                Karos Labs
              </span>
            </Link>
          </div>

          {/* Body. Documents and Competitor Track moved out to Account Center
              (portal revamp, Surface 01/06) — the full brand card stays, on
              explicit direction: it is the client's own identity, prominent,
              not collapsed into a bare name-and-logo row.

              PINNED ABOVE THE NAV, NOT BELOW IT (2026-08, client-zero
              feedback, Aug 8): the client's own brand is what a client should
              see FIRST in their own sidebar, before Home/AI agents/Calendar/
              Downloads — not three navigation rows down. `hideDescription`
              drops the inline "about" text the same feedback asked to move:
              it still lives one click away, in the Brand Profile popup this
              panel's own Contact-icon button opens.

              BRAND COLORS CAME BACK (2026-08, product owner). It moved out with
              the other two and was asked for again by name: the swatch row is
              part of the identity block, not a settings record — it is the one
              thing in the rail a person copies a value OUT of (click-to-copy
              hex), several times a day, and Account Center is two navigations
              away from wherever they are working. It remains ON the Account
              Center Profile tab as well; that is deliberate and is not the
              duplication Surface 06 removed — this is a one-line reader and an
              editor entry point, not a second copy of a page. */}
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 pb-0 pt-4">
            <ClientProfilePanel client={client} compact hideDescription />

            {/* One line — label, swatches, pencil — which is what keeps the
                rail inside the CD-E3 no-scroll contract it was pulled out of
                to protect. `isStaff` is deliberately NOT passed: this rail is
                mounted only for a CLIENT_USER, and the usage-percentage it
                gates is staff-internal (CD-E2). */}
            <BrandColorsSection
              guidelines={client.brandingGuidelines}
              clientId={client.id}
              hasWebsite={!!client.website}
            />

            <nav className="flex flex-col gap-0.5 border-t border-border pt-4">
              <NavLink item={tabNav[0]} pathname={pathname} />
              <ClientRailAgentsNav
                clientId={client.id}
                home={home}
                agents={agents}
                starredIds={starredAgentIds}
              />
              {tabNav.slice(1).map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </nav>
          </div>

          {/* Bottom account menu */}
          <div className="shrink-0 border-t border-border p-3">
            {/* The bell sits ON the rail, not inside the account dropdown - a
                badge only signals if it is visible without opening a menu, and
                staff get exactly that in the workspace header (QA F116). */}
            <div className="mb-2 flex items-center gap-2">
              {spendableCredits != null && (
                <Link
                  /* Deep-links the Credits section: settings opens on whichever
                     tab is first for this role otherwise, so a pill that says
                     "credits" landed people on Profile. */
                  href={`${settingsItem.href}?tab=credits`}
                  className="flex min-w-0 flex-1 items-center justify-between rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground"
                >
                  <span className="flex items-center gap-1.5">
                    <Icon name="Coins" className="h-3.5 w-3.5 text-neon" />
                    Credits
                  </span>
                  <span className="font-mono font-medium text-foreground">{spendableCredits}</span>
                </Link>
              )}
              <NotificationBell
                actionItems={actionItems}
                reviewJobs={reviewJobs}
                taskAlerts={taskAlerts}
                panelPlacement="up"
                viewerIsClient
                dismissals={dismissals}
              />
            </div>
            <AccountMenu user={user} client={client} settingsHref={settingsItem.href} />
          </div>
        </div>
      </aside>

      {/* ── Mobile top bar ──
           Branding + the credits pill only. The bell that used to sit here is
           in the Company sheet now (CD-H5): at this width the sheet is where
           every piece of account chrome lives, and the staff shell already
           works this way. The strip itself stays - it is the product's
           wordmark, not a menu (orchestrator ruling). */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
        <Link href={home} className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/kairos-head-disc-dark.svg"
            alt=""
            className="h-[26px] w-[26px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(242,241,236,0.14)]"
          />
          <span className="font-serif text-xl font-normal leading-none text-foreground">
            Karos Labs
          </span>
        </Link>
        <div className="flex items-center gap-2">
          {spendableCredits != null && (
            <Link
              href={`${settingsItem.href}?tab=credits`}
              aria-label={`${spendableCredits} credits remaining, open credits settings`}
              className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted"
            >
              <Icon name="Coins" className="h-3.5 w-3.5 text-neon" />
              <span className="font-mono font-medium text-foreground">{spendableCredits}</span>
            </Link>
          )}
        </div>
      </div>

      {/* ── Mobile bottom tab bar (last tab = Company sheet) ── */}
      <MobileTabBar
        /* The same four the desktop rail renders: one nav, two widths. */
        items={tabNav}
        companyOpen={companyOpen}
        onOpenCompany={() => setCompanyOpen(true)}
        /* CD-H5: the bell moved off the top bar into the sheet, so the tab
           carries the signal - same treatment CD-G9c gave the staff shell. */
        companyUnread={unread}
      />

      {/* ── Mobile Company sheet ── */}
      <MobileCompanySheet open={companyOpen} onClose={() => setCompanyOpen(false)}>
        <ClientProfilePanel client={client} hideDescription />

        {/* Same row the desktop rail carries, for the same reason — the sheet
            IS the rail at this width, and a swatch you cannot reach on a phone
            is a swatch that is not in the product. */}
        <BrandColorsSection
          guidelines={client.brandingGuidelines}
          clientId={client.id}
          hasWebsite={!!client.website}
        />

        {/* "AI agents" has no slot in the 3-icon bottom tab bar (Home, Calendar,
            Downloads fill it), so the roster + star toggles live here on
            mobile instead — the one-line mobile decision the SOW asked the
            build to make explicit. Documents/Competitors/Brand Colors moved
            to Account Center (Surface 06) — reached via the Account Center
            row below, same as the desktop rail. */}
        <div className="border-t border-border pt-4">
          <ClientRailAgentsNav
            clientId={client.id}
            home={home}
            agents={agents}
            starredIds={starredAgentIds}
          />
        </div>

        <div className="space-y-0.5 border-t border-border pt-4">
          {/* No Meetings row here either (AF-1): the Settings row below is the
              client's one route to it at every width, and the sheet must not
              re-open a destination the rail was just told to stop offering. */}
          {/* Explicit close: the sheet's on-navigation effect never fires when
              the link's route is already current (same-route trap - twin of the
              staff sheet's CD-G9c bounce-3). */}
          <Link
            href={settingsItem.href}
            onClick={() => setCompanyOpen(false)}
            className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Icon name="Settings" className="h-4 w-4 text-muted-2" />
            {settingsItem.label}
          </Link>
          {user.isGroupAdmin && (
            <Link
              href="/team"
              onClick={() => setCompanyOpen(false)}
              className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <Icon name="Users" className="h-4 w-4 text-muted-2" />
              Team
            </Link>
          )}
          {/* The bell's full panel, reachable at phone width now that the top
              bar no longer carries it (CD-H5). panelPlacement="up" opens it
              over the sheet body and the max-height keeps it inside the
              sheet's own scroll container instead of running off the bottom —
              the constraint the staff mount already uses.
              onNavigate is the same explicit close the Settings row above
              carries: a bell row whose destination is the route already open
              navigates nowhere, so the hook's on-navigation effect never fires
              and the sheet sits over the page looking frozen. */}
          <NotificationBell
            actionItems={actionItems}
            reviewJobs={reviewJobs}
            taskAlerts={taskAlerts}
            variant="row"
            panelPlacement="up"
            panelClassName="max-h-[45vh]"
            viewerIsClient
            dismissals={dismissals}
            onNavigate={() => setCompanyOpen(false)}
          />
          <div className="px-0">
            <ContactUsButton variant="row" userName={user.name} userEmail={user.email} />
          </div>
          <ThemeSwitch />
          {/* Sign out lives ONLY in the desktop rail's account menu, and that
              rail is display:none below md — so a client on a phone had no way
              out of their session at all. Same tail placement the staff sheet
              already uses. */}
          <LogoutButton compact />
        </div>
      </MobileCompanySheet>
    </>
  );
}
