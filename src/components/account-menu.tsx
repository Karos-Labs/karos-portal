"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icon";
import { cn, initials } from "@/lib/utils";
import { ThemeSwitch } from "@/components/theme-switch";
import { ContactUsButton } from "@/components/contact-us-modal";
import { LogoutButton } from "@/components/logout-button";
import type { AppUser, Client } from "@/lib/types";

/**
 * Notifications deliberately do NOT live in here - the bell is rendered on the
 * rail itself so its count is ambient (QA F116). A badge behind a dropdown is
 * not a badge.
 *
 * THE IDENTITY ROW IS A LINK, NOT A MENU TRIGGER (2026-08, product owner:
 * "there should be a slightly more accessible button to get into the Account
 * Center — maybe when you click the name at the bottom").
 *
 * The whole row used to open a dropdown whose most-used entry was one more
 * click away and was labelled "Settings" — a word that names neither the
 * destination ("Account Center") nor what is in it. Every route to a client's
 * profile, competitors, reporting, documents, archive, credits and meetings
 * therefore cost two clicks and a guess.
 *
 * So the row splits: the avatar + name navigate straight to Account Center, and
 * the chevron beside them — a real button, its own hit target, its own
 * accessible name — opens the menu that holds theme, support and sign out. The
 * menu keeps an "Account Center" row too, because a person who opened it looking
 * for the destination must find it there rather than be told to close it again.
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
      {/* Identity row: name → Account Center, chevron → menu */}
      <div
        className={cn(
          "group flex w-full items-center gap-1 rounded-md pr-1 transition-colors",
          open ? "bg-surface-2" : "hover:bg-surface-2",
        )}
      >
        <Link
          href={settingsHref}
          title="Open Account Center"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon"
        >
          {avatar("h-8 w-8 text-[11px]")}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{user.name}</p>
            {/* The company line becomes the affordance's label: it already sat
                under the name, and "Account Center" says where the row goes
                without spending a second line on it. The client's own name is
                two inches up this same rail, on the brand card. */}
            <p className="truncate text-[10px] text-muted-2 transition-colors group-hover:text-muted">
              {client.name} · Account Center
            </p>
          </div>
          {/* Always drawn, never hover-revealed. It is the only thing telling a
              person this row NAVIGATES rather than opening the menu the chevron
              beside it opens — and an affordance a touch device and a keyboard
              cannot see is the defect task-board-touch-reach.test.tsx exists to
              catch. */}
          <Icon name="ChevronRight" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
        </Link>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label="Open account menu"
          aria-expanded={open}
          title="Account menu"
          className="flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon"
        >
          <Icon name="ChevronsUpDown" className="h-3.5 w-3.5" />
        </button>
      </div>

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

            {/* Actions. Account Center leads — it is what the row above goes
                to, and a menu that hides its own primary destination behind a
                theme toggle is the two-click problem again. */}
            <div className="p-1">
              <Link
                href={settingsHref}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Icon name="Settings" className="h-4 w-4 text-muted-2" />
                Account Center
              </Link>
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
