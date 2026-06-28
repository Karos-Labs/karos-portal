"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { syncFirefliesAction } from "@/lib/actions";

export function MeetingSyncButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ synced: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await syncFirefliesAction();
      setResult(res);
      if (res.synced > 0) router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" onClick={sync} loading={loading}>
        <Icon name="RefreshCw" className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        {loading ? "Syncing…" : "Sync Fireflies"}
      </Button>
      {result && !loading && (
        <span className="text-xs text-muted">
          {result.synced} synced · {result.skipped} skipped
        </span>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
