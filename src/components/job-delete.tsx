"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner } from "@/components/ui";
import { Icon } from "@/components/icon";
import { deleteJobAction } from "@/lib/actions";

const CONFIRM =
  "Delete this run? The job record and its log are removed permanently; assets it created are kept.";

/**
 * Admin-only delete for a job (agent run).
 * `compact` renders an icon button for list rows; otherwise a full danger
 * button for the detail page, which navigates back to /jobs after deleting.
 */
export function JobDeleteButton({ jobId, compact }: { jobId: string; compact?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove() {
    if (!confirm(CONFIRM)) return;
    startTransition(async () => {
      const result = await deleteJobAction(jobId);
      if (result.error) setError(result.error);
      else if (compact) router.refresh();
      else router.push("/jobs");
    });
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={remove}
        disabled={pending}
        title="Delete run"
        className="rounded-md p-2 text-muted-2 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
      >
        {pending ? <Spinner className="h-4 w-4" /> : <Icon name="Trash2" className="h-4 w-4" />}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-danger">{error}</span>}
      <Button variant="danger" disabled={pending} onClick={remove}>
        {pending ? <Spinner className="h-4 w-4" /> : "Delete run"}
      </Button>
    </div>
  );
}
