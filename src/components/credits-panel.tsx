"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Badge, Label, Input } from "@/components/ui";
import { Icon } from "@/components/icon";
import { adjustCreditsAction, setCreditLimitsAction } from "@/lib/actions";
import { ContactUsButton } from "@/components/contact-us-modal";
import {
  CREDIT_BLOCK_REASON,
  CREDIT_COSTS,
  CREDIT_WINDOW_RESET,
  TASK_EXECUTION_COSTS,
  availableCredits,
  bindingCreditLimit,
  CREDIT_BUCKET_LABEL,
} from "@/lib/credits";
import type { AgentSpendRow } from "@/lib/credit-reporting";
import { cn, relativeTime } from "@/lib/utils";
import type { ClientCredits, CreditLedgerEntry, Role } from "@/lib/types";

/**
 * Every client-billable price, read straight off the pricing constants so the
 * card can never quote a stale figure. Agent runs are deliberately "from N":
 * CustomAgent.creditCost overrides the flat default per agent, so the real price
 * lives on the agent card, not here.
 */
const PRICE_ROWS: Array<{ label: string; price: string; note?: string }> = [
  { label: "Copilot message", price: `${CREDIT_COSTS.chatMessage}` },
  { label: "Correct one document", price: `${CREDIT_COSTS.targetedCorrection}` },
  { label: "Correct every document", price: `${CREDIT_COSTS.globalCorrection}` },
  {
    label: "Agent run",
    price: `from ${CREDIT_COSTS.customAgentRun}`,
    note: "each agent shows its own price",
  },
  { label: "Blog article", price: `${TASK_EXECUTION_COSTS.blog_article}` },
  { label: "Newsletter issue", price: `${TASK_EXECUTION_COSTS.newsletter_issue}` },
  { label: "Social posts", price: `${TASK_EXECUTION_COSTS.social_post}` },
  { label: "Landing page", price: `${TASK_EXECUTION_COSTS.landing_page}` },
  { label: "Other task execution", price: `${CREDIT_COSTS.taskExecution}` },
  {
    label: "Extra LinkedIn seat",
    price: `${CREDIT_COSTS.employeeSeat}`,
    note: "one-time, beyond your plan's seats",
  },
];

/** Compact "N / cap" usage line with a progress bar; cap-less shows plain spend. */
function UsageMeter({
  label,
  spent,
  limit,
  resetNote,
}: {
  label: string;
  spent: number;
  limit: number | null;
  /**
   * When this window's cap lifts — the clause from CREDIT_WINDOW_RESET, so it is
   * the same sentence the denial cites. A client could previously only learn
   * this by hitting the wall, since it lived inside assessCharge's messages.
   */
  resetNote?: string;
}) {
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
      {limit != null && resetNote && (
        <p className={cn("mt-1 text-[11px]", pct >= 100 ? "text-warning" : "text-muted-2")}>
          {/* Capitalised clause — the denial renders it mid-sentence. */}
          {resetNote.charAt(0).toUpperCase() + resetNote.slice(1)}
        </p>
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
  spendByAgent,
  role,
  viewer,
}: {
  clientId: string;
  credits: ClientCredits;
  ledger: CreditLedgerEntry[];
  /**
   * The per-agent breakdown (§6.2a), aggregated SERVER-side over the whole
   * ledger. Deliberately not derived here from `ledger`: that prop is the
   * capped "Recent activity" feed, so a breakdown computed from it would be a
   * breakdown of the last few rows presented as a breakdown of spend.
   */
  spendByAgent?: AgentSpendRow[];
  role: Role;
  /**
   * Signed-in viewer, for the support control offered when spending is blocked.
   * ContactUsButton needs a name and email; omit to render the explanation
   * without the contact route.
   */
  viewer?: { name: string; email: string };
}) {
  const router = useRouter();
  const isAdmin = role === "KAROS_ADMIN";
  // What the client can actually spend — the same helper the rail and the
  // Agents page use, so the three surfaces can no longer disagree. `now` is
  // omitted deliberately: the doc arrives from getClientCredits, which already
  // rolled its windows, and calling Date.now() during a client render would
  // make the value differ between the server and hydration passes.
  const spendable = availableCredits(credits);
  // Spending is walled when not even the cheapest billable action fits. Which
  // limit did it — balance, weekly cap or monthly cap — comes from the same
  // ladder assessCharge uses, so this card names exactly what the server would
  // refuse on rather than guessing from whichever meter looks fullest.
  const probeCost = CREDIT_COSTS.chatMessage;
  const blocked = spendable < probeCost;
  const bindingLimit = bindingCreditLimit(credits, probeCost);
  const blockReason = CREDIT_BLOCK_REASON[bindingLimit];

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
      setError("Something went wrong. Please try again.");
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
      setError("Something went wrong. Please try again.");
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
            AI actions (agent runs, copilot messages, task executions, doc corrections) spend credits.
          </p>
          {/* The subtitle named the actions but never their prices, so the
              ledger — a record of what you have ALREADY been charged — was the
              only place in the product that told a client what anything costs.
              Rendered from the pricing constants, never a hand-typed copy. */}
          <p className="mt-1 text-xs text-muted-2">
            Copilot message {CREDIT_COSTS.chatMessage} · doc correction{" "}
            {CREDIT_COSTS.targetedCorrection} · agent run from {CREDIT_COSTS.customAgentRun}.
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-2xl font-semibold">{spendable}</p>
          <p className="text-xs text-muted-2">credits available</p>
          {/* The headline used to be credits.balance, which is NOT what the
              client can spend: assessCharge clips it by the weekly/monthly caps.
              With a cap binding, this card promised 180 while the Agents page
              said 0 and every Run button was dead. The raw balance is still
              worth showing — it's what a cap release would hand back — but it
              is the secondary number now. */}
          {spendable !== credits.balance && (
            <p className="mt-0.5 text-[11px] text-muted-2">{credits.balance} on balance</p>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <UsageMeter
          label="Used this week"
          spent={credits.weekSpent}
          limit={credits.weeklyLimit}
          resetNote={CREDIT_WINDOW_RESET.weekly_limit}
        />
        <UsageMeter
          label="Used this month"
          spent={credits.monthSpent}
          limit={credits.monthlyLimit}
          resetNote={CREDIT_WINDOW_RESET.monthly_limit}
        />
      </div>

      {/* Full price list, collapsed. Native <details> so it needs no state and
          is keyboard-operable and open-by-default for anyone printing or using
          a reader that ignores the disclosure. */}
      <details className="group mt-4 rounded-md border border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs text-muted transition-colors hover:text-foreground">
          <span className="flex items-center gap-1.5">
            <Icon name="Receipt" className="h-3.5 w-3.5 text-muted-2" />
            What actions cost
          </span>
          <Icon
            name="ChevronDown"
            className="h-3.5 w-3.5 shrink-0 text-muted-2 transition-transform group-open:rotate-180"
          />
        </summary>
        <ul className="divide-y divide-border border-t border-border">
          {PRICE_ROWS.map((row) => (
            <li key={row.label} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 text-xs text-muted">
                {row.label}
                {row.note && <span className="ml-1 text-[11px] text-muted-2">({row.note})</span>}
              </span>
              <span className="shrink-0 font-mono text-xs text-foreground">{row.price}</span>
            </li>
          ))}
        </ul>
      </details>

      {/* Hitting a cap used to be silent: two meters, one of them red, and no
          sentence anywhere. The wording already existed but only ever appeared
          AFTER an action failed, inside assessCharge's denial. `blocked` is the
          real condition — availableCredits clips the balance by both caps, so a
          maxed weekly window and an empty balance both land here — and the line
          is creditBlockReason at the cheapest billable action, i.e. the limit
          the server would cite for their very next spend. */}
      {blocked && (
        <div className="mt-4 flex flex-wrap items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
          <Icon name="Lock" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs font-medium text-foreground">{blockReason}</p>
            {/* "until then" only parses when the reason named a reset day. A
                balance shortfall has no date attached — it lifts on a top-up,
                not on a Monday — so that sentence has to end differently. */}
            <p className="text-xs text-muted">
              Agent runs, copilot messages, task executions and doc corrections are paused
              {bindingLimit === "insufficient_balance" ? " until credits are added." : " until then."}
            </p>
            {viewer && (
              <div className="pt-1">
                <ContactUsButton
                  variant="row"
                  userName={viewer.name}
                  userEmail={viewer.email}
                  label={
                    bindingLimit === "insufficient_balance"
                      ? "Request more credits"
                      : "Ask about your limit"
                  }
                />
              </div>
            )}
          </div>
        </div>
      )}

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

      {/* §6.2(a). "Recent activity" answers "what happened last"; it has never
          answered "what am I paying for", which is the question a client
          actually brings to this page. Spend per agent, split into the setup
          they paid once for, the schedule they chose, and the runs they started
          themselves — the three things they can act on. Aggregated server-side
          over the whole ledger, not over the capped feed below. */}
      {spendByAgent && spendByAgent.length > 0 && (
        <div className="mt-5 border-t border-border pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-2">
            Where your credits went
          </p>
          <ul className="divide-y divide-border">
            {spendByAgent.map((row) => (
              <li key={row.agentId ?? "__none__"} className="py-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm text-foreground">{row.agentName}</p>
                  <span className="shrink-0 font-mono text-xs text-muted">{row.credits}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  {row.buckets.map((bucket) => (
                    <span key={bucket.bucket} className="text-[11px] text-muted-2">
                      {CREDIT_BUCKET_LABEL[bucket.bucket]}
                      <span className="ml-1 font-mono">{bucket.credits}</span>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

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
