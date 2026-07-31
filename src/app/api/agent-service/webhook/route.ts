import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assetTitleFromJobTitle } from "@/lib/job-title";
import {
  claimExternalJobCompletion,
  createAsset,
  getClient,
  getJob,
  getJobByExternalServiceId,
  isJobInFlight,
  updateJob,
} from "@/lib/data";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyAgentServiceSignature,
} from "@/lib/agent-service/verify";
import { agentServiceFetchHeaders } from "@/lib/agent-service/client";
import type { AgentServiceArtifact, AgentServiceWebhookPayload } from "@/lib/agent-service/types";
import type { AssetType, ExternalJobArtifact, JobStatus } from "@/lib/types";
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
import { autoCompleteTasksByTrigger, syncTaskForJobOutcome } from "@/lib/task-sync";
import { notifyJobFailure } from "@/lib/job-alerts";
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

const ASSET_TYPE_MAP = {
  social_post: "social_post",
  newsletter_issue: "email",
  blog_article: "article",
  landing_page: "note",
  custom: "note",
} as const satisfies Record<
  "social_post" | "newsletter_issue" | "blog_article" | "landing_page" | "custom",
  AssetType
>;

// Asset types a custom job may request via metadata.asset_type (whitelist — a
// hint is only honored if it's one of these, otherwise we fall back to "note").
const VALID_HINT_TYPES = new Set<AssetType>(["social_post", "instagram_post", "email", "article", "note"]);

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
const webhookPayloadSchema = z.object({
  event: z.literal("job.completed"),
  job_id: z.string().min(1),
  status: z.enum(["done", "failed", "cancelled", "dead_letter"]),
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
});

function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
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

  let job = await getJobByExternalServiceId(payload.job_id);
  if (!job) {
    // Submission race: the action may not have persisted external.serviceJobId
    // yet — fall back to the platform job id echoed through metadata.
    const platformJobId = payload.metadata?.platform_job_id;
    if (platformJobId) {
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
  }
  if (!job || !job.external) {
    // Unknown job — 404 so the service's delivery queue retries: the write
    // race window closes long before the retry schedule runs out.
    return NextResponse.json({ error: "No matching platform job" }, { status: 404 });
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
  // `events` is assembled from here on but persisted only after the claim, so a
  // delivery that loses the race leaves no trace.
  const events = [...job.events];
  const artifacts: ExternalJobArtifact[] = [];
  let rehostedTotal = 0;
  let launchTemplatesJson: string | null = null;
  let primaryText: { artifact: AgentServiceArtifact; content: string } | null = null;
  // A post is a multi-slide carousel: collect EVERY image, not just the
  // first. Keyed by artifact name so we can restore slide order (slide-2
  // before slide-10) regardless of artifact arrival order.
  const imageEntries: { name: string; url: string }[] = [];
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
      const withinBudget =
        artifact.bytes <= REHOST_FILE_LIMIT_BYTES &&
        rehostedTotal + artifact.bytes <= REHOST_TOTAL_LIMIT_BYTES;
      if (artifact.client_facing && artifact.url && withinBudget) {
        try {
          const res = await fetch(artifact.url, {
            headers: agentServiceFetchHeaders(artifact.url),
            signal: AbortSignal.timeout(fetchBudgetMs),
          });
          if (!res.ok) {
            events.push({
              at: Date.now(),
              level: "error",
              message: `Could not re-host ${artifact.name} (HTTP ${res.status}) - keeping service URL`,
            });
          }
          if (res.ok) {
            const bytes = Buffer.from(await res.arrayBuffer());
            // Measured HERE, immediately before the upload, rather than before
            // the body read above — reading the body spends phase budget too,
            // and a budget measured before it would let a slow read push the
            // upload past the deadline. Non-positive means don't start the
            // upload: this artifact keeps its service URL and the top of the
            // loop ends the phase.
            const uploadBudgetMs = Math.min(ARTIFACT_UPLOAD_TIMEOUT_MS, remainingRehostMs());
            if (uploadBudgetMs > 0) {
              rehostedTotal += bytes.length;
              const hosted = await uploadBytes({
                bytes,
                path: `agent-service/${job.id}/${deliveryNonce}/${artifact.sha256.slice(0, 12)}-${artifact.name}`,
                contentType: artifact.content_type ?? "application/octet-stream",
                timeoutMs: uploadBudgetMs,
              });
              entry.url = hosted.url;
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
          events.push({ at: Date.now(), level: "error", message: `Could not re-host ${artifact.name}` });
        }
      }
      artifacts.push(entry);
    }
  }

  // Natural-sort by filename so slide-2 precedes slide-10, then expose each
  // image as a carousel slide the asset card can page through.
  const orderedImageUrls = imageEntries
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((e) => e.url);
  const slides =
    orderedImageUrls.length > 1 ? orderedImageUrls.map((url) => ({ imageUrl: url })) : undefined;
  const clientFacingCount = artifacts.filter((a) => a.clientFacing).length;
  // For the Task Map sync below: the run may have been dispatched by a board
  // task, whose ticket gets the deliverable for client preview.
  const taskArtifactContent = primaryText ? primaryText.content.slice(0, CONTENT_CHAR_CAP) : "";
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
  const assetIds: string[] = [...job.assetIds];
  let createdAssetId: string | null = null;

  if (payload.status === "done") {
    if (clientFacingCount > 0) {
      // Custom agents (e.g. the LinkedIn generators) produce any asset shape, so
      // "note" is the safe default — but the submitter can hint the real type +
      // platform through metadata, which lands the draft as a schedulable post
      // with the right recommended window instead of a slot-less library note.
      const hintedType = payload.metadata?.asset_type as AssetType | undefined;
      const assetType =
        payload.task_type === "custom" && hintedType && VALID_HINT_TYPES.has(hintedType)
          ? hintedType
          : (ASSET_TYPE_MAP[payload.task_type] ?? "note");
      const platform = payload.metadata?.platform || undefined;
      // Strip the appended " - <client>" the submit paths add, so a client's
      // own workspace doesn't put their company name in half of every title.
      // Separator and strip share one definition (lib/job-title.ts) — this
      // looked for an em dash while every builder wrote a hyphen, so it never
      // fired for any run from any path.
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
          content: primaryText ? primaryText.content.slice(0, CONTENT_CHAR_CAP) : "",
          meta: {
            taskType: payload.task_type,
            agentsRepoSha: payload.agents_repo_sha,
            artifacts: artifacts.filter((a) => a.clientFacing),
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
        assetIds.push(assetId);
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
        await refundJobCharge(
          job.id,
          `Auto-refund · asset creation failed · ${job.agentName}`.slice(0, 120),
        ).catch((refundErr) =>
          console.error("[webhook] refund after asset-creation failure also failed:", refundErr),
        );
      }
    }
    events.push({
      at: now,
      level: "success",
      message: `Agent run complete - ${clientFacingCount} client-facing deliverable(s), attempt ${payload.attempt}`,
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

  // Best-effort like the blocks below it: the job is already claimed (single
  // delivery), so redelivery on a throw here would just be skipped as
  // "already processed" and never retry this write. Catching and continuing
  // keeps the launch-outcome/task-sync updates AND the after() cost-logging
  // block below reachable even when this particular write fails, instead of
  // losing all of them to an unhandled 500.
  try {
    await updateJob(job.id, {
      status,
      assetIds,
      events,
      error: payload.status === "done" ? null : (payload.error ?? payload.status),
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
  });

  return NextResponse.json({ ok: true, job_id: job.id, status });
}

// Health check for wiring the callback URL.
export async function GET() {
  return NextResponse.json({ ok: true, service: "agent-service-webhook" });
}
