"use client";

import { useState, useTransition } from "react";
import { Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { getLaunchCalibrationAction } from "@/lib/actions/agent-economics-actions";
import type { AgentEconomics, LaunchCalibration } from "@/lib/credit-reporting";

/**
 * What this client's agent has COST US, in dollars (§6.2b) — and what a setup
 * run costs relative to a normal one, measured (§6.3).
 *
 * Staff-only by construction: it is mounted only from the staff branch of the
 * agents page, and the cross-client measurement behind the button is a
 * requireStaff action. Nothing here is a client-facing number — the client's
 * side of the same question is credits, on their settings page.
 *
 * This is the "493 onboarding runs at ~$8.5" visibility Albert asked for,
 * scoped to one client agent. Legacy jobs get their own honestly-labelled
 * bucket rather than being folded into a run average they would bias.
 */
export function AgentEconomicsCard({
  customAgentId,
  agentName,
  economics,
  launchCreditCost,
  viewerIsStaff,
}: {
  customAgentId: string;
  agentName: string;
  /** This client's spend on this agent. */
  economics: AgentEconomics;
  /** The price currently set on the lab agent, for comparison. */
  launchCreditCost: number | null;
  /**
   * Required, not defaulted — every raw-$ figure in this card is internal
   * cost data a CLIENT_USER must never see (item 3's role-based cost
   * abstraction). The call site already only mounts this component for
   * staff, but that's a positional guarantee; this is the structural one —
   * a future caller that forgets its own `isStaff` check still can't render
   * a dollar figure to a client by accident.
   */
  viewerIsStaff: boolean;
}) {
  const [calibration, setCalibration] = useState<LaunchCalibration | null>(null);
  const [creditCost, setCreditCost] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Hooks above run unconditionally (Rules of Hooks) — this gate short-circuits
  // everything after them, before any $ figure is built or rendered.
  if (!viewerIsStaff) return null;

  const rows: Array<{ label: string; runs: number; usd: number }> = [
    { label: "Setup", ...economics.launch },
    { label: "Scheduled runs", ...economics.scheduled },
    { label: "Runs started by hand", ...economics.manual },
    { label: "Test runs (Control Room)", ...economics.test },
    { label: "Before run-type tracking", ...economics.untyped },
  ].filter((row) => row.runs > 0);

  function measure() {
    setError(null);
    startTransition(async () => {
      const result = await getLaunchCalibrationAction(customAgentId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setCalibration(result.calibration ?? null);
      setCreditCost(result.creditCost ?? null);
    });
  }

  return (
    <div className="rounded-[var(--radius)] border border-border bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-foreground">
          <Icon name="Coins" className="h-3.5 w-3.5 text-muted-2" />
          What {agentName} has cost
        </p>
        <span className="font-mono text-xs text-muted">${economics.totalUsd.toFixed(2)}</span>
      </div>

      {rows.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted-2">
          No runs with a reported cost yet.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-muted-2">
                {row.label}
                <span className="ml-1 text-muted-2">
                  ({row.runs} run{row.runs === 1 ? "" : "s"})
                </span>
              </span>
              <span className="font-mono text-muted">${row.usd.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 border-t border-border/60 pt-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-muted-2">
            Launch price now:{" "}
            {launchCreditCost != null ? (
              <span className="font-mono text-foreground">{launchCreditCost} credits</span>
            ) : (
              <span className="text-warning">not set. Clients cannot launch it</span>
            )}
          </p>
          <Button size="sm" variant="ghost" onClick={measure} loading={pending} disabled={pending}>
            <Icon name="Ruler" className="h-3.5 w-3.5" /> Measure
          </Button>
        </div>

        {calibration && (
          <div className="mt-2 rounded-md border border-border bg-surface-2/70 px-2.5 py-2">
            {calibration.ratio == null ? (
              /* Never a fallback multiplier — the whole point of the ruling is
                 that the price comes from measurement, so "not measurable yet"
                 is the honest answer and staff launches are what fix it. */
              <p className="text-[11px] text-muted-2">
                Not measurable yet · {calibration.launchRuns} setup run
                {calibration.launchRuns === 1 ? "" : "s"} and {calibration.runRuns} normal run
                {calibration.runRuns === 1 ? "" : "s"} with a reported cost, across all clients.
                Staff launches are free and are what produce this measurement.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[11px] text-foreground">
                    A setup costs{" "}
                    <span className="font-mono">{calibration.ratio.toFixed(1)}×</span> a normal run
                  </p>
                  {calibration.provisional && <Badge tone="warning">Thin sample</Badge>}
                </div>
                <p className="mt-1 text-[11px] text-muted-2">
                  ${calibration.launchAvgUsd?.toFixed(2)} avg over {calibration.launchRuns} setup
                  {calibration.launchRuns === 1 ? "" : "s"} vs $
                  {calibration.runAvgUsd?.toFixed(2)} avg over {calibration.runRuns} run
                  {calibration.runRuns === 1 ? "" : "s"}, across all clients.
                </p>
                {calibration.suggestedLaunchCredits != null && (
                  <p className="mt-1.5 text-[11px] text-foreground">
                    Suggested launch price:{" "}
                    <span className="font-mono text-neon">
                      {calibration.suggestedLaunchCredits} credits
                    </span>
                    {creditCost != null && (
                      <span className="text-muted-2"> ({calibration.ratio.toFixed(1)} × {creditCost})</span>
                    )}
                    . Set it on the agent in the Agents library.
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {error && <p className="mt-2 text-[11px] text-warning">{error}</p>}
      </div>
    </div>
  );
}
