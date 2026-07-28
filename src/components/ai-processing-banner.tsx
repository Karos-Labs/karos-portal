import { Icon } from "@/components/icon";
import { isAiProcessingLockActive } from "@/lib/constants";
import { hasAiProcessingFailure } from "@/lib/client-visibility";
import type { Client } from "@/lib/types";

type BannerClient = Pick<
  Client,
  "isAiProcessing" | "aiProcessingStartedAt" | "aiProcessingError" | "aiProcessingFailed"
>;

/**
 * Shown on the Dashboard, Task Map, and Settings views while the client's
 * workspace lock is active — surfaces it to every user on the account so a
 * teammate on another tab understands why the run controls are greyed out. Once
 * the lock clears, if the run that held it failed (e.g. out of credits), shows
 * what went wrong instead of just silently disappearing.
 *
 * QA F20: the copy used to name Regenerate and Refresh Task Map to EVERY viewer,
 * including CLIENT_USERs, who have neither control — both are staff-only actions.
 * `isClientViewer` picks the wording; `isAdmin` still gates the raw error string.
 * Employees (staff, not admin) keep the control names, which the old `isAdmin`
 * split got wrong in the other direction.
 */
export function AiProcessingBanner({
  client,
  isAdmin = false,
  isClientViewer = false,
}: {
  client: BannerClient;
  isAdmin?: boolean;
  isClientViewer?: boolean;
}) {
  if (isAiProcessingLockActive(client)) {
    return (
      <div className="mb-4 flex items-center gap-2.5 rounded-md border border-neon/25 bg-neon-soft px-3.5 py-2.5 text-sm text-foreground">
        <Icon name="Loader" className="h-4 w-4 shrink-0 animate-spin text-neon" />
        <p>
          <span className="font-medium">Karos Agents are building your workspace strategy</span>{" "}
          <span className="text-muted">
            {isClientViewer
              ? "— this usually takes a few minutes. Your workspace updates on its own when it finishes."
              : "— Regenerate and Refresh Task Map are locked until this finishes."}
          </span>
        </p>
      </div>
    );
  }

  // F69: THAT it failed is what a client viewer receives; the reason below is
  // staff-side and only the admin branch paints it.
  if (hasAiProcessingFailure(client)) {
    return (
      <div className="mb-4 flex items-center gap-2.5 rounded-md border border-danger/25 bg-danger/10 px-3.5 py-2.5 text-sm text-foreground">
        <Icon name="TriangleAlert" className="h-4 w-4 shrink-0 text-danger" />
        {isAdmin ? (
          <p>
            <span className="font-medium">Workspace generation failed:</span>{" "}
            {client.aiProcessingError && (
              <span className="text-muted">{client.aiProcessingError} </span>
            )}
            <span className="text-muted">Fix the underlying issue, then Regenerate / Refresh Task Map are available again.</span>
          </p>
        ) : isClientViewer ? (
          <p>
            <span className="font-medium">We hit a snag building your workspace strategy.</span>{" "}
            {/* Says only what the product does: the failure is on the client's
                activity timeline and badged on the staff client list — no email
                or push is sent, so it must not claim one (QA F69). */}
            <span className="text-muted">
              Your Karos team can see it and is on it — nothing for you to do.
            </span>
          </p>
        ) : (
          <p>
            <span className="font-medium">We hit a snag building your workspace strategy.</span>{" "}
            <span className="text-muted">Regenerate / Refresh Task Map are available again.</span>
          </p>
        )}
      </div>
    );
  }

  return null;
}
