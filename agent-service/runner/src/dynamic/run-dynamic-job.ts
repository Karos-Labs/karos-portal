import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DynamicRunReport, JobSpec, JobUsage, RunnerCompleteBody } from "../../../src/types.js";
import type { DynamicAgentJobPayload } from "../../../src/dynamic-types.js";
import { prepareWorkspace } from "../workspace.js";
import { collectArtifacts, guessContentType, snapshotOutputs } from "../artifacts.js";
import { ServiceCallback } from "../callback.js";
import { restoreCheckpoint, saveCheckpoint } from "../checkpoint.js";
import { TranscriptStreamer } from "../transcript.js";
import { runDynamicSteps, type DynamicRunResumeState, type DynamicStepTraceEntry } from "./step-runner.js";

/**
 * Everything main.ts needs to route a `specSnapshot` brief through the
 * generic execution engine instead of the hardcoded per-task-type path.
 * Kept as its own module (not inlined into main.ts) so it can be unit-tested
 * independently of the SDK's `query()` and of a live agent-service backend.
 *
 * Reuses the SAME workspace-prep / artifact-collection machinery the
 * hardcoded path uses (prepareWorkspace, collectArtifacts, uploadArtifact)
 * rather than inventing a parallel output channel: a dynamic agent's final
 * output and per-step trace are written as files under
 * `clients/<slug>/outputs/dynamic-agent/<runFolder>/{client,internal}/`, and
 * the EXISTING artifact diff/upload/webhook pipeline carries them to the
 * Portal exactly like any hardcoded custom-agent deliverable — so the
 * webhook handler, Asset creation, and the job detail page need no changes
 * at all to display a dynamic-agent run's result.
 */
export async function runDynamicJob(
  spec: JobSpec,
  payload: DynamicAgentJobPayload,
  callback: ServiceCallback,
): Promise<RunnerCompleteBody> {
  const workspace = await prepareWorkspace({
    bakedRepoDir: process.env.AGENTS_REPO_DIR ?? "/opt/karos-agents",
    workDir: process.env.WORK_DIR ?? "/work",
    clientId: spec.clientId,
    ...(spec.clientSlug ? { clientSlug: spec.clientSlug } : {}),
  });

  // Deterministic across attempts (no date component): a resumed attempt
  // needs to find a PRIOR attempt's internal/trace.json + partial-outputs.json
  // at this exact path after restoreCheckpoint downloads them, without
  // knowing which calendar day the first attempt ran on.
  const runFolder = `job-${spec.jobId.slice(0, 8)}`;
  const outDir = path.join(workspace.repoDir, "clients", workspace.clientSlug, "outputs", "dynamic-agent", runFolder);
  const clientDir = path.join(outDir, "client");
  const internalDir = path.join(outDir, "internal");
  await mkdir(clientDir, { recursive: true });
  await mkdir(internalDir, { recursive: true });

  const resumeFrom =
    spec.attempt > 1 ? await recoverResumeState(callback, workspace.repoDir, internalDir) : undefined;

  // Snapshotted AFTER restoring the prior attempt's checkpoint (above), not
  // before: `collectArtifacts` below treats anything absent from `before` as
  // a NEW deliverable of THIS attempt. A restored-but-not-rewritten file —
  // most importantly the prior attempt's own INCOMPLETE.md — must count as
  // already-there, or a resume that goes on to SUCCEED would re-upload that
  // stale "this run did not finish" file as a fresh client-facing artifact
  // alongside the real output. Restored files that DO get rewritten this
  // attempt (trace.json, partial-outputs.json, a re-failed INCOMPLETE.md)
  // still show up as changed — collectArtifacts diffs by size/mtime, and a
  // rewrite always changes at least the mtime.
  const before = await snapshotOutputs(workspace.repoDir, workspace.clientSlug);

  // SAME transcript streamer the hardcoded path uses (main.ts), so
  // `/v1/jobs/:id/transcript` and the Portal's transcript viewer work
  // identically for a dynamic run: every AI step's raw SDK message log
  // (assistant text, tool calls, the result message) is batched and flushed
  // here, not just the step-progress events a dynamic run also emits.
  const transcript = new TranscriptStreamer(callback);

  try {
    const result = await runDynamicSteps(payload.specSnapshot, payload.inputs, {
      // Per-step model routing rides the brief's existing `step_models` field.
      // `payload.stepModels` is that map (stepId -> alias), threaded from the
      // brief by main.ts; the step runner prefers it over the snapshot's own
      // step.model. See resolveStepModel() in step-runner.ts.
      stepModels: payload.stepModels,
      ...(resumeFrom ? { resumeFrom } : {}),
      onProgress: (event) => {
        // Live progress goes into the SAME transcript stream the SDK's own
        // messages flow through, so a run can be watched while it is still
        // going. The DURABLE copy the Portal renders its step bar from is the
        // structured `dynamicRun` report returned below — see DynamicRunReport
        // in src/types.ts. `reportStepProgress` is the ADDITIONAL live channel
        // that reaches the Portal's Job doc (job.step_progress webhook) before
        // the run finishes — best-effort, see callback.ts's doc comment.
        transcript.append({ type: "dynamic_step_progress", ...event });
        void callback.reportStepProgress({ stepId: event.stepId, stepName: event.label, status: event.status });
      },
      onTranscriptMessage: (message) => transcript.append(message),
    });

    await writeFile(path.join(internalDir, "trace.json"), JSON.stringify(result.trace, null, 2));

    // Run-level usage total (tokens + cost per model), summed across every AI
    // step by runDynamicSteps via the same mergeJobUsage the hardcoded path
    // uses across retry attempts. `report.usage`/`report.model` are the SAME
    // fields the hardcoded path (main.ts) populates, so the rest of the
    // pipeline (worker.ts's buildWebhookPayload, the Portal's webhook route,
    // cost/usage logging) needs NO changes to pick this up for dynamic runs.
    const usageFields = usageReportFields(result.usage);

    if (!result.ok) {
      // DECISION: persist the partial context so far and surface it as an
      // incomplete deliverable rather than discarding it.
      await writeFile(
        path.join(internalDir, "partial-outputs.json"),
        JSON.stringify(result.partialOutputs ?? {}, null, 2),
      );
      await writeFile(
        path.join(clientDir, "INCOMPLETE.md"),
        `# This run did not finish\n\nFailed at step \`${result.failedStepId ?? "unknown"}\`: ${result.error ?? "unknown error"}\n\nPartial output from earlier steps is in this run's internal trace.\n`,
      );
      await uploadArtifacts(callback, workspace.repoDir, workspace.clientSlug, before);
      // Preserve this attempt's whole output tree — including the
      // trace.json/partial-outputs.json just written above — so a retried
      // attempt can resume from `result.failedStepId` instead of re-running
      // every step (and re-billing every step's tokens) from scratch. Mirrors
      // what main.ts's hardcoded path already does in its own finally block.
      await saveCheckpoint(callback, workspace.repoDir, workspace.clientSlug, spec.attempt).catch((err) => {
        console.warn("dynamic-agent checkpoint save failed:", err instanceof Error ? err.message : err);
      });
      return {
        outcome: "failed",
        error: `failed at step "${result.failedStepId ?? "unknown"}": ${result.error ?? "unknown error"}`,
        transient: false,
        agentsRepoSha: workspace.agentsRepoSha,
        dynamicRun: buildRunReport(payload, result),
        ...usageFields,
      };
    }

    await writeFile(path.join(internalDir, "outputs.json"), JSON.stringify(result.outputs ?? {}, null, 2));
    await writeFile(path.join(clientDir, "output.md"), finalOutputMarkdown(result.finalOutput, result.trace));

    await uploadArtifacts(callback, workspace.repoDir, workspace.clientSlug, before);

    return {
      outcome: "done",
      transient: false,
      agentsRepoSha: workspace.agentsRepoSha,
      dynamicRun: buildRunReport(payload, result),
      ...usageFields,
    };
  } finally {
    await transcript.close();
  }
}

/**
 * Best-effort recovery of a prior attempt's checkpoint. Any failure — nothing
 * checkpointed yet, a missing/corrupt file — just means this attempt starts
 * fresh, exactly like attempt 1; it is never a hard error.
 */
async function recoverResumeState(
  callback: ServiceCallback,
  repoDir: string,
  internalDir: string,
): Promise<DynamicRunResumeState | undefined> {
  try {
    await restoreCheckpoint(callback, repoDir);
    const [traceRaw, outputsRaw] = await Promise.all([
      readFile(path.join(internalDir, "trace.json"), "utf8"),
      readFile(path.join(internalDir, "partial-outputs.json"), "utf8"),
    ]);
    const priorTrace = (JSON.parse(traceRaw) as DynamicStepTraceEntry[]).filter((entry) => entry.status === "done");
    const outputs = JSON.parse(outputsRaw) as Record<string, unknown>;
    return {
      completedStepIds: new Set(priorTrace.map((entry) => entry.stepId)),
      outputs,
      priorTrace,
    };
  } catch (err) {
    console.warn("dynamic-agent checkpoint restore skipped:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Mirrors main.ts's `report.usage`/`report.model` assignment off a result message's usage. */
function usageReportFields(usage: JobUsage | undefined): { usage?: JobUsage; model?: string } {
  if (!usage) return {};
  const models = Object.keys(usage.models);
  return models.length > 0 ? { usage, model: models.join(",") } : { usage };
}

/**
 * The structured, persisted half of the per-step report. `stderr` is
 * deliberately NOT carried: it is a raw engine diagnostic that only belongs in
 * the internal trace artifact, never on a document the Portal renders from.
 */
function buildRunReport(
  payload: DynamicAgentJobPayload,
  result: Awaited<ReturnType<typeof runDynamicSteps>>,
): DynamicRunReport {
  const report: DynamicRunReport = {
    specId: payload.specId,
    specVersion: payload.specVersion,
    steps: result.trace.map((entry) => ({
      stepId: entry.stepId,
      type: entry.type,
      label: entry.label,
      status: entry.status,
      durationMs: entry.durationMs,
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.usage ? { usage: entry.usage } : {}),
    })),
  };
  if (result.failedStepId !== undefined) report.failedStepId = result.failedStepId;
  if (result.failedStepIndex !== undefined) report.failedStepIndex = result.failedStepIndex;
  const partial = result.partialOutputs ?? {};
  if (Object.keys(partial).length > 0) report.hasPartialOutput = true;
  return report;
}

async function uploadArtifacts(
  callback: ServiceCallback,
  repoDir: string,
  clientSlug: string,
  before: Awaited<ReturnType<typeof snapshotOutputs>>,
): Promise<void> {
  const { artifacts, skipped } = await collectArtifacts(repoDir, clientSlug, before);
  for (const s of skipped) console.warn(`artifact skipped: ${s}`);
  for (const artifact of artifacts) {
    const contentType = guessContentType(artifact.relPath);
    await callback.uploadArtifact({
      absPath: artifact.absPath,
      relPath: artifact.relPath,
      clientFacing: artifact.clientFacing,
      ...(contentType ? { contentType } : {}),
    });
  }
}

function finalOutputMarkdown(finalOutput: unknown, trace: DynamicStepTraceEntry[]): string {
  const lastStep = trace[trace.length - 1];
  const body = typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput, null, 2);
  return `# ${lastStep?.label ?? "Agent output"}\n\n${body}\n`;
}
