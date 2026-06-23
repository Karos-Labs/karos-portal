"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { importLabsSkillsAction } from "@/lib/actions";

/**
 * Admin-only: import the karos-labs skill library (karos/* + XO Digital) as runnable agents.
 * Idempotent — safe to click again to refresh imported agents from the latest library.
 */
export function ImportLabsSkillsButton({ variant = "outline" }: { variant?: "primary" | "outline" }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setResult(null);
    try {
      const { created, updated, failed, total } = await importLabsSkillsAction();
      setResult(
        `${created} new, ${updated} updated${failed ? `, ${failed} failed (click again to retry)` : ""} — of ${total}.`,
      );
      router.refresh();
    } catch (e) {
      setResult(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant={variant} onClick={run} loading={loading}>
        <Icon name="Library" className="h-4 w-4" />
        Import Karos skills
      </Button>
      {result && <span className="text-xs text-muted">{result}</span>}
    </div>
  );
}
