"use client";

import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { toggleStarredAgentAction } from "@/lib/actions";

/**
 * "Pin to sidebar" on the agent's own page — a direct, unmistakable way to
 * star an agent, alongside the sidebar dropdown's star (client-rail-agents-nav.tsx).
 * Same optimistic-then-refresh pattern as that component and for the same
 * reason: `toggleStarredAgentAction`'s server-side revalidatePath cannot
 * reliably reach the ROOT `(app)/layout.tsx` that renders the pinned rows
 * (see that action's own note), so this component drives the refresh itself.
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
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
        optimisticStarred
          ? "border-neon/30 bg-neon-soft text-neon hover:bg-neon/20"
          : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      <Icon name="Star" className={cn("h-3.5 w-3.5", optimisticStarred && "fill-current")} />
      {optimisticStarred ? "Pinned" : "Pin to sidebar"}
    </button>
  );
}
