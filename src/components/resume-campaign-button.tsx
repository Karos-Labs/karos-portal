"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { resumeCampaignAction, type CampaignStepResult } from "@/lib/actions";

/**
 * Resumes a campaign run: dispatches whatever steps are eligible right now
 * and leaves completed/in-flight/blocked steps untouched (see
 * resumeCampaignAction). Reports a short per-step summary so a client can see
 * exactly what happened rather than just "done".
 */
export function ResumeCampaignButton({
  campaignId,
  clientId,
  label = "Resume run",
}: {
  campaignId: string;
  clientId: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    setSummary(null);
    startTransition(async () => {
      const res = await resumeCampaignAction(campaignId, clientId);
      if (!res.ok) {
        setError(res.error ?? "Couldn't resume this run.");
        return;
      }
      setSummary(summarize(res.steps ?? []));
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="accent" size="sm" onClick={onClick} loading={pending}>
        <Icon name="Play" className="h-3.5 w-3.5" />
        {label}
      </Button>
      {error && <p className="text-xs text-danger">{error}</p>}
      {summary && <p className="text-xs text-muted-2">{summary}</p>}
    </div>
  );
}

function summarize(steps: CampaignStepResult[]): string {
  const dispatched = steps.filter((s) => s.outcome === "dispatched").length;
  const waiting = steps.filter((s) => s.outcome === "waiting").length;
  const errored = steps.filter((s) => s.outcome === "error");
  if (errored.length > 0) return `${errored.length} step(s) couldn't start: ${errored[0].error}`;
  if (dispatched === 0 && waiting === 0) return "Every step is already done or in progress.";
  const parts: string[] = [];
  if (dispatched > 0) parts.push(`${dispatched} step(s) started`);
  if (waiting > 0) parts.push(`${waiting} still waiting on a dependency`);
  return parts.join(" · ");
}
