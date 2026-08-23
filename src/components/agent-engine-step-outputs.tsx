"use client";

import { useState } from "react";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { JobTranscript, TranscriptCount } from "@/components/job-transcript";
import type { AgentStepTranscript, StepOutputPreview } from "@/lib/agent-engine/step-transcript";

/**
 * What each step of an agent-engine run actually produced — the reasoning
 * transcript for its agent steps, and the recorded output for everything else.
 *
 * The transcript half renders through `<JobTranscript>`, the SAME component the
 * legacy agent-service transcript uses, because `step-transcript.ts` projects
 * the engine's `AgentExecutionResult` into that component's own
 * `TranscriptTurn` shape. Two delivery paths, two sources of transcript data,
 * one renderer — a second one would drift, and the first symptom would be the
 * two paths disagreeing about what "thinking" looks like.
 *
 * Everything is collapsed by default and nothing is fetched: both halves are
 * projections of records the panel already read, capped server-side before they
 * crossed into this component (see `stepOutputPreviews`).
 */
export function AgentEngineStepOutputs({
  transcripts,
  previews,
}: {
  transcripts: Array<{ stepId: string; transcript: AgentStepTranscript }>;
  previews: StepOutputPreview[];
}) {
  if (transcripts.length === 0 && previews.length === 0) return null;

  return (
    <div className="mt-5 space-y-4 border-t border-border pt-4">
      {transcripts.length > 0 && (
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-2">Agent reasoning</p>
            <p className="mt-0.5 text-xs text-muted-2">
              What each AI step reasoned and the tools it ran — read off the step&apos;s own checkpoint, not a separate log.
            </p>
          </div>
          {transcripts.map(({ stepId, transcript }) => (
            <StepTranscript key={stepId} stepId={stepId} transcript={transcript} />
          ))}
        </div>
      )}

      {previews.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-2">Step outputs</p>
          {previews.map((preview) => (
            <OutputDisclosure key={preview.stepId} preview={preview} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A non-`completed` execution status is the thing a reader most needs to see about an agent step, so it wears the tone rather than sitting in the JSON. */
const EXECUTION_STATUS_TONE: Readonly<Record<string, "success" | "warning" | "danger">> = {
  completed: "success",
  content_fail: "warning",
  budget_exceeded: "warning",
  tooling_error: "danger",
};

function StepTranscript({ stepId, transcript }: { stepId: string; transcript: AgentStepTranscript }) {
  const [open, setOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const status = transcript.executionStatus;

  return (
    <div className="rounded-lg border border-border/60 bg-surface-2/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-2 px-2.5 py-2 text-left"
      >
        <Icon name="Brain" className="h-3.5 w-3.5 shrink-0 text-neon-dim" />
        <span className="text-xs font-medium">{stepId}</span>
        {status && <Badge tone={EXECUTION_STATUS_TONE[status] ?? "neutral"}>{status.replace(/_/g, " ")}</Badge>}
        <TranscriptCount turns={transcript.turns} />
        {transcript.inputTokens !== undefined && (
          <span className="text-xs text-muted-2">
            {transcript.inputTokens.toLocaleString()} / {(transcript.outputTokens ?? 0).toLocaleString()} tokens
          </span>
        )}
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-2" />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border/60 px-2.5 py-3">
          <JobTranscript turns={transcript.turns} truncated={transcript.truncated} />

          {/* The structured object the agent returned. Separate from the turns
              above because it is not a turn — it is what the step handed back to
              the workflow, and it is what every later step and the deliverable
              itself were built from. */}
          {transcript.finalOutput && (
            <div className="rounded-lg border border-border/60 bg-surface-2/40">
              <button
                type="button"
                onClick={() => setOutputOpen((v) => !v)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
              >
                <Icon name="FileCheck" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
                <span className="text-xs font-medium text-muted-2">Final output</span>
                <Icon
                  name={outputOpen ? "ChevronDown" : "ChevronRight"}
                  className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-2"
                />
              </button>
              {outputOpen && (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border/60 p-2.5 text-[11px] leading-relaxed text-muted">
                  {transcript.finalOutput}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OutputDisclosure({ preview }: { preview: StepOutputPreview }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border/60 bg-surface-2/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Icon
          name={preview.kind === "gate" ? "UserCheck" : "Code"}
          className="h-3.5 w-3.5 shrink-0 text-muted-2"
        />
        <span className="min-w-0 truncate text-xs font-medium text-muted">{preview.stepId}</span>
        {preview.kind === "gate" && <Badge tone="info">human</Badge>}
        {!open && <span className="min-w-0 flex-1 truncate text-xs text-muted-2">{firstLine(preview.json)}</span>}
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-2" />
      </button>
      {open && (
        <>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border/60 p-2.5 text-[11px] leading-relaxed text-muted">
            {preview.json}
          </pre>
          {preview.truncated && (
            <p className="px-2.5 pb-2 text-[11px] text-muted-2">Output truncated for display.</p>
          )}
        </>
      )}
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() && !/^[[{]$/.test(l.trim())) ?? "";
  const trimmed = line.trim();
  return trimmed.length > 100 ? `${trimmed.slice(0, 100)}…` : trimmed;
}
