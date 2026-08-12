import { ExecutionsClient, JobsClient } from "@google-cloud/run";
import type { ServiceConfig } from "../config.js";
import type { JobSpec } from "../types.js";
import { buildSpecEnv, type ExecutionHandle, type JobExecutor } from "./executor.js";

/**
 * Runs each agent job as one Cloud Run Job execution: per-job container
 * isolation with the pinned runner image. The Cloud Run job definition must
 * reference the same runner image this service was configured with.
 */
export class CloudRunJobExecutor implements JobExecutor {
  private readonly jobs = new JobsClient();
  private readonly executions = new ExecutionsClient();

  constructor(private readonly config: ServiceConfig) {}

  async start(spec: JobSpec, env: Record<string, string>): Promise<ExecutionHandle> {
    const cloudRun = this.config.cloudRun;
    if (!cloudRun) throw new Error("cloudRun config missing");
    const name = `projects/${cloudRun.project}/locations/${cloudRun.region}/jobs/${cloudRun.job}`;
    const envList = Object.entries({ ...env, ...buildSpecEnv(spec) }).map(([key, value]) => ({
      name: key,
      value,
    }));
    const [operation] = await this.jobs.runJob({
      name,
      overrides: {
        containerOverrides: [{ env: envList }],
        taskCount: 1,
        timeout: { seconds: Math.ceil(spec.timeoutMs / 1000) + 120 },
      },
    });
    const executionName = (operation.metadata as { name?: string } | undefined)?.name;
    return {
      wait: operation.promise().then(() => undefined),
      kill: async () => {
        if (!executionName) return;
        try {
          await this.executions.cancelExecution({ name: executionName });
        } catch {
          // execution may already be finished
        }
      },
    };
  }
}
