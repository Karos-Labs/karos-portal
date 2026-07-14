import { loadConfig } from "./config.js";
import { makeRedis } from "./queue/connection.js";
import { makeQueue, enqueueJob, removeQueuedJob } from "./queue/queue.js";
import { makeWebhooksQueue, startWebhookWorker } from "./queue/webhooks.js";
import { JobsStore } from "./state/jobs-store.js";
import { buildServer } from "./server.js";
import { makeArtifactStore } from "./storage/make-store.js";
import { finalizeJob } from "./lifecycle/finalize.js";
import { startWorker } from "./queue/worker.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const redis = makeRedis(config.redisUrl);
  const store = new JobsStore(redis, config.jobTtlSeconds);
  const artifactStore = makeArtifactStore(config);
  const queue = makeQueue(redis);
  const webhooksQueue = makeWebhooksQueue(redis);

  const app = await buildServer({
    config,
    store,
    artifactStore,
    enqueue: (record) => enqueueJob(queue, record),
    removeQueued: (jobId) => removeQueuedJob(queue, jobId),
    finalize: (record) => finalizeJob({ store, artifactStore, webhooksQueue }, record),
  });

  if (process.env.RUN_WORKER_IN_PROCESS === "1") {
    startWorker({ config, store, artifactStore, queue, webhooksQueue });
    startWebhookWorker({ config, store });
    app.log.info("worker started in-process");
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
