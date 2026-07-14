"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icon";
import { updateAutoScheduleAction } from "@/lib/actions";

export default function AutoScheduleToggle({ clientId, enabled }: { clientId: string; enabled?: boolean }) {
  const [isOn, setIsOn] = useState(!!enabled);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle() {
    const next = !isOn;
    setIsOn(next);
    setError(null);
    startTransition(async () => {
      const res = await updateAutoScheduleAction(clientId, next);
      if (!res.ok) {
        setIsOn(!next);
        setError(res.error ?? "Could not update auto-schedule setting");
      }
    });
  }

  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-4 py-3">
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
          isOn ? "bg-success/10 text-success" : "bg-surface-3 text-muted",
        )}
      >
        <Icon name="Calendar" className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground">Auto-schedule approved content</p>
        <p className="text-xs text-muted truncate">
          {isOn
            ? "Approved assets will be auto-scheduled when a compatible integration exists"
            : "Approved assets will be placed on the calendar as manual entries"}
        </p>
        {error && <p className="mt-0.5 text-xs text-danger">{error}</p>}
      </div>
      <button
        onClick={toggle}
        disabled={isPending}
        aria-checked={isOn}
        role="switch"
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25 disabled:opacity-50",
          isOn ? "bg-success" : "bg-surface-3",
        )}
      >
        <span
          className={cn(
            "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-primary shadow-md transition-transform duration-200",
            isOn ? "translate-x-5" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}
