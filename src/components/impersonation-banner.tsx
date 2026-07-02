"use client";

import { useTransition } from "react";
import { Icon } from "@/components/icon";
import { stopImpersonationAction } from "@/lib/actions";
import type { AppUser } from "@/lib/types";

export function ImpersonationBanner({
  realAdmin,
  viewingAs,
}: {
  realAdmin: AppUser;
  viewingAs: AppUser;
}) {
  const [pending, startTransition] = useTransition();

  function exit() {
    startTransition(async () => {
      await stopImpersonationAction();
    });
  }

  /* Quiet alert: neutral bar on the ground tone, one amber dot carries the
     "you are impersonating" signal. */
  return (
    <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2">
      <div className="flex min-w-0 items-center gap-2.5 text-xs text-muted">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
        <span className="truncate">
          Viewing as <span className="font-medium text-foreground">{viewingAs.name}</span>
          <span className="ml-1.5 text-muted-2">({viewingAs.email})</span>
        </span>
        <span className="hidden text-muted-2 sm:inline">·</span>
        <span className="hidden truncate text-muted-2 sm:inline">
          Logged in as {realAdmin.name}
        </span>
      </div>
      <button
        onClick={exit}
        disabled={pending}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
      >
        <Icon name="LogOut" className="h-3.5 w-3.5" />
        {pending ? "Exiting..." : "Exit impersonation"}
      </button>
    </div>
  );
}
