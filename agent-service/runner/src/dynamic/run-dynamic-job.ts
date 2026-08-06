import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DynamicRunReport, JobSpec, RunnerCompleteBody } from "../../../src/types.js";
import type { DynamicAgentJobPayload } from "../../../src/dynamic-types.js";
import { prepareWorkspace } from "../workspace.js";
import { collectArtifacts, guessContentType, snapshotOutputs } from "../artifacts.js";
import { ServiceCallback } from "../callback.js";
import { runDynamicSteps, type DynamicStepTraceEntry } from "./step-runner.js";

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

  const before = await snapshotOutputs(workspace.repoDir, workspace.clientSlug);

  const isoDate = new Date().toISOString().slice(0, 10);
  const runFolder = `${isoDate}-job-${spec.jobId.slice(0, 8)}`;
  const outDir = path.join(workspace.repoDir, "clients", workspace.clientSlug, "outputs", "dynamic-agent", runFolder);
  const clientDir = path.join(outDir, "client");
  const internalDir = path.join(outDir, "internal");
  await mkdir(clientDir, { recursive: true });
  await mkdir(internalDir, { recursive: true });

  const result = await runDynamicSteps(payload.specSnapshot, payload.inputs, {
    // Per-step model routing rides the brief's existing `step_models` field.
    // `payload.stepModels` is that map (stepId -> alias), threaded from the
    // brief by main.ts; the step runner prefers it over the snapshot's own
    // step.model. See resolveStepModel() in step-runner.ts.
    stepModels: payload.stepModels,
    onProgress: (event) => {
      // Live progress goes into the SAME transcript stream the SDK's own
      // messages flow through (TranscriptStreamer, wired by main.ts), so a
      // run can be watched while it is still going. The DURABLE copy the
      // Portal renders its step bar from is the structured `dynamicRun`
      // report returned below — see DynamicRunReport in src/types.ts.
      callback.appendTranscript(`${JSON.stringify({ type: "dynamic_step_progress", ...event })}\n`).catch(() => {
        // best-effort — the job's outcome doesn't depend on progress delivery
      });
    },
  });

  await writeFile(path.join(internalDir, "trace.json"), JSON.stringify(result.trace, null, 2));

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
    return {
      outcome: "failed",
      error: `failed at step "${result.failedStepId ?? "unknown"}": ${result.error ?? "unknown error"}`,
      transient: false,
      agentsRepoSha: workspace.agentsRepoSha,
      dynamicRun: buildRunReport(payload, result),
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
  };
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
