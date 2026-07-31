"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { regenerateClientKeyAction } from "@/lib/actions";

/**
 * Invite-key chip. Low-profile: small monospace text + copy icon, no heading,
 * no card border.
 *
 * `canRotate` adds the remediation control: the key auto-approves any signup
 * straight into the workspace, so whoever may hand it out must also be able to
 * replace it once it leaks (QA F56 - the rotate control existed on the server
 * but was mounted on no page). The server action re-checks the caller: staff,
 * or the workspace's own group admin.
 */
export function ClientKeyInline({
  clientKeyId,
  clientId,
  canRotate = false,
}: {
  clientKeyId: string;
  clientId?: string;
  canRotate?: boolean;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [currentKey, setCurrentKey] = useState(clientKeyId);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Store-previous-prop pattern: a server refresh with a new key wins over local state.
  const [prevKey, setPrevKey] = useState(clientKeyId);
  if (prevKey !== clientKeyId) {
    setPrevKey(clientKeyId);
    setCurrentKey(clientKeyId);
  }

  async function copy() {
    await navigator.clipboard.writeText(currentKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function rotate() {
    if (!clientId) return;
    setError(null);
    startTransition(async () => {
      try {
        const { clientKeyId: newKey } = await regenerateClientKeyAction(clientId);
        setCurrentKey(newKey);
        setConfirming(false);
        router.refresh();
      } catch {
        setError("Could not replace the key - ask your Karos team.");
      }
    });
  }

  return (
    <div className="border-t border-border/50 pt-4">
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-2">
        Invite key
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-md bg-surface-2 px-2.5 py-1.5 text-[11px] font-mono text-muted-2">
          {currentKey}
        </code>
        <button
          onClick={copy}
          title={copied ? "Copied!" : "Copy invite key"}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-2 transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <Icon name={copied ? "Check" : "Copy"} className="h-3.5 w-3.5" />
        </button>
        {canRotate && clientId && (
          <button
            onClick={() => setConfirming(true)}
            disabled={isPending || confirming}
            title="Replace this key"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-2 transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
          >
            <Icon name="RefreshCw" className={isPending ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[10px] text-muted-2">
        Share this key with teammates so they can join your workspace.
        {canRotate && " Anyone who has it can join, so replace it if it leaks."}
      </p>

      {confirming && (
        <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2">
          <p className="text-[11px] leading-relaxed text-foreground">
            Replace this key? The current one stops working immediately, and teammates who
            haven&apos;t joined yet will need the new one.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={rotate}
              disabled={isPending}
              className="rounded-md border border-warning/40 bg-warning/15 px-2.5 py-1 text-[11px] font-medium text-warning disabled:opacity-50"
            >
              Replace key
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-1.5 text-[10px] text-danger">{error}</p>}
    </div>
  );
}
