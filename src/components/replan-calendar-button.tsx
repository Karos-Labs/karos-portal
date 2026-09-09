"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { reflowClientCalendarAction } from "@/lib/actions";

/**
 * Staff-only recovery control: re-runs the content-chain reflow for this
 * client. Reflow already fires after every lab import and webhook delivery -
 * this exists for the rare case where one of those best-effort calls failed
 * and no further import/webhook has healed the calendar since.
 */
export function ReplanCalendarButton({
  clientId,
  menuItem = false,
}: {
  clientId: string;
  /**
   * Render the trigger as a row in a "More actions" menu rather than as a
   * standalone header button (2026-09). Ghost over subtle: inside a popover the
   * subtle variant's own fill and border draw a second card around every row.
   */
  menuItem?: boolean;
}) {
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
    /* In a menu the note goes UNDER the row: a popover is 240px wide and the
       side-by-side arrangement squeezed "Re-planned 3 posts" and the button
       into a column each. In a header it stays beside the button, as before. */
    <div className={menuItem ? "flex w-full flex-col gap-1" : "flex items-center gap-2"}>
      {note && !menuItem && <span className="text-xs text-muted">{note}</span>}
      <Button size="sm" variant={menuItem ? "ghost" : "subtle"} onClick={replan} loading={pending}>
        <Icon name="CalendarSync" className="h-3.5 w-3.5" /> Re-plan calendar
      </Button>
      {note && menuItem && <span className="px-3 text-[11px] text-muted">{note}</span>}
    </div>
  );
}
