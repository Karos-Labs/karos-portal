"use client";

import { useState, useTransition } from "react";
import { Button, Card, CardTitle } from "@/components/ui";
import { runDynamicAgentAction } from "@/lib/actions";
import type { DynamicAgentInputDef, DynamicAgentInputValue } from "@/lib/types";
import { DynamicAgentIntakeForm } from "@/components/dynamic-agent-intake-form";
import { INTAKE_ACTION_FAILED, intakeSave } from "@/lib/intake-save";
import { IntakeRunError } from "@/components/intake-run-error";
import { AgentRunProgress } from "@/components/client-agents/run-progress";
import { useRunWatchActions, useShowRunInPage, useWatchedRun, watchedOutcome } from "@/components/run-watch";
import { runOutcomeSentence } from "@/lib/run-progress";

/**
 * The one explicit "Run" button a client can press in the portal, and until the
 * flow audit (2026-09, R2) it ended by throwing them out of the app.
 *
 * WHAT IT USED TO DO. On success it called `router.push('/jobs/{jobId}')`.
 * `/jobs/[id]` is staff-guarded, so a CLIENT_USER was bounced `/jobs/{id}` →
 * `/dashboard` → `/clients/{id}`: they pressed Run, paid for a run, and landed
 * on Home with no acknowledgement that anything had happened. The confirmation
 * it left behind — `"Submitted, job {jobId}."` — was a raw database id printed
 * on a page the reader was already being navigated away from.
 *
 * WHAT IT DOES NOW is what the agent pages do: the press resolves IN PLACE
 * into the run's progress, the same bar and sentence as their run form, and
 * hands the run to the corner dock so it stays in sight after the reader
 * leaves (2026-09-10). Nothing about the run itself changed — same action,
 * same charge, same job.
 *
 * TWO OTHER THINGS THE PUSH WAS HIDING, both fixed here rather than left for
 * the next reader:
 *
 *  · The action call did not go through `intakeSave`, so a REJECTION (a lapsed
 *    session — `requireClientAccess` throws — a cold container, a dropped
 *    request) escaped the transition with no `result` to read: the button went
 *    back to idle and said nothing. Every other write on a client intake
 *    surface funnels through `intakeSave` and this one is now no exception.
 *  · The action returned the submit core's error verbatim, so
 *    `"Agent service is not configured (AGENT_SERVICE_URL /
 *     AGENT_SERVICE_TOKEN)."` could be printed to a client. That is fixed on
 *    the server, in `runDynamicAgentAction`, behind the same
 *    `clientSafeRunError` allowlist the other run actions use — a filter in the
 *    browser would leak the string into the RSC payload regardless.
 */
export function DynamicAgentRun({
  specId,
  agentName,
  clientId,
  inputSchema,
  creditsCost,
  priceIsEstimate = false,
  viewerIsBilled = true,
  isStaff = false,
}: {
  specId: string;
  /** The spec's name, for the dock's row. */
  agentName: string;
  clientId: string;
  inputSchema: DynamicAgentInputDef[];
  /**
   * `DynamicAgentSpec.creditsCost` — what this press charges a billable client.
   * The submit core freezes it onto the brief's `specSnapshot` and charges it
   * once at job creation, so the figure quoted here is the one at the till.
   */
  creditsCost: number;
  /**
   * Whether the credits rework is on for this deployment
   * (`CREDITS_PLAN_V2_ENABLED`), carried as a PROP because a client component
   * cannot read a non-`NEXT_PUBLIC_` env var.
   *
   * A DYNAMIC RUN IS NOT EXEMPT FROM SETTLEMENT (review wave, 2026-09). The
   * spec's `creditsCost` is what is HELD at job creation, and the webhook then
   * settles it to what the run actually used, exactly as it does for a lab
   * agent — but this was the one run surface still quoting a flat "Costs 20
   * credits" with no hedge, so a client watched a different number leave their
   * balance and had been told, here, that this was the price. The frozen
   * snapshot pins what is CHARGED UPFRONT; it does not exempt the run from the
   * reconciliation every other run goes through.
   */
  priceIsEstimate?: boolean;
  /** `isBillableClientActor()` — decides whose money the quote names, not the figure. */
  viewerIsBilled?: boolean;
  /** Staff read the staff sentences under the progress bar. */
  isStaff?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { watch } = useRunWatchActions();
  const watched = useWatchedRun(started ? startedJobId : null);
  useShowRunInPage(started ? startedJobId : null);

  function handleSubmit(inputs: Record<string, DynamicAgentInputValue>) {
    setError(null);
    startTransition(async () => {
      // Not a save and not an upload: the third funnel sentence, whose remedy
      // is written for a press rather than for a form still on screen.
      const result = await intakeSave(
        () => runDynamicAgentAction(specId, clientId, inputs),
        INTAKE_ACTION_FAILED,
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      const jobId = "jobId" in result ? result.jobId : undefined;
      if (jobId) {
        setStartedJobId(jobId);
        // Home for both readers: its "Generated today" lists the output first.
        watch({ jobId, agentName, noun: "deliverable", href: `/clients/${clientId}` });
      }
      setStarted(true);
    });
  }

  if (started) {
    const outcome = (watched && watchedOutcome(watched)) || "working";
    const headline = watched?.headline;
    return (
      <Card>
        <CardTitle className="mb-3">Your run has started</CardTitle>
        <AgentRunProgress outcome={outcome} {...(headline ? { headline } : {})} />
        <p className="mt-3 text-xs leading-relaxed text-muted">
          {runOutcomeSentence(outcome, !isStaff)}
        </p>
        {/* The way back to a second run, since the form is gone. It resets this
            component's own state rather than reloading: the run that just
            started is not affected either way. */}
        <Button variant="subtle" className="mt-3" onClick={() => setStarted(false)}>
          Run it again
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle className="mb-3">Run this agent</CardTitle>
      <DynamicAgentIntakeForm
        inputSchema={inputSchema}
        clientId={clientId}
        submitting={pending}
        onSubmit={handleSubmit}
        creditsCost={creditsCost}
        priceIsEstimate={priceIsEstimate}
        viewerIsBilled={viewerIsBilled}
      />
      <IntakeRunError error={error} />
    </Card>
  );
}
