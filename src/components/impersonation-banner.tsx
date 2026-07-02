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

  return (
    <div className="flex items-center justify-between border-b border-warning/30 bg-warning/10 px-4 py-2.5">
      <div className="flex items-center gap-2 text-sm text-warning">
        <Icon name="Eye" className="h-4 w-4 shrink-0" />
        <span>
          Viewing as <span className="font-semibold">{viewingAs.name}</span>
          <span className="ml-1.5 text-warning/70 text-xs">({viewingAs.email})</span>
        </span>
        <span className="hidden text-warning/40 sm:inline">·</span>
        <span className="hidden text-xs text-warning/70 sm:inline">
          You are logged in as {realAdmin.name}
        </span>
      </div>
      <button
        onClick={exit}
        disabled={pending}
        className="flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-1 text-xs font-medium text-warning transition-colors hover:bg-warning/20 disabled:opacity-50"
      >
        <Icon name="LogOut" className="h-3.5 w-3.5" />
        {pending ? "Exiting..." : "Exit impersonation"}
      </button>
    </div>
  );
}
