"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { Icon } from "@/components/icon";
import { cn, initials } from "@/lib/utils";
import { startImpersonationAction } from "@/lib/actions";
import type { AppUser, Client, Role } from "@/lib/types";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  roles: Role[];
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/clients", label: "Clients", icon: "Building2", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/agents", label: "Agents", icon: "Bot", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/jobs", label: "Jobs", icon: "ListChecks", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/transcripts", label: "Meetings", icon: "Mic", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/assets", label: "Assets", icon: "FolderOpen", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/tasks", label: "Tasks", icon: "CheckSquare", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"] },
  { href: "/registrations", label: "Registrations", icon: "UserCheck", roles: ["KAROS_ADMIN"] },
  { href: "/team", label: "Team", icon: "Users", roles: ["KAROS_ADMIN"] },
  { href: "/connect", label: "Connect", icon: "Plug", roles: ["KAROS_ADMIN", "KAROS_EMPLOYEE"] },
  { href: "/admin/analytics", label: "Analytics", icon: "TrendingUp", roles: ["KAROS_ADMIN"] },
];

const ROLE_LABEL: Record<Role, string> = {
  KAROS_ADMIN: "Admin",
  KAROS_EMPLOYEE: "Employee",
  CLIENT_USER: "Client",
};

function ImpersonatePicker({
  clients,
  clientUsers,
}: {
  clients: Client[];
  clientUsers: AppUser[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();

  function impersonate(uid: string) {
    setOpen(false);
    startTransition(async () => {
      await startImpersonationAction(uid);
    });
  }

  const grouped = clients
    .map((c) => ({
      client: c,
      users: clientUsers.filter((u) => u.clientId === c.id),
    }))
    .filter((g) => g.users.length > 0);

  const filtered = query.trim()
    ? grouped
        .map((g) => ({
          ...g,
          users: g.users.filter(
            (u) =>
              u.name.toLowerCase().includes(query.toLowerCase()) ||
              u.email.toLowerCase().includes(query.toLowerCase()),
          ),
        }))
        .filter((g) => g.users.length > 0)
    : grouped;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={pending}
        className={cn(
          "flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-sm transition-colors disabled:opacity-50",
          open
            ? "bg-surface-2 text-foreground"
            : "text-muted hover:bg-surface-2 hover:text-foreground",
        )}
      >
        <Icon name="Eye" className="h-4 w-4 shrink-0 text-muted-2" />
        <span className="flex-1 text-left">{pending ? "Loading..." : "View as client"}</span>
        <Icon
          name="ChevronDown"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-2 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-50 mb-1.5 w-72 overflow-hidden rounded-[12px] border border-border bg-surface shadow-xl">
            <div className="border-b border-border p-2">
              <input
                type="text"
                placeholder="Search users..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-[8px] bg-surface-2 px-3 py-1.5 text-xs outline-none placeholder:text-muted-2"
                autoFocus
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-muted-2">No client users found</p>
              ) : (
                filtered.map(({ client, users }) => (
                  <div key={client.id}>
                    <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                      {client.name}
                    </p>
                    {users.map((u) => (
                      <button
                        key={u.uid}
                        onClick={() => impersonate(u.uid)}
                        className="flex w-full flex-col rounded-[8px] px-3 py-2 text-left hover:bg-surface-2"
                      >
                        <span className="text-sm font-medium text-foreground">{u.name}</span>
                        <span className="text-[11px] text-muted-2">{u.email}</span>
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function UserMenu({
  user,
  realAdmin,
}: {
  user: AppUser;
  realAdmin?: AppUser;
}) {
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
          <img
            src={user.photoURL}
            alt=""
            className="h-9 w-9 shrink-0 rounded-full object-cover"
          />
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

export function Sidebar({
  user,
  pendingCount = 0,
  realAdmin,
  clientUsers = [],
  clients = [],
}: {
  user: AppUser;
  pendingCount?: number;
  realAdmin?: AppUser;
  clientUsers?: AppUser[];
  clients?: Client[];
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const clientHomePath = user.role === "CLIENT_USER" && user.clientId ? `/clients/${user.clientId}` : null;

  const items = NAV.filter((n) => {
    if (n.roles.includes(user.role)) return true;
    // Team is also visible for isGroupAdmin CLIENT_USER accounts
    if (n.href === "/team" && user.role === "CLIENT_USER" && user.isGroupAdmin) return true;
    return false;
  }).map((n) => {
    // Point the Dashboard link directly at the client's own page
    if (n.href === "/dashboard" && clientHomePath) return { ...n, href: clientHomePath };
    return n;
  });

  const nav = (
    <nav className="flex flex-1 flex-col gap-1">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        const badge = item.href === "/registrations" && pendingCount > 0 ? pendingCount : null;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={cn(
              "group flex items-center gap-3 rounded-[10px] px-3 py-2 text-sm transition-all duration-150 active:scale-[0.97]",
              active
                ? "bg-neon-soft text-neon shadow-[inset_0_0_0_1px_rgba(45,255,158,0.15)]"
                : "text-muted hover:bg-surface-2 hover:text-foreground",
            )}
          >
            <Icon
              name={item.icon}
              className={cn("h-4 w-4", active ? "text-neon" : "text-muted-2 group-hover:text-foreground")}
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

  const content = (
    <div className="flex h-full flex-col gap-4 p-4">
      <Link href="/dashboard" className="flex items-center gap-2 px-2 py-1">
        <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neon-soft neon-glow">
          <Icon name="Sparkles" className="h-4 w-4 text-neon" />
        </div>
        <span className="text-base font-semibold tracking-tight">
          Karos<span className="text-neon">CMO</span>
        </span>
      </Link>

      {nav}

      <div className="mt-auto space-y-2 border-t border-border pt-3">
        {user.role === "KAROS_ADMIN" && (
          <ImpersonatePicker clients={clients} clientUsers={clientUsers} />
        )}

        <UserMenu user={user} realAdmin={realAdmin} />
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
        <Link href="/dashboard" className="flex items-center gap-2">
          <Icon name="Sparkles" className="h-5 w-5 text-neon" />
          <span className="font-semibold">Karos<span className="text-neon">CMO</span></span>
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
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-64 overflow-y-auto border-r border-border bg-surface">{content}</div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface/60 md:block">
        <div className="sticky top-0 h-screen">{content}</div>
      </aside>
    </>
  );
}
