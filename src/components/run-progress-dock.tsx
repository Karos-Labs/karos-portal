"use client";

/**
 * The corner card that keeps a started run in sight until it lands.
 *
 * WHAT IT REPLACES (SCRUM-416). Nothing - and that is the ticket. Pressing
 * "Create a new post" produced a dialog panel with a tick, the word "started"
 * and a thirty-minute estimate, and then the reader closed it and had no way
 * to tell whether anything was happening. Lola: "I got the 30-minute popup, but
 * how do I know where it goes, if it worked, etc."
 *
 * IT IS THE PERSISTENT HALF, on purpose. Progress inside the dialog answers the
 * question only while the dialog is open, and nobody watches a modal for half
 * an hour. This is mounted in the app shell, so the answer survives every
 * navigation in the tab and a reload (see run-watch.tsx). The dialog shows the
 * same watch while it is open, from the same store, so the two cannot disagree.
 *
 * IT ASSEMBLES, it does not invent. The bar is `AgentRunProgress`, the same one
 * the in-page run form turns into, and the sentences are `runOutcomeSentence`.
 * It quotes no duration: the moving bar answers "how long".
 *
 * WHAT IT DOES NOT DO. It does not cancel (`CancelRunControl` lives on the
 * agent page, where the refund rules are already painted), and it does not
 * report WHY a run produced nothing: `job.error` is an internal string and
 * AF-14 keeps a failure that is ours off a client's screen. What it gives them
 * instead is that nothing is coming and the two things they can do about it.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon } from "@/components/icon";
import { AgentRunProgress } from "@/components/client-agents/run-progress";
import { ContactUsButton } from "@/components/contact-us-modal";
import { useRestoreRunPolling, useRunWatch, type WatchedRun } from "@/components/run-watch";
import { runOutcome, runOutcomeSentence } from "@/lib/run-progress";
import type { JobStatus } from "@/lib/types";

function DockRow({
  run,
  viewerIsClient,
  onDismiss,
}: {
  run: WatchedRun;
  viewerIsClient: boolean;
  onDismiss: () => void;
}) {
  // No answer yet - the first tick has not landed. `queued` is what the run IS
  // at that moment and what the ladder's first step already says, so the strip
  // is honest rather than empty.
  const status = (run.status ?? "queued") as JobStatus;
  const outcome = run.agentDone ? "landed" : runOutcome(status);

  return (
    <div className="rounded-[var(--radius)] border border-border bg-surface p-3 shadow-lg">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">
            {run.agentName}
          </p>
          <p className="truncate text-xs text-muted-2">
            {outcome === "working" ? `Making your ${run.noun}` : `Your ${run.noun}`}
          </p>
        </div>
        {/* Dismiss, not cancel - it stops the reader watching, not the run.
            Said in the label rather than left to a glyph. */}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Stop showing this ${run.noun} run`}
          className="focus-ring -mr-1 -mt-1 rounded-md p-1 text-muted-2 transition-colors hover:text-foreground"
        >
          <Icon name="X" className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* The same bar as the run form, compact: what it is doing while it
          works, full once the agent is done, none for a run that stopped. */}
      {outcome !== "stopped" && (
        <div className="mt-2">
          <AgentRunProgress
            headline={outcome === "working" ? (run.headline ?? "Starting the run") : "Done"}
            working={outcome === "working"}
          />
        </div>
      )}

      <p className="mt-2 text-xs leading-relaxed text-muted">
        {runOutcomeSentence(outcome, viewerIsClient)}
      </p>

      {outcome === "landed" && run.href && (
        /* Round 6, rule 3: a quiet link is muted to foreground with an
           underline, and no glyph trails the label. A watch with no href gets
           NO link: see WatchedRun.href - for some readers the honest answer to
           "where did it go" is "nowhere they can open yet". */
        <Link
          href={run.href}
          className="focus-ring mt-2 inline-block rounded-md text-xs text-muted underline underline-offset-2 transition-colors hover:text-foreground"
        >
          See it
        </Link>
      )}
      {outcome === "stopped" && viewerIsClient && (
        <div className="mt-2">
          {/* `row`, not the icon: the icon form is the rail's Support glyph
              and this is a sentence's answer, so it needs a label. */}
          <ContactUsButton variant="row" label="Ask us about it" />
        </div>
      )}
    </div>
  );
}

/**
 * Mounted once per shell, beside the copilot dock.
 *
 * Renders nothing at all when there is nothing to watch, which is the common
 * case - so it costs a client with no run in flight an empty div and no poll.
 */
export function RunProgressDock({ viewerIsClient }: { viewerIsClient: boolean }) {
  const { runs, forget } = useRunWatch();
  // A reader who reloaded mid-run has watches in storage and no interval;
  // `watch()` is the only other thing that starts one and is not called again
  // on that path.
  useRestoreRunPolling(runs.length);
  // Polling counts every run above; only the DRAWING skips a run whose own page
  // is on screen, where the run form has already turned into its progress.
  const pathname = usePathname();
  const shown = runs.filter((run) => run.origin !== pathname);

  if (shown.length === 0) return null;

  return (
    <div
      /* Above the page, below a modal (z-50 is the Modal's own layer): a reader
         who opens the run dialog again must not have it covered by this. Bottom
         offset clears the client shell's mobile tab bar. */
      className="pointer-events-none fixed bottom-24 right-4 z-40 flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 md:bottom-6"
      aria-live="polite"
    >
      {shown.map((run) => (
        <div key={run.jobId} className="pointer-events-auto">
          <DockRow
            run={run}
            viewerIsClient={viewerIsClient}
            onDismiss={() => forget(run.jobId)}
          />
        </div>
      ))}
    </div>
  );
}
