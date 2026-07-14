"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { createAccessTokenAction, revokeAccessTokenAction } from "@/lib/actions";
import { relativeTime } from "@/lib/utils";
import type { AccessToken } from "@/lib/types";

export function TokenManager({ tokens, mcpUrl }: { tokens: AccessToken[]; mcpUrl: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    setCreating(true);
    try {
      const res = await createAccessTokenAction(name || "Claude Code");
      setFresh(res.token);
      setName("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create token");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this token? Any Claude Code using it will lose access immediately.")) return;
    await revokeAccessTokenAction(id);
    router.refresh();
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-4">
      {/* Newly minted token — shown once */}
      {fresh && (
        <div className="space-y-2 rounded-md border border-neon/40 bg-neon-soft p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-neon">
            <Icon name="KeyRound" className="h-3.5 w-3.5" />
            Copy this token now. You won&apos;t see it again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md bg-surface-2 px-2.5 py-2 text-xs">{fresh}</code>
            <Button size="sm" variant="outline" onClick={() => copy(fresh)}>
              <Icon name={copied ? "Check" : "Copy"} className="h-3.5 w-3.5" />
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Button size="sm" variant="outline" onClick={() => copy(`claude mcp add --transport http karos ${mcpUrl} --header "Authorization: Bearer ${fresh}"`)}>
            <Icon name="Terminal" className="h-3.5 w-3.5" />
            Copy full setup command
          </Button>
        </div>
      )}

      {/* Create */}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name (e.g. MacBook Claude Code)" />
        </div>
        <Button onClick={create} loading={creating}>
          <Icon name="Plus" className="h-4 w-4" />
          Generate
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}

      {/* Existing */}
      {tokens.length > 0 && (
        <div className="space-y-2">
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{t.name}</p>
                <p className="text-xs text-muted-2">
                  <code>{t.prefix}…</code> · {t.lastUsedAt ? `used ${relativeTime(t.lastUsedAt)}` : "never used"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="neutral">{relativeTime(t.createdAt)}</Badge>
                <button onClick={() => revoke(t.id)} className="text-muted-2 transition-colors hover:text-danger" aria-label="Revoke token">
                  <Icon name="Trash2" className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
