"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { regenerateClientKeyAction } from "@/lib/actions";

export function ClientKeyPanel({
  clientId,
  clientKeyId,
}: {
  clientId: string;
  clientKeyId?: string;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [currentKey, setCurrentKey] = useState(clientKeyId ?? "");

  async function copy() {
    if (!currentKey) return;
    await navigator.clipboard.writeText(currentKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function regenerate() {
    if (!confirm("Regenerate the key? The old key will stop working immediately.")) return;
    setRegenerating(true);
    try {
      const { clientKeyId: newKey } = await regenerateClientKeyAction(clientId);
      setCurrentKey(newKey);
      router.refresh();
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <CardTitle>Client Access Key</CardTitle>
          <p className="mt-0.5 text-xs text-muted">
            Share this key with the client&apos;s primary user so they can self-register.
          </p>
        </div>
      </div>

      {currentKey ? (
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-[10px] bg-surface-2 px-3 py-2 text-xs text-neon font-mono">
            {currentKey}
          </code>
          <Button size="sm" variant="outline" onClick={copy}>
            <Icon name={copied ? "Check" : "Copy"} className="h-3.5 w-3.5" />
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-2 italic">No key generated yet.</p>
      )}

      <div className="border-t border-border pt-3">
        <Button
          size="sm"
          variant="subtle"
          onClick={regenerate}
          loading={regenerating}
          disabled={regenerating}
        >
          <Icon name="RefreshCw" className="h-3.5 w-3.5" />
          {currentKey ? "Regenerate key" : "Generate key"}
        </Button>
        <p className="mt-1.5 text-[11px] text-muted-2">
          Regenerating immediately invalidates the previous key. Any users who haven&apos;t registered
          yet will need the new key.
        </p>
      </div>
    </Card>
  );
}
