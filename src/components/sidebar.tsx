"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icon";
import { LogoutButton } from "@/components/logout-button";
import { initials, cn } from "@/lib/utils";
import type { AppUser, Role } from "@/lib/types";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  roles: Role[];
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard", roles: ["admin", "employee", "client"] },
  { href: "/clients", label: "Clients", icon: "Building2", roles: ["admin", "employee"] },
  { href: "/agents", label: "Agents", icon: "Bot", roles: ["admin", "employee"] },
  { href: "/jobs", label: "Jobs", icon: "ListChecks", roles: ["admin", "employee"] },
  { href: "/transcripts", label: "Meetings", icon: "Mic", roles: ["admin", "employee", "client"] },
  { href: "/assets", label: "Assets", icon: "FolderOpen", roles: ["admin", "employee", "client"] },
  { href: "/team", label: "Team", icon: "Users", roles: ["admin"] },
  { href: "/connect", label: "Connect", icon: "Plug", roles: ["admin", "employee"] },
];

const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  employee: "Employee",
  client: "Client",
};

export function Sidebar({ user }: { user: AppUser }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => n.roles.includes(user.role));

  const nav = (
    <nav className="flex flex-1 flex-col gap-1">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={cn(
              "group flex items-center gap-3 rounded-[10px] px-3 py-2 text-sm transition-colors",
              active
                ? "bg-neon-soft text-neon"
                : "text-muted hover:bg-surface-2 hover:text-foreground",
            )}
          >
            <Icon
              name={item.icon}
              className={cn("h-4 w-4", active ? "text-neon" : "text-muted-2 group-hover:text-foreground")}
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  const content = (
    <div className="flex h-full flex-col gap-4 p-4">
      <Link href="/dashboard" className="flex items-center gap-2 px-2 py-1">
        <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neon-soft">
          <Icon name="Sparkles" className="h-4 w-4 text-neon" />
        </div>
        <span className="text-base font-semibold tracking-tight">
          Karos<span className="text-neon">CMO</span>
        </span>
      </Link>

      {nav}

      <div className="mt-auto space-y-2 border-t border-border pt-3">
        <div className="flex items-center gap-3 px-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-neon">
            {initials(user.name)}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-[11px] text-muted-2">{ROLE_LABEL[user.role]}</p>
          </div>
        </div>
        <LogoutButton compact />
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
