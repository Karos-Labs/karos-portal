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
import { CompetitorTrack, BrandColorsSection } from "@/components/client-context-sections";
import type { AppUser, Client, Role } from "@/lib/types";

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
  { href: "/tasks", label: "Tasks", icon: "CheckSquare", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/team", label: "Team", icon: "Users", roles: ["KAROS_ADMIN"] },
  { href: "/connect", label: "Connect", icon: "Plug", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/admin/analytics", label: "Analytics", icon: "TrendingUp", roles: ["KAROS_ADMIN"] },
];

// The 4 client-facing tabs shown to staff when in Client View mode
function clientViewNav(clientId: string): NavItem[] {
  return [
    { href: `/clients/${clientId}`, label: "Dashboard", icon: "LayoutDashboard", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"], exact: true },
    { href: `/clients/${clientId}/agents`, label: "AI Agents", icon: "Bot", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
    { href: `/clients/${clientId}/assets`, label: "Library", icon: "Library", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
    { href: "/tasks", label: "Progress", icon: "ListChecks", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  ];
}

const ROLE_LABEL: Record<Role, string> = {
  KAROS_ADMIN: "Admin",
  KAROS_EMPLOYEE: "Employee",
  CLIENT_USER: "Client",
};

/* ── View-as-Client picker ───────────────────────────────────────────── */

function ClientContextPicker({ clients }: { clients: Client[] }) {
  const router = useRouter();
  const { activeClient, setActiveClient } = useActiveClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? clients.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    : clients;

  function selectClient(client: Client) {
    setOpen(false);
    setQuery("");
    // Optimistically switch the nav immediately; ClientContextSync fills in docs/competitors on load
    setActiveClient({ client, contextDocs: [], competitors: [], isAdmin: true });
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
          {activeClient ? activeClient.client.name : "View as client"}
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
                      {logoUrl ? (
                        <Image
                          src={logoUrl!}
                          alt=""
                          width={24}
                          height={24}
                          className="h-6 w-6 shrink-0 rounded-[5px] border border-border bg-surface-2 object-contain"
                          unoptimized
                        />
                      ) : (
                        <div
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-[10px] font-semibold"
                          style={{ background: accentColor + "1f", color: accentColor }}
                        >
                          {initials(client.name)}
                        </div>
                      )}
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

function UserMenu({ user, realAdmin }: { user: AppUser; realAdmin?: AppUser }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

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
          "flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left transition-colors",
          open ? "bg-surface-2" : "hover:bg-surface-2",
        )}
      >
        {user.photoURL ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={user.photoURL}
              alt=""
              className="h-9 w-9 shrink-0 rounded-full object-cover"
            />
          </>
        ) : (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-neon">
            {initials(user.name)}
          </div>
        )}
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
          <div className="absolute bottom-full left-0 right-0 z-50 mb-1.5 overflow-hidden rounded-[12px] border border-border bg-surface shadow-xl">
            <div className="p-1">
              <Link
                href="/settings"
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-[8px] px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Icon name="Settings" className="h-4 w-4" />
                Settings
              </Link>
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
}: {
  user: AppUser;
  pendingCount?: number;
  realAdmin?: AppUser;
  clients?: Client[];
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { activeClient } = useActiveClient();

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

  // Client-context sections appended below core nav when a client is active
  const clientSections = activeClient ? (
    <div className="mt-2 space-y-4">
      {/* Client header */}
      <div className="border-t border-border pt-4">
        <div className="mb-1 flex items-center gap-2 px-1">
          {activeClient.client.logoUrl || activeClient.client.brandingGuidelines?.logoUrl ? (
            <Image
              src={(activeClient.client.logoUrl || activeClient.client.brandingGuidelines?.logoUrl)!}
              alt=""
              width={24}
              height={24}
              className="h-6 w-6 shrink-0 rounded-[5px] border border-border bg-surface-2 object-contain"
              unoptimized
            />
          ) : (
            <div
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-[10px] font-semibold"
              style={{
                background: (activeClient.client.accentColor ?? "#2dff9e") + "1f",
                color: activeClient.client.accentColor ?? "#2dff9e",
              }}
            >
              {initials(activeClient.client.name)}
            </div>
          )}
          <span className="flex-1 truncate text-sm font-semibold text-foreground">
            {activeClient.client.name}
          </span>
          <Link
            href={`/clients/${activeClient.client.id}`}
            onClick={() => setOpen(false)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
            title="Go to client dashboard"
          >
            <Icon name="ArrowUpRight" className="h-3 w-3" />
          </Link>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <ClientDocuments
          contextDocs={activeClient.contextDocs}
          isAdmin={activeClient.isAdmin}
          clientId={activeClient.client.id}
        />
      </div>

      <CompetitorTrack
        competitors={activeClient.competitors}
        clientId={activeClient.client.id}
        isStaff={true}
      />

      <BrandColorsSection
        guidelines={activeClient.client.brandingGuidelines}
        clientId={activeClient.client.id}
        hasWebsite={!!activeClient.client.website}
      />
    </div>
  ) : null;

  const content = (
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

      {/* Scrollable body: core nav + optional client sections */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {nav}
        {clientSections}
      </div>

      {/* Bottom — fixed */}
      <div className="shrink-0 space-y-2 border-t border-border px-4 py-3">
        {user.role === "KAROS_ADMIN" && (
          <ClientContextPicker clients={clients} />
        )}
        <UserMenu user={user} realAdmin={realAdmin} />
      </div>
    </div>
  );

  return (
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
          className="text-muted transition-colors hover:text-foreground"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          <Icon name={open ? "X" : "Menu"} className="h-5 w-5" />
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
            {content}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-border bg-background md:block">
        <div className="sticky top-0 h-screen">{content}</div>
      </aside>
    </>
  );
}
