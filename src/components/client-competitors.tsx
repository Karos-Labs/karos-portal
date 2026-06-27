"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Input } from "@/components/ui";
import { Icon } from "@/components/icon";
import { addCompetitorAction, removeCompetitorAction } from "@/lib/actions";
import type { Competitor } from "@/lib/types";

/** Best-effort host extraction from a possibly protocol-less URL ("tokens.liqi.com.br/x" → "tokens.liqi.com.br"). */
function hostOf(website: string): string | null {
  const raw = website.trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
}

function CompetitorFavicon({ website, name }: { website: string; name: string }) {
  const host = hostOf(website);
  const [failed, setFailed] = useState(false);
  if (host && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`https://icons.duckduckgo.com/ip3/${host}.ico`}
        alt=""
        className="h-5 w-5 shrink-0 rounded"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-surface-3 text-[10px] font-semibold text-muted"
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function ClientCompetitors({ clientId, competitors }: { clientId: string; competitors: Competitor[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await addCompetitorAction(clientId, { name, website });
      setName("");
      setWebsite("");
      setAdding(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add competitor.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(c: Competitor) {
    if (!confirm(`Remove “${c.name}” from competitors?`)) return;
    setBusyId(c.id);
    try {
      await removeCompetitorAction(clientId, c.id);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <CardTitle>Competitors</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
          <Icon name={adding ? "X" : "Plus"} className="h-3.5 w-3.5" />
          {adding ? "Cancel" : "Add"}
        </Button>
      </div>

      {adding && (
        <form onSubmit={add} className="space-y-2 rounded-[10px] border border-border bg-surface-2 p-3">
          <Input
            placeholder="Competitor name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <Input
            placeholder="Website (e.g. competitor.com)"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          <Button type="submit" size="sm" loading={saving} disabled={!name.trim()}>
            Add competitor
          </Button>
        </form>
      )}

      {competitors.length === 0 ? (
        <p className="text-sm text-muted-2">No competitors tracked yet. Add the brands this client competes with.</p>
      ) : (
        <ul className="space-y-1">
          {competitors.map((c) => {
            const host = hostOf(c.website);
            return (
              <li
                key={c.id}
                className="group flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-surface-2"
              >
                <CompetitorFavicon website={c.website} name={c.name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  {host && <p className="truncate text-[11px] text-muted-2">{host}</p>}
                </div>
                {host && (
                  <a
                    href={c.website.includes("://") ? c.website : `https://${c.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-2 opacity-0 transition-opacity hover:text-neon group-hover:opacity-100"
                    aria-label={`Open ${c.name}`}
                  >
                    <Icon name="ExternalLink" className="h-3.5 w-3.5" />
                  </a>
                )}
                <button
                  onClick={() => remove(c)}
                  disabled={busyId === c.id}
                  className="text-muted-2 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 disabled:opacity-50"
                  aria-label={`Remove ${c.name}`}
                >
                  <Icon name="Trash2" className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
