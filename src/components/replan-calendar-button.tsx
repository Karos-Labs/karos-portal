"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { reflowClientCalendarAction } from "@/lib/actions";

/**
 * Staff-only recovery control: re-runs the content-chain reflow for this
 * client. Reflow already fires after every lab import and webhook delivery —
 * this exists for the rare case where one of those best-effort calls failed
 * and no further import/webhook has healed the calendar since.
 */
export function ReplanCalendarButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  function replan() {
    setNote(null);
    startTransition(async () => {
      const res = await reflowClientCalendarAction(clientId);
      if (res.error) {
        setNote(res.error);
        return;
      }
      setNote(
        res.changed === 0 ? "Calendar already in order" : `Re-planned ${res.changed} post${res.changed === 1 ? "" : "s"}`,
      );
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {note && <span className="text-xs text-muted">{note}</span>}
      <Button size="sm" variant="subtle" onClick={replan} loading={pending}>
        <Icon name="CalendarSync" className="h-3.5 w-3.5" /> Re-plan calendar
      </Button>
    </div>
  );
}
