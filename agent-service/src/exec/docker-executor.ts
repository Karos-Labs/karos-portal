import { spawn } from "node:child_process";
import { once } from "node:events";
import type { ServiceConfig } from "../config.js";
import type { JobSpec } from "../types.js";
import { encodeJobSpec, type ExecutionHandle, type JobExecutor } from "./executor.js";

const STOP_GRACE_SECONDS = 25;

export class DockerExecutor implements JobExecutor {
  constructor(private readonly config: ServiceConfig) {}

  async start(spec: JobSpec, env: Record<string, string>): Promise<ExecutionHandle> {
    const containerName = `agent-job-${spec.jobId}`;
    const args = ["run", "--rm", "--name", containerName, "--init"];
    if (this.config.dockerNetwork) args.push("--network", this.config.dockerNetwork);
    for (const [key, value] of Object.entries({ ...env, JOB_SPEC_B64: encodeJobSpec(spec) })) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(this.config.runnerImage);

    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(`[job ${spec.jobId}] ${chunk.toString()}`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[job ${spec.jobId}] ${chunk.toString()}`);
    });

    const wait = once(child, "exit").then(() => undefined);
    return {
      wait,
      kill: async () => {
        await new Promise<void>((resolve) => {
          const stop = spawn("docker", ["stop", "-t", String(STOP_GRACE_SECONDS), containerName], {
            stdio: "ignore",
          });
          stop.on("exit", () => resolve());
          stop.on("error", () => resolve());
        });
      },
    };
  }
}
