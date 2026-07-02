"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icon";
import { cn, initials } from "@/lib/utils";
import { ThemeSwitch } from "@/components/theme-switch";
import { NotificationBell } from "@/components/notification-bell";
import { ContactUsButton } from "@/components/contact-us-modal";
import { LogoutButton } from "@/components/logout-button";
import type {
  ActionItemNotification,
  AgentReviewNotification,
  AppUser,
  Client,
  ClientTask,
} from "@/lib/types";

export function AccountMenu({
  user,
  client,
  settingsHref,
  actionItems,
  reviewJobs,
  taskAlerts,
}: {
  user: AppUser;
  client: Client;
  settingsHref: string;
  actionItems: ActionItemNotification[];
  reviewJobs: AgentReviewNotification[];
  taskAlerts: ClientTask[];
}) {
  const [open, setOpen] = useState(false);

  // Close the menu when navigation completes (instead of on click), so a <Link>
  // isn't unmounted mid-click — which would cancel the navigation.
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
      {/* Profile trigger */}
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
          open ? "bg-surface-2" : "hover:bg-surface-2",
        )}
      >
        {avatar("h-8 w-8 text-[11px]")}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{user.name}</p>
          <p className="truncate text-[10px] text-muted-2">{client.name}</p>
        </div>
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

            {/* Actions */}
            <div className="p-1">
              <ThemeSwitch />
              <NotificationBell
                variant="row"
                panelPlacement="right"
                actionItems={actionItems}
                reviewJobs={reviewJobs}
                taskAlerts={taskAlerts}
              />
              <Link
                href={settingsHref}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Icon name="Settings" className="h-4 w-4 text-muted-2" />
                Settings
              </Link>
              <ContactUsButton variant="row" />
            </div>

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
