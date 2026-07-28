"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { MobileCompanySheet, MobileTabBar, useCompanySheet } from "@/components/mobile-shell";
import { ClientProfilePanel } from "@/components/client-profile-panel";
import { ClientDocuments } from "@/components/client-documents";
import { clientIntelSchedule } from "@/lib/intel-schedule";
import { AccountMenu } from "@/components/account-menu";
import { ThemeSwitch } from "@/components/theme-switch";
import { NotificationBell } from "@/components/notification-bell";
import { ContactUsButton } from "@/components/contact-us-modal";
import { CompetitorTrack, BrandColorsSection } from "@/components/client-context-sections";
import { isAiProcessingLockActive } from "@/lib/constants";
import { hasAiProcessingFailure } from "@/lib/client-visibility";
import type {
  ActionItemNotification,
  AgentReviewNotification,
  AppUser,
  Client,
  ClientCompetitor,
  ClientContextDoc,
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

export function ClientRail({
  user,
  client,
  contextDocs,
  competitors,
  isAdmin,
  actionItems,
  reviewJobs,
  taskAlerts,
  spendableCredits,
  correctionPricing,
}: {
  user: AppUser;
  client: Client;
  contextDocs: ClientContextDoc[];
  competitors: ClientCompetitor[];
  isAdmin: boolean;
  actionItems: ActionItemNotification[];
  reviewJobs: AgentReviewNotification[];
  taskAlerts: ClientTask[];
  /**
   * Credits the client can actually SPEND right now — availableCredits(), i.e.
   * the balance clipped by the weekly/monthly caps, not the raw stored balance.
   * The pill is labelled "remaining", so it must be the number the charge
   * transaction would honour. Shown as a pill linking to settings; hidden when null.
   */
  spendableCredits?: number | null;
  /**
   * Price of a targeted document correction, for the Correct Info modal the
   * rail's document panel opens. Resolved server-side and present ONLY for a
   * billable client viewer, so staff never see a charge they don't incur;
   * `blockReason` is the server's own refusal line when the cost won't fit.
   */
  correctionPricing?: { cost: number; blockReason?: string };
}) {
  const pathname = usePathname();
  const home = `/clients/${client.id}`;
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";

  // The Library merged into the Workspace's Archive tab (2026-07) — one page
  // for board + activity + everything the agents delivered.
  const primaryNav: NavItem[] = [
    { href: home, label: "Dashboard", icon: "LayoutDashboard", exact: true },
    { href: `${home}/agents`, label: "AI Agents", icon: "Bot" },
    { href: "/calendar", label: "Calendar", icon: "CalendarClock" },
    { href: "/tasks", label: "Workspace", icon: "ListChecks" },
  ];
  const settingsItem: NavItem = { href: `${home}/settings`, label: "Settings", icon: "Settings" };

  // Bar + sheet frame are shared with the staff shell's client-context mode —
  // see components/mobile-shell.tsx (CD-G9a). The hook closes the sheet on
  // navigation.
  const [companyOpen, setCompanyOpen] = useCompanySheet();

  // The same three feeds the bell counts, so the Company tab's dot and the
  // badge inside the sheet can never disagree (CD-H5).
  const unread = actionItems.length + reviewJobs.length + taskAlerts.length;

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

          {/* Body. NOT a scroll container by contract (CD-E3): nav + company
              chip + Documents + Competitor Track + Brand Colors + footer must
              fit the viewport at common laptop heights. The content set is
              bounded (4 tabs, ≤6 documents, ≤5 tracked competitors, ≤4
              swatches), so the compacted stack fits; overflow-y-auto remains
              the safety valve for genuinely short windows rather than clipping
              a whole section away. */}
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-4 pb-0 pt-4">
            <nav className="flex flex-col gap-0.5">
              {primaryNav.map((item) => {
                const active = isActive(pathname, item);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-surface-2 text-foreground"
                        : "text-muted hover:bg-surface-2 hover:text-foreground",
                    )}
                  >
                    <Icon
                      name={item.icon}
                      className={cn(
                        "h-4 w-4 shrink-0",
                        active ? "text-foreground" : "text-muted-2 group-hover:text-foreground",
                      )}
                    />
                    <span className="flex-1">{item.label}</span>
                  </Link>
                );
              })}
            </nav>

            <div className="mt-4 border-t border-border pt-4">
              <ClientProfilePanel client={client} />
            </div>

            <div className="mt-4 border-t border-border pt-4">
              <ClientDocuments
                contextDocs={contextDocs}
                isAdmin={isAdmin}
                clientId={client.id}
                isAiProcessing={isAiProcessingLockActive(client)}
                aiProcessingFailed={hasAiProcessingFailure(client)}
                intelSchedule={clientIntelSchedule(client)}
                correctionPricing={correctionPricing}
              />
            </div>

            <CompetitorTrack
              competitors={competitors}
              clientId={client.id}
              isStaff={isStaff}
            />

            <BrandColorsSection
              guidelines={client.brandingGuidelines}
              clientId={client.id}
              hasWebsite={!!client.website}
            />
          </div>

          {/* Bottom account menu */}
          <div className="shrink-0 border-t border-border p-3">
            {/* The bell sits ON the rail, not inside the account dropdown — a
                badge only signals if it is visible without opening a menu, and
                staff get exactly that in the workspace header (QA F116). */}
            <div className="mb-2 flex items-center gap-2">
              {spendableCredits != null && (
                <Link
                  href={settingsItem.href}
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
           works this way. The strip itself stays — it is the product's
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
              href={settingsItem.href}
              aria-label={`${spendableCredits} credits remaining, open settings`}
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
        items={primaryNav}
        companyOpen={companyOpen}
        onOpenCompany={() => setCompanyOpen(true)}
        /* CD-H5: the bell moved off the top bar into the sheet, so the tab
           carries the signal — same treatment CD-G9c gave the staff shell. */
        companyUnread={unread}
      />

      {/* ── Mobile Company sheet ── */}
      <MobileCompanySheet open={companyOpen} onClose={() => setCompanyOpen(false)}>
        <ClientProfilePanel client={client} />

        <div className="border-t border-border pt-4">
          <ClientDocuments
            contextDocs={contextDocs}
            isAdmin={isAdmin}
            clientId={client.id}
            isAiProcessing={isAiProcessingLockActive(client)}
            aiProcessingFailed={hasAiProcessingFailure(client)}
            intelSchedule={clientIntelSchedule(client)}
            correctionPricing={correctionPricing}
          />
        </div>

        <CompetitorTrack competitors={competitors} clientId={client.id} isStaff={isStaff} />

        <BrandColorsSection
          guidelines={client.brandingGuidelines}
          clientId={client.id}
          hasWebsite={!!client.website}
        />

        <div className="space-y-0.5 border-t border-border pt-4">
          {/* Explicit close: the sheet's on-navigation effect never fires when
              the link's route is already current (same-route trap — twin of the
              staff sheet's CD-G9c bounce-3). */}
          <Link
            href={settingsItem.href}
            onClick={() => setCompanyOpen(false)}
            className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Icon name="Settings" className="h-4 w-4 text-muted-2" />
            Settings
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
              the constraint the staff mount already uses. */}
          <NotificationBell
            actionItems={actionItems}
            reviewJobs={reviewJobs}
            taskAlerts={taskAlerts}
            variant="row"
            panelPlacement="up"
            panelClassName="max-h-[45vh]"
            viewerIsClient
          />
          <div className="px-0">
            <ContactUsButton variant="row" userName={user.name} userEmail={user.email} />
          </div>
          <ThemeSwitch />
        </div>
      </MobileCompanySheet>
    </>
  );
}
