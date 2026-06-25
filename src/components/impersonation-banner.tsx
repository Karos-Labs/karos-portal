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
    <div className="flex items-center justify-between border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
      <div className="flex items-center gap-2 text-sm text-amber-400">
        <Icon name="Eye" className="h-4 w-4 shrink-0" />
        <span>
          Viewing as <span className="font-semibold">{viewingAs.name}</span>
          <span className="ml-1.5 text-amber-400/60 text-xs">({viewingAs.email})</span>
        </span>
        <span className="hidden text-amber-400/40 sm:inline">·</span>
        <span className="hidden text-xs text-amber-400/60 sm:inline">
          You are logged in as {realAdmin.name}
        </span>
      </div>
      <button
        onClick={exit}
        disabled={pending}
        className="flex items-center gap-1.5 rounded-[8px] border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
      >
        <Icon name="LogOut" className="h-3.5 w-3.5" />
        {pending ? "Exiting..." : "Exit impersonation"}
      </button>
    </div>
  );
}
