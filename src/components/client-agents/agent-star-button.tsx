"use client";

import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { toggleStarredAgentAction } from "@/lib/actions";

/**
 * "Pin to sidebar" on the agent's own page — and, since round 6, the ONLY place
 * an agent is pinned.
 *
 * The rail used to carry a star on every row: grey glyphs that meant nothing
 * until hovered and orange ones that spent the rationed accent once per pin, so
 * a client with four pins spent it four times in the nav. The rail is now marks
 * and names, and this is the control (think-agents §3).
 *
 * NO ORANGE IN EITHER STATE. Pinned is ink on `surface-2` with a filled star,
 * unpinned is an outline star on a hairline — the same two-state treatment a
 * toggle gets everywhere, without claiming the one colour reserved for the
 * control that moves the client forward.
 *
 * Optimistic-then-refresh because `toggleStarredAgentAction`'s server-side
 * revalidatePath cannot reliably reach the ROOT `(app)/layout.tsx` that renders
 * the pinned rows (see that action's own note), so this component drives the
 * refresh itself. It does not need the rail's old active-client write-back: this
 * control only exists under `/clients/[id]`, whose layout mounts
 * ClientContextSync, so the refresh reads a context that has been updated.
 *
 * Rendered for both viewer types — the same authorization
 * `toggleStarredAgentAction` already grants a CLIENT_USER for their own
 * client and staff for any client (including "View as Client").
 */
export function AgentStarButton({
  clientId,
  agentId,
  starred,
}: {
  clientId: string;
  agentId: string;
  starred: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [optimisticStarred, setOptimisticStarred] = useOptimistic(starred);

  function toggle() {
    const next = !optimisticStarred;
    startTransition(async () => {
      setOptimisticStarred(next);
      await toggleStarredAgentAction(clientId, agentId, next);
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isPending}
      aria-pressed={optimisticStarred}
      aria-label={optimisticStarred ? "Unpin from sidebar" : "Pin to sidebar"}
      className={cn(
        "focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
        optimisticStarred
          ? "border-border bg-surface-2 text-foreground hover:bg-surface-3"
          : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      <Icon name="Star" className={cn("h-3.5 w-3.5", optimisticStarred && "fill-current")} />
      {optimisticStarred ? "Pinned" : "Pin to sidebar"}
    </button>
  );
}
