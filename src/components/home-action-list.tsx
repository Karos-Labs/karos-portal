"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { dismissActionAction, markActionNotRelevantAction } from "@/lib/actions";
import type { ClientResolvedAction, ResolvedActionStatus } from "@/lib/action-list";

/**
 * Home's "Next actions" widget (portal revamp, Surface 08) — the real
 * 15-item engine, replacing Task 5's stateless shell. `resolved` arrives
 * already computed server-side (lib/action-list.ts's `resolveActionList`):
 * live signals decide most of the 15, `ClientActionState` decides the rest.
 * This component only narrates that answer and fires the two client-chosen
 * states — it holds no completion logic of its own.
 *
 * `overrides` makes Dismiss / "Not relevant for me" feel instant: the row's
 * displayed status flips the moment a button is pressed, while the matching
 * server action runs in the background and `revalidatePath` catches the
 * server state up next time this page loads.
 */
export function ActionListWidget({
  clientId,
  resolved,
}: {
  clientId: string;
  resolved: ClientResolvedAction[];
}) {
  const [, startTransition] = useTransition();
  const [overrides, setOverrides] = useState<Record<string, ResolvedActionStatus>>({});
  const [expanded, setExpanded] = useState(false);

  const withOverrides = resolved.map((a) => ({ ...a, status: overrides[a.id] ?? a.status }));
  // "Not relevant for me" is the one permanent skip in the portal — it drops
  // out of the list entirely, never just greys out like a done or snoozed row.
  const visible = withOverrides.filter((a) => a.status !== "not_relevant");
  const eligible = visible.filter((a) => a.status === "eligible");
  const shown = expanded ? visible : eligible.slice(0, 3);

  function act(
    actionId: string,
    status: ResolvedActionStatus,
    fn: (clientId: string, actionId: string) => Promise<unknown>,
  ) {
    setOverrides((prev) => ({ ...prev, [actionId]: status }));
    startTransition(() => {
      void fn(clientId, actionId);
    });
  }

  if (eligible.length === 0 && !expanded) return null;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <CardTitle className="min-w-0 truncate">Next actions</CardTitle>
        {visible.length > 3 && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2 transition-colors hover:text-foreground"
          >
            {expanded ? "Show less" : `See all ${visible.length}`}
          </button>
        )}
      </div>
      <ul className="space-y-2">
        {shown.map((a) => {
          const done = a.status === "done";
          const snoozed = a.status === "dismissed";
          return (
            <li key={a.id} className="group/row relative">
              <Link
                href={a.href}
                className={cn(
                  "flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5 pr-8 transition-colors hover:border-border-strong",
                  (done || snoozed) && "opacity-60",
                )}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3">
                  <Icon name={done ? "Check" : a.icon} className="h-3.5 w-3.5 text-muted-2" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {a.label}
                </span>
                {snoozed && <span className="shrink-0 text-[10px] text-muted-2">Snoozed</span>}
                <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" />
              </Link>
              {a.status === "eligible" && (
                // Reachable without a pointer: these dismiss/snooze the row, and a
                // hover-only reveal hides them entirely on touch and for keyboard
                // nav (#89's shape — same fallback as client-context-sections.tsx's
                // "Stop tracking" button and clients-grid.tsx).
                <div className="absolute right-9 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100">
                  <button
                    type="button"
                    title="Dismiss for now"
                    onClick={() => act(a.id, "dismissed", dismissActionAction)}
                    className="rounded p-1 text-muted-2 hover:bg-surface-3 hover:text-foreground"
                  >
                    <Icon name="Clock" className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Not relevant for me"
                    onClick={() => act(a.id, "not_relevant", markActionNotRelevantAction)}
                    className="rounded p-1 text-muted-2 hover:bg-surface-3 hover:text-foreground"
                  >
                    <Icon name="X" className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
