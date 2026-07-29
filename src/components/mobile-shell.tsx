"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { MOBILE_TAB_BAR_H } from "@/lib/constants";

/**
 * The narrow-width (<md) chrome both portal shells share: a fixed bottom tab
 * bar whose LAST tab is Company, and the full-screen sheet that tab opens.
 * There is no top menu and no hamburger at this width by contract (CD-G9a) —
 * the client shell has rendered this since the portal redesign, and the staff
 * shell adopts it whenever a client context is active.
 *
 * The two shells differ only in what they put INSIDE the sheet (the staff
 * flavour carries internal-tier documents and the staff-only competitor /
 * brand controls), so the bar and the sheet frame live here and the contents
 * stay with each shell.
 */

export interface MobileTabItem {
  href: string;
  label: string;
  icon: string;
  /** Match the path exactly — otherwise a parent tab stays lit on its children. */
  exact?: boolean;
}

function isTabActive(pathname: string, item: MobileTabItem): boolean {
  const path = item.href.split("?")[0];
  return item.exact ? pathname === path : pathname === path || pathname.startsWith(path + "/");
}

/**
 * Tailwind's `md`, as a media query. The sheet and the bar exist only below it
 * — above it both shells show a rail instead — so this is the width at which
 * the sheet stops being a thing that can be open.
 */
const MD_QUERY = "(min-width: 48rem)";

/**
 * Company-sheet open state that closes itself on navigation — tapping a link
 * inside the sheet has to reveal the page it just routed to — and on crossing
 * `md`.
 *
 * The breakpoint half is CD-H6: `md:hidden` stops PAINTING the sheet at desktop
 * width but leaves it mounted and `open`, so the sheet and any panel opened
 * inside it park their `fixed inset-0` layers over the desktop UI with no
 * on-screen control left to dismiss them, and shrinking the window back below
 * `md` re-reveals a sheet the reader never asked for. Both shells take their
 * state from this hook, so closing it here covers the client rail and the
 * staff sidebar at once.
 */
export function useCompanySheet(): [boolean, (open: boolean) => void] {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    // Mount-time sync is unnecessary: `open` starts false, so there is nothing
    // to close until someone opens it — and this listener fires the moment the
    // viewport crosses the boundary after that.
    const mq = window.matchMedia(MD_QUERY);
    const closeAboveMd = () => {
      if (mq.matches) setOpen(false);
    };
    mq.addEventListener("change", closeAboveMd);
    return () => mq.removeEventListener("change", closeAboveMd);
  }, []);

  return [open, setOpen];
}

export function MobileTabBar({
  items,
  companyOpen,
  onOpenCompany,
  companyUnread = 0,
}: {
  items: MobileTabItem[];
  companyOpen: boolean;
  onOpenCompany: () => void;
  /**
   * Unread notifications reachable only from inside the sheet. The staff shell
   * moved its bell in there (CD-G9c), so the tab carries a dot to keep the
   * signal alive; the client shell keeps its bell on screen and passes 0.
   */
  companyUnread?: number;
}) {
  const pathname = usePathname();

  return (
    <nav
      /* Height comes from lib/constants (MOBILE_TAB_BAR_H) — the copilot dock
         offsets its collapsed strip off the same number (CD-G9b). */
      className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-background/95 backdrop-blur-sm md:hidden"
      style={{ height: MOBILE_TAB_BAR_H }}
    >
      {items.map((item) => {
        const active = isTabActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 text-[10px] font-medium leading-none transition-colors",
              active ? "text-neon" : "text-muted-2 hover:text-foreground",
            )}
          >
            <Icon name={item.icon} className="h-5 w-5" />
            {item.label}
          </Link>
        );
      })}
      <button
        onClick={onOpenCompany}
        className={cn(
          "relative flex flex-1 flex-col items-center justify-center gap-1 text-[10px] font-medium leading-none transition-colors",
          companyOpen ? "text-neon" : "text-muted-2 hover:text-foreground",
        )}
      >
        <span className="relative">
          <Icon name="Building2" className="h-5 w-5" />
          {companyUnread > 0 && (
            <span
              className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-neon ring-2 ring-background"
              aria-hidden="true"
            />
          )}
        </span>
        Company
        {companyUnread > 0 && <span className="sr-only">{companyUnread} unread notifications</span>}
      </button>
    </nav>
  );
}

export function MobileCompanySheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface md:hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-semibold">Company</span>
        <button
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label="Close"
        >
          <Icon name="X" className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
    </div>
  );
}
