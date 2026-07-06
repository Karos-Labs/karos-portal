import { createServer } from "node:http";
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

// The worker is a queue consumer, but Cloud Run *services* require the
// container to listen on $PORT to pass the startup/health probe. Serve a
// trivial health endpoint so the always-on worker stays deployable there.
const port = Number(process.env.PORT ?? 8080);
createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, role: "worker" }));
}).listen(port, () => console.log(`worker health server listening on :${port}`));
