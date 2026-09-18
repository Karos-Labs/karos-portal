import "server-only";
import { createJob, updateJob } from "@/lib/data";
import { MiddlewareDispatchError, dispatchViaMiddleware, isMiddlewareDispatchEnabled } from "./middleware-client";
import { agentEngineRunIdFromMessageId, isAgentEnginePubSubConfigured, publishAgentEngineRun } from "./pubsub-client";
import { toJobInputSummary } from "./run-input-display";

export interface DispatchAgentEngineRunInput {
  clientId: string;
  clientSlug: string;
  productId: string;
  runKind: "setup" | "recurring";
  /** The job's own display label, e.g. "SEO/GEO Research (Agent Engine)". */
  agentName: string;
  title: string;
  inputs?: Record<string, unknown>;
  /** The job doc's own `input` display field — a human-readable summary, distinct from `inputs` above (the envelope's raw payload). Defaults to `{}`. */
  inputSummary?: Record<string, string>;
  /** `Job.createdBy` — a real user id for a staff/client-triggered dispatch, "system" (the default) for one an internal pipeline (onboarding) triggers on nobody's behalf. */
  createdBy?: string;
  /**
   * Dispatch against a job doc the caller already created, instead of
   * creating one here.
   *
   * `submit-custom.ts` needs this: a custom-agent job carries fields this
   * function knows nothing about (`customAgentId`, `runLabel`,
   * `clientAgentId`, `templateKey`) and the portal renders from them, and it
   * charges credits against the job id before anything is dispatched. Having
   * it create a second job would orphan the charge and hide the run from
   * every surface that looks it up by custom agent.
   *
   * The publish/fallback/record sequence stays here either way, which is the
   * point — a second copy of the middleware fallback is exactly what this
   * function exists to prevent.
   */
  existingJobId?: string;
}

export type DispatchAgentEngineRunResult = { jobId: string; agentEngineRunId: string } | { jobId: string; error: string } | { error: string };

/**
 * The one flag that turns on agent-engine dispatch anywhere in this repo —
 * `submit-managed.ts`'s managed-catalog path and `dispatch-research-
 * agents.ts`'s onboarding-observability path both gate on this single
 * switch, rather than each growing its own. Default OFF: unset (or
 * "false") keeps every dispatch path exactly as it behaved before Task 2 —
 * a deliberate, instantly-revertible opt-in, not a behavior change existing
 * deployments get for free.
 */
export function isAgentEngineDispatchEnabled(): boolean {
  return process.env.AGENT_ENGINE_DISPATCH_ENABLED === "true";
}

/**
 * Whether a dispatch to agent-engine can leave the building right now — the
 * counterpart to `isAgentServiceConfigured()` (`src/lib/agent-service/
 * client.ts`) for the engine, and SCRUM-264's subject.
 *
 * Mirrors the exact transport guard `dispatchAgentEngineRun` runs below
 * before publishing, so this can never say "healthy" while that function is
 * about to return an error, or vice versa: middleware dispatch, when
 * enabled, needs nothing else (`isMiddlewareDispatchEnabled` already folds
 * in its own base-URL check); the direct-publish fallback needs
 * `AGENT_ENGINE_PUBSUB_TOPIC` (or the Pub/Sub emulator). A client whose
 * custom agents route to agent-engine (every client with a lab slug, since the
 * 2026-09-06 allowlist removal — see `./health`) but whose transport is unconfigured gets exactly
 * the same class of silent failure agent-service clients already have a
 * banner for — this function is what lets a caller say so instead.
 */
export function isAgentEngineTransportConfigured(): boolean {
  return isMiddlewareDispatchEnabled() || isAgentEnginePubSubConfigured();
}

/**
 * Creates a `jobs` doc and dispatches it through agent-engine's Pub/Sub
 * topic — the one place this repo does that, shared by
 * `submit-managed.ts`'s own agent-engine branch and the two new observable
 * onboarding dispatches (`dispatch-research-agents.ts`) so the
 * create-job/publish/record-runId/handle-failure sequence can't drift
 * between the three callers.
 */
/**
 * ── PROJECT THE CLIENT'S LIVE CONTEXT, IMMEDIATELY BEFORE THE RUN IS
 *    PUBLISHED (04 A1, SCRUM-482). ──
 *
 * `projectClientToWorkspace` writes `clients/<slug>/context/<docType>.json`,
 * `client/brand.json` and `client/profile.json` — the files agent-engine's own
 * `client.getContextDoc` reads. Until this call it had exactly two callers, the
 * end of a Regenerate and a branding refresh, and neither of them is a run.
 *
 * So the engine read whatever the last Regenerate happened to leave behind. A
 * client who corrected their brand voice, rewrote their market strategy or
 * fixed a colour and then pressed Run got an agent working from the previous
 * projection — with nothing anywhere saying so, because the files were present
 * and well-formed, just old. A1's whole requirement is one sentence: *"live
 * data at run time, never an onboarding-time snapshot"*.
 *
 * BEFORE THE PUBLISH, NOT BESIDE IT. The engine reads these files as soon as
 * the run starts, so projecting concurrently with the publish is a race the
 * portal would lose about as often as it won. That costs one Firestore read and
 * a handful of small object writes on the dispatch path, which is the price of
 * the run being about the client as they are now.
 *
 * BEST-EFFORT, exactly like the projector itself: an unwritable bucket, a
 * client that has no `agentsRepoSlug` or a Firestore hiccup all mean "the run
 * goes out against the last projection", which is strictly what happened before
 * this existed. Failing a dispatch because a side channel is down would trade a
 * stale context for no run at all.
 *
 * The onboarding path projects and then dispatches, so it projects twice. The
 * write is derived entirely from the client record, so the second one is the
 * same bytes — not worth a cache that could itself go stale.
 */
async function projectLiveContextBeforeDispatch(clientId: string): Promise<void> {
  try {
    const [{ projectClientToWorkspace }, { getClient, listClientContextDocs }] = await Promise.all([
      import("./context-doc-projection"),
      import("@/lib/data"),
    ]);
    const client = await getClient(clientId);
    if (!client) return;
    const docs = await listClientContextDocs(clientId);
    const result = await projectClientToWorkspace(client, docs);
    if (!result.projected && result.reason) {
      console.info(`[agent-engine] dispatch projection skipped for ${clientId}: ${result.reason}`);
    }
  } catch (e) {
    console.error(`[agent-engine] projecting live context before dispatch failed (non-fatal):`, e);
  }
}

export async function dispatchAgentEngineRun(input: DispatchAgentEngineRunInput): Promise<DispatchAgentEngineRunResult> {
  // Two transports, one downstream contract. Going through the control plane
  // means the run carries a resolved prompt/template version; publishing
  // directly means the engine uses whatever is baked into its image. Either
  // way the job ends up on the same topic and the run id is derived the same
  // way, so everything after this function is unchanged.
  const viaMiddleware = isMiddlewareDispatchEnabled();
  if (!viaMiddleware && !isAgentEnginePubSubConfigured()) {
    return { error: "AGENT_ENGINE_PUBSUB_TOPIC (or the Pub/Sub emulator) is not configured." };
  }

  const now = Date.now();
  const jobId =
    input.existingJobId ??
    (await createJob({
      clientId: input.clientId,
      agentId: "agent-engine",
      agentName: input.agentName,
      title: input.title,
      status: "queued",
      // The wire payload, flattened, whenever a caller did not hand us a
      // display summary of its own. Before this, `?? {}` meant the control
      // plane's agent card, the research regenerate modal and the
      // recommendation runner all created jobs whose `input` was empty while a
      // real direction travelled to the engine — and the run page, which reads
      // this field, answered "No inputs." about a run that had one. The one
      // place that holds both the envelope and the job doc is here, so the
      // derivation belongs here rather than in each caller, where the next
      // caller would forget it again.
      input: input.inputSummary ?? toJobInputSummary(input.inputs),
      assetIds: [],
      events: [{ at: now, level: "info", message: "Dispatched to agent-engine" }],
      createdBy: input.createdBy ?? "system",
      createdAt: now,
      updatedAt: now,
    }));

  // A1: the run must be about the client as they are NOW. This is the last
  // point at which the portal can say so, and until it existed no dispatch
  // path said it at all.
  await projectLiveContextBeforeDispatch(input.clientId);

  const publishDirect = async (): Promise<string> =>
    (
      await publishAgentEngineRun({
        clientSlug: input.clientSlug,
        productId: input.productId,
        runKind: input.runKind,
        // `input`, matching the engine's own schema key. `DispatchAgentEngineRunInput`
        // keeps the plural for its callers, who are talking about "the run's
        // inputs"; the rename happens here, once, at the wire boundary.
        ...(input.inputs && Object.keys(input.inputs).length > 0 ? { input: input.inputs } : {}),
        idempotencyKey: jobId,
        correlationId: jobId,
      })
    ).messageId;

  try {
    let messageId: string;
    let fellBack = false;

    if (!viaMiddleware) {
      messageId = await publishDirect();
    } else {
      try {
        messageId = (
          await dispatchViaMiddleware({
            productId: input.productId,
            clientSlug: input.clientSlug,
            runKind: input.runKind,
            ...(input.inputs && Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {}),
            correlationId: jobId,
            ...(input.createdBy ? { requestedBy: input.createdBy } : {}),
          })
        ).pubsubMessageId;
      } catch (middlewareError) {
        // Only fall back when the control plane could not service the request.
        // A 409 (duplicate run) or 422 (agent misconfigured) is re-raised: see
        // MiddlewareDispatchError's own doc comment for why publishing anyway
        // would double-run a job or silently discard the resolved prompt.
        const recoverable =
          middlewareError instanceof MiddlewareDispatchError && middlewareError.shouldFallBack;
        if (!recoverable) throw middlewareError;

        // Structured so a log-based metric can count degraded dispatches —
        // this path still produces a working job, so nothing else would ever
        // surface that the control plane is down.
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            message: "agent-engine dispatch fell back to direct Pub/Sub",
            reason: middlewareError.message,
            status: middlewareError.status ?? null,
            jobId,
            clientSlug: input.clientSlug,
            productId: input.productId,
          }),
        );
        if (!isAgentEnginePubSubConfigured()) {
          // No fallback transport available either — nothing left to try.
          throw middlewareError;
        }
        messageId = await publishDirect();
        fellBack = true;
      }
    }

    // Same derivation either way: the middleware returns the id of the message
    // it published, and agent-engine's consumer keys the run off that same id.
    const agentEngineRunId = agentEngineRunIdFromMessageId(messageId);
    await updateJob(jobId, {
      agentEngineRunId,
      agentEngineProductId: input.productId,
      // Recorded on the job, not just in logs: a run dispatched this way has
      // no resolved prompt/template version attached to it, and whoever
      // reviews the output later needs to be able to tell.
      ...(fellBack
        ? {
            events: [
              { at: now, level: "info" as const, message: "Dispatched to agent-engine" },
              {
                // "info", not "error": the job really was dispatched and will
                // run. JobRunEvent has no "warn" level, so the degradation
                // lives in the message text.
                at: Date.now(),
                level: "info" as const,
                message:
                  "Degraded dispatch: the control plane was unavailable, so this run went " +
                  "straight to agent-engine without a resolved prompt/template version.",
              },
            ],
          }
        : {}),
      updatedAt: Date.now(),
    });
    return { jobId, agentEngineRunId };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Agent engine dispatch failed";
    await updateJob(jobId, {
      status: "failed",
      error: message,
      events: [
        { at: now, level: "info", message: "Dispatched to agent-engine" },
        { at: Date.now(), level: "error", message },
      ],
      updatedAt: Date.now(),
    });
    return { jobId, error: message };
  }
}
