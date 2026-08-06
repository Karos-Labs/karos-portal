const API_URL = process.env.AGENT_SERVICE_URL ?? "http://localhost:8080";
const TOKEN = process.env.AGENT_SERVICE_TOKEN ?? "dev-token";
const CALLBACK_URL = process.env.DEMO_CALLBACK_URL ?? "http://mock-webhook:9009/webhook";
const TASK_TYPE = process.env.DEMO_TASK_TYPE ?? "social_post";
const CLIENT_SLUG = process.env.DEMO_CLIENT_SLUG;

const briefs: Record<string, Record<string, unknown>> = {
  social_post: { count: 1, topic: "behind the scenes of a product photoshoot", platform: "instagram" },
  landing_page: { page_goal: "Collect waitlist signups for a demo product" },
};

async function main(): Promise<void> {
  const body = {
    task_type: TASK_TYPE,
    client_id: "demo-client",
    ...(CLIENT_SLUG ? { client_slug: CLIENT_SLUG } : {}),
    brief: briefs[TASK_TYPE] ?? briefs.social_post,
    callback_url: CALLBACK_URL,
    metadata: { demo: "true" },
  };
  console.log(`[demo] submitting ${TASK_TYPE} job to ${API_URL} ...`);
  const submit = await fetch(`${API_URL}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const submitBody = (await submit.json()) as { job_id?: string; details?: unknown };
  if (!submit.ok || !submitBody.job_id) {
    console.error(`[demo] submit failed (${submit.status}):`, submitBody);
    process.exit(1);
  }
  const jobId = submitBody.job_id;
  console.log(`[demo] job_id=${jobId} — polling...`);

  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${API_URL}/v1/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const job = (await res.json()) as {
      status: string;
      error?: string;
      artifacts: Array<{ path: string; client_facing?: boolean; clientFacing?: boolean; url?: string }>;
      usage?: { totalCostUsd?: number };
      agentsRepoSha?: string;
    };
    process.stdout.write(`[demo] status=${job.status} artifacts=${job.artifacts?.length ?? 0}\n`);
    if (["done", "failed", "cancelled", "dead_letter"].includes(job.status)) {
      console.log(JSON.stringify(job, null, 2));
      console.log(
        job.status === "done"
          ? `[demo] SUCCESS — cost $${job.usage?.totalCostUsd?.toFixed(4) ?? "?"} @ ${job.agentsRepoSha?.slice(0, 8)}`
          : `[demo] job ended: ${job.status}${job.error ? ` — ${job.error}` : ""}`,
      );
      process.exit(job.status === "done" ? 0 : 1);
    }
  }
}

void main();
