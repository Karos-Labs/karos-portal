"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import { runDynamicAgentAction } from "@/lib/actions";
import type { DynamicAgentInputDef, DynamicAgentInputValue } from "@/lib/types";
import { DynamicAgentIntakeForm } from "@/components/dynamic-agent-intake-form";
import { INTAKE_ACTION_FAILED, intakeSave } from "@/lib/intake-save";
import { IntakeRunError } from "@/components/intake-run-error";
import { clientArchiveLink } from "@/lib/agent-intake-links";
import { RUN_ESTIMATE_SENTENCE } from "@/lib/run-estimate";

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
 * WHAT IT DOES NOW is what the six lab intake surfaces do: the press resolves
 * IN PLACE into a run-started card that says how long the run takes and where
 * the output lands. Nothing about the run itself changed — same action, same
 * charge, same job.
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
  clientId,
  inputSchema,
  creditsCost,
  priceIsEstimate = false,
  viewerIsBilled = true,
  isStaff = false,
}: {
  specId: string;
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
  /** Which archive route this reader can actually open — see clientArchiveLink. */
  isStaff?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [pending, startTransition] = useTransition();
  const archive = clientArchiveLink({ clientId, isStaff });

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
      setStarted(true);
    });
  }

  if (started) {
    return (
      <Card>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Your run has started</CardTitle>
          <Badge tone="success">Running</Badge>
        </div>
        <p className="mt-1 flex items-start gap-2 text-sm text-muted">
          <Icon name="CircleCheck" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <span>
            The agent is working. This takes {RUN_ESTIMATE_SENTENCE}, and the finished work appears
            in{" "}
            <a href={archive.href} className="underline hover:text-foreground">
              {archive.label}
            </a>{" "}
            once your Karos team has approved it. You can close this page; the run keeps going.
          </span>
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
