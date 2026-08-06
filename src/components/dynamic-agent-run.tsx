"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle } from "@/components/ui";
import { runDynamicAgentAction } from "@/lib/actions";
import type { DynamicAgentInputDef, DynamicAgentInputValue } from "@/lib/types";
import { DynamicAgentIntakeForm } from "@/components/dynamic-agent-intake-form";

export function DynamicAgentRun({
  specId,
  clientId,
  inputSchema,
}: {
  specId: string;
  clientId: string;
  inputSchema: DynamicAgentInputDef[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(inputs: Record<string, DynamicAgentInputValue>) {
    setError(null);
    startTransition(async () => {
      const result = await runDynamicAgentAction(specId, clientId, inputs);
      if (result.error) {
        setError(result.error);
        return;
      }
      setJobId(result.jobId ?? null);
      if (result.jobId) router.push(`/jobs/${result.jobId}`);
    });
  }

  return (
    <Card>
      <CardTitle className="mb-3">Run this agent</CardTitle>
      <DynamicAgentIntakeForm
        inputSchema={inputSchema}
        clientId={clientId}
        submitting={pending}
        onSubmit={handleSubmit}
      />
      {error ? <p className="mt-3 text-xs text-danger" role="alert">{error}</p> : null}
      {jobId ? <p className="mt-3 text-xs text-success">Submitted, job {jobId}.</p> : null}
    </Card>
  );
}
