import { loadConfig } from "../config.js";
import { makeRedis } from "./connection.js";
import { makeQueue } from "./queue.js";
import { makeWebhooksQueue, startWebhookWorker } from "./webhooks.js";
import { JobsStore } from "../state/jobs-store.js";
import { makeArtifactStore } from "../storage/make-store.js";
import { startWorker } from "./worker.js";

const config = loadConfig();
const redis = makeRedis(config.redisUrl);
const store = new JobsStore(redis, config.jobTtlSeconds);
const artifactStore = makeArtifactStore(config);
const queue = makeQueue(redis);
const webhooksQueue = makeWebhooksQueue(redis);

startWorker({ config, store, artifactStore, queue, webhooksQueue });
startWebhookWorker({ config, store });
console.log(`agent-service worker started (executor=${config.executor}, concurrency=${config.workerConcurrency})`);
