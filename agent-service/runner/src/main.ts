import { query } from "@anthropic-ai/claude-agent-sdk";
import { decodeJobSpec } from "../../src/exec/executor.js";
import { getTaskTypeConfig } from "../../src/task-types.js";
import type { RunnerCompleteBody } from "../../src/types.js";
import { ServiceCallback } from "./callback.js";
import { prepareWorkspace, writeClientContext } from "./workspace.js";
import { buildSkillsShim } from "./skills-shim.js";
import { contextFileList, downloadContextFiles } from "./context-files.js";
import { collectArtifacts, guessContentType, snapshotOutputs } from "./artifacts.js";
import { extractUsage, isResultMessage, TranscriptStreamer } from "./transcript.js";

const SELF_TIMEOUT_BUFFER_MS = 45_000;

function isTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|50\d|overloaded|rate.?limit/i.test(message);
}

async function main(): Promise<void> {
  const specB64 = process.env.JOB_SPEC_B64;
  if (!specB64) throw new Error("JOB_SPEC_B64 not set");
  const spec = decodeJobSpec(specB64);
  const callback = new ServiceCallback(spec);
  const taskConfig = getTaskTypeConfig(spec.taskType);

  let report: RunnerCompleteBody = { outcome: "failed", error: "runner did not finish", transient: true };
  const transcript = new TranscriptStreamer(callback);

  try {
    const workspace = await prepareWorkspace({
      bakedRepoDir: process.env.AGENTS_REPO_DIR ?? "/opt/karos-agents",
      workDir: process.env.WORK_DIR ?? "/work",
      clientId: spec.clientId,
      ...(spec.clientSlug ? { clientSlug: spec.clientSlug } : {}),
      ...(spec.agentVersion ? { agentVersion: spec.agentVersion } : {}),
    });
    report.agentsRepoSha = workspace.agentsRepoSha;

    await writeClientContext({ repoDir: workspace.repoDir, brief: spec.brief });
    const downloaded = await downloadContextFiles(workspace.repoDir, spec.contextFiles);
    const linkedSkills = await buildSkillsShim({
      repoDir: workspace.repoDir,
      entrySkillDir: taskConfig.entrySkillDir,
      skillRoots: taskConfig.skillRoots,
      clientSlug: workspace.clientSlug,
      includeClientSkills: taskConfig.includeClientSkills,
    });
    console.log(`workspace ready: sha=${workspace.agentsRepoSha} skills=${linkedSkills.length}`);

    const before = await snapshotOutputs(workspace.repoDir, workspace.clientSlug);
    const isoDate = new Date().toISOString().slice(0, 10);
    const prompt = taskConfig.buildPrompt(spec, {
      clientSlug: workspace.clientSlug,
      runFolder: `${isoDate}-job-${spec.jobId.slice(0, 8)}`,
      isoDate,
      contextFileList: contextFileList(downloaded),
      clientScaffolded: workspace.clientScaffolded,
    });

    const q = query({
      prompt,
      options: {
        cwd: workspace.repoDir,
        settingSources: ["project"],
        skills: "all",
        allowedTools: taskConfig.allowedTools,
        disallowedTools: taskConfig.disallowedTools,
        permissionMode: "dontAsk",
        model: taskConfig.model,
        maxTurns: taskConfig.maxTurns,
        maxBudgetUsd: taskConfig.maxBudgetUsd,
        env: { ...process.env } as Record<string, string>,
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
              transient: true,
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
    await transcript.close();
    await callback.complete(report);
  }
  process.exit(report.outcome === "done" ? 0 : 1);
}

void main();
