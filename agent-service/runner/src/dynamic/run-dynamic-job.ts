import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DynamicRunReport, JobSpec, JobUsage, RunnerCompleteBody } from "../../../src/types.js";
import type { DynamicAgentJobPayload } from "../../../src/dynamic-types.js";
import { prepareWorkspace } from "../workspace.js";
import { collectArtifacts, guessContentType, snapshotOutputs } from "../artifacts.js";
import { ServiceCallback } from "../callback.js";
import { restoreCheckpoint, saveCheckpoint } from "../checkpoint.js";
import { TranscriptStreamer } from "../transcript.js";
import { downloadContextFiles } from "../context-files.js";
import { formatError } from "../error-format.js";
import {
  runDynamicSteps,
  type DynamicRunResumeState,
  type DynamicStepTraceEntry,
} from "./step-runner.js";
import { verifyForbiddenTopics } from "./guardrail-verify.js";
import { DEDUPE_SIMILARITY_THRESHOLD, closestMatch } from "./similarity.js";

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

  // Per-AI-step "client data access" grant: pre-fetch this client's own
  // context doc(s) ONCE for the whole run, via the SAME downloadContextFiles
  // the hardcoded path already uses (no second download mechanism) — then
  // read the file back into a string for prompt injection, since a dynamic
  // AI step has no filesystem/tool access to read it itself (see
  // step-runner.ts's own doc comment on why that step type is a pure text
  // completion). Skipped entirely when no step asks for client data, so a run
  // with the grant unused never pays for the download.
  const clientContextText = await resolveClientContextText(payload.specSnapshot, spec, workspace);

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
      // Only ever reaches a step whose OWN spec sets allowClientData — see
      // composePrompt's scoping guarantee in step-runner.ts.
      ...(clientContextText ? { clientContextText } : {}),
      // Topic guardrails and prior-output history, both frozen onto the brief
      // at job creation (docs/dynamic-agent-guardrails.md). Spread away when
      // absent, so a run for a client with no forbidden topics and an agent
      // without the de-duplication opt-in passes exactly the deps it always did.
      ...(payload.guardrails?.forbiddenTopics?.length
        ? { forbiddenTopics: payload.guardrails.forbiddenTopics }
        : {}),
      ...(payload.outputHistory ? { outputHistory: payload.outputHistory.items } : {}),
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
        console.warn("dynamic-agent checkpoint save failed:", formatError(err));
      });
      return {
        outcome: "failed",
        error: `failed at step "${result.failedStepId ?? "unknown"}": ${result.error ?? "unknown error"}`,
        transient: false,
        agentsRepoSha: workspace.agentsRepoSha,
        // A failed run still records WHICH steps carried the guardrail, so an
        // operator can see the constraint was in force up to the failure — but
        // no verification, because there is no deliverable to verify.
        dynamicRun: buildRunReport(payload, result, {
          ...guardrailBase(payload, result.guardrailInjectedStepIds),
        }),
        ...usageFields,
      };
    }

    await writeFile(path.join(internalDir, "outputs.json"), JSON.stringify(result.outputs ?? {}, null, 2));

    // The two engine-owned post-checks, run BEFORE the deliverable is
    // committed to the client-facing folder. A failed pipeline never reaches
    // here at all, so there is always a real deliverable to check.
    //
    // DECISION (2026-08, supersedes the original "flags, never fails"
    // contract in docs/dynamic-agent-guardrails.md §2.3): a topic-guardrail
    // VIOLATION now BLOCKS the run — `outcome: "failed"` below — instead of
    // only annotating a delivered draft. The artifact/asset pipeline is
    // gated on `outcome === "done"` (webhook route.ts), so a blocked run
    // never creates a client-visible asset, and `refundJobCharge` already
    // runs for every non-"done" outcome, so the client is refunded exactly
    // like any other failed run. De-duplication still only flags: it is a
    // similarity signal for a human to weigh, not a correctness violation.
    const deliverable = deliverableText(result.finalOutput);
    const checks = await runPostChecks(payload, result.guardrailInjectedStepIds, deliverable);
    if (checks.guardrail?.verification || checks.dedupe) {
      await writeFile(path.join(internalDir, "run-checks.json"), JSON.stringify(checks, null, 2));
    }

    if (checks.guardrail?.verification?.status === "violation") {
      const topics = checks.guardrail.verification.violatedTopics.join(", ") || "a forbidden topic";
      // Mirrors the failed-step INCOMPLETE.md convention above: a marker
      // under `client/` explaining why nothing was delivered, plus the
      // actual draft preserved under `internal/` for staff to review — never
      // uploaded as a client-facing asset, since `outcome: "failed"` skips
      // asset creation entirely (webhook route.ts).
      await writeFile(
        path.join(clientDir, "BLOCKED.md"),
        `# This run was blocked\n\nThe finished draft engaged with a topic this client does not allow: ${topics}.\n\nNo asset was created and no charge was kept. The draft itself is preserved in this run's internal trace for staff review.\n`,
      );
      await writeFile(
        path.join(internalDir, "blocked-output.md"),
        finalOutputMarkdown(result.finalOutput, result.trace),
      );
      await uploadArtifacts(callback, workspace.repoDir, workspace.clientSlug, before);
      return {
        outcome: "failed",
        error: `Blocked by topic guardrail: draft engaged with ${topics}`,
        transient: false,
        agentsRepoSha: workspace.agentsRepoSha,
        dynamicRun: buildRunReport(payload, result, checks),
        ...usageFields,
      };
    }

    await writeFile(path.join(clientDir, "output.md"), finalOutputMarkdown(result.finalOutput, result.trace));

    await uploadArtifacts(callback, workspace.repoDir, workspace.clientSlug, before);

    return {
      outcome: "done",
      transient: false,
      agentsRepoSha: workspace.agentsRepoSha,
      dynamicRun: buildRunReport(payload, result, checks),
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
    console.warn("dynamic-agent checkpoint restore skipped:", formatError(err));
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
/** The two engine-owned post-check verdicts, as they land on the run report. */
interface RunChecks {
  guardrail?: DynamicRunReport["guardrail"];
  dedupe?: DynamicRunReport["dedupe"];
}

/**
 * The guardrail record MINUS the verification — what was in force and where it
 * was applied. Split out because a failed run reports this much and no more:
 * the constraint really was injected into the steps that ran, but there is no
 * deliverable to verify, and a missing `verification` is how the UI knows to
 * say "not checked" rather than showing a green tick it never earned.
 */
function guardrailBase(payload: DynamicAgentJobPayload, injectedStepIds: string[]): RunChecks {
  const forbiddenTopics = payload.guardrails?.forbiddenTopics ?? [];
  if (forbiddenTopics.length === 0) return {};
  return { guardrail: { forbiddenTopics, injectedStepIds } };
}

/**
 * Runs both post-checks against a finished deliverable.
 *
 * Order matters only for cost: the guardrail verification is a model call and
 * the de-duplication check is pure local computation, so a run with neither
 * feature configured makes no calls and does no work at all — which is the
 * zero-impact guarantee this whole feature rests on.
 */
export async function runPostChecks(
  payload: DynamicAgentJobPayload,
  injectedStepIds: string[],
  deliverable: string,
): Promise<RunChecks> {
  const checks: RunChecks = guardrailBase(payload, injectedStepIds);

  if (checks.guardrail) {
    checks.guardrail.verification = await verifyForbiddenTopics(
      deliverable,
      checks.guardrail.forbiddenTopics,
    );
  }

  // `outputHistory` present at all IS the opt-in signal — the Portal only
  // attaches it for a spec with dedupeAgainstHistory set, so an agent without
  // the flag never reaches this branch. An empty items array is a distinct,
  // meaningful state: the feature is on, this is just the agent's first run
  // for this client.
  if (payload.outputHistory) {
    const history = payload.outputHistory.items;
    if (history.length === 0 || !deliverable.trim()) {
      checks.dedupe = {
        status: "no_history",
        // An empty deliverable compares against nothing even when history
        // exists — comparedCount says what was ACTUALLY compared, not what
        // was available, so it can't contradict a "no_history" status.
        comparedCount: deliverable.trim() ? history.length : 0,
        maxSimilarity: 0,
        threshold: DEDUPE_SIMILARITY_THRESHOLD,
      };
    } else {
      const best = closestMatch(deliverable, history);
      const score = best?.score ?? 0;
      const similar = score >= DEDUPE_SIMILARITY_THRESHOLD;
      checks.dedupe = {
        status: similar ? "similar" : "ok",
        comparedCount: history.length,
        maxSimilarity: score,
        threshold: DEDUPE_SIMILARITY_THRESHOLD,
        ...(similar && best ? { mostSimilarJobId: best.jobId } : {}),
      };
    }
  }

  return checks;
}

function buildRunReport(
  payload: DynamicAgentJobPayload,
  result: Awaited<ReturnType<typeof runDynamicSteps>>,
  checks: RunChecks = {},
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
      ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
    })),
  };
  if (checks.guardrail) report.guardrail = checks.guardrail;
  if (checks.dedupe) report.dedupe = checks.dedupe;
  if (result.failedStepId !== undefined) report.failedStepId = result.failedStepId;
  if (result.failedStepIndex !== undefined) report.failedStepIndex = result.failedStepIndex;
  const partial = result.partialOutputs ?? {};
  if (Object.keys(partial).length > 0) report.hasPartialOutput = true;
  return report;
}

/**
 * Pre-fetches this client's own context doc(s) once for the whole run, when
 * at least one AI step has `allowClientData: true`. Reuses
 * `downloadContextFiles` (the SAME download path the hardcoded task-type
 * skills use) rather than a second HTTP-fetching mechanism, then reads the
 * downloaded file(s) back into one string, since a dynamic AI step has no
 * filesystem to read them from directly.
 *
 * Returns undefined (not an empty string) whenever there is genuinely
 * nothing to deliver — no requesting step, no context files on the brief, or
 * every downloaded file was empty — so `runDynamicSteps`'s
 * `...(clientContextText ? {...} : {})` spread cleanly omits the field
 * instead of threading through an empty value.
 */
export async function resolveClientContextText(
  snapshot: DynamicAgentJobPayload["specSnapshot"],
  spec: JobSpec,
  workspace: { repoDir: string; clientSlug: string },
): Promise<string | undefined> {
  const needsClientData = snapshot.steps.some((s) => s.type === "ai" && s.allowClientData === true);
  if (!needsClientData || spec.contextFiles.length === 0) return undefined;

  const downloaded = await downloadContextFiles(workspace.repoDir, workspace.clientSlug, spec.contextFiles);
  const parts: string[] = [];
  for (const file of downloaded) {
    const absPath = path.join(workspace.repoDir, "client_context", "files", file.name);
    const content = await readFile(absPath, "utf8").catch(() => "");
    if (content.trim()) parts.push(content);
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
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

/**
 * The run's deliverable AS TEXT — the single source of truth for "what did
 * this run actually produce".
 *
 * Exported and shared with the post-checks deliberately. Reading
 * `finalOutput` as a string and treating anything else as empty (which is what
 * the first version of the checks did) silently exempted every pipeline whose
 * last step returns an object — a code step — from both the guardrail and the
 * de-duplication check, while still shipping that object's JSON to the client
 * in output.md. The check has to see exactly the bytes that ship, so both call
 * this.
 */
export function deliverableText(finalOutput: unknown): string {
  if (typeof finalOutput === "string") return finalOutput;
  if (finalOutput === undefined || finalOutput === null) return "";
  return JSON.stringify(finalOutput, null, 2);
}

function finalOutputMarkdown(finalOutput: unknown, trace: DynamicStepTraceEntry[]): string {
  const lastStep = trace[trace.length - 1];
  return `# ${lastStep?.label ?? "Agent output"}\n\n${deliverableText(finalOutput)}\n`;
}
