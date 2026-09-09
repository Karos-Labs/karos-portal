"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Badge, Label, Input } from "@/components/ui";
import { Icon } from "@/components/icon";
import { adjustCreditsAction, setCreditLimitsAction } from "@/lib/actions";
import { ContactUsButton } from "@/components/contact-us-modal";
import {
  CLIENT_PRICE_ROWS,
  CREDIT_BLOCK_REASON,
  CREDIT_COSTS,
  CREDIT_WINDOW_RESET,
  ESTIMATED_PRICE_NOTE,
  availableCredits,
  bindingCreditLimit,
  clientPriceText,
  settledCreditsLabel,
  CREDIT_BUCKET_LABEL,
} from "@/lib/credits";
import { StaffOnlySection } from "@/components/staff-only-section";
import {
  MONTHLY_COST_ALERT_FRACTION,
  type AgentSpendRow,
  type ClientMonthlyCost,
} from "@/lib/credit-reporting";
import { cn, relativeTime } from "@/lib/utils";
import type { ClientCredits, CreditLedgerEntry, Role } from "@/lib/types";

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
   * When this window's cap lifts - the clause from CREDIT_WINDOW_RESET, so it is
   * the same sentence the denial cites. A client could previously only learn
   * this by hitting the wall, since it lived inside assessCharge's messages.
   */
  resetNote?: string;
}) {
  // A cap of 0 means "no spending allowed" - show it as fully used.
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
          {/* Capitalised clause - the denial renders it mid-sentence. */}
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
  monthlyCost,
  pricesAreEstimates,
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
  /**
   * What this client has actually cost Karos this month, against the $130 line
   * (credits rework, 2026-09). STAFF ONLY, and gated on the SERVER: the settings
   * page passes it only to a staff viewer, so a client's payload never carries
   * our raw cost at all — this is a "use client" component, so anything crossing
   * this boundary is readable from view-source whether the panel paints it or
   * not. The same structural gate `agent-economics.tsx` uses, for the same
   * reason.
   */
  monthlyCost?: ClientMonthlyCost;
  /**
   * Whether this deployment charges an estimate and settles it to real usage
   * (`CREDITS_PLAN_V2_ENABLED`), resolved on the server: this is a `"use
   * client"` component and cannot read a non-`NEXT_PUBLIC_` env var. Wording
   * only — every figure on the card is the same either way.
   */
  pricesAreEstimates?: boolean;
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
  // What the client can actually spend - the same helper the rail and the
  // Agents page use, so the three surfaces can no longer disagree. `now` is
  // omitted deliberately: the doc arrives from getClientCredits, which already
  // rolled its windows, and calling Date.now() during a client render would
  // make the value differ between the server and hydration passes.
  const spendable = availableCredits(credits);
  // Spending is walled when not even the cheapest billable action fits. Which
  // limit did it - balance, weekly cap or monthly cap - comes from the same
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
            AI actions (agent runs, copilot messages, task executions, document corrections) spend credits.
          </p>
          {/* The subtitle named the actions but never their prices, so the
              ledger - a record of what you have ALREADY been charged - was the
              only place in the product that told a client what anything costs.
              Rendered from the pricing constants, never a hand-typed copy.

              "document correction", not "doc correction", in all three places on
              this card: the ledger rows THIS PANEL renders below say "Document
              correction · Brand voice", so the abbreviation put two names for one
              purchase on one screen — the price of it at the top and the record of
              it at the bottom. The Documents tab a client clicks to make the
              correction is not abbreviated either. */}
          <p className="mt-1 text-xs text-muted-2">
            Copilot message from {CREDIT_COSTS.chatMessage} · document correction{" "}
            {CREDIT_COSTS.targetedCorrection} · agent run from {CREDIT_COSTS.customAgentRun}.
          </p>
          {/* THE ONE SENTENCE THAT MAKES THE NUMBERS ABOVE HONEST (credits
              rework, 2026-09). Every figure on this card is now a typical
              price: the charge is reserved when the work starts and reconciled
              to what it actually used when it finishes, which is why a ledger
              row below can read less than the price quoted above it. Read off
              the shared constant, not typed here, so the eleven surfaces that
              quote a price cannot describe the rule eleven ways. */}
          {pricesAreEstimates && (
            <p className="mt-1 text-xs text-muted-2">
              Prices are typical. {ESTIMATED_PRICE_NOTE}
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="stat-number text-2xl font-semibold">{spendable}</p>
          <p className="text-xs text-muted-2">credits available</p>
          {/* The headline used to be credits.balance, which is NOT what the
              client can spend: assessCharge clips it by the weekly/monthly caps.
              With a cap binding, this card promised 180 while the Agents page
              said 0 and every Run button was dead. The raw balance is still
              worth showing - it's what a cap release would hand back - but it
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
          a reader that ignores the disclosure.

          THE ROWS ARE CLIENT_PRICE_ROWS (lib/credits.ts) AND THIS FILE HOLDS NO
          LIST OF ITS OWN. It held one until 2026-08-01 and the copilot's system
          prompt held a second, and both were missing the same entry — the
          one-time agent setup charge, the biggest thing a client pays for. Two
          copies of a rule is two places to leave a line out of.

          These labels are BILLING vocabulary — the priced units a client is
          charged in — and the §7.3 identity helper deliberately does not touch
          them (F147/WP-7). The boundary: identity answers "who made this thing
          in front of me", so a post, a run row and an archive group all have to
          say the same name. A price list answers "what does one of these cost",
          which is a question about the product line and has no piece of content
          and no agent to attribute. Resolving these through an umbrella would
          price "Instagram Agent" and leave a client with a social umbrella
          unable to find the social-post rate at all.

          "Where your credits went" further down IS the identity question, so it
          does resolve through the umbrella — see spendAgentNames on the settings
          page that feeds it. */}
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
          {CLIENT_PRICE_ROWS.map((row) => (
            <li key={row.label} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 text-xs text-muted">
                {row.label}
                {row.note && <span className="ml-1 text-[11px] text-muted-2">({row.note})</span>}
              </span>
              <span className="shrink-0 font-mono text-xs text-foreground">
                {clientPriceText(row)}
              </span>
            </li>
          ))}
        </ul>
      </details>

      {/* Hitting a cap used to be silent: two meters, one of them red, and no
          sentence anywhere. The wording already existed but only ever appeared
          AFTER an action failed, inside assessCharge's denial. `blocked` is the
          real condition - availableCredits clips the balance by both caps, so a
          maxed weekly window and an empty balance both land here - and the line
          is creditBlockReason at the cheapest billable action, i.e. the limit
          the server would cite for their very next spend. */}
      {blocked && (
        <div className="mt-4 flex flex-wrap items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
          <Icon name="Lock" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs font-medium text-foreground">{blockReason}</p>
            {/* "until then" only parses when the reason named a reset day. A
                balance shortfall has no date attached - it lifts on a top-up,
                not on a Monday - so that sentence has to end differently. */}
            <p className="text-xs text-muted">
              Agent runs, copilot messages, task executions and document corrections are paused
              {bindingLimit === "insufficient_balance" ? " until credits are added." : " until then."}
            </p>
            {/* R7 (flow audit 2026-09): ONE label. This control opened the very
                same dialog as the account menu's "Support" while calling itself
                "Request more credits" or "Ask about your limit" — three names
                for one destination, which is the finding. The ask is not lost:
                the two sentences directly above name the limit that is binding
                and what it takes to lift it, and the dialog opens on an empty
                subject the client fills in either way. */}
            {viewer && (
              <div className="pt-1">
                <ContactUsButton variant="row" userName={viewer.name} userEmail={viewer.email} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── What this client actually costs us, beside what they were charged ──
          Staff only, and additive to the client's own card (the parity rule):
          it sits in the shared frame rather than styled like the cards above,
          so a staff member previewing the account can tell at a glance which
          half the client gets.

          WHY TWO LINES AND NOT ONE. Settle-to-actual makes "2600 credits ⇒ no
          more than $130" true by construction for every credit a client is
          CHARGED. Two kinds of real spend never reach the ledger and therefore
          bypass that guarantee: runs nobody billed (staff-fired, View as
          Client, schedules with billClientCredits off) and refunded failures,
          whose tokens are gone even though the credits came back. So the cost
          line can legitimately exceed monthSpent × $0.05, and the GAP BETWEEN
          THE TWO LINES IS THAT LEAK. Showing them side by side is what makes
          it visible instead of assumed. */}
      {monthlyCost && (
        <StaffOnlySection className="mt-5" label="Staff only · what this client costs us">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-2">Cost to us this month</span>
              <span
                className={cn(
                  "font-mono text-sm",
                  monthlyCost.fraction >= 1
                    ? "text-danger"
                    : monthlyCost.fraction >= MONTHLY_COST_ALERT_FRACTION
                      ? "text-warning"
                      : "text-foreground",
                )}
              >
                ${monthlyCost.usd.toFixed(2)} of ${monthlyCost.budgetUsd.toFixed(2)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-2">Client charged</span>
              <span className="font-mono text-sm text-muted">
                {credits.monthSpent}
                {credits.monthlyLimit != null ? ` of ${credits.monthlyLimit}` : ""} credits
              </span>
            </div>
            <p className="text-[11px] text-muted-2">
              {monthlyCost.runs} run{monthlyCost.runs === 1 ? "" : "s"} counted, including
              staff-fired and failed ones.
              {monthlyCost.unpricedRows > 0
                ? ` ${monthlyCost.unpricedRows} usage row${monthlyCost.unpricedRows === 1 ? "" : "s"} could not be priced and ${monthlyCost.unpricedRows === 1 ? "is" : "are"} not counted.`
                : ""}
            </p>
            {monthlyCost.fraction >= MONTHLY_COST_ALERT_FRACTION && (
              <p
                className={cn(
                  "text-[11px]",
                  monthlyCost.fraction >= 1 ? "text-danger" : "text-warning",
                )}
              >
                {monthlyCost.fraction >= 1
                  ? "Over the monthly cost line for this client. Check for unbilled schedules or a failing agent burning runs."
                  : "Past 80% of the monthly cost line for this client."}
              </p>
            )}
          </div>
        </StaffOnlySection>
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
          themselves - the three things they can act on. Aggregated server-side
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
                  {/* A SETTLED RUN SHOWS BOTH FIGURES (credits rework, 2026-09).
                      Without the estimate beside it, a settlement reads as a
                      second, unexplained charge for a run the client already
                      paid for; with it, the row says what the whole two-phase
                      model does. Built from the row's own fields rather than
                      parsed back out of the reason line. `estimateCredits −
                      delta` is what the run finally cost: delta is positive
                      when credits came back. */}
                  {e.kind === "settlement" && e.estimateCredits != null && (
                    <p className="text-xs text-muted-2">
                      {settledCreditsLabel(e.estimateCredits - e.delta, e.estimateCredits)}
                    </p>
                  )}
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
