import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assetTitleFromJobTitle } from "@/lib/job-title";
import {
  claimExternalJobCompletion,
  createAsset,
  getClient,
  getCustomAgent,
  getJob,
  getJobByExternalServiceId,
  isJobInFlight,
  listClientSeats,
  listLiDirectionRequests,
  markLiDirectionRequestCovered,
  updateJob,
  upsertLiAgentState,
  upsertBlogAgentState,
  upsertCarouselAgentState,
  upsertReputationAgentState,
  upsertNewsletterAgentState,
  upsertNewsletterLedgerEntry,
  upsertRedditAgentState,
  upsertSeatVoiceProfile,
} from "@/lib/data";
import { isXAgent } from "@/lib/agent-service/x-agent-context";
import {
  isLinkedInAgent,
  isLinkedInSetupV2,
  isLinkedInV2Agent,
} from "@/lib/agent-service/linkedin-agent-context";
import {
  LI_STATE_MAX_CHARS,
  coveredDirectionRequests,
  isLiCommitArtifact,
  liStateDateFor,
  liStateKindFor,
} from "@/lib/agent-service/linkedin-state-capture";
import {
  isRedditAgent,
  isRedditRunnerV2,
  isRedditSetupV2,
} from "@/lib/agent-service/reddit-agent-context";
import { isNewsletterAgent } from "@/lib/agent-service/newsletter-agent-context";
import { isBlogAgent } from "@/lib/agent-service/blog-agent-context";
import { isReputationAgent } from "@/lib/agent-service/reputation-agent-context";
import { isCarouselAgent } from "@/lib/agent-service/carousel-agent-context";
import {
  CAROUSEL_STATE_MAX_CHARS,
  type CarouselClientFile,
  buildCarouselEnvelope,
  carouselEnvelopeHasContent,
  carouselStateContentType,
  carouselStateDateFor,
  carouselStateKindFor,
  isCarouselSlideName,
} from "@/lib/agent-service/carousel-state-capture";
import {
  REPUTATION_STATE_MAX_CHARS,
  type ReputationClientFile,
  buildReputationEnvelope,
  reputationEnvelopeHasContent,
  reputationStateContentType,
  reputationStateDateFor,
  reputationStateHasContent,
  reputationStateKindFor,
} from "@/lib/agent-service/reputation-state-capture";
import {
  BLOG_STATE_MAX_CHARS,
  type BlogClientFile,
  blogEnvelopeHasContent,
  blogStateContentType,
  blogStateDateFor,
  blogStateKindFor,
  buildBlogEnvelope,
} from "@/lib/agent-service/blog-state-capture";
import {
  NEWSLETTER_STATE_MAX_CHARS,
  type NewsletterClientFile,
  buildNewsletterEnvelope,
  newsletterEnvelopeHasContent,
  newsletterStateContentType,
  newsletterStateDateFor,
  newsletterIssueNumberFrom,
  newsletterLedgerKindFor,
  newsletterStateKindFor,
  NEWSLETTER_LEDGER_MAX_CHARS,
} from "@/lib/agent-service/newsletter-state-capture";
import {
  REDDIT_STATE_MAX_CHARS,
  type RedditClientFile,
  buildRedditV2Envelope,
  isRedditRunRecordArtifact,
  redditOutcomeFrom,
  redditStateContentType,
  redditStateDateFor,
  redditStateKindFor,
} from "@/lib/agent-service/reddit-state-capture";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyAgentServiceSignature,
} from "@/lib/agent-service/verify";
import { agentServiceFetchHeaders } from "@/lib/agent-service/client";
import type { AgentServiceArtifact, AgentServiceWebhookPayload } from "@/lib/agent-service/types";
import { deliverableAssetType } from "@/lib/agent-service/deliverable-asset-type";
import type { BlogAgentState, CarouselAgentState, ExternalJobArtifact, Job, JobRunEvent, JobStatus, LiAgentState, NewsletterAgentState, NewsletterLedgerEntry, RedditAgentState, ReputationAgentState } from "@/lib/types";
import { uploadBytes } from "@/lib/storage";
import { recommendedScheduleFields } from "@/lib/scheduling";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import {
  ARTIFACT_FETCH_TIMEOUT_MS,
  ARTIFACT_UPLOAD_TIMEOUT_MS,
  REHOST_DEADLINE_MS,
} from "@/lib/agent-service/rehost-budget";
import { orderKeyForCreatedAt } from "@/lib/post-chain";
import { reflowClientChain } from "@/lib/chain";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { applyLaunchOutcome, isLaunchTemplatesArtifact } from "@/lib/jobs/launch-outcome";
import { getClientAgent } from "@/lib/data-client-agents";
import { syncOptionsFromBatchAsset } from "@/lib/client-agent-slots";
import {
  autoCompleteTasksByTrigger,
  findDispatchingTask,
  syncTaskForJobOutcome,
} from "@/lib/task-sync";
import { notifyJobFailure } from "@/lib/job-alerts";
import { buildStepBreakdown } from "@/lib/jobs/step-breakdown";
import { logger } from "@/services/logger";

// The re-host phase is budgeted to end well inside this (rehost-budget.ts),
// leaving the claim and the writes after it the remainder.
export const maxDuration = 120;

const REHOST_FILE_LIMIT_BYTES = 25 * 1024 * 1024;
const REHOST_TOTAL_LIMIT_BYTES = 150 * 1024 * 1024;
const CONTENT_CHAR_CAP = 100_000;

const STATUS_MAP: Record<AgentServiceWebhookPayload["status"], JobStatus> = {
  done: "review",
  failed: "failed",
  dead_letter: "failed",
  // A deliberate stop is not a breakage: it maps to itself so the badge, the
  // progress strip and every failure count can tell the two apart.
  cancelled: "cancelled",
};

// The task-type map, the metadata.asset_type whitelist and the draft-only fence
// over both now live in one module (agent-service/deliverable-asset-type.ts),
// because the type decides whether the product will offer to PUBLISH the
// deliverable — see `deliverableAssetType` at the asset write below.

const TEXT_EXTENSIONS = [".md", ".html", ".txt"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

/**
 * Structural validation of the (signature-verified) webhook body. The HMAC proves the
 * sender, not the shape — a malformed-but-signed payload previously reached `.map`/`.reduce`
 * on `artifacts`/`usage.models` and could throw mid-handler after the job was claimed.
 * Required fields are the ones the handler routes on; secondary fields stay lenient (with
 * defaults) so a valid delivery is never rejected over an optional field.
 */
const artifactSchema = z.object({
  name: z.string(),
  path: z.string().default(""),
  bytes: z.number().default(0),
  sha256: z.string().default(""),
  content_type: z.string().optional(),
  client_facing: z.boolean().default(false),
  url: z.string(),
});
const usageSchema = z.object({
  totalCostUsd: z.number().optional(),
  numTurns: z.number().optional(),
  models: z
    .record(
      z.string(),
      z.object({
        inputTokens: z.number().default(0),
        outputTokens: z.number().default(0),
        cacheReadInputTokens: z.number().default(0),
        cacheCreationInputTokens: z.number().default(0),
        costUsd: z.number().optional(),
      }),
    )
    .default({}),
});
/**
 * Dynamic Agent Studio's per-step report. Present only for a dynamic run; a
 * hardcoded agent's webhook never carries it, which is why every field is
 * optional at the payload level rather than gated on task_type.
 */
const dynamicRunSchema = z.object({
  specId: z.string().min(1),
  specVersion: z.number(),
  steps: z
    .array(
      z.object({
        stepId: z.string().min(1),
        type: z.enum(["ai", "code"]),
        label: z.string().default(""),
        status: z.enum(["done", "failed"]),
        durationMs: z.number().default(0),
        model: z.string().optional(),
        error: z.string().optional(),
        /** This step's own token/cost usage (AI steps only). */
        usage: usageSchema.optional(),
      }),
    )
    .default([]),
  failedStepId: z.string().optional(),
  failedStepIndex: z.number().optional(),
  hasPartialOutput: z.boolean().optional(),
});

const jobCompletedPayloadSchema = z.object({
  event: z.literal("job.completed"),
  job_id: z.string().min(1),
  status: z.enum(["done", "failed", "cancelled", "dead_letter"]),
  /**
   * INBOUND, so this is deliberately WIDER than what the platform can start.
   *
   * `newsletter_issue` is retired — it is gone from `ManagedTaskType`, from
   * `MANAGED_PRODUCTS` and from the service's own `TASK_TYPES`, so nothing can
   * dispatch one any more. It stays HERE because a v1 job already queued when
   * the service was cut still has to be able to report back: this schema runs
   * before anything else, so a rejected enum means a 400, no claim, no asset, no
   * refund on a failure, and the service retrying a delivery that can never
   * succeed. The run is finished either way; the only question is whether the
   * client gets the issue they paid for.
   *
   * The type mirror is `WireTaskType` (lib/types.ts). Remove this member only
   * once no v1 job can possibly still be in flight — which is a date, not a
   * deploy.
   */
  task_type: z.enum(["social_post", "newsletter_issue", "blog_article", "landing_page", "custom"]),
  client_id: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
  artifacts: z.array(artifactSchema).default([]),
  usage: usageSchema.optional(),
  agents_repo_sha: z.string().optional(),
  model: z.string().optional(),
  error: z.string().optional(),
  transcript_url: z.string().optional(),
  attempt: z.number().default(0),
  dynamic_run: dynamicRunSchema.optional(),
});

/**
 * Dynamic Agent Studio only: a best-effort, fire-and-forget live-progress
 * ping (see agent-service/src/api/internal.ts's /step-progress route). Unlike
 * job.completed, losing one of these is harmless — the next ping, or the
 * eventual job.completed, resyncs the Portal — so this branch (below) never
 * touches credits, artifacts, or refunds.
 */
const jobStepProgressPayloadSchema = z.object({
  event: z.literal("job.step_progress"),
  job_id: z.string().min(1),
  status: z.literal("running"),
  client_id: z.string().min(1),
  current_step_id: z.string().optional(),
  current_step_name: z.string().optional(),
  completed_step_ids: z.array(z.string()).default([]),
});

const webhookPayloadSchema = z.discriminatedUnion("event", [
  jobCompletedPayloadSchema,
  jobStepProgressPayloadSchema,
]);

function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

const MB = 1024 * 1024;

/**
 * Bytes as whole megabytes for the run log — and the rounding DIRECTION is part
 * of the sentence, not a detail.
 *
 * `Math.round` on both halves of a comparison made the reason contradict itself:
 * a 25.4 MB artifact against a 25 MB cap logged "it is 25 MB, over the 25 MB
 * per-file limit", which is the message a staff member reads to decide whether to
 * raise the cap. Every file between 25.0 and 25.5 MB said that, and the run-total
 * message had the same property near 150 MB.
 *
 * So a size that BROKE a limit rounds up and a size already CONSUMED rounds down.
 * Both err away from the claim being made, so neither can read as equal to the
 * limit it is being compared against. The cost is that a 25.4 MB file is logged
 * as 26 MB — an overstatement under 1 MB, which cannot change the decision this
 * sentence exists to inform (whether to raise the cap) and cannot contradict it.
 */
function mbAtLeast(bytes: number): number {
  return Math.ceil(bytes / MB);
}

/** A size already consumed — rounded down, so it never claims more than it used. */
function mbAtMost(bytes: number): number {
  return Math.floor(bytes / MB);
}

/** An exact limit. The constants are whole megabytes, so this is lossless. */
function mbExact(bytes: number): number {
  return bytes / MB;
}

/**
 * Agent-service webhook receiver. Verifies the HMAC signature (fail-closed:
 * without AGENT_WEBHOOK_SECRET every request is rejected), updates the
 * mirrored `jobs` doc, re-hosts client-facing artifacts into the platform's
 * own storage, creates a reviewable asset, and records token usage/cost.
 *
 * Two phases, split by `claimExternalJobCompletion`. Everything that can throw
 * or run long — the refund, the template lookup, and the artifact re-host — runs
 * BEFORE the claim and fails the delivery with a retryable 503; the claim is the
 * single gate on every persisted side effect after it, and an advisory
 * status pre-filter above the expensive work keeps a settled redelivery from
 * paying for it twice. See TOMER-HANDOVER §4.1c.
 */
export async function POST(req: NextRequest) {
  const handlerStartedAt = Date.now();
  const secretsEnv = process.env.AGENT_WEBHOOK_SECRET;
  if (!secretsEnv) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  const rawBody = await req.text();
  const valid = verifyAgentServiceSignature({
    secrets: secretsEnv.split(",").map((s) => s.trim()).filter(Boolean),
    signatureHeader: req.headers.get(SIGNATURE_HEADER),
    timestampHeader: req.headers.get(TIMESTAMP_HEADER),
    rawBody,
  });
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = webhookPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Unsupported payload", detail: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  // `metadata`/`task_type` only exist on the job.completed variant — a
  // job.step_progress ping never carries either, by design, so this fallback
  // (and the log line below it) is a no-op for that event rather than a
  // lookup it could ever satisfy.
  const platformJobId = payload.event === "job.completed" ? payload.metadata?.platform_job_id : undefined;

  let job = await getJobByExternalServiceId(payload.job_id);
  if (!job && platformJobId && payload.event === "job.completed") {
    // Submission race: the action may not have persisted external.serviceJobId
    // yet — fall back to the platform job id echoed through metadata.
    const candidate = await getJob(platformJobId);
    if (
      candidate &&
      candidate.clientId === payload.client_id &&
      (!candidate.external || candidate.external.serviceJobId === payload.job_id)
    ) {
      job = {
        ...candidate,
        external: candidate.external ?? { serviceJobId: payload.job_id, taskType: payload.task_type },
      };
    }
  }
  if (!job || !job.external) {
    // No job matched. This wants a RETRY — the submission race the fallback
    // above exists for is exactly the window a second attempt closes — and it
    // used to ask for one with a 404 and a comment saying so. The sender does
    // not read comments: `deliverWebhook` classifies EVERY 4xx as "rejected"
    // (agent-service/src/webhooks/deliver.ts), and the webhooks worker returns
    // on "rejected" instead of throwing (agent-service/src/queue/webhooks.ts),
    // so BullMQ never re-queues it. One attempt, then the delivery is gone.
    //
    // Gone is unrecoverable, not merely late: `reconcileOneJob` deliberately
    // leaves a job the service reports as `done` alone so this webhook's
    // redelivery can attach the deliverables (reconcile-job.ts). With no
    // redelivery the run sits queued/running for ever, no asset is written, and
    // a client-charged run is never refunded.
    //
    // So this joins the two conditions below it at 503, the code the sender
    // does retry, with their wording. ONE rule holds the seam — 5xx retryable,
    // 4xx permanent — instead of an exemption list inside the sender for the
    // 4xx codes that secretly meant "try again". The receiver's remaining 4xx
    // (400 malformed, 401 bad signature) are permanent for real.
    //
    // THE COST, STATED: a delivery that can never match — a deleted job, a
    // payload from another environment, a client or serviceJobId mismatch — is
    // now retried across the queue's full ~42-minute schedule instead of once.
    // Bounded, and cheap: this check sits above every expensive phase, so an
    // attempt costs one or two Firestore reads and no re-host.
    console.error(
      `[webhook] no platform job matched service job ${payload.job_id} ` +
        `(client ${payload.client_id}, platform_job_id ${platformJobId ?? "absent"}). ` +
        `Delivery failed for retry.`,
    );
    return NextResponse.json(
      { error: "No matching platform job — retry delivery" },
      { status: 503 },
    );
  }

  // Dynamic Agent Studio only: a live-progress ping, handled and returned
  // entirely separately from job.completed below. Guarded by the SAME
  // in-flight check the advisory pre-filter uses just below (a stale/
  // out-of-order ping against an already-terminal job is a no-op), but with
  // none of job.completed's claim/refund/artifact/asset machinery — this
  // event never carries usage, credits, or artifacts.
  if (payload.event === "job.step_progress") {
    if (!isJobInFlight(job.status)) {
      return NextResponse.json({ ok: true, skipped: true, reason: "Already processed" });
    }
    await updateJob(job.id, {
      currentStepId: payload.current_step_id ?? null,
      currentStepName: payload.current_step_name ?? null,
      completedStepIds: payload.completed_step_ids,
      updatedAt: Date.now(),
    });
    return NextResponse.json({ ok: true });
  }

  // Advisory pre-filter — an OPTIMISATION, not a second gate. The claim below
  // stays the sole authority on whether a delivery may proceed; this only spares
  // an already-settled REDELIVERY the expensive pre-claim work the claim would
  // make it throw away: the refund, the template lookup, and above all the
  // artifact re-host, which can move up to REHOST_TOTAL_LIMIT_BYTES per attempt
  // under a fresh path segment that nothing records. It reads the `job` already
  // in hand, so it costs no extra Firestore read.
  //
  // This is not a rare race. The sender abandons each delivery at 30s
  // (agent-service/src/webhooks/deliver.ts) while the re-host budget below is
  // longer, so exactly the slow manifests that budget exists for get retried on
  // the service's schedule (agent-service/src/queue/webhooks.ts). Without this
  // filter, every one of those attempts re-hosts the whole manifest again.
  //
  // It relies on one invariant: a job's status only ever moves TOWARD terminal —
  // created `queued`, then written once to a terminal value. Nothing resurrects a
  // job to `queued`/`running` (`retryJobAction` submits a NEW job rather than
  // reopening this one). Given that, "terminal here" implies "terminal at the
  // claim", so the filter can only ever agree with the claim. If that invariant
  // is ever broken this filter must go, because it would then reject deliveries
  // the claim would have accepted.
  if (!isJobInFlight(job.status)) {
    return NextResponse.json({ ok: true, skipped: true, reason: "Already processed" });
  }

  const status = STATUS_MAP[payload.status] ?? "failed";

  // Client-charged runs (custom agents fired by CLIENT_USERs) get their
  // credits back when the run dies without deliverables. This MUST happen
  // before the claim below: the claim is single-use, so a refund attempted
  // after it has no retry if the write fails or the instance dies in between.
  // Failing the delivery instead (503) keeps it in the service's retry queue,
  // and the deterministic refund_<chargeEntryId> ledger id makes redelivery
  // safe after a half-applied attempt. No-op for staff-fired runs (never
  // charged) and for already-refunded redeliveries.
  let refund: { refunded: boolean; amount?: number } = { refunded: false };
  if (payload.status !== "done") {
    try {
      refund = await refundJobCharge(
        job.id,
        `Auto-refund · run ${payload.status} · ${job.agentName}`.slice(0, 120),
      );
    } catch {
      return NextResponse.json({ error: "Refund write failed — retry delivery" }, { status: 503 });
    }
  }

  // ── Run shape, derived once ──
  // A launch run is a setup run that designs the client's templates: its
  // deliverables are working material for staff, NOT content. They land as
  // staff-only assets, skip the chain entirely (nothing about them belongs on a
  // calendar), and the umbrella advances to curation. A Control Room "Test Run"
  // gets the same exclusion for a different reason (staff verifying the
  // pipeline, not a one-time setup artifact). Our own job doc is the source of
  // truth for the run type; the metadata echo is the fallback for a job written
  // before the field was stamped. Derived here, above the claim, because the
  // re-host below needs it and because one derivation is the only way both the
  // template gate and the asset flags can agree.
  const clientAgentId = job.clientAgentId ?? payload.metadata?.karos_client_agent_id ?? null;
  const isLaunchRun =
    (job.runType ?? payload.metadata?.karos_run_type) === "launch" && Boolean(clientAgentId);
  const isTestRun = (job.runType ?? payload.metadata?.karos_run_type) === "test";

  // The template stream this run was fired against, resolved BEFORE the claim
  // for the same reason the refund above is: the claim is single-use, so a
  // lookup that throws after it has no retry — redelivery would short-circuit
  // on "Already processed" and the asset would be written with no template
  // forever. Failing the delivery (503) keeps it in the service queue instead.
  //
  // WHITELISTED against the umbrella's own registry, and FENCED by client: the
  // key is trusted from our job doc first and the metadata echo second, but a
  // stale or hand-crafted key must never write a stream name onto a client's
  // deliverable that their agent does not have, and an umbrella id from another
  // tenant must never be read through at all. The archive groups by exactly
  // this field, so a wrong value is worse than none.
  const runTemplateKey = job.templateKey ?? payload.metadata?.karos_template_key ?? null;
  let runTemplate: { key: string; name?: string } | null = null;
  if (runTemplateKey && clientAgentId && !isLaunchRun) {
    let umbrella;
    try {
      umbrella = await getClientAgent(clientAgentId);
    } catch {
      return NextResponse.json(
        { error: "Template lookup failed — retry delivery" },
        { status: 503 },
      );
    }
    if (umbrella && umbrella.clientId === job.clientId) {
      const match = umbrella.templates?.find((t) => t.key === runTemplateKey);
      if (match) runTemplate = { key: match.key, name: match.name };
    }
  }

  // Is this a LinkedIn v2 run, whose internal state files have to be captured
  // during the artifact phase? Resolved HERE, before the loop, because the loop
  // is where the artifacts stream past and the customAgent read is one document.
  // Best-effort: a failed read means state is not captured this delivery, which
  // costs the next run its memory and must not cost this client their post.
  let isLinkedInStateJob = false;
  let isLinkedInSetupJob = false;
  // Reddit v2's state matters more than most: the run's rules audit decides
  // whether a product may be named in a subreddit, and losing it is how an
  // account gets banned. Same one-document read as the LinkedIn resolution.
  let isRedditStateJob = false;
  // Newsletter v2: the issue index in this run is the numbering authority, so a
  // lost capture means the next run re-mints a number a subscriber already saw.
  let isNewsletterStateJob = false;
  // Blog v2: three claims per run (post number, subject, slug) and the client's
  // whole standing site is rebuilt from completed runs, so a lost capture is how
  // two presses write the same article — or how the rebuild deletes posts it can
  // no longer see a run for.
  let isBlogStateJob = false;
  // Reputation v2: the response ledger is the no-repeat memory, and losing it
  // means drafting a second public reply to a review a human already answered
  // under the client's own name.
  let isReputationStateJob = false;
  // Carousel v2: the topic catalogue is the continuity file. Lose it and the
  // next press posts a topic already on the client's public grid.
  let isCarouselStateJob = false;
  try {
    const producing = job.customAgentId ? await getCustomAgent(job.customAgentId) : null;
    isLinkedInStateJob = producing ? isLinkedInV2Agent(producing.key) : false;
    isLinkedInSetupJob = producing ? isLinkedInSetupV2(producing.key) : false;
    isRedditStateJob = producing
      ? isRedditRunnerV2(producing.key) || isRedditSetupV2(producing.key)
      : false;
    isNewsletterStateJob = producing ? isNewsletterAgent(producing.key) : false;
    isBlogStateJob = producing ? isBlogAgent(producing.key) : false;
    isReputationStateJob = producing ? isReputationAgent(producing.key) : false;
    isCarouselStateJob = producing ? isCarouselAgent(producing.key) : false;
  } catch {
    isLinkedInStateJob = false;
    isLinkedInSetupJob = false;
    isRedditStateJob = false;
    isNewsletterStateJob = false;
    isBlogStateJob = false;
    isReputationStateJob = false;
    isCarouselStateJob = false;
  }

  // ── Artifact re-host — the longest pre-claim phase (finding #45) ──
  // This used to run AFTER the claim, which is how a run lost its deliverables:
  // the claim wrote status "review" first, then a wall-clock kill or an instance
  // recycle during the fetch/upload loop left a success-looking job with zero
  // assets, no error, the client's credits spent, and every redelivery
  // answering "Already processed". Nothing could recover it — the stuck-job
  // sweep only looks at queued/running, and the reconciler deliberately refuses
  // to touch a job the service reports as done. Fetching first means a kill
  // here costs a retry instead of a deliverable.
  //
  // `events` holds ONLY the lines THIS delivery adds. It is assembled from here
  // on and persisted only after the claim, so a delivery that loses the race
  // leaves no trace — and it is deliberately NOT seeded from `job.events`
  // (finding #54): that array was read before the re-host, the re-host can take
  // most of a minute, and the job doc is not this handler's alone. See the
  // merge just above `updateJob` for what it is concatenated onto and why the
  // base is re-read there rather than reused from here.
  const events: JobRunEvent[] = [];
  const artifacts: ExternalJobArtifact[] = [];
  // ── The two lists the asset is built from (findings #47, #50, #51) ──
  // `artifacts` is the JOB's record: every entry the manifest declared, in
  // manifest order, client-facing or not, and for an entry we could not copy it
  // keeps the service's own URL so staff can still fetch the file from the job
  // page while that link lives.
  //
  // `rehosted` is the CLIENT's record: only the entries whose bytes are now in
  // our storage. The asset is built from this list and nothing else, which is
  // the invariant that closes #47 — an agent-service artifact URL is a V4 signed
  // GCS link with a 7-day TTL, so a client-facing asset carrying one plays for a
  // week and then 403s forever, with nothing anywhere saying why.
  //
  // WHAT A CLIENT SEES for an artifact we could not copy, decided rather than
  // defaulted: nothing. Not a link that works today and dies next week. The file
  // stays on the run record for staff (the jobs page links every artifact), the
  // reason is one loud error event per file, and if NOTHING was copied the run is
  // treated as the zero-deliverable run it is — refunded, and the ticket released
  // as retryable. The residual we accept: a 30 MB video the client could have
  // watched this week is not offered at all, and the remedy is a human (raise the
  // per-file limit, or hand the file over). A silent expiry is worse than an
  // absence somebody is told about.
  const rehosted: ExternalJobArtifact[] = [];
  // One entry per client-facing artifact we could NOT copy: the file, and why.
  const notRehosted: { name: string; reason: string }[] = [];
  // The image files among them, kept separately for the carousel report below:
  // slides and the cover are derived from the images we HAVE, so a missing
  // slide-1 silently promotes slide-2 to the cover (#50).
  const missingImages: string[] = [];
  let rehostedTotal = 0;
  let launchTemplatesJson: string | null = null;
  let primaryText: { artifact: AgentServiceArtifact; content: string } | null = null;
  // A post is a multi-slide carousel: collect EVERY image, not just the
  // first. Keyed by artifact name so we can restore slide order (slide-2
  // before slide-10) regardless of artifact arrival order.
  const imageEntries: { name: string; url: string }[] = [];
  // Setup (launch) runs may emit one voice-profile--<seat-slug>.md per seat
  // swept — captured off the same decoded bytes as primaryText, no second
  // fetch (x-agent-v2). Launch runs only; launch deliverables stay staff-only
  // regardless via launchDeliverable:true below.
  const voiceProfileArtifacts: { seatSlug: string; content: string }[] = [];
  // LinkedIn v2 durable state (ledger, topic catalog, agent memory, the
  // manager's plan, the research cache, the foundation). These are INTERNAL
  // artifacts — a client never reads a ledger — so they are fetched for their
  // text only and never re-hosted, never attached to an asset. Without this the
  // v2 skills' whole between-runs memory dies with the container; see
  // lib/agent-service/linkedin-state-capture.ts.
  const liStateArtifacts: {
    kind: LiAgentState["kind"];
    content: string;
    contentDate: string;
    path: string;
  }[] = [];
  /**
   * The writer's `12-commit.json`, if this run produced one. Read for exactly one
   * field — which direction requests the run says it covered — so the portal can
   * close those rows. Held as raw text and parsed after the claim: the pre-claim
   * phase is a budget, not a place to do work whose result a lost race discards.
   */
  let liCommitJson: string | null = null;
  // Reddit v2 durable state, same rules as the LinkedIn set: internal artifacts
  // fetched for their TEXT only, never re-hosted, never attached to an asset.
  // A Reddit v2 run's client-facing text files, kept so the folders can be
  // flattened into the reader's envelope after the claim. The bytes are already
  // decoded for primaryText, so this costs no extra fetch.
  const redditClientFiles: RedditClientFile[] = [];
  /** The run's own outcome record, for the four-outcome distinction. */
  let redditRunRecord: string | null = null;
  const newsletterClientFiles: NewsletterClientFile[] = [];
  /** A blog v2 run's client-facing five, flattened into the envelope after the claim. */
  const blogClientFiles: BlogClientFile[] = [];
  /**
   * A carousel run's client-facing TEXT. The slides are images and never reach
   * this list — they are re-hosted like any other image deliverable, and the
   * envelope names them rather than carrying them.
   */
  const carouselClientFiles: CarouselClientFile[] = [];
  /** Carousel v2 durable state, same rules as its five siblings. */
  const carouselStateArtifacts: {
    kind: CarouselAgentState["kind"];
    content: string;
    contentDate: string;
    path: string;
  }[] = [];
  /** A reputation pulse's client-facing folder, flattened after the claim. */
  const reputationClientFiles: ReputationClientFile[] = [];
  /** Reputation v2 durable state, same rules as its four siblings. */
  const reputationStateArtifacts: {
    kind: ReputationAgentState["kind"];
    content: string;
    contentDate: string;
    path: string;
  }[] = [];
  /** Blog v2 durable state, same rules as its three siblings. */
  const blogStateArtifacts: {
    kind: BlogAgentState["kind"];
    content: string;
    contentDate: string;
    path: string;
  }[] = [];
  /**
   * The newsletter's PER-ISSUE published research, captured for the BLOG.
   *
   * The only cross-product capture in this handler: every other buffer here holds
   * something the producing agent will read back itself. These rows are read by a
   * DIFFERENT agent, and the newsletter run that produces them has no idea the
   * blog exists.
   */
  const newsletterLedgerArtifacts: {
    kind: "issue-items" | "scan-log";
    issueNumber: string;
    content: string;
    contentDate: string;
    path: string;
  }[] = [];
  const newsletterStateArtifacts: {
    kind: NewsletterAgentState["kind"];
    content: string;
    contentDate: string;
    path: string;
  }[] = [];
  const redditStateArtifacts: {
    kind: RedditAgentState["kind"];
    account: string | null;
    content: string;
    contentDate: string;
    path: string;
  }[] = [];
  // What is LEFT of the pre-claim deadline, counted from the top of the handler.
  // Every network call below is bounded by this rather than by a fixed
  // per-artifact constant, and a non-positive value means the budget is spent:
  // start nothing new. See rehost-budget.ts for what that does and does not bound.
  const remainingRehostMs = () => REHOST_DEADLINE_MS - (Date.now() - handlerStartedAt);
  // Concurrent deliveries both re-host now (see the claim below), so each
  // delivery writes under its own path segment. Sharing a path would mean the
  // loser's upload replaces the object — and with it the Firebase download
  // token — breaking the URL the winner already stored on the asset.
  const deliveryNonce = randomUUID().slice(0, 8);

  if (payload.status === "done") {

    for (const artifact of payload.artifacts) {
      // The value checked IS the value passed, so AbortSignal.timeout can never
      // be handed zero or a negative. Non-positive means the phase is spent:
      // start nothing new and let the pre-claim check below fail the delivery
      // for retry rather than doing work it is about to discard.
      const fetchBudgetMs = Math.min(ARTIFACT_FETCH_TIMEOUT_MS, remainingRehostMs());
      if (fetchBudgetMs <= 0) break;
      const entry: ExternalJobArtifact = {
        name: artifact.name,
        path: artifact.path,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        clientFacing: artifact.client_facing,
        ...(artifact.content_type ? { contentType: artifact.content_type } : {}),
        url: artifact.url,
      };
      // ONE reporting path for every way a client-facing artifact fails to
      // arrive, so no reason can be quieter than another. The size-capped path
      // used to fall straight through to `artifacts.push(entry)` logging NOTHING
      // while the HTTP-error path logged — same outcome for the client, one of
      // them invisible (#47).
      let copiedIntoOurStorage = false;
      const cannotRehost = (reason: string) => {
        // The two lists stay mutually exclusive. Everything after the upload is
        // pure, but a throw there would otherwise report a file that IS attached
        // to the deliverable as missing from it — a log that contradicts the asset
        // beside it is worse than one line fewer.
        if (copiedIntoOurStorage) return;
        notRehosted.push({ name: artifact.name, reason });
        if (IMAGE_EXTENSIONS.includes(extension(artifact.name))) missingImages.push(artifact.name);
        events.push({
          at: Date.now(),
          level: "error",
          message:
            `Could not re-host ${artifact.name} - ${reason}. ` +
            `It stays on the run record for staff and is NOT attached to the client's deliverable.`,
        });
      };

      // An internal artifact that is LinkedIn v2 state: fetched for its text and
      // nothing else. It is not re-hosted, so it never gains a client-facing URL,
      // never joins `rehosted`, and cannot become part of a deliverable — the
      // only thing that leaves this branch is a string in `liStateArtifacts`.
      const liPath = artifact.path ?? artifact.name;
      const liStateKind = isLinkedInStateJob ? liStateKindFor(liPath) : null;
      const liIsCommit = isLinkedInStateJob && isLiCommitArtifact(liPath);
      const newsletterState = isNewsletterStateJob ? newsletterStateKindFor(liPath) : null;
      if (!artifact.client_facing && newsletterState && artifact.url) {
        try {
          const budget = Math.min(ARTIFACT_FETCH_TIMEOUT_MS, remainingRehostMs());
          if (budget > 0) {
            const res = await fetch(artifact.url, {
              headers: agentServiceFetchHeaders(artifact.url),
              signal: AbortSignal.timeout(budget),
            });
            if (res.ok) {
              const text = (await res.text()).slice(0, NEWSLETTER_STATE_MAX_CHARS);
              if (text.trim()) {
                newsletterStateArtifacts.push({
                  kind: newsletterState,
                  content: text,
                  contentDate: newsletterStateDateFor(liPath, handlerStartedAt),
                  path: liPath,
                });
              }
            }
          }
        } catch {
          // Best-effort and not reported to the client: the issue in front of
          // them is finished either way. The cost is the NEXT run's memory, and
          // the events below record that for staff.
        }
      }
      // The two LEDGER files a newsletter run publishes FOR THE BLOG. Fetched on
      // the newsletter's delivery because that is the only moment they exist:
      // the run folder is destroyed with the runner, and unlike the newsletter's
      // own state the blog cannot regenerate them — they record what another
      // product's paid research found. Internal, so fetched for their text only
      // and never re-hosted.
      const ledgerKind = isNewsletterStateJob ? newsletterLedgerKindFor(liPath) : null;
      const ledgerIssue = ledgerKind ? newsletterIssueNumberFrom(liPath) : null;
      if (!artifact.client_facing && ledgerKind && ledgerIssue && artifact.url) {
        try {
          const budget = Math.min(ARTIFACT_FETCH_TIMEOUT_MS, remainingRehostMs());
          if (budget > 0) {
            const res = await fetch(artifact.url, {
              headers: agentServiceFetchHeaders(artifact.url),
              signal: AbortSignal.timeout(budget),
            });
            if (res.ok) {
              const text = (await res.text()).slice(0, NEWSLETTER_LEDGER_MAX_CHARS);
              if (text.trim()) {
                newsletterLedgerArtifacts.push({
                  kind: ledgerKind,
                  issueNumber: ledgerIssue,
                  content: text,
                  contentDate: newsletterStateDateFor(liPath, handlerStartedAt),
                  path: liPath,
                });
              }
            }
          }
        } catch {
          // Best-effort. The issue in front of the client is finished either way;
          // the cost is the BLOG's next run, and the events below record it.
        }
      }
      const blogState = isBlogStateJob ? blogStateKindFor(liPath) : null;
      if (!artifact.client_facing && blogState && artifact.url) {
        try {
          const budget = Math.min(ARTIFACT_FETCH_TIMEOUT_MS, remainingRehostMs());
          if (budget > 0) {
            const res = await fetch(artifact.url, {
              headers: agentServiceFetchHeaders(artifact.url),
              signal: AbortSignal.timeout(budget),
            });
            if (res.ok) {
              const text = (await res.text()).slice(0, BLOG_STATE_MAX_CHARS);
              if (text.trim()) {
                blogStateArtifacts.push({
                  kind: blogState,
                  content: text,
                  contentDate: blogStateDateFor(liPath, handlerStartedAt),
                  path: liPath,
                });
              }
            }
          }
        } catch {
          // Best-effort, same as its three siblings.
        }
      }
      const carouselState = isCarouselStateJob ? carouselStateKindFor(liPath) : null;
      if (!artifact.client_facing && carouselState && artifact.url) {
        try {
          const budget = Math.min(ARTIFACT_FETCH_TIMEOUT_MS, remainingRehostMs());
          if (budget > 0) {
            const res = await fetch(artifact.url, {
              headers: agentServiceFetchHeaders(artifact.url),
              signal: AbortSignal.timeout(budget),
            });
            if (res.ok) {
              const text = (await res.text()).slice(0, CAROUSEL_STATE_MAX_CHARS);
              if (text.trim()) {
                carouselStateArtifacts.push({
                  kind: carouselState,
                  content: text,
                  contentDate: carouselStateDateFor(liPath, handlerStartedAt),
                  path: liPath,
                });
              }
            }
          }
        } catch {
          // Best-effort, same as its five siblings.
        }
      }
      const reputationState = isReputationStateJob ? reputationStateKindFor(liPath) : null;
      if (!artifact.client_facing && reputationState && artifact.url) {
        try {
          const budget = Math.min(ARTIFACT_FETCH_TIMEOUT_MS, remainingRehostMs());
          if (budget > 0) {
            const res = await fetch(artifact.url, {
              headers: agentServiceFetchHeaders(artifact.url),
              signal: AbortSignal.timeout(budget),
            });
            if (res.ok) {
              const text = (await res.text()).slice(0, REPUTATION_STATE_MAX_CHARS);
              // The guard that makes whole-file replace safe for the two ledgers:
              // an empty body would REPLACE a full response ledger with nothing,
              // which is exactly the state that produces a duplicate public reply.
              if (reputationStateHasContent(text)) {
                reputationStateArtifacts.push({
                  kind: reputationState,
                  content: text,
                  contentDate: reputationStateDateFor(liPath, handlerStartedAt),
                  path: liPath,
                });
              }
            }
          }
        } catch {
          // Best-effort, same as its four siblings.
        }
      }
      const redditState = isRedditStateJob ? redditStateKindFor(liPath) : null;
      const redditIsRunRecord = isRedditStateJob && isRedditRunRecordArtifact(liPath);
      if (!artifact.client_facing && (redditState || redditIsRunRecord) && artifact.url) {
        try {
          const budget = Math.min(ARTIFACT_FETCH_TIMEOUT_MS, remainingRehostMs());
          if (budget > 0) {
            const res = await fetch(artifact.url, {
              headers: agentServiceFetchHeaders(artifact.url),
              signal: AbortSignal.timeout(budget),
            });
            if (res.ok) {
              const text = (await res.text()).slice(0, REDDIT_STATE_MAX_CHARS);
              if (text.trim() && redditIsRunRecord && !redditRunRecord) redditRunRecord = text;
              if (text.trim() && redditState) {
                redditStateArtifacts.push({
                  kind: redditState.kind,
                  account: redditState.account,
                  content: text,
                  contentDate: redditStateDateFor(liPath, handlerStartedAt),
                  path: liPath,
                });
              }
            }
          }
        } catch {
          // Best-effort, and NOT reported to the client: the delivery in front of
          // them is a finished set of replies either way. The cost is the NEXT
          // run's memory, which the events below record for staff.
        }
      } else if (!artifact.client_facing && (liStateKind || liIsCommit) && artifact.url) {
        try {
          const budget = Math.min(ARTIFACT_FETCH_TIMEOUT_MS, remainingRehostMs());
          if (budget > 0) {
            const res = await fetch(artifact.url, {
              headers: agentServiceFetchHeaders(artifact.url),
              signal: AbortSignal.timeout(budget),
            });
            if (res.ok) {
              const text = (await res.text()).slice(0, LI_STATE_MAX_CHARS);
              if (text.trim() && liStateKind) {
                liStateArtifacts.push({
                  kind: liStateKind,
                  content: text,
                  contentDate: liStateDateFor(liPath, handlerStartedAt),
                  path: liPath,
                });
              }
              if (text.trim() && liIsCommit) liCommitJson = text;
            }
          }
        } catch {
          // Best-effort by design, and NOT reported to the client. State that
          // fails to capture costs the NEXT run its memory, which the events
          // below record for staff — but the delivery in front of this client is
          // a finished post either way, and failing it would throw that away.
        }
      } else if (!artifact.client_facing) {
        // Internal working file: never re-hosted, never on the asset, not a
        // failure. Its service URL on the job record is the intended state.
      } else if (!artifact.url) {
        cannotRehost("the service sent no download URL");
      } else if (artifact.bytes > REHOST_FILE_LIMIT_BYTES) {
        cannotRehost(
          `it is ${mbAtLeast(artifact.bytes)} MB, past the ${mbExact(REHOST_FILE_LIMIT_BYTES)} MB per-file limit`,
        );
      } else if (rehostedTotal + artifact.bytes > REHOST_TOTAL_LIMIT_BYTES) {
        // Says why THIS file was refused, not just how full the run is. "already
        // copied 149 MB of its 150 MB limit" reads as though there was room.
        cannotRehost(
          `this run has already copied ${mbAtMost(rehostedTotal)} MB and this file would take it past its ${mbExact(REHOST_TOTAL_LIMIT_BYTES)} MB limit`,
        );
      } else {
        try {
          const res = await fetch(artifact.url, {
            headers: agentServiceFetchHeaders(artifact.url),
            signal: AbortSignal.timeout(fetchBudgetMs),
          });
          if (!res.ok) {
            cannotRehost(`the service answered HTTP ${res.status}`);
          } else {
            const bytes = Buffer.from(await res.arrayBuffer());
            // Measured HERE, immediately before the upload, rather than before
            // the body read above — reading the body spends phase budget too,
            // and a budget measured before it would let a slow read push the
            // upload past the deadline. Non-positive means don't start the
            // upload: this artifact keeps its service URL on the job record, is
            // reported as un-attachable below, and the top of the loop ends the
            // phase.
            const uploadBudgetMs = Math.min(ARTIFACT_UPLOAD_TIMEOUT_MS, remainingRehostMs());
            if (uploadBudgetMs <= 0) {
              cannotRehost("the run ran out of time before the file could be copied");
            } else {
              rehostedTotal += bytes.length;
              const hosted = await uploadBytes({
                bytes,
                path: `agent-service/${job.id}/${deliveryNonce}/${artifact.sha256.slice(0, 12)}-${artifact.name}`,
                contentType: artifact.content_type ?? "application/octet-stream",
                timeoutMs: uploadBudgetMs,
              });
              entry.url = hosted.url;
              copiedIntoOurStorage = true;
              // The setup run's structured output (seam T1). Captured here off
              // the bytes we already fetched — no second round-trip — and only
              // for launch runs, so a client agent that happens to ship a
              // templates.json in a normal run can't reseed the registry.
              if (isLaunchRun && isLaunchTemplatesArtifact(artifact.name)) {
                launchTemplatesJson = bytes.toString("utf8").slice(0, 20_000);
              }
              const ext = extension(artifact.name);
              if (TEXT_EXTENSIONS.includes(ext)) {
                const content = bytes.toString("utf8");
                // Setup-run per-seat voice profiles (x-agent-v2): captured off
                // the same decoded bytes, setup runs only — same rule as the
                // templates.json capture above.
                //
                // OR the LinkedIn v2 SETUP agent, which is the same kind of run
                // reached a different way. `isLaunchRun` requires a clientAgents
                // umbrella, and LinkedIn v2 deliberately has none: adding a
                // person is a repeatable act, and that flow allows exactly one
                // launch per umbrella (`already_live`). Keyed to the SETUP agent
                // and never the writer — a drafting run must not be able to
                // overwrite the voice it drafted with.
                const voiceProfileMatch = artifact.name
                  .split("/")
                  .pop()
                  ?.match(/^voice-profile--(.+)\.md$/i);
                if ((isLaunchRun || isLinkedInSetupJob) && voiceProfileMatch) {
                  voiceProfileArtifacts.push({ seatSlug: voiceProfileMatch[1], content });
                }
                // A Reddit v2 run's per-thread folders, kept as (path, text)
                // pairs so the envelope can be assembled after the claim: the
                // reader is handed ONE string, and these folders are what has to
                // become it.
                if (isRedditStateJob) {
                  redditClientFiles.push({ path: artifact.path ?? artifact.name, text: content });
                }
                // The newsletter's D7 four. Collected as (path, text) pairs so the
                // envelope can be assembled after the claim: the two themes are
                // built by one command so they never disagree, which only holds
                // if they reach the reader together.
                if (isNewsletterStateJob) {
                  newsletterClientFiles.push({
                    path: artifact.path ?? artifact.name,
                    text: content,
                  });
                }
                // A blog v2 run's five client files — the standalone page, the
                // CMS fragment, the markdown, about.txt and publish-notes.txt.
                // Same reason as the newsletter's four: the reader is handed ONE
                // string, and a size race would give them the page instead of the
                // fragment they actually paste.
                if (isBlogStateJob) {
                  blogClientFiles.push({ path: artifact.path ?? artifact.name, text: content });
                }
                // A reputation pulse's client folder: `01-response-drafts/`,
                // `02-flags/` and about.txt. Collected as (path, text) pairs
                // because the FOLDER decides which bucket a file lands in, and
                // the size race would otherwise hand the reader one draft and
                // drop every flag — the half with a deadline.
                if (isReputationStateJob) {
                  reputationClientFiles.push({
                    path: artifact.path ?? artifact.name,
                    text: content,
                  });
                }
                if (isCarouselStateJob) {
                  carouselClientFiles.push({
                    path: artifact.path ?? artifact.name,
                    text: content,
                  });
                }
                // DRAFTS.md is the pinned deliverable-of-record for the drafting
                // agents (X, LinkedIn) — prefer it deterministically over the
                // size race, so a long sibling text file (a video brief, an
                // about.txt) can never displace the batch the reader parses and
                // the next run's anti-duplication re-injects.
                const isDrafts = (a: AgentServiceArtifact) =>
                  a.name.split("/").pop()?.toLowerCase() === "drafts.md";
                if (
                  !primaryText ||
                  (isDrafts(artifact) && !isDrafts(primaryText.artifact)) ||
                  (isDrafts(artifact) === isDrafts(primaryText.artifact) &&
                    content.length > primaryText.content.length)
                ) {
                  primaryText = { artifact, content };
                }
              } else if (IMAGE_EXTENSIONS.includes(ext)) {
                imageEntries.push({ name: artifact.name, url: hosted.url });
              }
            }
          }
        } catch {
          // The fetch timed out, the body read died, or the upload threw. This
          // catch cannot tell the three apart, so the reason does not pretend to.
          cannotRehost("the transfer failed");
        }
      }
      artifacts.push(entry);
      if (copiedIntoOurStorage) rehosted.push(entry);
    }
  }

  // Natural-sort by filename so slide-2 precedes slide-10, then expose each
  // image as a carousel slide the asset card can page through.
  const orderedImages = imageEntries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  const orderedImageUrls = orderedImages.map((e) => e.url);
  // #50 — the carousel that arrives short. `slides` and the cover below are
  // derived from the images that re-hosted, so a failed slide leaves a carousel
  // one photo shorter and, when it is the FIRST one, hands the cover to the next
  // slide along. Both were silent. Nothing here can recover the missing photo;
  // what it can do is stop the run reading as complete, and name the file that is
  // now the cover so the two facts are in one place.
  if (missingImages.length > 0 && orderedImages.length > 0) {
    events.push({
      at: Date.now(),
      level: "error",
      message:
        `Carousel is short ${missingImages.length} photo(s) (${missingImages.join(", ")}) - ` +
        `the deliverable carries ${orderedImages.length}, and the cover is now ${orderedImages[0]!.name}.`,
    });
  }
  const slides =
    orderedImageUrls.length > 1 ? orderedImageUrls.map((url) => ({ imageUrl: url })) : undefined;
  // THE count of what the client is actually getting, and the reason it is not
  // `artifacts.filter(clientFacing).length` any more (#51): that number counted
  // what the manifest DECLARED. A 60s timeout or a non-200 on DRAFTS.md left it
  // at 1 and created a titled asset with an empty body, an orderKey, a chain date
  // and a place on the calendar — a deliverable, as far as every surface could
  // tell, with nothing in it.
  //
  // "Copied" and not "has text": an image-only run is a real delivery whose
  // primary text is legitimately empty (task-sync.ts, on `artifact: ""` being a
  // real renderable state), and so is a PDF-only run. What is not a delivery is a
  // run where nothing at all reached our storage.
  // ── Reddit v2: the folders become the reader's one string ──
  // v2 writes client/<nn>-answer/{approach-1.md,approach-2.md,about.txt}, and the
  // reader is handed `asset.content` alone. So the folders are flattened here,
  // where the file bytes already exist, into the versioned envelope both sides
  // import from lib/reddit-drafts.
  //
  // The OUTCOME comes from the run's own record, never from counting files. An
  // empty thread list means either "nothing was worth your account's name" (a
  // correct run) or "we could not read Reddit" (our datacenter address is
  // blocked), and telling a client the first when the second is true blames their
  // niche for our outage. With no record to read, `delivered` is only claimed when
  // threads actually arrived.
  const redditEnvelope =
    isRedditStateJob && (redditClientFiles.length > 0 || redditRunRecord)
      ? (() => {
          const record = redditRunRecord ? redditOutcomeFrom(redditRunRecord) : { outcome: null };
          const built = buildRedditV2Envelope({
            files: redditClientFiles,
            outcome: record.outcome ?? "delivered",
            ...(record.consideredCount !== undefined
              ? { consideredCount: record.consideredCount }
              : {}),
            ...(record.outcomeNote ? { outcomeNote: record.outcomeNote } : {}),
          });
          if (!record.outcome && built.threads.length === 0) built.outcome = "held";
          return built;
        })()
      : null;
  if (redditEnvelope) {
    events.push({
      at: Date.now(),
      level: redditEnvelope.outcome === "degraded" ? "error" : "info",
      message:
        redditEnvelope.outcome === "degraded"
          ? "Reddit could not be read on this run (datacenter addresses are blocked), so nothing was judged. This is not 'no good threads'."
          : `Reddit run outcome: ${redditEnvelope.outcome} - ${redditEnvelope.threads.length} thread(s) delivered.`,
    });
  }

  // ── Newsletter v2: the D7 four become the reader's one string ──
  const newsletterEnvelope = isNewsletterStateJob
    ? buildNewsletterEnvelope(newsletterClientFiles)
    : null;
  const newsletterEnvelopeJson =
    newsletterEnvelope && newsletterEnvelopeHasContent(newsletterEnvelope)
      ? JSON.stringify(newsletterEnvelope)
      : null;

  // ── Blog v2: the D40+D56 five become the reader's one string ──
  const blogEnvelope = isBlogStateJob ? buildBlogEnvelope(blogClientFiles) : null;
  const blogEnvelopeJson =
    blogEnvelope && blogEnvelopeHasContent(blogEnvelope) ? JSON.stringify(blogEnvelope) : null;

  // ── Reputation v2: the client folder becomes the reader's one string ──
  const reputationEnvelope = isReputationStateJob
    ? buildReputationEnvelope(reputationClientFiles)
    : null;
  const reputationEnvelopeJson =
    reputationEnvelope && reputationEnvelopeHasContent(reputationEnvelope)
      ? JSON.stringify(reputationEnvelope)
      : null;

  // ── Carousel v2: the caption and about become the reader's one string ──
  // The SLIDE NAMES come off the client-facing artifact manifest rather than the
  // text list, because the slides are images: their bytes never pass through the
  // text branch above. Counting them here is what lets a reader see that ten
  // were made and notice when nine arrived.
  const carouselEnvelope = isCarouselStateJob
    ? buildCarouselEnvelope(
        carouselClientFiles,
        artifacts.filter((a) => a.clientFacing && isCarouselSlideName(a.name)).map((a) => a.name),
      )
    : null;
  const carouselEnvelopeJson =
    carouselEnvelope && carouselEnvelopeHasContent(carouselEnvelope)
      ? JSON.stringify(carouselEnvelope)
      : null;

  const deliveredCount = rehosted.length;
  // For the Task Map sync below: the run may have been dispatched by a board
  // task, whose ticket gets the deliverable for client preview.
  const redditEnvelopeJson = redditEnvelope ? JSON.stringify(redditEnvelope) : null;
  const taskArtifactContent = newsletterEnvelopeJson
    ? newsletterEnvelopeJson.slice(0, CONTENT_CHAR_CAP)
    : blogEnvelopeJson
    ? blogEnvelopeJson.slice(0, CONTENT_CHAR_CAP)
    : reputationEnvelopeJson
    ? reputationEnvelopeJson.slice(0, CONTENT_CHAR_CAP)
    : carouselEnvelopeJson
    ? carouselEnvelopeJson.slice(0, CONTENT_CHAR_CAP)
    : redditEnvelopeJson
    ? redditEnvelopeJson.slice(0, CONTENT_CHAR_CAP)
    : primaryText
      ? primaryText.content.slice(0, CONTENT_CHAR_CAP)
      : "";
  const taskArtifactImage = orderedImageUrls[0] ?? null;

  // Last pre-claim guard: the re-host has eaten the budget this handler needed
  // for the writes below, so fail the delivery instead of claiming a job we
  // cannot finish paying out. 503 is retryable to the service (5xx maps to
  // "unreachable" in agent-service/src/webhooks/deliver.ts, and the webhooks
  // queue gives it exponential backoff over ~42 minutes), and nothing has been
  // claimed, so the retry runs the whole delivery again with a fresh budget.
  if (remainingRehostMs() <= 0) {
    // Log it OUR side too. The sender abandons each delivery at 30s while this
    // budget is longer, so by the time this 503 exists the socket is usually
    // gone and nobody reads the body — the service just sees its own attempt
    // time out. This line is the only place the real reason is legible.
    console.error(
      `[webhook] re-host budget exceeded for job ${job.id} (service job ${payload.job_id}): ` +
        `${rehostedTotal} bytes re-hosted in ${Date.now() - handlerStartedAt}ms of ` +
        `${REHOST_DEADLINE_MS}ms. Delivery failed for retry; nothing claimed.`,
    );
    return NextResponse.json(
      { error: "Re-host budget exceeded — retry delivery" },
      { status: 503 },
    );
  }

  // ── Atomic claim ──
  // The single gate on every persisted side effect below it: the asset, the job
  // record, the launch-state advance, the task sync and the usage log. Exactly
  // one delivery flips the job out of queued/running, which is what makes the
  // service's redelivery idempotent.
  //
  // Deliberate trade (finding #45): because the re-host above now runs first,
  // two GENUINELY CONCURRENT deliveries can both fetch and upload, and the one
  // that loses this claim leaves its uploaded bytes orphaned in storage. We
  // accept duplicate blobs — the alternative was re-hosting after the claim,
  // where a wall-clock kill left a success-looking "review" job with no assets,
  // no error, the client's credits spent, and no recovery path at all. A LATER
  // redelivery of a settled job pays nothing: the advisory filter above turns it
  // away before the re-host.
  //
  // The window this leaves: a kill between this claim and `createAsset` below
  // still produces that unrecoverable state. What the reorder bought is its
  // size — one Firestore write instead of the fetch and upload of a whole
  // manifest.
  const claimed = await claimExternalJobCompletion(job.id, status);
  if (!claimed) {
    return NextResponse.json({ ok: true, skipped: true, reason: "Already processed" });
  }

  const now = Date.now();
  // Only the id THIS delivery creates, for the same reason `events` above holds
  // only this delivery's lines: both are merged onto a freshly-read base at the
  // write below. Unlike `events`, no second writer appends here today — job
  // creation seeds it empty and this handler is the only thing that ever adds
  // to it — so this half is symmetry with the events merge, not a loss being
  // repaired.
  const newAssetIds: string[] = [];
  let createdAssetId: string | null = null;

  if (payload.status === "done") {
    // Setup-run voice profiles (x-agent-v2): generic on any custom agent with
    // seats, not gated to X — resolved via the job's customAgentId so LinkedIn/
    // Reddit adopt this with no webhook change once they emit the same
    // artifact convention. Best-effort AND after the claim: a save failure here
    // must not fail the whole delivery — the next launch run re-sweeps and
    // overwrites anyway.
    if ((isLaunchRun || isLinkedInSetupJob) && voiceProfileArtifacts.length > 0) {
      try {
        const customAgent = job.customAgentId ? await getCustomAgent(job.customAgentId) : null;
        const agentKey = customAgent?.key ?? "";
        const agent = isXAgent(agentKey)
          ? "x"
          : isLinkedInAgent(agentKey)
            ? "linkedin"
            : isRedditAgent(agentKey)
              ? "reddit"
              : null;
        if (agent) {
          const seats = await listClientSeats(job.clientId);
          const seatBySlug = new Map(seats.map((s) => [s.slug, s]));
          for (const { seatSlug, content } of voiceProfileArtifacts) {
            const seat = seatBySlug.get(seatSlug);
            if (!seat) continue;
            await upsertSeatVoiceProfile({
              clientId: job.clientId,
              agent,
              seatId: seat.id,
              content,
              builtAt: now,
              builtByJobId: job.id,
            });
          }
        }
      } catch (e) {
        console.error("[webhook] seat voice profile save failed:", e);
        events.push({
          at: Date.now(),
          level: "error",
          message: "Voice profile save failed - retries on the next launch run",
        });
      }
    }

    // LinkedIn v2 durable state. After the claim and best-effort, like the sweep
    // above: this is the NEXT run's memory, and losing it must not fail a delivery
    // that already produced a post. It IS reported as an error event, because a
    // run whose ledger did not persist will repeat itself and that is the only
    // place anyone could find out why.
    if (liStateArtifacts.length > 0) {
      // Last write wins per kind, and the manifest's order is the run's own write
      // order, so the newest copy of each file is the one that lands.
      const byKind = new Map(liStateArtifacts.map((row) => [row.kind, row]));
      for (const row of byKind.values()) {
        try {
          await upsertLiAgentState({
            clientId: job.clientId,
            kind: row.kind,
            content: row.content,
            contentType: row.path.endsWith(".json")
              ? "application/json"
              : row.path.endsWith(".yaml") || row.path.endsWith(".yml")
                ? "text/yaml"
                : "text/markdown",
            contentDate: row.contentDate,
            capturedFromJobId: job.id,
            capturedAt: now,
          });
        } catch (e) {
          console.error(`[webhook] LinkedIn ${row.kind} state save failed:`, e);
          events.push({
            at: Date.now(),
            level: "error",
            message: `LinkedIn ${row.kind} did not persist - the next run will not see this run's changes to it.`,
          });
        }
      }
    }

    // Newsletter v2 durable state. After the claim and best-effort, like its two
    // siblings. The ISSUE INDEX is called out in its own error line because its
    // failure mode is not forgetfulness: without it the next run claims a number
    // that already shipped, and a real subscriber list receives a second copy of
    // the same issue.
    if (newsletterStateArtifacts.length > 0) {
      const byKind = new Map(newsletterStateArtifacts.map((row) => [row.kind, row]));
      for (const row of byKind.values()) {
        try {
          await upsertNewsletterAgentState({
            clientId: job.clientId,
            kind: row.kind,
            content: row.content,
            contentType: newsletterStateContentType(row.path),
            contentDate: row.contentDate,
            capturedFromJobId: job.id,
            capturedAt: now,
          });
        } catch (e) {
          console.error(`[webhook] newsletter ${row.kind} state save failed:`, e);
          events.push({
            at: Date.now(),
            level: "error",
            message:
              row.kind === "issue-index"
                ? "The newsletter ISSUE INDEX did not persist. The next run may claim an issue number that has already been sent - check the index before running again."
                : `Newsletter ${row.kind} did not persist - the next run will not see this run's changes to it.`,
          });
        }
      }
    }

    // The newsletter's PER-ISSUE research, for the blog. One row per (issue,
    // kind) so a client's whole shipped history stays readable — the blog walks a
    // window of the six most recent issues, and overwriting the previous issue's
    // handoff would make that window one deep.
    //
    // The issue MARKDOWN comes from the envelope rather than from a second fetch:
    // it is client-facing, so its bytes are already decoded above. Taking it from
    // the envelope also guarantees the blog reads exactly the text the client
    // was given, which is the framework's own rule — never the internal trail.
    if (newsletterLedgerArtifacts.length > 0 || (isNewsletterStateJob && newsletterEnvelope)) {
      const rows: Array<{
        kind: NewsletterLedgerEntry["kind"];
        issueNumber: string;
        content: string;
        contentDate: string;
        contentType: string;
      }> = newsletterLedgerArtifacts.map((row) => ({
        kind: row.kind,
        issueNumber: row.issueNumber,
        content: row.content,
        contentDate: row.contentDate,
        contentType: "application/json",
      }));
      const issueNumber = newsletterEnvelope?.issueNumber;
      if (issueNumber && newsletterEnvelope?.text?.trim()) {
        rows.push({
          kind: "issue-markdown",
          issueNumber,
          content: newsletterEnvelope.text.slice(0, NEWSLETTER_LEDGER_MAX_CHARS),
          contentDate: new Date(now).toISOString().slice(0, 10),
          contentType: "text/markdown",
        });
      }
      for (const row of rows) {
        try {
          await upsertNewsletterLedgerEntry({
            clientId: job.clientId,
            issueNumber: row.issueNumber,
            kind: row.kind,
            content: row.content,
            contentType: row.contentType,
            contentDate: row.contentDate,
            capturedFromJobId: job.id,
            capturedAt: now,
          });
        } catch (e) {
          console.error(`[webhook] newsletter ledger ${row.kind} save failed:`, e);
          events.push({
            at: Date.now(),
            level: "error",
            message:
              `Issue ${row.issueNumber}'s ${row.kind} did not persist. The BLOG agent reads this to pick` +
              " a subject, so that issue will not appear as a candidate for it. The newsletter itself is unaffected.",
          });
        }
      }
    }

    // Blog v2 durable state. Reported as an error because the POST INDEX and the
    // CLUSTERS file carry this run's three claims: without them two presses can
    // take different post numbers and then write the same article, which is the
    // failure the subject claim exists to prevent.
    if (blogStateArtifacts.length > 0) {
      const byKind = new Map(blogStateArtifacts.map((row) => [row.kind, row]));
      for (const row of byKind.values()) {
        try {
          await upsertBlogAgentState({
            clientId: job.clientId,
            kind: row.kind,
            content: row.content,
            contentType: blogStateContentType(row.path),
            contentDate: row.contentDate,
            capturedFromJobId: job.id,
            capturedAt: now,
          });
        } catch (e) {
          console.error(`[webhook] blog ${row.kind} state save failed:`, e);
          events.push({
            at: Date.now(),
            level: "error",
            message:
              row.kind === "post-index"
                ? "The blog POST INDEX did not persist. The next run may claim a post number that has already published, and every pending internal link on it is lost - check the index before running again."
                : row.kind === "clusters"
                  ? "The blog CLUSTERS file did not persist. It holds this run's subject claim, so a second run could pick the same subject and write the same article."
                  : `Blog ${row.kind} did not persist - the next run will not see this run's changes to it.`,
          });
        }
      }
    }

    // Carousel v2 durable state. Reported as an error because the TOPIC
    // CATALOGUE is the continuity file: without it the next press picks a topic
    // already on the client's public grid, where a repeat is visible to everyone
    // who follows them.
    if (carouselStateArtifacts.length > 0) {
      const byKind = new Map(carouselStateArtifacts.map((row) => [row.kind, row]));
      for (const row of byKind.values()) {
        try {
          await upsertCarouselAgentState({
            clientId: job.clientId,
            kind: row.kind,
            content: row.content,
            contentType: carouselStateContentType(row.path),
            contentDate: row.contentDate,
            capturedFromJobId: job.id,
            capturedAt: now,
          });
        } catch (e) {
          console.error(`[webhook] carousel ${row.kind} state save failed:`, e);
          events.push({
            at: Date.now(),
            level: "error",
            message:
              row.kind === "topic-catalog"
                ? "The carousel TOPIC CATALOGUE did not persist. The next post may repeat a subject that has already been published - check the catalogue before running again."
                : row.kind === "style-config"
                  ? "The carousel STYLE CONFIG did not persist. The next post has no visual system to build against and will stop."
                  : `Carousel ${row.kind} did not persist - the next run will not see this run's changes to it.`,
          });
        }
      }
    }

    // Reputation v2 durable state. Reported as an error because the RESPONSE
    // LEDGER is the no-repeat memory: without it the next pulse drafts a second
    // public reply to a review a human already answered, under the client's own
    // name, on a page strangers read.
    if (reputationStateArtifacts.length > 0) {
      const byKind = new Map(reputationStateArtifacts.map((row) => [row.kind, row]));
      for (const row of byKind.values()) {
        try {
          await upsertReputationAgentState({
            clientId: job.clientId,
            kind: row.kind,
            content: row.content,
            contentType: reputationStateContentType(row.path),
            contentDate: row.contentDate,
            capturedFromJobId: job.id,
            capturedAt: now,
          });
        } catch (e) {
          console.error(`[webhook] reputation ${row.kind} state save failed:`, e);
          events.push({
            at: Date.now(),
            level: "error",
            message:
              row.kind === "response-ledger"
                ? "The reputation RESPONSE LEDGER did not persist. The next check may draft a second public reply to a review that has already been answered - check the ledger before running again."
                : row.kind === "crisis-ledger"
                  ? "The reputation CRISIS LEDGER did not persist. The record of what was escalated, and to whom, is missing for this run."
                  : row.kind === "roster"
                    ? "The reputation ROSTER did not persist. The next check has nowhere to read from and will stop."
                    : `Reputation ${row.kind} did not persist - the next run will not see this run's changes to it.`,
          });
        }
      }
    }

    // Reddit v2 durable state. After the claim and best-effort, like the sibling
    // sweeps. Reported as an error event because a run whose RULES AUDIT did not
    // persist is the one case where the next run is not merely forgetful but
    // unsafe — it would hold no reading of what each subreddit allows.
    if (redditStateArtifacts.length > 0) {
      // Last write wins per (kind, account); the manifest's order is the run's own
      // write order, so the newest copy of each file lands.
      const byKey = new Map(
        redditStateArtifacts.map((row) => [`${row.kind}::${row.account ?? ""}`, row]),
      );
      for (const row of byKey.values()) {
        try {
          await upsertRedditAgentState({
            clientId: job.clientId,
            kind: row.kind,
            account: row.account,
            content: row.content,
            contentType: redditStateContentType(row.path),
            contentDate: row.contentDate,
            capturedFromJobId: job.id,
            capturedAt: now,
          });
        } catch (e) {
          console.error(`[webhook] Reddit ${row.kind} state save failed:`, e);
          events.push({
            at: Date.now(),
            level: "error",
            message:
              `Reddit ${row.kind} did not persist` +
              (row.kind === "rules-audit"
                ? " - the next run has NO record of what each subreddit allows and must re-read them before drafting."
                : " - the next run will not see this run's changes to it."),
          });
        }
      }
    }

    // Close the direction requests this run reported covering. Matched on the
    // exact request text, because that is what the run was given and the only
    // handle it has on a row — the portal never sends it a document id.
    if (liCommitJson) {
      try {
        const covered = coveredDirectionRequests(liCommitJson);
        if (covered.length > 0) {
          const open = (await listLiDirectionRequests(job.clientId, { status: "open" })).filter(
            (row) => covered.includes(row.request.trim()),
          );
          for (const row of open) {
            await markLiDirectionRequestCovered(job.clientId, row.id, job.id);
          }
        }
      } catch (e) {
        // A row left open is re-offered next run, which is the harmless
        // direction: the client asked for it and gets it again.
        console.error("[webhook] LinkedIn direction-request close failed:", e);
      }
    }

    if (deliveredCount > 0) {
      // Custom agents (e.g. the LinkedIn generators) produce any asset shape, so
      // the slot-less library note is the safe default — but the submitter can
      // hint the real type + platform through metadata, which lands the draft as
      // a schedulable post with the right recommended window.
      //
      // The hint is whitelisted AND fenced: the type is what decides whether the
      // product offers to publish this deliverable, and a Reddit reply must never
      // become publishable (#49 — the fence, the whitelist and the task-type map
      // are all in agent-service/deliverable-asset-type.ts). The deliverable's own
      // text is the primary signal, the run's identity strings the fallback.
      const assetType = deliverableAssetType({
        taskType: payload.task_type,
        hint: payload.metadata?.asset_type,
        content: primaryText?.content,
        identity: [
          job.agentName,
          job.title,
          payload.metadata?.karos_agent_key,
          payload.metadata?.platform,
        ],
      });
      const platform = payload.metadata?.platform || undefined;
      // Strip the appended " - <client>" the submit paths add, so a client's
      // own workspace doesn't put their company name in half of every title.
      // Separator and strip share one definition (lib/job-title.ts) — this
      // looked for an em dash while every builder wrote a hyphen, so it never
      // fired for any run from any path.
      // The title stays the produced-work base — NEVER the typed brief. F132's
      // ruling ("never echo free-text input as a client-facing label") is why
      // Job.runLabel rides in meta below instead of being baked in here: meta
      // lets a staff surface show what was asked while every client surface
      // keeps reading a produced-work title. It also keeps free text out of
      // AgentMark's platform sniff, which reads titles.
      const assetTitle = assetTitleFromJobTitle(job.title, job.agentName);
      // Only real catalog products get a template chip; "custom" runs have no
      // managed product (getManagedProduct would fall back to the first one).
      const managedProduct = MANAGED_PRODUCTS.find((p) => p.taskType === payload.task_type);
      // The job is already claimed (single delivery, see above), so a write
      // failure here can't fall back to redelivery — a naive throw would 500
      // and strand the run with no asset, no cost/usage log (the after() below
      // never registers), and for a client-charged custom-agent run, no refund.
      // Catch, log, refund the charge (a no-op for staff-fired runs), and let
      // the job-status/cost-logging writes below still run instead of dying here.
      try {
        const assetId = await createAsset({
          clientId: job.clientId,
          jobId: job.id,
          agentId: "agent-service",
          type: assetType,
          title: assetTitle,
          // The Reddit v2 envelope wins over the size-picked primary text: the
          // reader parses this exact string, and one of the run's own approach
          // files would otherwise be chosen as "the deliverable" by length.
          // The newsletter envelope wins over the size race for the same reason
          // Reddit's does: the largest text file here is one of the two HTML
          // renders, and picking it would call half the deliverable the whole of
          // it and lose the other three files.
          // The blog envelope wins for the same reason both of those do, and its
          // size race is the worst of the three: `<slug>.html` and
          // `<slug>-body.html` are near-identical in length, so which one a
          // client received as "the article" would have come down to how much
          // page chrome the template happened to add.
          content: newsletterEnvelopeJson
            ? newsletterEnvelopeJson.slice(0, CONTENT_CHAR_CAP)
            : blogEnvelopeJson
            ? blogEnvelopeJson.slice(0, CONTENT_CHAR_CAP)
            : reputationEnvelopeJson
            ? reputationEnvelopeJson.slice(0, CONTENT_CHAR_CAP)
            : carouselEnvelopeJson
            ? carouselEnvelopeJson.slice(0, CONTENT_CHAR_CAP)
            : redditEnvelopeJson
            ? redditEnvelopeJson.slice(0, CONTENT_CHAR_CAP)
            : primaryText
              ? primaryText.content.slice(0, CONTENT_CHAR_CAP)
              : "",
          meta: {
            taskType: payload.task_type,
            agentsRepoSha: payload.agents_repo_sha,
            // What the run was ASKED to do (see Job.runLabel). Staff-facing
            // data: surfaces that show it must gate on the viewer (F132).
            ...(job.runLabel ? { runLabel: job.runLabel } : {}),
            // ONLY the artifacts now in our own storage — see the `rehosted`
            // note above. This was `artifacts.filter(clientFacing)`, which put
            // every un-re-hosted 7-day service URL onto the client's asset:
            // assetVideos/assetImages read this list, so a 30 MB clip over the
            // per-file cap played for a week and then 403'd forever (#47), and a
            // carousel's failed slide left its dying URL in the record (#50).
            artifacts: rehosted,
            ...(slides ? { slides } : {}),
            // Staff-only working material, excluded from every client library
            // surface by getClientLibraryAssets. Flagged on the asset itself
            // rather than inferred later: the exclusion has to survive whatever
            // status or date this asset ends up with.
            ...(isLaunchRun ? { launchDeliverable: true, clientAgentId } : {}),
            // Same exclusion mechanism, for a Control Room Test Run — see
            // isTestRun above and asset-visibility.ts's isTestRunAsset().
            ...(isTestRun ? { testRun: true } : {}),
          },
          imageUrl: orderedImageUrls[0] ?? null,
          ...(platform ? { channels: [platform] } : {}),
          status: "draft",
          // Template attribution, in precedence order. A managed product IS its
          // own template. A custom run fired against one of the umbrella's
          // template streams carries the key on the job (submit-custom stores it
          // and echoes karos_template_key) — and until now the webhook dropped it
          // on the floor, so every post a per-template run produced arrived with
          // no template at all. That is the join the archive groups by, the chip
          // the calendar paints and the key per-template feedback is scoped to:
          // without it a client's own streams are invisible on their deliverables.
          ...(managedProduct
            ? { templateKey: payload.task_type, templateName: managedProduct.name }
            : runTemplate
              ? {
                  templateKey: runTemplate.key,
                  ...(runTemplate.name ? { templateName: runTemplate.name } : {}),
                }
              : {}),
          orderKey: orderKeyForCreatedAt(now, job.id),
          ...recommendedScheduleFields(assetType, 0, platform),
          createdBy: "agent-service",
          createdAt: now,
          updatedAt: now,
        });
        newAssetIds.push(assetId);
        createdAssetId = assetId;
        // Auto-assign the new post its one-per-day chain date. Best-effort: the
        // job is already claimed (single delivery), so a reflow failure must not
        // fail the webhook — it self-heals on the next import/webhook/staff reflow.
        // Launch deliverables are skipped entirely: they are not calendar
        // entities, and reflowing them would hand a client's chain a day for a
        // document about templates. Test-run output is skipped the same way — it
        // must never get a calendar date until (if ever) promoted out of test.
        if (!isLaunchRun && !isTestRun) {
          await reflowClientChain(job.clientId).catch(() =>
            events.push({
              at: Date.now(),
              level: "error",
              message: "Calendar reflow failed - run the staff reflow action",
            }),
          );

          // §4.5b — an X drafts BATCH landing is the moment its days can be
          // sliced into daily options. This is where the batch actually arrives:
          // the recurring X run delivers here every week, and the horizon path
          // (which is template-gated, and an options umbrella has no templates)
          // never sees it. Identified by the same parse predicate as every other
          // X surface, and looked up BY this job's client so a crafted payload
          // cannot reach another tenant's plan.
          //
          // Safe after the single-use claim: assignment never touches a day that
          // already has options, so a redelivery adds nothing. Best-effort for
          // the same reason the reflow above is — the deliverable is already
          // written, and the next batch re-attempts any day still unassigned.
          await syncOptionsFromBatchAsset({
            clientId: job.clientId,
            assetId,
            content: primaryText ? primaryText.content : "",
          }).catch(() =>
            events.push({
              at: Date.now(),
              level: "error",
              message: "Daily options assignment failed - retries on the next batch",
            }),
          );
        }
      } catch (e) {
        console.error("[webhook] asset creation failed:", e);
        events.push({
          at: Date.now(),
          level: "error",
          message: `Failed to create deliverable asset: ${e instanceof Error ? e.message : "unknown error"}`,
        });
        // Keyed by the JOB only, deliberately. A task-dispatched run whose asset
        // write throws still lands its draft on the board ticket (task-sync
        // below writes `artifact: taskArtifactContent` on the success path), so
        // the client did receive the deliverable — just not into their library.
        // The zero-deliverable branch below is the case where they received
        // nothing at all, and that one pairs on the task key too.
        await refundJobCharge(
          job.id,
          `Auto-refund · asset creation failed · ${job.agentName}`.slice(0, 120),
        ).catch((refundErr) =>
          console.error("[webhook] refund after asset-creation failure also failed:", refundErr),
        );
      }
    } else if (!isLaunchRun) {
      // A run that finished with NOTHING THE CLIENT CAN SEE. The service says
      // "done", so the refund above (gated on a non-done status) never fires and
      // the asset-creation refund below it is unreachable — no asset was
      // attempted. The client paid for a deliverable and received none, which is
      // the same outcome as a failed run and is refunded the same way.
      //
      // REACHED TWO WAYS since #51: a manifest with no client-facing artifact at
      // all, and a manifest whose client-facing artifacts all failed to reach our
      // storage. The second used to create an empty titled asset instead, so it
      // never refunded and never released the ticket. `notRehosted` below is what
      // keeps the two apart in the log — "produced no deliverables" would be a
      // lie about a run that produced a file we could not copy.
      //
      // BOTH LEDGER KEYS, because the charge is not always filed under the job.
      // A run fired at the agent directly is charged under the JOB id; a run
      // dispatched by a board task was charged under the TASK id before this job
      // existed (execution-actions passes `jobId: task.id`), and the job itself
      // was submitted as the non-billable task engine, so nothing was ever
      // written under job.id for it. Task dispatch is the ordinary way a client
      // spends agent credits, so looking up the job alone made this refund a
      // no-op for most real runs. The task is resolved from OUR record of the
      // dispatch (findDispatchingTask), not from the payload's word for it.
      //
      // Idempotent by construction: refundJobCharge writes the deterministic
      // refund_<chargeEntryId> ledger id via tx.create() — keyed to the CHARGE,
      // not to the key it was found under — so a redelivery that gets past the
      // advisory filter, and the task-sync refund further down, cannot pay
      // twice. A no-op for staff-fired runs, which were never charged.
      const zeroDeliverableTask = await findDispatchingTask(
        job.id,
        job.clientId,
        payload.metadata?.karos_task_id,
      ).catch((e) => {
        console.error("[webhook] dispatching-task lookup for zero-deliverable refund failed:", e);
        return null;
      });
      const zeroDeliverableRefund = await refundJobCharge(
        [job.id, zeroDeliverableTask?.id],
        `Auto-refund · run produced no deliverables · ${job.agentName}`.slice(0, 120),
      ).catch((refundErr) => {
        console.error("[webhook] refund after zero-deliverable run failed:", refundErr);
        return { refunded: false as const, amount: undefined };
      });
      if (zeroDeliverableRefund.refunded) {
        events.push({
          at: now,
          level: "info",
          message: `Refunded ${zeroDeliverableRefund.amount} credit${zeroDeliverableRefund.amount === 1 ? "" : "s"} — the run produced no client-facing deliverables`,
        });
      }
      if (notRehosted.length > 0) {
        events.push({
          at: now,
          level: "error",
          message:
            `No deliverable was created: the run produced ${notRehosted.length} client-facing file(s) ` +
            `and none of them could be copied into platform storage. They are listed above with a reason each.`,
        });
      }
    }
    // Counts what was ATTACHED, not what the manifest declared, and names the
    // shortfall rather than letting the run read as clean (#47/#50/#51). The
    // per-file reasons are each on their own line above, so this one carries the
    // names only: it is the line a reader sees first, not the record.
    events.push({
      at: now,
      level: notRehosted.length > 0 ? "error" : "success",
      message:
        `Agent run complete - ${deliveredCount} client-facing deliverable(s) attached, attempt ${payload.attempt}` +
        (notRehosted.length > 0
          ? `. ${notRehosted.length} could not be re-hosted and are NOT on the deliverable: ${notRehosted.map((a) => a.name).join(", ")}`
          : ""),
    });
  } else {
    events.push({
      at: now,
      level: "error",
      message:
        payload.status === "cancelled"
          ? "Job cancelled"
          : `Job ${payload.status.replace("_", " ")}: ${payload.error ?? "unknown error"}`,
    });
    if (refund.refunded) {
      events.push({
        at: now,
        level: "info",
        message: `Refunded ${refund.amount} credit${refund.amount === 1 ? "" : "s"} for the failed run`,
      });
    }
  }

  const inputTokens = Object.values(payload.usage?.models ?? {}).reduce((s, m) => s + m.inputTokens, 0);
  const outputTokens = Object.values(payload.usage?.models ?? {}).reduce((s, m) => s + m.outputTokens, 0);

  // ── The base the two arrays are merged onto (finding #54) ──
  // `events` and `assetIds` are written as WHOLE ARRAYS, so whatever base they
  // are built on is what survives — and `job` was read at the top of the
  // handler, before a re-host that is budgeted to run for most of a minute.
  // The job doc is not this handler's alone for that minute:
  // `requestJobCancellation` (src/lib/actions/external-job-actions.ts) appends
  // "Cancellation requested" with the same read-modify-write idiom and takes no
  // claim, so a stop a staff member asked for mid-re-host was being erased by
  // the write below. Re-reading here, as late as it can be read, shrinks the
  // window that append can be lost in from the whole re-host to this one write.
  //
  // NOT re-read from the claim's own transaction snapshot, which was the other
  // candidate: the claim happens before the asset write, the chain reflow and
  // the options sync, so its snapshot is older than this one.
  //
  // WHAT THIS IS NOT: a transaction. An append landing between this read and
  // the update is still overwritten. Closing that needs the merge to happen
  // inside a transaction on the job doc, which is `src/lib/data.ts`'s to own.
  //
  // A failed read falls back to the array we already hold: the pre-re-host copy
  // is stale but real, and dropping this delivery's own lines to punish a read
  // failure would lose more than it protects.
  let freshJob: Job | null = null;
  try {
    freshJob = await getJob(job.id);
  } catch (e) {
    console.error("[webhook] pre-write job re-read failed, merging onto the pre-re-host copy:", e);
  }
  const mergedEvents = [...(freshJob?.events ?? job.events), ...events];
  const mergedAssetIds = [...(freshJob?.assetIds ?? job.assetIds), ...newAssetIds];

  // Best-effort like the blocks below it: the job is already claimed (single
  // delivery), so redelivery on a throw here would just be skipped as
  // "already processed" and never retry this write. Catching and continuing
  // keeps the launch-outcome/task-sync updates AND the after() cost-logging
  // block below reachable even when this particular write fails, instead of
  // losing all of them to an unhandled 500.
  try {
    await updateJob(job.id, {
      status,
      assetIds: mergedAssetIds,
      events: mergedEvents,
      error: payload.status === "done" ? null : (payload.error ?? payload.status),
      // Dynamic Agent Studio only: the structured per-step report, stored so the
      // job page can render a step bar and an "incomplete" banner from data
      // rather than parsing them back out of `error`. `stepBreakdown` is the
      // same data reshaped into the Job Control Room's cost/token vocabulary
      // (see step-breakdown.ts). Nothing is "current" once the run is terminal.
      ...(payload.dynamic_run
        ? { dynamicRun: payload.dynamic_run, stepBreakdown: buildStepBreakdown(payload.dynamic_run) }
        : {}),
      currentStepId: null,
      currentStepName: null,
      external: {
        ...job.external,
        ...(payload.agents_repo_sha ? { agentsRepoSha: payload.agents_repo_sha } : {}),
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.usage?.totalCostUsd !== undefined ? { totalCostUsd: payload.usage.totalCostUsd } : {}),
        inputTokens,
        outputTokens,
        artifacts,
        ...(payload.transcript_url ? { transcriptUrl: payload.transcript_url } : {}),
      },
      updatedAt: now,
    });
  } catch (e) {
    console.error("[webhook] job record update failed:", e);
  }

  // ── Client-agent launch state ──
  // Advances the umbrella (launching → curating, or → launch_failed) and seeds
  // the template registry from templates.json when the setup run emitted one.
  // Best-effort like the syncs below: the job is already claimed, so a write
  // failure here must not fail the delivery — staff can reset a stuck umbrella.
  if (isLaunchRun && clientAgentId) {
    try {
      await applyLaunchOutcome({
        clientAgentId,
        clientId: job.clientId,
        status: payload.status,
        error: payload.status === "done" ? null : (payload.error ?? payload.status),
        templatesJson: launchTemplatesJson,
        refunded: refund.refunded,
        now,
      });
    } catch (e) {
      console.error("[webhook] client-agent launch update failed:", e);
    }
  }

  // ── Task Map sync ──
  // 1. A run dispatched BY a board task lands its deliverable on the ticket
  //    for client preview + approve/re-run; failures release the task and
  //    refund the execution charge. Matched by metadata.externalJobId with
  //    the karos_task_id echo as the race-proof fallback.
  // 2. INDEPENDENT successful runs (not dispatched by a task) auto-complete
  //    pending "watch" tasks whose completionTrigger matches this product,
  //    scoped to the run's platform — a task-dispatched run must not close
  //    sibling tasks of the same product, and an Instagram run must not close
  //    a TikTok watcher.
  // Best-effort: the job is already claimed, so a sync error must not fail the
  // delivery (redelivery would be skipped as already-processed anyway).
  try {
    const dispatchingTaskId = payload.metadata?.karos_task_id;
    if (payload.status === "done") {
      const taskSynced = await syncTaskForJobOutcome(
        job.id,
        job.clientId,
        {
          ok: true,
          assetId: createdAssetId,
          content: taskArtifactContent,
          imageUrl: taskArtifactImage,
        },
        dispatchingTaskId,
      );
      if (!taskSynced && !dispatchingTaskId) {
        await autoCompleteTasksByTrigger(
          job.clientId,
          `product_run:${payload.task_type}`,
          `Auto-completed - ${job.agentName} run delivered`,
          { platform: typeof job.input?.platform === "string" ? job.input.platform : undefined },
        );
      }
    } else {
      await syncTaskForJobOutcome(
        job.id,
        job.clientId,
        {
          ok: false,
          error: payload.error ?? `Agent run ${payload.status.replace("_", " ")}`,
        },
        dispatchingTaskId,
      );
    }
  } catch (e) {
    console.error("[webhook] task sync failed:", e);
  }

  const jobId = job.id;
  const clientId = job.clientId;
  const agentName = job.agentName;
  const runFailed = status === "failed" || status === "cancelled";
  // Distinct from `runFailed` above (which only gates "did anything go
  // wrong, log the error text") — the usage-log `status` field additionally
  // separates "cancelled" from "failed" so a deliberate Force Cancel doesn't
  // inflate the Agent Leaderboard's failedRuns count the way a genuine
  // breakage should (see usage-log.ts's doc comment on the field).
  const usageStatus: "success" | "failed" | "cancelled" =
    status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "success";
  after(async () => {
    // Alert on "failed" only — "cancelled" is a deliberate human stop, not a
    // failure worth paging anyone about. Best-effort: notifyJobFailure never
    // throws, so this can't affect the usage-logging below it.
    if (status === "failed") {
      const client = await getClient(clientId).catch(() => null);
      await notifyJobFailure(
        { ...job, status, error: payload.error ?? payload.status },
        client,
      );
    }
    const models = payload.usage?.models;
    if (models && Object.keys(models).length > 0) {
      for (const [modelName, usage] of Object.entries(models)) {
        logger.logUsage({
          clientId,
          agentId: "agent-service",
          agentName,
          modelName,
          operation: "managed_job",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          jobId,
          status: usageStatus,
          ...(runFailed ? { errorMessage: payload.error ?? payload.status } : {}),
        });
      }
    } else if (runFailed) {
      // The agent-service reported no per-model usage for this failure — still
      // record a zero-cost stub so the run is visible in the leaderboard/dashboards
      // instead of vanishing (item: "no invisible spend" applies to visibility of
      // the *attempt*, not only to attempts that happen to carry a token count).
      logger.logUsage({
        clientId,
        agentId: "agent-service",
        agentName,
        modelName: payload.model ?? "unknown",
        operation: "managed_job",
        inputTokens: 0,
        outputTokens: 0,
        jobId,
        status: usageStatus,
        errorMessage: payload.error ?? payload.status,
      });
    }
    // Dynamic Agent Studio only: one usageLogs row PER STEP that spent tokens,
    // tagged with stepId — in addition to the per-model run-level rows above,
    // not instead of them. This is what makes "which step costs the most"
    // answerable ACROSS jobs (the run-level rows above only answer it within
    // one job's own sidebar); Job.stepBreakdown is the within-this-job answer.
    //
    // GATED ON status === "done", deliberately narrower than the run-level
    // loop above: a resumed run's dynamic_run.steps carries every EARLIER
    // attempt's completed steps too (resumeFrom prepends their original
    // trace entries so step-level cost history survives a resume — see
    // step-runner.ts), and THIS SAME webhook route already processed a
    // job.completed delivery for that earlier failed attempt, logging those
    // steps once already. Logging them again here on every later delivery
    // would double (or triple...) count their tokens/cost in usageLogs and
    // analyticsSnapshot every time. Restricting to the run's one eventual
    // "done" delivery means every step is logged exactly once, ever — at the
    // cost of a step's usageLogs row not existing at all if the job never
    // succeeds (dead-lettered after exhausting attempts). That step's cost is
    // still visible on Job.stepBreakdown (written regardless of status,
    // right above), and the run-level rows above are unaffected either way.
    for (const step of payload.status === "done" ? payload.dynamic_run?.steps ?? [] : []) {
      const models = Object.entries(step.usage?.models ?? {});
      if (models.length === 0) continue;
      for (const [modelName, usage] of models) {
        logger.logUsage({
          clientId,
          agentId: "agent-service",
          agentName,
          modelName,
          operation: "managed_job_step",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          jobId,
          stepId: step.stepId,
          status: step.status === "done" ? "success" : "failed",
          ...(step.error ? { errorMessage: step.error } : {}),
        });
      }
    }
  });

  return NextResponse.json({ ok: true, job_id: job.id, status });
}

// Health check for wiring the callback URL.
export async function GET() {
  return NextResponse.json({ ok: true, service: "agent-service-webhook" });
}
