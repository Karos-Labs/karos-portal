"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner } from "@/components/ui";
import { Icon } from "@/components/icon";
import { retryJobAction } from "@/lib/actions";

/**
 * Re-submits a failed custom-agent run with the same agent/client/prompt
 * (retryJobAction) - the job detail page's version of the same control
 * `RetryRunControl` (custom-agents.tsx) and the /jobs list row already offer,
 * mirroring ManagedJobCancelButton's shape for the pending/error handling.
 *
 * Unlike those two (both rows in a LIST, where the new run just shows up as
 * another row after a refresh), this button lives ON the old failed job's own
 * page - a plain `router.refresh()` would re-render the same still-failed
 * job with no sign anything happened. Navigating to the new job id instead
 * (retryJobAction always creates a fresh job) is what actually shows the
 * retry took effect.
 */
export function JobRetryButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-danger">{error}</span>}
      <Button
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await retryJobAction(jobId);
            if (result.error) setError(result.error);
            else if (result.jobId) router.push(`/jobs/${result.jobId}`);
          })
        }
      >
        {pending ? <Spinner className="h-4 w-4" /> : <Icon name="RotateCw" className="h-4 w-4" />}
        Retry run
      </Button>
    </div>
  );
}
