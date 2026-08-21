"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner } from "@/components/ui";
import { resolveAgentEngineGateAction } from "@/lib/actions";

/**
 * The human-approval action for an agent-engine run paused at
 * `awaiting_gate` — Task 3's "paused runs render human approval actions
 * triggering gate resolution via agent-engine." Distinct from the legacy
 * `ApprovePanel` (which approves an already-finished `Asset`, post
 * completion): this approves/rejects a run that is mid-flight, still
 * holding a Pub/Sub-derived `agentEngineRunId`, before it can continue.
 */
export function AgentEngineGateApproval({ jobId, gateId }: { jobId: string; gateId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  function resolve(decision: "approve" | "reject") {
    startTransition(async () => {
      const result = await resolveAgentEngineGateAction(jobId, gateId, decision, notes || undefined);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-3">
      <p className="text-xs text-muted-2">This run is paused waiting on your review of gate &quot;{gateId}&quot;.</p>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional notes"
        rows={2}
        className="w-full rounded-md border border-border bg-surface p-2 text-sm"
        disabled={pending}
      />
      {error && <span className="text-xs text-danger">{error}</span>}
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={pending} onClick={() => resolve("approve")}>
          {pending ? <Spinner className="h-4 w-4" /> : "Approve"}
        </Button>
        <Button variant="danger" disabled={pending} onClick={() => resolve("reject")}>
          {pending ? <Spinner className="h-4 w-4" /> : "Reject"}
        </Button>
      </div>
    </div>
  );
}
