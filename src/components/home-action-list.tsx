"use client";

import { useState, useTransition } from "react";
import { Card, CardTitle } from "@/components/ui";
import { HomeTaskRow } from "@/components/home-task-row";
import { markActionNotRelevantAction } from "@/lib/actions";
import type { ClientResolvedAction, ResolvedActionStatus } from "@/lib/action-list";

/**
 * Home's "Next actions" widget (portal revamp, Surface 08) — the real
 * 15-item engine, replacing Task 5's stateless shell. `resolved` arrives
 * already computed server-side (lib/action-list.ts's `resolveActionList`):
 * live signals decide most of the 15, `ClientActionState` decides the rest.
 * This component only narrates that answer and fires the one client-chosen
 * state — it holds no completion logic of its own.
 *
 * `overrides` makes "Not relevant for me" feel instant: the row's displayed
 * status flips the moment the X is pressed, while the matching server action
 * runs in the background and `revalidatePath` catches the server state up next
 * time this page loads.
 *
 * PORTAL FEEDBACK ROUND 2, 2026-09 — this widget now renders the SAME row as
 * "Recommended tasks" below it (home-task-row.tsx), for the reason the ruling
 * gives: every list on Home offers one X and one "Let's do this", and two lists
 * an inch apart may not spell that pair two ways. Three consequences, all
 * deliberate:
 *  - The ROW IS NO LONGER A LINK. The button navigates. A row that is itself a
 *    link cannot hold buttons without nesting interactive elements, which is
 *    what forced the old controls into an absolutely-positioned hover overlay.
 *  - THE CONTROLS ARE ALWAYS VISIBLE, not revealed on `group-hover` with a
 *    touch fallback. They are the row's primary gesture now.
 *  - SNOOZE IS GONE (the clock button, `dismissActionAction`). It was a third
 *    verb on a two-verb row and said nothing the X does not: a client who does
 *    not want an item now X's it. Rows ALREADY snoozed still render — muted,
 *    labelled, uncontrolled — so nobody's existing state silently reappears.
 */
export function ActionListWidget({
  clientId,
  resolved,
  startExpanded = false,
}: {
  clientId: string;
  resolved: ClientResolvedAction[];
  /**
   * Open already-expanded rather than collapsed to the usual top 3 — set by
   * the caller from `shouldStartExpanded` (lib/action-list.ts) for a client
   * who has barely started the checklist, so the mandatory-onboarding ask is
   * satisfied by prominence rather than a navigation block.
   */
  startExpanded?: boolean;
}) {
  const [, startTransition] = useTransition();
  const [overrides, setOverrides] = useState<Record<string, ResolvedActionStatus>>({});
  const [expanded, setExpanded] = useState(startExpanded);

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
          const isEligible = a.status === "eligible";
          return (
            <li key={a.id}>
              <HomeTaskRow
                icon={done ? "Check" : a.icon}
                title={a.label}
                muted={done || snoozed}
                {...(snoozed
                  ? { trailing: <span className="text-[10px] text-muted-2">Snoozed</span> }
                  : {})}
                {...(isEligible
                  ? {
                      dismiss: {
                        label: "Not relevant for me",
                        onClick: () => act(a.id, "not_relevant", markActionNotRelevantAction),
                      },
                      start: { href: a.href },
                    }
                  : {})}
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
