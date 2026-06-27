"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { runContentEngineAction } from "@/lib/actions";

/**
 * Staff trigger for a native content-engine run: picks the next on-brand topic
 * from the client's catalog and generates a QA-gated carousel in the background.
 * Only rendered for clients that have a content-engine config seeded.
 */
export function ContentEngineLauncher({ clientId, clientName }: { clientId: string; clientName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { jobId } = await runContentEngineAction({ clientId });
      router.push(`/jobs/${jobId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the run");
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <CardTitle>Content engine</CardTitle>
        <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">e12</span>
      </div>
      <p className="mb-3 text-sm text-muted-2">
        Picks the next on-brand topic for {clientName} (dedupe + cooldown via the ledger), generates a QA-gated carousel, and saves it for review.
      </p>
      <Button size="sm" onClick={run} disabled={busy}>
        <Icon name={busy ? "Loader" : "Sparkles"} className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
        {busy ? "Starting…" : "Run content engine (next topic)"}
      </Button>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </Card>
  );
}
