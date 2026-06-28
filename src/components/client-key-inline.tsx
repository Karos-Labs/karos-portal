"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";

/**
 * Read-only invite-key chip shown to CLIENT_USER at the bottom of the sidebar.
 * Low-profile: small monospace text + copy icon, no heading, no card border.
 */
export function ClientKeyInline({ clientKeyId }: { clientKeyId: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(clientKeyId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="border-t border-border/50 pt-4">
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-2">
        Invite key
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-[8px] bg-surface-2 px-2.5 py-1.5 text-[11px] font-mono text-muted-2">
          {clientKeyId}
        </code>
        <button
          onClick={copy}
          title={copied ? "Copied!" : "Copy invite key"}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-border text-muted-2 transition-colors hover:border-neon/40 hover:text-neon"
        >
          <Icon name={copied ? "Check" : "Copy"} className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-muted-2">
        Share this key with teammates so they can join your workspace.
      </p>
    </div>
  );
}
