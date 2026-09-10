"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner } from "@/components/ui";
import { cancelManagedJobAction } from "@/lib/actions";

export function ManagedJobCancelButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-danger">{error}</span>}
      <Button
        variant="danger"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await cancelManagedJobAction(jobId);
            if (result.error) setError(result.error);
            else router.refresh();
          })
        }
      >
        {pending ? <Spinner className="h-4 w-4" /> : "Cancel run"}
      </Button>
    </div>
  );
}
