"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { ClientProfilePanel } from "@/components/client-profile-panel";
import { ClientDocuments } from "@/components/client-documents";
import { AccountMenu } from "@/components/account-menu";
import { ThemeSwitch } from "@/components/theme-switch";
import { NotificationBell } from "@/components/notification-bell";
import { ContactUsButton } from "@/components/contact-us-modal";
import type {
  ActionItemNotification,
  AgentReviewNotification,
  AppUser,
  BrandColor,
  BrandingGuidelines,
  Client,
  ClientContextDoc,
  ClientTask,
} from "@/lib/types";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  exact?: boolean;
}

/* ── Brand color swatches ─────────────────────────────────────────────── */

function BrandColorsSection({ guidelines }: { guidelines: BrandingGuidelines | undefined }) {
  const colors: BrandColor[] = guidelines?.dominantColors?.slice(0, 4) ?? [];

  // Fall back to legacy scalar fields when dominantColors is absent.
  const effective: { hex: string; role?: string }[] =
    colors.length > 0
      ? colors
      : (
          [
            { hex: guidelines?.primaryAccent, role: "Primary" },
            { hex: guidelines?.secondaryAccent, role: "Secondary" },
            { hex: guidelines?.brandNeutralDark, role: "Neutral dark" },
            { hex: guidelines?.brandNeutralLight, role: "Neutral light" },
          ] as { hex: string | undefined; role: string }[]
        ).filter((c): c is { hex: string; role: string } => Boolean(c.hex));

  if (effective.length === 0) return null;

  return (
    <div className="border-t border-border pt-4">
      <p className="mb-2.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
        Brand Colors
      </p>
      <div className="flex items-center gap-2 px-1">
        {effective.map((color, i) => (
          <div key={i} className="group relative">
            <div
              className="h-7 w-7 rounded-full ring-1 ring-white/10 shadow-sm transition-transform group-hover:scale-110"
              style={{ backgroundColor: color.hex }}
              title={color.role ? `${color.role} · ${color.hex}` : color.hex}
            />
            {/* Hex tooltip on hover */}
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity z-10 whitespace-nowrap">
              <div className="rounded-md border border-border bg-surface-3 px-2 py-1 text-[10px] font-mono text-foreground shadow-lg">
                {color.hex}
                {color.role && (
                  <span className="ml-1 font-sans text-muted-2">· {color.role}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
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
  actionItems,
  reviewJobs,
  taskAlerts,
}: {
  user: AppUser;
  client: Client;
  contextDocs: ClientContextDoc[];
  actionItems: ActionItemNotification[];
  reviewJobs: AgentReviewNotification[];
  taskAlerts: ClientTask[];
}) {
  const pathname = usePathname();
  const home = `/clients/${client.id}`;

  const primaryNav: NavItem[] = [
    { href: home, label: "Analytics", icon: "BarChart3", exact: true },
    { href: `${home}/agents`, label: "AI Agents", icon: "Bot" },
    { href: "/assets", label: "Library", icon: "Library" },
    { href: "/tasks", label: "Progress", icon: "ListChecks" },
  ];
  const settingsItem: NavItem = { href: `${home}/settings`, label: "Settings", icon: "Settings" };

  // Mobile "Company" sheet (profile + docs + settings/support/theme). Close on navigation.
  const [companyOpen, setCompanyOpen] = useState(false);
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    if (companyOpen) setCompanyOpen(false);
  }

  return (
    <>
      {/* ── Desktop left rail (z-30 so its menus/panels sit above the center column) ── */}
      <aside className="relative z-30 hidden w-72 shrink-0 border-r border-border bg-surface/60 md:block">
        <div className="sticky top-0 flex h-screen flex-col">
          {/* Logo */}
          <div className="shrink-0 px-4 pt-4">
            <Link href={home} className="flex items-center gap-2 px-2 py-1">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-neon-soft neon-glow">
                <Icon name="Sparkles" className="h-4 w-4 text-neon" />
              </div>
              <span className="text-base font-semibold tracking-tight">
                Karos<span className="text-neon">CMO</span>
              </span>
            </Link>
          </div>

          {/* Scrollable: primary nav + profile + documents */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
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
                        ? "bg-neon-soft text-neon shadow-[inset_0_0_0_1px_rgba(45,255,158,0.15)]"
                        : "text-muted hover:bg-surface-2 hover:text-foreground",
                    )}
                  >
                    <Icon
                      name={item.icon}
                      className={cn("h-4 w-4 shrink-0", active ? "text-neon" : "text-muted-2 group-hover:text-foreground")}
                    />
                    <span className="flex-1">{item.label}</span>
                  </Link>
                );
              })}
            </nav>

            <div className="border-t border-border pt-4">
              <ClientProfilePanel client={client} />
            </div>
            <div className="border-t border-border pt-4">
              <ClientDocuments contextDocs={contextDocs} />
            </div>
            <BrandColorsSection guidelines={client.brandingGuidelines} />
          </div>

          {/* Bottom: account menu (settings · notifications · theme · support · log out) */}
          <div className="shrink-0 border-t border-border p-3">
            <AccountMenu
              user={user}
              client={client}
              settingsHref={settingsItem.href}
              actionItems={actionItems}
              reviewJobs={reviewJobs}
              taskAlerts={taskAlerts}
            />
          </div>
        </div>
      </aside>

      {/* ── Mobile top bar (logo + notifications only) ── */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
        <Link href={home} className="flex items-center gap-2">
          <Icon name="Sparkles" className="h-5 w-5 text-neon" />
          <span className="font-semibold">Karos<span className="text-neon">CMO</span></span>
        </Link>
        <NotificationBell actionItems={actionItems} reviewJobs={reviewJobs} taskAlerts={taskAlerts} />
      </div>

      {/* ── Mobile bottom tab bar (last tab = Company sheet) ── */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-surface/95 backdrop-blur-sm md:hidden">
        {primaryNav.map((item) => {
          const active = isActive(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-medium transition-colors",
                active ? "text-neon" : "text-muted-2 hover:text-foreground",
              )}
            >
              <Icon name={item.icon} className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
        <button
          onClick={() => setCompanyOpen(true)}
          className={cn(
            "flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-medium transition-colors",
            companyOpen ? "text-neon" : "text-muted-2 hover:text-foreground",
          )}
        >
          <Icon name="Building2" className="h-5 w-5" />
          Company
        </button>
      </nav>

      {/* ── Mobile Company sheet ── */}
      {companyOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-surface md:hidden">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold">Company</span>
            <button
              onClick={() => setCompanyOpen(false)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              aria-label="Close"
            >
              <Icon name="X" className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <ClientProfilePanel client={client} />
            <div className="border-t border-border pt-4">
              <ClientDocuments contextDocs={contextDocs} />
            </div>
            <BrandColorsSection guidelines={client.brandingGuidelines} />

            <div className="space-y-0.5 border-t border-border pt-4">
              <Link
                href={settingsItem.href}
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Icon name="Settings" className="h-4 w-4 text-muted-2" />
                Settings
              </Link>
              {user.isGroupAdmin && (
                <Link
                  href="/team"
                  className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                >
                  <Icon name="Users" className="h-4 w-4 text-muted-2" />
                  Team
                </Link>
              )}
              <div className="px-0">
                <ContactUsButton variant="row" />
              </div>
              <ThemeSwitch />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
