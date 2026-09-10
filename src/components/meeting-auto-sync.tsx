"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { syncFirefliesAction } from "@/lib/actions";

type State = "idle" | "syncing" | "done" | "error";

// Module-level cooldown: prevents re-firing on rapid navigations
let lastSyncAt = 0;
const SYNC_COOLDOWN_MS = 60_000;

export function MeetingAutoSync() {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [synced, setSynced] = useState(0);

  useEffect(() => {
    const now = Date.now();
    if (now - lastSyncAt < SYNC_COOLDOWN_MS) return;
    lastSyncAt = now;

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: show syncing state immediately before the async work starts
    setState("syncing");

    syncFirefliesAction()
      .then((res) => {
        if (cancelled) return;
        setSynced(res.synced);
        setState("done");
        if (res.synced > 0) router.refresh();
        // Fade out after 4 s
        setTimeout(() => { if (!cancelled) setState("idle"); }, 4000);
      })
      .catch(() => {
        if (!cancelled) setState("idle"); // Silent failure - manual button remains
      });

    return () => { cancelled = true; };
    // Run once on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "idle") return null;

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-opacity ${
        state === "done"
          ? "border-neon/30 bg-neon-soft/30 text-neon"
          : "border-border bg-surface-2 text-muted"
      }`}
    >
      {state === "syncing" ? (
        <>
          <Icon name="RefreshCw" className="h-3 w-3 animate-spin" />
          Syncing Fireflies…
        </>
      ) : (
        <>
          <Icon name="Check" className="h-3 w-3" />
          {synced > 0 ? `${synced} new meeting${synced !== 1 ? "s" : ""}` : "Up to date"}
        </>
      )}
    </div>
  );
}
