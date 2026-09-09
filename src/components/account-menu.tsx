"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icon";
import { cn, initials } from "@/lib/utils";
import { ThemeSwitch } from "@/components/theme-switch";
import { ContactUsButton } from "@/components/contact-us-modal";
import { LogoutButton } from "@/components/logout-button";
import { useMenuDismiss } from "@/components/use-menu-dismiss";
import type { AppUser, Client } from "@/lib/types";

/**
 * Notifications deliberately do NOT live in here - the bell is rendered on the
 * rail itself so its count is ambient (QA F116). A badge behind a dropdown is
 * not a badge.
 *
 * THE IDENTITY ROW IS THE MENU TRIGGER, AND THE ONLY CONTROL ON IT — a
 * REVERSAL of the split this note used to argue for (portal feedback round 2,
 * 2026-09: "this button is confusing, should be only one").
 *
 * The split was: avatar + name navigated straight to Account Center, and a
 * chevron beside them opened the menu. It was aimed at a real complaint — the
 * destination used to be two clicks and a guess away — but it answered it with
 * two adjacent targets that look like one row and do different things, and
 * neither of them announces which half a click will land on. A person reading
 * the row cannot tell it apart from every other "click your name" menu in every
 * other app, so the chevron reads as decoration and the navigation reads as an
 * accident.
 *
 * So: ONE control. The whole row is a `<button>` with `aria-expanded`, and the
 * cost that motivated the split is paid inside the menu instead — "Account
 * Center" is its FIRST row, so the destination is one click from the row it was
 * one click from before. The sub-line still names it, because the menu's first
 * row is the promise that line is making.
 */
export function AccountMenu({
  user,
  client,
  settingsHref,
  staffExtras,
}: {
  user: AppUser;
  /**
   * Only the display name is read, so this is a `Pick` rather than a `Client`:
   * the staff shell's client-context arm mounts this same menu (parity pass
   * 2026-09, ruling D9) and holds a `StaffShellClientView`, which is a
   * projection and not a whole document. Widening this back to `Client` is what
   * would force that shell to re-ship the join token to satisfy a type.
   */
  client: Pick<Client, "name">;
  settingsHref: string;
  /**
   * ADDITIVE staff-only rows, rendered as their own bordered group under a
   * "STAFF" caption inside the dropdown (parity pass 2026-09, ruling D10).
   *
   * The ruling is that a staff member in client context sees the CLIENT'S
   * chrome — so the extras a client has no equivalent of ("Your settings",
   * "Exit client view") cannot be mixed in among the rows the client also has,
   * or the two shells stop being the same shell. They get a fenced, labelled
   * group instead: clearly present, clearly internal, and absent entirely for
   * the client's own mount, which passes nothing.
   */
  staffExtras?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useMenuDismiss(open, setOpen);

  // Close the menu when navigation completes (instead of on click), so a <Link>
  // isn't unmounted mid-click - which would cancel the navigation.
  const pathname = usePathname();
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    if (open) setOpen(false);
  }

  const avatar = (size: string) =>
    user.photoURL ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={user.photoURL} alt="" className={cn("shrink-0 rounded-full object-cover", size)} />
    ) : (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-foreground",
          size,
        )}
      >
        {initials(user.name)}
      </div>
    );

  return (
    <div className="relative">
      {/* Identity row — ONE control, the whole row, opening the menu. */}
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        /* NAMES THE PERSON (review wave, 2026-09). An aria-label replaces the
           button's contents outright, so "Open account menu" was the WHOLE
           accessible name — the two lines a sighted reader uses to tell whose
           account and whose workspace this is were announced as nothing. */
        aria-label={`Open account menu for ${user.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Account menu"
        className={cn(
          "group flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon",
          open ? "bg-surface-2" : "hover:bg-surface-2",
        )}
      >
        {avatar("h-8 w-8 text-[11px]")}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{user.name}</p>
          {/* Still names Account Center, and now it is a description of the
              menu's first row rather than of where the row itself goes. The
              client's own name is two inches up this same rail, on the brand
              card. */}
          <p className="truncate text-[10px] text-muted-2 transition-colors group-hover:text-muted">
            {client.name} · Account Center
          </p>
        </div>
        {/* The row's only glyph, and it says "menu" — always drawn, never
            hover-revealed, because an affordance a touch device and a keyboard
            cannot see is the defect task-board-touch-reach.test.tsx exists to
            catch. */}
        <Icon name="ChevronsUpDown" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 right-0 z-50 mb-2 rounded-lg border border-border bg-surface shadow-2xl">
            {/* Identity header */}
            <div className="flex items-center gap-3 border-b border-border p-3">
              {avatar("h-10 w-10 text-sm")}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{user.name}</p>
                <p className="truncate text-[11px] text-muted-2">{user.email}</p>
              </div>
            </div>

            {/* Actions. Account Center leads, and now it is the ONLY route to
                the destination the row above names — a menu that buried it
                behind a theme toggle would put back exactly the two-clicks-and-
                a-guess this row was split apart to fix (and un-split, portal
                feedback round 2, 2026-09). It stays first. */}
            <div className="p-1">
              <Link
                href={settingsHref}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Icon name="Settings" className="h-4 w-4 text-muted-2" />
                Account Center
              </Link>
              {/* TEAM — the same conditional row the mobile Company sheet has
                  carried all along (client-rail.tsx), now at desktop width too
                  (flow audit 2026-09, R11 · F14 · NN/g *Left-Side Vertical
                  Navigation*: do not hide a desktop destination behind a
                  narrow-width menu). `/team` was linked from ONE place in the
                  entire client portal, and that place is `md:hidden`, so a group
                  admin on a laptop could not reach the page they are the admin
                  of at all.
                  The predicate is the viewer's, not the shell's — `isGroupAdmin`
                  is exactly what /team's own guard checks — so the client rail
                  and the staff shell's client-context arm, which both mount this
                  menu, cannot end up offering different rows to one person
                  (parity pass 2026-09). It is not a "staff extra": a group admin
                  is a client. */}
              {user.isGroupAdmin && (
                <Link
                  href="/team"
                  className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                >
                  <Icon name="Users" className="h-4 w-4 text-muted-2" />
                  Team
                </Link>
              )}
              <ThemeSwitch />
              <ContactUsButton variant="row" userName={user.name} userEmail={user.email} />
            </div>

            {/* Staff extras — fenced and captioned, never interleaved. */}
            {staffExtras && (
              <div className="border-t border-border p-1">
                <p className="px-3 pb-1 pt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-2">
                  Staff
                </p>
                {staffExtras}
              </div>
            )}

            {/* Log out */}
            <div className="border-t border-border p-1">
              <LogoutButton compact />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
