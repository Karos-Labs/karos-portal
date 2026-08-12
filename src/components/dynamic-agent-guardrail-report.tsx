import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import type { DynamicAgentDedupeReport, DynamicAgentGuardrailReport } from "@/lib/types";

/**
 * Staff-facing findings for a Dynamic Agent Studio run: the topic-guardrail
 * verdict and the output de-duplication verdict (docs/dynamic-agent-guardrails.md).
 *
 * Rendered on the job detail page, which is staff-only
 * (`requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"])`) — deliberately NOT inside
 * DynamicAgentStepProgress, which is the client-legible step bar. A finding
 * here names a forbidden topic and quotes the draft back; both are internal
 * review material, and the step bar's own rule is that raw engine detail never
 * shares a component with something a client reads.
 *
 * Pure render, like the step bar: everything comes from the report already on
 * the job. Returns null when neither feature was active for the run, so a job
 * from before this existed — or one for a client with no guardrails running an
 * agent without the opt-in — renders exactly as it did.
 */
export function DynamicAgentGuardrailReportCard({
  guardrail,
  dedupe,
}: {
  guardrail?: DynamicAgentGuardrailReport;
  dedupe?: DynamicAgentDedupeReport;
}) {
  if (!guardrail && !dedupe) return null;

  return (
    <div className="mb-6 space-y-3 rounded-[var(--radius)] border border-border bg-surface p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">Run checks</p>

      {guardrail ? <GuardrailRow guardrail={guardrail} /> : null}
      {dedupe ? <DedupeRow dedupe={dedupe} /> : null}
    </div>
  );
}

function GuardrailRow({ guardrail }: { guardrail: DynamicAgentGuardrailReport }) {
  const verification = guardrail.verification;
  const tone =
    verification?.status === "violation" ? "danger" : verification?.status === "error" ? "warning" : "success";

  // No verification at all means the run never reached a deliverable to check —
  // a failed pipeline. Say that, rather than showing a green tick for a check
  // that did not run.
  const headline = !verification
    ? "Not checked — the run did not produce a deliverable."
    : verification.status === "violation"
      ? `Flagged: this draft engages with ${verification.violatedTopics.join(", ") || "a restricted topic"}.`
      : verification.status === "error"
        ? "The check could not be completed for this run."
        : "Clean — no restricted topic found in the deliverable.";

  return (
    <Row
      icon={tone === "danger" ? "ShieldAlert" : tone === "warning" ? "CircleAlert" : "ShieldCheck"}
      tone={!verification ? "muted" : tone}
      title="Topic guardrails"
      headline={headline}
    >
      <p className="mt-1 text-[11px] text-muted-2">
        {guardrail.forbiddenTopics.length} topic{guardrail.forbiddenTopics.length === 1 ? "" : "s"} in force
        {guardrail.injectedStepIds.length > 0
          ? ` · applied to ${guardrail.injectedStepIds.length} step${guardrail.injectedStepIds.length === 1 ? "" : "s"}`
          : ""}
      </p>
      {verification?.evidence ? (
        <p className="mt-1.5 border-l-2 border-danger/40 pl-2 text-[11px] italic text-muted">
          “{verification.evidence}”
        </p>
      ) : null}
    </Row>
  );
}

function DedupeRow({ dedupe }: { dedupe: DynamicAgentDedupeReport }) {
  const pct = Math.round(dedupe.maxSimilarity * 100);
  const headline =
    dedupe.status === "no_history"
      ? "No earlier drafts to compare against yet."
      : dedupe.status === "similar"
        ? `Flagged: ${pct}% similar to an earlier draft for this client.`
        : `Distinct — closest earlier draft is ${pct}% similar.`;

  return (
    <Row
      icon={dedupe.status === "similar" ? "CopyCheck" : "Copy"}
      tone={dedupe.status === "similar" ? "warning" : dedupe.status === "no_history" ? "muted" : "success"}
      title="Repetition check"
      headline={headline}
    >
      {dedupe.comparedCount > 0 ? (
        <p className="mt-1 text-[11px] text-muted-2">
          Compared against {dedupe.comparedCount} earlier draft{dedupe.comparedCount === 1 ? "" : "s"} · flags
          above {Math.round(dedupe.threshold * 100)}%
        </p>
      ) : null}
    </Row>
  );
}

const TONE_CHIP: Record<string, string> = {
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  danger: "border-danger/40 bg-danger/10 text-danger",
  muted: "border-border bg-surface-2 text-muted-2",
};

function Row({
  icon,
  tone,
  title,
  headline,
  children,
}: {
  icon: string;
  tone: string;
  title: string;
  headline: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full border", TONE_CHIP[tone])}>
        <Icon name={icon} className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted">{headline}</p>
        {children}
      </div>
    </div>
  );
}
