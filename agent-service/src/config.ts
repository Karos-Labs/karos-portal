export interface ServiceConfig {
  port: number;
  redisUrl: string;
  /** accepted bearer tokens for the platform-facing API; multiple entries allow rotation */
  authTokens: string[];
  /** HMAC secret for outbound webhooks */
  webhookSecret: string;
  /** base URL runners use to reach this service (internal network) */
  internalBaseUrl: string;
  /** base URL used in artifact links handed to the platform */
  publicBaseUrl: string;
  artifactStore: "local" | "gcs";
  artifactsDir: string;
  gcsBucket?: string;
  executor: "docker" | "cloudrun";
  runnerImage: string;
  dockerNetwork?: string;
  cloudRun?: { project: string; region: string; job: string };
  anthropicApiKey?: string;
  /** xAI key for live X search/reads (the X agent's research leg); optional. */
  xaiApiKey?: string;
  defaultTimeoutMs: number;
  maxAttempts: number;
  jobTtlSeconds: number;
  workerConcurrency: number;
  /** proxy URL injected into job containers; empty string disables */
  jobHttpProxy?: string;
  /** permit http:// callback_urls (local dev / compose only) */
  allowInsecureCallbacks: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required env var ${key}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const executor = (env.EXECUTOR ?? "docker") as ServiceConfig["executor"];
  if (executor !== "docker" && executor !== "cloudrun") {
    throw new Error(`EXECUTOR must be "docker" or "cloudrun", got "${executor}"`);
  }
  const artifactStore = (env.ARTIFACT_STORE ?? "local") as ServiceConfig["artifactStore"];
  if (artifactStore !== "local" && artifactStore !== "gcs") {
    throw new Error(`ARTIFACT_STORE must be "local" or "gcs", got "${artifactStore}"`);
  }
  if (artifactStore === "gcs" && !env.AGENT_ARTIFACTS_BUCKET) {
    throw new Error("AGENT_ARTIFACTS_BUCKET is required when ARTIFACT_STORE=gcs");
  }
  const authTokens = required(env, "AGENT_SERVICE_TOKENS")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (authTokens.length === 0) throw new Error("AGENT_SERVICE_TOKENS must contain at least one token");

  const config: ServiceConfig = {
    port: Number(env.PORT ?? 8080),
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    authTokens,
    webhookSecret: required(env, "AGENT_WEBHOOK_SECRET"),
    internalBaseUrl: env.INTERNAL_BASE_URL ?? `http://localhost:${env.PORT ?? 8080}`,
    publicBaseUrl: env.PUBLIC_BASE_URL ?? env.INTERNAL_BASE_URL ?? `http://localhost:${env.PORT ?? 8080}`,
    artifactStore,
    artifactsDir: env.ARTIFACTS_DIR ?? "./data",
    executor,
    runnerImage: env.RUNNER_IMAGE ?? "karos-agent-runner:latest",
    defaultTimeoutMs: Number(env.JOB_DEFAULT_TIMEOUT_MS ?? 15 * 60 * 1000),
    maxAttempts: Number(env.JOB_MAX_ATTEMPTS ?? 2),
    jobTtlSeconds: Number(env.JOB_TTL_SECONDS ?? 30 * 24 * 3600),
    workerConcurrency: Number(env.WORKER_CONCURRENCY ?? 2),
    allowInsecureCallbacks: env.ALLOW_INSECURE_CALLBACKS === "1",
  };
  if (env.AGENT_ARTIFACTS_BUCKET) config.gcsBucket = env.AGENT_ARTIFACTS_BUCKET;
  if (env.DOCKER_NETWORK) config.dockerNetwork = env.DOCKER_NETWORK;
  if (env.ANTHROPIC_API_KEY) config.anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (env.XAI_API_KEY) config.xaiApiKey = env.XAI_API_KEY;
  if (env.JOB_HTTP_PROXY) config.jobHttpProxy = env.JOB_HTTP_PROXY;
  if (executor === "cloudrun") {
    config.cloudRun = {
      project: required(env, "CLOUDRUN_PROJECT"),
      region: required(env, "CLOUDRUN_REGION"),
      job: required(env, "CLOUDRUN_JOB"),
    };
  }
  return config;
}
