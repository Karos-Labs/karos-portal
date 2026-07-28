"use client";

import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { useActiveClient } from "@/lib/active-client-context";

/**
 * Persistent bar for CLIENT-CONTEXT mode — the staff picker that re-points the
 * workspace at one client.
 *
 * Two different features used to share the "View as" label and the eye icon:
 * real impersonation, which swaps the session and always showed a bar with a
 * labelled exit, and this one, which changes what staff SEE while they keep
 * acting as staff (full visibility, staff-only controls live, runs free).
 * Nothing on screen distinguished them, so an admin could not tell whether the
 * next click would spend the client's credits (QA F60).
 */
export function ClientContextBar() {
  const router = useRouter();
  const { activeClient, setActiveClient } = useActiveClient();

  if (!activeClient) return null;

  function exit() {
    setActiveClient(null);
    // Navigate away so ClientContextSync unmounts and cannot re-set the
    // context on refresh (same body as the sidebar picker's clear).
    router.push("/clients");
  }

  return (
    <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2">
      <div className="flex min-w-0 items-center gap-2.5 text-xs text-muted">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-info" aria-hidden="true" />
        <span className="truncate">
          Client context:{" "}
          <span className="font-medium text-foreground">{activeClient.client.name}</span>
        </span>
        <span className="hidden text-muted-2 sm:inline">·</span>
        <span className="hidden truncate text-muted-2 sm:inline">
          staff view, full visibility, runs are free
        </span>
      </div>
      <button
        onClick={exit}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-foreground/30 hover:text-foreground"
      >
        <Icon name="LogOut" className="h-3.5 w-3.5" />
        Exit client view
      </button>
    </div>
  );
}
