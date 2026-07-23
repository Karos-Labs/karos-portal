import { Icon } from "@/components/icon";
import { isAiProcessingLockActive } from "@/lib/constants";
import type { Client } from "@/lib/types";

type BannerClient = Pick<Client, "isAiProcessing" | "aiProcessingStartedAt" | "aiProcessingError">;

/**
 * Shown on the Dashboard, Task Map, and Settings views while the client's
 * workspace lock is active — surfaces it to every user on the account so a
 * teammate on another tab understands why Regenerate / Refresh Task Map are
 * greyed out. Once the lock clears, if the run that held it failed (e.g. out
 * of credits), shows what went wrong instead of just silently disappearing —
 * Regenerate / Refresh Task Map are already unlocked again at that point.
 */
export function AiProcessingBanner({ client, isAdmin = false }: { client: BannerClient; isAdmin?: boolean }) {
  if (isAiProcessingLockActive(client)) {
    return (
      <div className="mb-4 flex items-center gap-2.5 rounded-md border border-neon/25 bg-neon-soft px-3.5 py-2.5 text-sm text-foreground">
        <Icon name="Loader" className="h-4 w-4 shrink-0 animate-spin text-neon" />
        <p>
          <span className="font-medium">Karos Agents are building your workspace strategy</span>{" "}
          <span className="text-muted">- Regenerate and Refresh Task Map are locked until this finishes.</span>
        </p>
      </div>
    );
  }

  if (client.aiProcessingError) {
    return (
      <div className="mb-4 flex items-center gap-2.5 rounded-md border border-danger/25 bg-danger/10 px-3.5 py-2.5 text-sm text-foreground">
        <Icon name="TriangleAlert" className="h-4 w-4 shrink-0 text-danger" />
        {isAdmin ? (
          <p>
            <span className="font-medium">Workspace generation failed:</span>{" "}
            <span className="text-muted">{client.aiProcessingError}</span>{" "}
            <span className="text-muted">Fix the underlying issue, then Regenerate / Refresh Task Map are available again.</span>
          </p>
        ) : (
          <p>
            <span className="font-medium">We hit a snag building your workspace strategy.</span>{" "}
            <span className="text-muted">Our team has been notified and is on it - Regenerate / Refresh Task Map will be available again shortly.</span>
          </p>
        )}
      </div>
    );
  }

  return null;
}
