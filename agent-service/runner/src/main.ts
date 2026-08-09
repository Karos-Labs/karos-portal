import { query } from "@anthropic-ai/claude-agent-sdk";
import { decodeJobSpec } from "../../src/exec/executor.js";
import { resolveTaskConfig } from "../../src/task-types.js";
import type { RunnerCompleteBody } from "../../src/types.js";
import { isDynamicAgentBrief, type DynamicAgentJobPayload } from "../../src/dynamic-types.js";
import { runDynamicJob } from "./dynamic/run-dynamic-job.js";
import { ServiceCallback } from "./callback.js";
import { reportComplete } from "./report-complete.js";
import { prepareWorkspace, writeClientContext } from "./workspace.js";
import { buildSkillsShim } from "./skills-shim.js";
import { contextFileList, downloadContextFiles } from "./context-files.js";
import { collectArtifacts, guessContentType, snapshotOutputs } from "./artifacts.js";
import { extractUsage, isResultMessage, TranscriptStreamer } from "./transcript.js";
import { KAROS_MCP_ALLOWED_TOOLS, karosMcpServers } from "./mcp.js";
import { isTransientError, isTransientResultError } from "./error-classification.js";
import { restoreCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { buildStepAgentDefinitions, sdkEnv } from "./sdk-options.js";

const SELF_TIMEOUT_BUFFER_MS = 45_000;

async function main(): Promise<void> {
  const specB64 = process.env.JOB_SPEC_B64;
  if (!specB64) throw new Error("JOB_SPEC_B64 not set");
  delete process.env.JOB_SPEC_B64;
  const spec = decodeJobSpec(specB64);
  const callback = new ServiceCallback(spec);

  // Dynamic Agent Studio's WHOLE routing signal (Phase 7): a brief carrying a
  // frozen `specSnapshot` takes the generic execution engine instead of the
  // hardcoded per-task-type path below. Deliberately the very first branch in
  // main() — this IS the backward-compatibility seam. Any brief without
  // `specSnapshot` (every hardcoded X/LinkedIn/Reddit/social_post/etc. run)
  // never reaches this condition and falls straight through to the unchanged
  // path beneath it.
  if (isDynamicAgentBrief(spec.brief)) {
    let report: RunnerCompleteBody = { outcome: "failed", error: "dynamic runner did not finish", transient: true };
    try {
      report = await runDynamicJob(
        spec,
        {
          specId: String(spec.brief.specId ?? spec.brief.specSnapshot.id),
          specVersion: Number(spec.brief.spec_version ?? spec.brief.specSnapshot.version),
          specSnapshot: spec.brief.specSnapshot,
          clientId: spec.clientId,
          inputs: (spec.brief.inputs as DynamicAgentJobPayload["inputs"]) ?? {},
          // The brief's existing step_models field, reused for per-step model
          // routing on the dynamic path (stepId -> alias). custom.json pins it
          // to the alias enum on this branch.
          ...(spec.brief.step_models
            ? { stepModels: spec.brief.step_models as Record<string, string> }
            : {}),
        },
        callback,
      );
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error("dynamic runner failed:", message);
      report = { outcome: "failed", error: message.slice(0, 20000), transient: isTransientError(err) };
    } finally {
      await reportComplete(callback, report);
    }
    process.exit(report.outcome === "done" ? 0 : 1);
    return;
  }

  let report: RunnerCompleteBody = { outcome: "failed", error: "runner did not finish", transient: true };
  const transcript = new TranscriptStreamer(callback);
  // Set once the workspace exists, so the finally block below can save a
  // checkpoint even when the failure was thrown (not delivered as a result
  // message) — as long as there's an output tree to snapshot.
  let checkpointTarget: { repoDir: string; clientSlug: string } | undefined;

  try {
    // Resolved inside the try (not before it): a malformed brief throws here
    // (bad entry_skill_dir etc.), and that throw needs to land in the catch
    // below and get reported like any other failure — not skip straight past
    // it as an unhandled rejection with no callback.complete() call at all.
    const taskConfig = resolveTaskConfig(spec.taskType, spec.brief);
    const workspace = await prepareWorkspace({
      bakedRepoDir: process.env.AGENTS_REPO_DIR ?? "/opt/karos-agents",
      workDir: process.env.WORK_DIR ?? "/work",
      clientId: spec.clientId,
      ...(spec.clientSlug ? { clientSlug: spec.clientSlug } : {}),
      ...(spec.agentVersion ? { agentVersion: spec.agentVersion } : {}),
    });
    checkpointTarget = { repoDir: workspace.repoDir, clientSlug: workspace.clientSlug };
    report.agentsRepoSha = workspace.agentsRepoSha;

    await writeClientContext({ repoDir: workspace.repoDir, brief: spec.brief });
    const downloaded = await downloadContextFiles(workspace.repoDir, workspace.clientSlug, spec.contextFiles);
    const linkedSkills = await buildSkillsShim({
      repoDir: workspace.repoDir,
      entrySkillDir: taskConfig.entrySkillDir,
      skillRoots: taskConfig.skillRoots,
      clientSlug: workspace.clientSlug,
      includeClientSkills: taskConfig.includeClientSkills,
    });
    console.log(`workspace ready: sha=${workspace.agentsRepoSha} skills=${linkedSkills.length}`);

    // Taken BEFORE restoring a checkpoint: collectArtifacts diffs against
    // this baseline, so restored files still read as "new" and get uploaded
    // even if the agent never touches them again this attempt.
    const before = await snapshotOutputs(workspace.repoDir, workspace.clientSlug);
    let resumedFileCount = 0;
    if (spec.attempt > 1) {
      resumedFileCount = await restoreCheckpoint(callback, workspace.repoDir).catch((err) => {
        console.warn(
          "checkpoint restore failed, continuing from scratch:",
          err instanceof Error ? err.message : err,
        );
        return 0;
      });
      if (resumedFileCount > 0) {
        console.log(`resumed ${resumedFileCount} file(s) from attempt ${spec.attempt - 1}'s checkpoint`);
      }
    }

    const isoDate = new Date().toISOString().slice(0, 10);
    const prompt = taskConfig.buildPrompt(spec, {
      clientSlug: workspace.clientSlug,
      runFolder: `${isoDate}-job-${spec.jobId.slice(0, 8)}`,
      isoDate,
      contextFileList: contextFileList(downloaded),
      clientScaffolded: workspace.clientScaffolded,
      resumedFileCount,
    });
    const mcpServers = karosMcpServers(spec);
    const stepAgents = buildStepAgentDefinitions(taskConfig.stepModels);

    const q = query({
      prompt,
      options: {
        cwd: workspace.repoDir,
        settingSources: ["project"],
        skills: "all",
        allowedTools: mcpServers
          ? [...taskConfig.allowedTools, ...KAROS_MCP_ALLOWED_TOOLS]
          : taskConfig.allowedTools,
        disallowedTools: taskConfig.disallowedTools,
        ...(mcpServers ? { mcpServers, strictMcpConfig: true } : {}),
        ...(stepAgents ? { agents: stepAgents } : {}),
        permissionMode: "dontAsk",
        model: taskConfig.model,
        ...(taskConfig.effort ? { effort: taskConfig.effort } : {}),
        maxTurns: taskConfig.maxTurns,
        maxBudgetUsd: taskConfig.maxBudgetUsd,
        env: sdkEnv(),
      },
    });

    let interrupted: "cancel" | "timeout" | undefined;
    const selfTimeout = setTimeout(
      () => {
        interrupted = "timeout";
        void q.interrupt();
      },
      Math.max(60_000, spec.timeoutMs - SELF_TIMEOUT_BUFFER_MS),
    );
    selfTimeout.unref();
    const onSigterm = (): void => {
      interrupted ??= "cancel";
      void q.interrupt();
    };
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigterm);

    let sawResult = false;
    try {
      for await (const message of q) {
        transcript.append(message);
        if (isResultMessage(message)) {
          sawResult = true;
          report.usage = extractUsage(message);
          const models = Object.keys(report.usage.models);
          if (models.length > 0) report.model = models.join(",");
          if (message.subtype === "success") {
            report = { ...report, outcome: "done", transient: false };
            delete report.error;
          } else if (message.subtype === "error_max_turns" || message.subtype === "error_max_budget_usd") {
            report = {
              ...report,
              outcome: "failed",
              transient: false,
              error: `run stopped: ${message.subtype}`,
            };
          } else {
            report = {
              ...report,
              outcome: "failed",
              transient: isTransientResultError(message.subtype, message.errors),
              error: `run errored: ${message.subtype}${message.errors?.length ? ` — ${message.errors.join("; ")}` : ""}`,
            };
          }
        }
      }
    } finally {
      clearTimeout(selfTimeout);
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigterm);
    }

    if (interrupted === "cancel") {
      report = { ...report, outcome: "cancelled", transient: false };
      delete report.error;
    } else if (interrupted === "timeout") {
      report = { ...report, outcome: "failed", transient: true, error: "runner self-timeout before deadline" };
    } else if (!sawResult) {
      report = { ...report, outcome: "failed", transient: true, error: "SDK stream ended without a result message" };
    }

    const { artifacts, skipped } = await collectArtifacts(workspace.repoDir, workspace.clientSlug, before);
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
    if (report.outcome === "done" && artifacts.length === 0) {
      report = {
        ...report,
        outcome: "failed",
        transient: false,
        error: "run reported success but produced no artifacts",
      };
    }
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("runner failed:", message);
    report = {
      outcome: "failed",
      error: message.slice(0, 20000),
      transient: isTransientError(err),
      ...(report.agentsRepoSha ? { agentsRepoSha: report.agentsRepoSha } : {}),
    };
  } finally {
    // No point saving on the last attempt — a transient verdict past
    // maxAttempts dead-letters the job with no further attempt to restore into.
    if (report.outcome === "failed" && report.transient && spec.attempt < spec.maxAttempts && checkpointTarget) {
      await saveCheckpoint(callback, checkpointTarget.repoDir, checkpointTarget.clientSlug, spec.attempt).catch(
        (err) => console.warn("checkpoint save failed:", err instanceof Error ? err.message : err),
      );
    }
    await transcript.close();
    await reportComplete(callback, report);
  }
  process.exit(report.outcome === "done" ? 0 : 1);
}

void main();
