"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Badge, Label, Input } from "@/components/ui";
import { Icon } from "@/components/icon";
import { adjustCreditsAction, setCreditLimitsAction } from "@/lib/actions";
import { relativeTime } from "@/lib/utils";
import type { ClientCredits, CreditLedgerEntry, Role } from "@/lib/types";

/** Compact "N / cap" usage line with a progress bar; cap-less shows plain spend. */
function UsageMeter({ label, spent, limit }: { label: string; spent: number; limit: number | null }) {
  // A cap of 0 means "no spending allowed" — show it as fully used.
  const pct =
    limit == null ? 0 : limit === 0 ? 100 : Math.min(100, Math.round((spent / limit) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-2">{label}</span>
        <span className="font-mono text-muted">
          {spent}
          {limit != null ? ` / ${limit}` : ""}
        </span>
      </div>
      {limit != null && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className={pct >= 100 ? "h-full bg-danger" : pct >= 80 ? "h-full bg-warning" : "h-full bg-neon"}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Credits & usage section for the client settings page.
 * All roles see the balance, window usage, and ledger; admins additionally
 * get the grant/deduct form and the weekly/monthly cap editor.
 */
export function CreditsPanel({
  clientId,
  credits,
  ledger,
  role,
}: {
  clientId: string;
  credits: ClientCredits;
  ledger: CreditLedgerEntry[];
  role: Role;
}) {
  const router = useRouter();
  const isAdmin = role === "KAROS_ADMIN";

  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [weekly, setWeekly] = useState(credits.weeklyLimit != null ? String(credits.weeklyLimit) : "");
  const [monthly, setMonthly] = useState(credits.monthlyLimit != null ? String(credits.monthlyLimit) : "");
  const [busy, setBusy] = useState<"grant" | "limits" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function grant() {
    setError(null);
    setNotice(null);
    const n = Number(amount);
    setBusy("grant");
    try {
      const res = await adjustCreditsAction(clientId, n, note);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNotice(`Balance is now ${res.balance} credits.`);
      setAmount("");
      setNote("");
      router.refresh();
    } catch {
      setError("Something went wrong — please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function saveLimits() {
    setError(null);
    setNotice(null);
    const parse = (v: string) => (v.trim() === "" ? null : Number(v));
    setBusy("limits");
    try {
      const res = await setCreditLimitsAction(clientId, parse(weekly), parse(monthly));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNotice("Spend limits updated.");
      router.refresh();
    } catch {
      setError("Something went wrong — please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Icon name="Coins" className="h-4 w-4 text-neon" />
            Credits &amp; usage
          </CardTitle>
          <p className="mt-0.5 text-sm text-muted-2">
            AI actions — agent runs, copilot messages, task executions, doc corrections — spend credits.
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-2xl font-semibold">{credits.balance}</p>
          <p className="text-xs text-muted-2">credits available</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <UsageMeter label="Used this week" spent={credits.weekSpent} limit={credits.weeklyLimit} />
        <UsageMeter label="Used this month" spent={credits.monthSpent} limit={credits.monthlyLimit} />
      </div>

      {isAdmin && (
        <div className="mt-5 grid gap-4 border-t border-border pt-4 lg:grid-cols-2">
          <div>
            <Label>Grant / deduct credits</Label>
            <div className="mt-1 flex gap-2">
              <Input
                type="number"
                placeholder="e.g. 100 or -25"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-32"
              />
              <Input
                placeholder="Note (shows in the ledger)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button size="sm" loading={busy === "grant"} onClick={grant} disabled={!amount.trim()}>
                Apply
              </Button>
            </div>
          </div>
          <div>
            <Label>Spend limits (empty = no cap)</Label>
            <div className="mt-1 flex gap-2">
              <Input
                type="number"
                placeholder="Weekly"
                value={weekly}
                onChange={(e) => setWeekly(e.target.value)}
                className="w-28"
              />
              <Input
                type="number"
                placeholder="Monthly"
                value={monthly}
                onChange={(e) => setMonthly(e.target.value)}
                className="w-28"
              />
              <Button size="sm" variant="outline" loading={busy === "limits"} onClick={saveLimits}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      {notice && <p className="mt-3 text-xs text-neon">{notice}</p>}

      <div className="mt-5 border-t border-border pt-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-2">Recent activity</p>
        {ledger.length === 0 ? (
          <p className="text-sm text-muted-2">No credit activity yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {ledger.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm">{e.reason}</p>
                  <p className="text-xs text-muted-2">
                    {relativeTime(e.createdAt)}
                    {e.actorName ? ` · ${e.actorName}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={e.delta > 0 ? "success" : "neutral"}>
                    {e.delta > 0 ? `+${e.delta}` : e.delta}
                  </Badge>
                  <span className="w-12 text-right font-mono text-xs text-muted-2">{e.balanceAfter}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
