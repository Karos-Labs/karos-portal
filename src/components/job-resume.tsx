"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner } from "@/components/ui";
import { Icon } from "@/components/icon";
import { resumeFailedJobAction } from "@/lib/actions";

/**
 * Resume a failed Dynamic Agent Studio run (resumeFailedJobAction) — the
 * dynamic-agent counterpart of JobRetryButton, for the job type that
 * button's own `job.customAgentId` gate excludes. Same navigate-to-the-
 * returned-jobId shape as JobRetryButton: a plain `router.refresh()` would
 * re-render the same still-failed job with no sign anything happened.
 */
export function JobResumeButton({ jobId }: { jobId: string }) {
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
            const result = await resumeFailedJobAction(jobId);
            if (result.error) setError(result.error);
            else if (result.jobId) router.push(`/jobs/${result.jobId}`);
          })
        }
      >
        {pending ? <Spinner className="h-4 w-4" /> : <Icon name="RotateCw" className="h-4 w-4" />}
        Resume run
      </Button>
    </div>
  );
}
