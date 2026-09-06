"use client";

import Link from "next/link";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/**
 * ONE nav row, for the two shells that render the SAME nav (parity pass
 * 2026-09).
 *
 * The client's rail (client-rail.tsx) and the staff shell's client-context arm
 * (sidebar.tsx) offer a client the identical destinations, and the product
 * owner ruled that they must also LOOK identical — "the shell chrome must be
 * essentially the same thing the client sees". Two hand-written copies of a row
 * cannot hold that: they already drifted once on the active treatment alone
 * (V4, the orange tab a client never gets), and the radius, the padding and the
 * icon size were three more chances to drift the same way.
 *
 * So the row lives here and both shells mount it. The agency (no-context) staff
 * nav is deliberately NOT a caller — that nav is the workspace's own chrome,
 * out of scope for the parity ruling, and it keeps its `rounded-[10px]` rows.
 */
export interface RailNavItem {
  href: string;
  label: string;
  icon: string;
  /** Exact-match only — for a shell "home" whose children are separate rows. */
  exact?: boolean;
}

export function isActive(pathname: string, item: RailNavItem): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(item.href + "/");
}

export function NavLink({ item, pathname }: { item: RailNavItem; pathname: string }) {
  const active = isActive(pathname, item);
  return (
    <Link
      href={item.href}
      className={cn(
        /* `.focus-ring` (round 6): the primary navigation had NO focus style at
           all — the one place in the product where a keyboard reader cannot be
           allowed to lose their place. Applied on the base string, outside the
           active ternary, which is what client-shell-nav.test.ts reads. */
        "focus-ring group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
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
