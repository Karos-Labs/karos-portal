import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "../../src/webhooks/sign.js";
import type { WebhookPayload } from "../../src/types.js";

/**
 * Real end-to-end runs against a live local stack (`make up` + `make runner`),
 * one per task type. Each run spends real Anthropic tokens and takes many
 * minutes, so everything is gated behind AGENT_E2E=1 (CI skips by default).
 *
 *   AGENT_E2E=1 AGENT_E2E_TASKS=social_post npm run test:e2e
 *
 * AGENT_E2E_TASKS: comma-separated subset (default: all four task types).
 * DEMO_CLIENT_SLUG: optionally run against a real lab client folder.
 */
const RUN = process.env.AGENT_E2E === "1";
const API_URL = process.env.AGENT_SERVICE_URL ?? "http://localhost:8080";
const TOKEN = process.env.AGENT_SERVICE_TOKEN ?? "dev-token";
const SECRET = process.env.AGENT_WEBHOOK_SECRET ?? "dev-webhook-secret";
const JOB_TIMEOUT_MS = 35 * 60 * 1000;

const ALL_BRIEFS: Record<string, Record<string, unknown>> = {
  social_post: { count: 1, topic: "a friendly behind-the-scenes moment", platform: "instagram" },
  landing_page: { page_goal: "Collect signups for a test waitlist" },
};
const TASKS = (process.env.AGENT_E2E_TASKS ?? Object.keys(ALL_BRIEFS).join(","))
  .split(",")
  .map((t) => t.trim())
  .filter((t) => t in ALL_BRIEFS);

describe.skipIf(!RUN)("agent-service e2e", () => {
  let server: Server;
  let callbackPort: number;
  const received = new Map<string, WebhookPayload>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const valid = verifySignature({
          secrets: [SECRET],
          signatureHeader: req.headers[SIGNATURE_HEADER] as string | undefined,
          timestampHeader: req.headers[TIMESTAMP_HEADER] as string | undefined,
          rawBody,
        });
        if (!valid) {
          res.writeHead(401).end();
          return;
        }
        const payload = JSON.parse(rawBody) as WebhookPayload;
        received.set(payload.job_id, payload);
        res.writeHead(200).end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const address = server.address();
    callbackPort = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(() => {
    server?.close();
  });

  it.each(TASKS)(
    "runs a %s job to completion with artifacts and a signed webhook",
    async (taskType) => {
      const submit = await fetch(`${API_URL}/v1/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          task_type: taskType,
          client_id: "e2e-client",
          ...(process.env.DEMO_CLIENT_SLUG ? { client_slug: process.env.DEMO_CLIENT_SLUG } : {}),
          brief: ALL_BRIEFS[taskType],
          // worker container → host test listener (Docker Desktop DNS)
          callback_url: `http://host.docker.internal:${callbackPort}/webhook`,
          metadata: { e2e: "true" },
        }),
      });
      expect(submit.status).toBe(202);
      const { job_id } = (await submit.json()) as { job_id: string };

      const deadline = Date.now() + JOB_TIMEOUT_MS;
      let status = "queued";
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10_000));
        const res = await fetch(`${API_URL}/v1/jobs/${job_id}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        const job = (await res.json()) as { status: string };
        status = job.status;
        if (["done", "failed", "cancelled", "dead_letter"].includes(status)) break;
      }
      expect(status).toBe("done");

      const finalRes = await fetch(`${API_URL}/v1/jobs/${job_id}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const final = (await finalRes.json()) as {
        artifacts: Array<{ path: string; clientFacing: boolean; url?: string }>;
        usage?: { models: Record<string, unknown> };
        agentsRepoSha?: string;
      };
      expect(final.artifacts.length).toBeGreaterThan(0);
      expect(final.artifacts.some((a) => a.clientFacing)).toBe(true);
      expect(final.agentsRepoSha).toMatch(/^[0-9a-f]{40}$/);
      expect(Object.keys(final.usage?.models ?? {}).length).toBeGreaterThan(0);

      const webhook = received.get(job_id);
      expect(webhook, "signed webhook must have been delivered and verified").toBeDefined();
      expect(webhook?.status).toBe("done");
      expect(webhook?.artifacts.length).toBeGreaterThan(0);
    },
    JOB_TIMEOUT_MS + 60_000,
  );
});
