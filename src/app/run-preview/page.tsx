import { notFound } from "next/navigation";
import { AgentRunProgress } from "@/components/client-agents/run-progress";
import { phaseProgress } from "@/lib/agent-run-phases";

/**
 * DEV ONLY. A look at the client's run-progress surface without needing a live
 * run to be mid-flight — the states it has to be right in are exactly the ones
 * that are hardest to catch by hand, because each lasts a few seconds.
 *
 * `notFound()` in production rather than a flag: this renders no client data
 * and guards nothing, so the safe default is that it does not exist off a
 * developer's machine.
 */
export default function RunPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();

  // The real Instagram run, step by step (agentEngineRuns, 2026-09-09).
  const walk: Array<{ caption: string; stepId: string; kind: string }> = [
    { caption: "just submitted · nothing reported yet", stepId: "", kind: "" },
    { caption: "00-auto-setup", stepId: "00-auto-setup", kind: "code" },
    { caption: "04b-research-extract-facts", stepId: "04b-research-extract-facts", kind: "agent" },
    { caption: "05-write-copy-attempt-1", stepId: "05-write-copy-attempt-1", kind: "agent" },
    { caption: "08-render-carousel-attempt-1", stepId: "08-render-carousel-attempt-1", kind: "code" },
    { caption: "07d-dedupe-check-attempt-1", stepId: "07d-dedupe-check-attempt-1", kind: "code" },
    { caption: "09a-batch-review-r0 (the human gate)", stepId: "09a-batch-review-r0", kind: "gate" },
  ];

  return (
    <div className="min-h-screen bg-background p-6 text-foreground md:p-10">
      <div className="mx-auto w-full max-w-3xl">
        <h1 className="text-xl font-semibold">Run progress · what the client sees</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Replaces the dialog that said the work would be ready in about 30 minutes and invited you
          to close the page. Driven by the step ids agent-engine really writes; the six phases are
          in <code className="text-xs">lib/agent-run-phases.ts</code>.
        </p>

        <div className="mt-8 space-y-8">
          {walk.map((w) => {
            const p = phaseProgress(
              w.stepId ? { currentStepId: w.stepId, currentStepKind: w.kind } : {},
            );
            return (
              <div key={w.caption}>
                <p className="mb-2 font-mono text-[11px] text-muted-2">{w.caption}</p>
                <AgentRunProgress
                  steps={p.phases.map((x) => ({ id: x.id, label: x.label, state: x.state }))}
                  headline={p.headline}
                  done={p.done}
                  total={p.total}
                />
              </div>
            );
          })}

          <div>
            <p className="mb-2 font-mono text-[11px] text-muted-2">
              finished
            </p>
            {(() => {
              const p = phaseProgress({ finished: true });
              return (
                <AgentRunProgress
                  steps={p.phases.map((x) => ({ id: x.id, label: x.label, state: x.state }))}
                  headline={p.headline}
                  done={p.done}
                  total={p.total}
                  finished
                />
              );
            })()}
          </div>

          <div>
            <p className="mb-2 font-mono text-[11px] text-muted-2">
              no honest denominator · the indeterminate sweep
            </p>
            <AgentRunProgress steps={[]} headline="Writing the copy" done={0} total={null} />
          </div>
        </div>
      </div>
    </div>
  );
}
