"use client";

import { useRouter } from "next/navigation";
import { ConfirmAction } from "@/components/confirm-action";
import { Button, Spinner } from "@/components/ui";
import { Icon } from "@/components/icon";
import { deleteJobAction } from "@/lib/actions";

/**
 * Admin-only delete for a job (agent run).
 * `compact` renders an icon button for list rows; otherwise a full danger
 * button for the detail page, which navigates back to /jobs after deleting.
 *
 * The confirmation used to be `window.confirm()` — a dialog that cannot be
 * styled, ignores the theme, and asks its question with OK/Cancel buttons in
 * the browser's language on a surface that may be in Hebrew. See
 * `ConfirmAction`.
 */
export function JobDeleteButton({ jobId, compact }: { jobId: string; compact?: boolean }) {
  const router = useRouter();

  const remove = async (): Promise<string | undefined> => {
    const result = await deleteJobAction(jobId);
    if (result.error) return result.error;
    if (compact) router.refresh();
    else router.push("/jobs");
    return undefined;
  };

  return (
    <ConfirmAction
      question="Delete this run?"
      detail="The job record and its log are removed permanently. Assets it created are kept."
      confirmLabel="Delete run"
      onConfirm={remove}
      trigger={({ onClick, disabled }) =>
        compact ? (
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title="Delete run"
            className="rounded-md p-2 text-muted-2 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
          >
            {disabled ? <Spinner className="h-4 w-4" /> : <Icon name="Trash2" className="h-4 w-4" />}
          </button>
        ) : (
          <Button variant="danger" disabled={disabled} onClick={onClick}>
            Delete run
          </Button>
        )
      }
    />
  );
}
