"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import {
  getClient,
  updateClient,
  listClientContextDocs,
  upsertClientContextDoc,
  getClientContextDocById,
  getClientContextDocByTier,
  updateContextDocSummary,
  updateContextDocContent,
  logFeedback,
  tryAcquireAiProcessingLock,
  releaseAiProcessingLock,
  approveSeoGeoRecommendation,
} from "@/lib/data";
import { logger } from "@/services/logger";
import { getCurrentUser } from "@/lib/auth";
import type { ContextDocTier } from "@/lib/types";
import { requireStaff, requireAdmin, logActivity, logGenerationFailure } from "./_shared";
import { findRoutableRecommendation } from "@/lib/agent-engine/seo-geo-report-lookup";
import {
  dispatchSeoGeoRecommendationRun,
  type SeoGeoRecommendationRunMode,
} from "@/lib/agent-engine/dispatch-recommendation-run";
import { stripPipelineMarkers } from "@/lib/doc-render";
import { CREDIT_COSTS } from "@/lib/credits";
import {
  chargeClientModelCall,
  refundClientModelCall,
  withClientModelCharge,
} from "@/lib/client-model-charge";
import { SYSTEM_AI_ACTOR_NAME } from "@/lib/activity-actors";
import {
  researchReportReadyDescription,
  researchReportReadyTitle,
} from "@/lib/activity-titles";
import { contextDocLabel } from "@/lib/context-doc-copy";
import {
  computeFirstIntelScheduleRun,
  clampIntervalMonths,
  clampScheduleDayOfMonth,
} from "@/lib/intel-schedule";

const CONTEXT_DOC_TIERS: ContextDocTier[] = ["internal", "client", "internal-only"];

function isContextDocTier(value: string): value is ContextDocTier {
  return (CONTEXT_DOC_TIERS as string[]).includes(value);
}

/**
 * Both correction paths below run through `withClientModelCharge`
 * (lib/client-model-charge.ts), which is the app's single answer to "a client
 * triggered a model call": it decides who pays (staff and View-as-Client are
 * free), and it hands the credits back when the call fails. The local
 * charge/refund pair that used to sit here refunded ONLY when the model returned
 * an unchanged document — a thrown call left the client paying for a crash.
 *
 * The two specs are written out at their call sites rather than built by a
 * helper here. Deliberate: `reason` is client copy stored in the ledger, and
 * client-copy-boundary.test.ts sweeps it by following the literal from the
 * persisting write back to the object it was written in. A helper that RETURNS
 * the spec puts a call expression where that follow expects a literal, and the
 * sweep goes quietly blind — which is exactly what happened the first time these
 * were consolidated.
 */

/**
 * Generate a short (2-sentence) company brief from the client's context docs.
 * Cached on `client.brief` — only regenerates when `force` is set or no brief exists.
 * Callable by staff or the client themselves.
 */
export async function generateClientBriefAction(
  clientId: string,
  force = false,
): Promise<{ ok: true; brief: string } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  if (!user || user.disabled) return { ok: false, error: "Unauthorized" };
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { ok: false, error: "Forbidden" };
  }

  const client = await getClient(clientId);
  if (!client) return { ok: false, error: "Client not found" };
  if (client.brief && !force) return { ok: true, brief: client.brief };

  // Client tier only, for every caller — not just client ones. This action is
  // network-reachable by a CLIENT_USER for their own account, and the brief it
  // writes is persisted on client.brief and rendered to the client whoever
  // triggered it. The old `?? docs.find(byDocType)` fallback pulled the internal
  // analyst copy into that prompt whenever a client-tier row was missing.
  const docs = await listClientContextDocs(clientId, "client");
  const source = ["product-information", "brand-voice", "market-strategy"]
    .map((dt) => docs.find((d) => d.docType === dt))
    .filter(Boolean)
    .map((d) => d!.content.replace(/^---[\s\S]*?---\n?/, "").slice(0, 1800))
    .join("\n\n");

  if (!source.trim()) return { ok: false, error: "No documents to summarize yet." };

  // Past the cache, so this WILL call a model. One Haiku call, priced at
  // `CREDIT_COSTS.taskAssist` (1) — the rate whose own definition is "small
  // Haiku task helpers". The cached return above is free; only a real
  // regeneration costs anything, and `force` is supplied by the caller, which
  // is what made this rerunnable on demand and unmetered.
  const briefCharge = {
    user,
    clientId,
    amount: CREDIT_COSTS.taskAssist,
    operation: "ai_tool" as const,
    // Client copy: the ledger feed renders ungated to a CLIENT_USER.
    reason: "Company description",
  };
  const { denied: briefDenied, chargedAt: briefChargedAt } = await chargeClientModelCall(briefCharge);
  if (briefDenied !== null) return { ok: false, error: briefDenied };

  const { generateText } = await import("ai");
  const { aiFor, usageFor } = await import("@/lib/ai/provider");
  const briefUsageMeta = {
    clientId, agentId: null, agentName: "Company Brief",
    ...usageFor("intel.actions"), operation: "client_brief",
  };
  let text: string;
  let usage: { inputTokens?: number; outputTokens?: number };
  try {
    ({ text, usage } = await generateText({
      model: aiFor("intel.actions").model,
      system:
        "Write a plain, factual company description in exactly two short sentences (about two lines total). " +
        "Describe what the company does and who it serves. " +
        "Do NOT use em dashes ( · ). Do NOT use marketing hype or adjectives like 'leading' or 'innovative'. " +
        "Return only the description text, no preamble.",
      messages: [{ role: "user", content: `Company: ${client.name}\n\n${source}` }],
      maxOutputTokens: 160,
    }));
  } catch (err) {
    logger.logGenerationFailure(briefUsageMeta, err);
    await refundClientModelCall(briefCharge, briefChargedAt, "Refund · company description failed");
    throw err;
  }

  after(() =>
    logger.logUsage({
      ...briefUsageMeta,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }),
  );

  const brief = text
    .trim()
    .replace(/\s*[—–]\s*/g, ", ") // strip em/en dashes
    .replace(/^["']|["']$/g, "")
    .slice(0, 320);

  if (!brief) {
    await refundClientModelCall(
      briefCharge,
      briefChargedAt,
      "Refund · company description came back empty",
    );
    return { ok: false, error: "Could not generate a description." };
  }

  await updateClient(clientId, { brief });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true, brief };
}

/**
 * Record client/staff approval of one SEO/GEO recommendation (QA Fix 6). This is the real
 * "approve" the action plan needs: it persists the approval on the clientSeoGeo doc and
 * logs it to the client's activity timeline (which staff monitor), so the team can execute
 * it. Callable by the client for their own account or by staff — works with no navigation,
 * so a client viewer never hits an empty-agents dead end.
 */
/**
 * WHAT APPROVE ACTUALLY DOES, end to end (CD-J1 directive 6).
 *
 * A client clicks Approve on a row of the SEO/GEO action plan. Then:
 *
 *  1. AUTHORIZE — a client user may only approve against their own clientId;
 *     staff and admins may approve on any client's behalf.
 *  2. PERSIST — `approveSeoGeoRecommendation` adds the recId to `approvedRecIds`
 *     on the client's `clientSeoGeo` doc, inside a transaction, through a Set, so
 *     a double-click or two people clicking at once cannot duplicate it. It throws
 *     if there is no capture to approve against. The recIds are the REC_COPY keys,
 *     which is why those keys are stable: renaming one orphans an approval.
 *  3. LOG — an activity-timeline entry the team monitors ("SEO/GEO fix approved",
 *     carrying the plain-English title and who approved it). This is the hand-off.
 *     There is no separate work queue: the timeline IS how the team learns a fix
 *     was authorized.
 *  4. REVALIDATE — the client page re-renders and the row shows its approved state
 *     to everyone, client and staff alike, from the persisted set rather than from
 *     the clicking browser's memory.
 *
 * Then, for every category EXCEPT `owner: "karos_agent"`, a HUMAN on the Karos
 * team makes the change on the client's site (or the client connects a tool,
 * for `karos_tool`) — approval there is still authorization, not execution.
 *
 *  5. DISPATCH, `karos_agent` ONLY (D2/SCRUM-278, SCRUM-260/T-B15) — this is
 *     the split this ticket implements. `owner`/`actionKind` classify the
 *     SAME recId's routable recommendation (looked up from the client's most
 *     recent `seo-geo-agent` report asset, `findRoutableRecommendation`) —
 *     never `recId` itself. Only `owner: "karos_agent"` ever dispatches a
 *     real agent-engine run (`dispatchSeoGeoRecommendationRun`), gated behind
 *     `SEO_GEO_RECOMMENDATION_RUN_DISPATCH_ENABLED` (default OFF — see that
 *     module's own header for why this must stay off in production today).
 *     `karos_tool` and `client_manual` never dispatch anything, flag or no
 *     flag — see that module for what "a tool runs it" concretely means in
 *     this repo instead. A dispatch failure (or no classification data at
 *     all — e.g. the client has no materialized report yet, or agent-engine
 *     hasn't started sending `owner` classification for real) never fails
 *     the approval itself: the approval already persisted in step 2, and a
 *     client whose click didn't also start a run should still see it as
 *     approved, not as an error.
 *
 * `upsertClientSeoGeo` deliberately carries `approvedRecIds` across
 * re-captures so a refresh cannot silently un-approve work that was already
 * authorized.
 */
export async function approveSeoGeoRecommendationAction(
  clientId: string,
  recId: string,
  title: string,
): Promise<
  | { ok: true; approved: string[]; runDispatched: boolean; runMode?: SeoGeoRecommendationRunMode; runError?: string }
  | { ok?: never; error: string }
> {
  try {
    const user = await getCurrentUser();
    if (!user || user.disabled) return { error: "Unauthorized" };
    if (user.role === "CLIENT_USER") {
      if (user.clientId !== clientId) return { error: "Forbidden" };
    } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
      return { error: "Forbidden" };
    }
    const approved = await approveSeoGeoRecommendation(clientId, recId);
    const actorRole = user.role === "CLIENT_USER" ? "client" : "staff";
    await logActivity({
      clientId,
      timestamp: Date.now(),
      type: "MANUAL_NOTE",
      title: "SEO/GEO fix approved",
      description: `Approved for the team to execute: ${title.slice(0, 160)}`,
      actor: user.name,
      actorRole,
    });

    // Step 5 above. Best-effort and isolated from the approval's own result —
    // same convention `dispatchOnboardingResearchAgents` uses for its own
    // best-effort dispatches: a run that can't be classified or can't be
    // dispatched is never a reason to tell the client their approval failed.
    let runDispatched = false;
    let runMode: SeoGeoRecommendationRunMode | undefined;
    let runError: string | undefined;
    try {
      const rec = await findRoutableRecommendation(clientId, recId);
      const client = rec ? await getClient(clientId) : null;
      if (rec && client) {
        const outcome = await dispatchSeoGeoRecommendationRun(rec, client, user.uid);
        if (outcome.dispatched) {
          runDispatched = true;
          runMode = outcome.mode;
          if ("error" in outcome.result) {
            runError = outcome.result.error;
          } else {
            await logActivity({
              clientId,
              timestamp: Date.now(),
              type: "MANUAL_NOTE",
              title: outcome.mode === "apply" ? "SEO/GEO fix run started" : "SEO/GEO fix draft run started",
              description: `Agent-engine run dispatched for: ${title.slice(0, 160)}`,
              actor: SYSTEM_AI_ACTOR_NAME,
              actorRole: "system",
            });
          }
        }
      }
    } catch (e) {
      runError = e instanceof Error ? e.message : "Could not dispatch the agent-engine run";
    }

    revalidatePath(`/clients/${clientId}`);
    return { ok: true, approved, runDispatched, ...(runMode ? { runMode } : {}), ...(runError ? { runError } : {}) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not record approval" };
  }
}

export async function addActivityNoteAction(clientId: string, text: string): Promise<void> {
  const user = await requireStaff();
  if (!text.trim()) throw new Error("Note text is required");
  await logActivity({
    clientId,
    timestamp: Date.now(),
    type: "MANUAL_NOTE",
    title: "Note",
    description: text.trim(),
    actor: user.name,
    actorRole: "staff",
  });
  revalidatePath(`/clients/${clientId}`);
}

/**
 * Run the Intel Report pipeline for a client. Admins and employees only.
 *
 * The pipeline normally takes minutes and is allowed 20 before it is treated as
 * dead, while Cloud Run kills the request at 300s — so awaiting it inside the
 * action meant any run past five minutes reported failure for a run that may
 * well have completed, with the stale-lock window then blocking the retry. The
 * lock check stays synchronous (so a second click still gets the "already
 * running" error immediately); everything after it runs in `after()`, matching
 * the three other triggers of this same pipeline (client creation, onboarding
 * completion, the cron). Progress is the AiProcessingBanner plus the lock, which
 * already disables the Regenerate button.
 *
 * @param runSpecificContext Optional run-specific instructions entered at execution time.
 *   These are threaded into the pipeline as Layer C (highest priority) and expire after this run.
 */
export async function generateIntelReportAction(
  clientId: string,
  runSpecificContext?: string,
): Promise<void> {
  // Admin, not staff: every UI entry point (docs-header button, dashboard
  // button) is admin-gated per Albert's CD-G5 ruling, and the schedule action
  // above it already requires admin. A staff-wide server gate under admin-only
  // UI would let an employee fire a full pipeline run by invoking the action
  // directly (dash-lens note, 2026-07-28).
  await requireAdmin();
  // Same workspace lock the post-onboarding background trigger uses — stops this
  // manual Regenerate from overlapping that run (or a second concurrent click).
  if (!(await tryAcquireAiProcessingLock(clientId))) {
    throw new Error("AI generation is already running for this client. Please wait for it to finish.");
  }

  after(async () => {
    let failure: string | undefined;
    try {
      const { runIntelReportPipeline } = await import("@/lib/intel");
      await runIntelReportPipeline(clientId, runSpecificContext);
      await updateClient(clientId, { lastIntelReportAt: Date.now() });
      const focus = runSpecificContext?.trim()
        ? `"${runSpecificContext.trim().slice(0, 100)}${runSpecificContext.trim().length > 100 ? "…" : ""}"`
        : undefined;
      await logActivity({
        clientId,
        timestamp: Date.now(),
        type: "INTEL_GENERATION",
        title: researchReportReadyTitle(),
        description: researchReportReadyDescription({ recurring: false, focus }),
        actor: SYSTEM_AI_ACTOR_NAME,
        actorRole: "system",
      });
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      console.error("[intel] Regenerate pipeline failed:", e);
    } finally {
      // Passing `failure` (undefined on success) both releases the lock and
      // persists WHY it failed — the run no longer throws to the caller, so this
      // record is the only place the reason survives.
      await releaseAiProcessingLock(clientId, failure);
      await logGenerationFailure(clientId, failure);
    }
  });

  revalidatePath(`/clients/${clientId}`);
}

/**
 * Set or clear the recurring Intel Report + SEO/GEO regeneration schedule for a
 * client (Schedule modal, admin-only). This — alongside client creation and the
 * manual Regenerate action above — is one of the ONLY three ways the pipeline
 * ever runs; /api/intel-report-schedule is the sole cron that reads these
 * fields, and it never fires for a client with intelScheduleEnabled false.
 *
 * Enabling (or editing the day/interval) always re-anchors nextRunAt to the
 * next upcoming occurrence of dayOfMonth, so a change takes effect starting
 * from the next real calendar hit rather than an arbitrary future date.
 */
export async function updateIntelScheduleAction(
  clientId: string,
  input: { enabled: boolean; intervalMonths: number; dayOfMonth: number },
): Promise<{ ok: true; nextRunAt: number | null } | { ok?: never; error: string }> {
  try {
    await requireAdmin();
    const intervalMonths = clampIntervalMonths(input.intervalMonths);
    const dayOfMonth = clampScheduleDayOfMonth(input.dayOfMonth);
    const nextRunAt = input.enabled ? computeFirstIntelScheduleRun(dayOfMonth) : null;

    await updateClient(clientId, {
      intelScheduleEnabled: input.enabled,
      intelScheduleIntervalMonths: intervalMonths,
      intelScheduleDayOfMonth: dayOfMonth,
      intelScheduleNextRunAt: nextRunAt,
    });
    revalidatePath(`/clients/${clientId}`);
    return { ok: true, nextRunAt };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not update the schedule" };
  }
}

/**
 * Re-condense the existing internal context docs for a client into fresh client-tier docs.
 * Does NOT re-run the full 5-agent research pipeline — only the condensation pass.
 */
export async function refreshClientContextDocsAction(clientId: string): Promise<void> {
  await requireStaff();

  const [client, internalDocs] = await Promise.all([
    getClient(clientId),
    listClientContextDocs(clientId, "internal"),
  ]);
  if (!client) throw new Error("Client not found");

  const { RESEARCH_ENGINE_RULES, METRICS_RULES } = await import("@/lib/intel");
  const rules = [RESEARCH_ENGINE_RULES, "", METRICS_RULES].filter(Boolean).join("\n");

  const internalMap: Record<string, string> = {};
  for (const doc of internalDocs) internalMap[doc.docType] = doc.content;

  const { refreshClientCondensedDocs } = await import("@/lib/intel");
  const condensed = await refreshClientCondensedDocs(client, internalMap, rules);

  const now = Date.now();

  // Fetch existing client-tier docs to preserve version counters and createdAt timestamps.
  // Non-client docs (internal, internal-only) are left completely untouched so their
  // Firestore IDs remain stable for any in-flight applyTargetedDocCorrectionAction calls.
  const existingClientDocs = await listClientContextDocs(clientId, "client");
  const existingByDocType = new Map(existingClientDocs.map((d) => [d.docType, d]));

  await Promise.all(
    condensed.map((doc) => {
      const prev = existingByDocType.get(doc.docType);
      return upsertClientContextDoc({
        clientId,
        docType: doc.docType,
        tier: "client" as ContextDocTier,
        content: doc.content,
        version: (prev?.version ?? 0) + 1,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      });
    }),
  );

  revalidatePath(`/clients/${clientId}`);
}

/**
 * Generate a 4-5 bullet executive summary for a context document using Claude Haiku.
 * Cached on the doc row and served without a model call while the version is
 * unchanged.
 *
 * `tier` is honoured for staff and IGNORED for a client caller, who always gets
 * the "client" tier. Returns an empty array when that tier has no such document
 * — this never falls back to another tier.
 */
export async function generateDocSummaryAction(
  clientId: string,
  docType: string,
  tier: string,
): Promise<string[]> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) throw new Error("Forbidden");

  // Tier is resolved STRICTLY — no cross-tier fallback. A server action is
  // network-reachable, so with a fallback a client could name a docType that has
  // no client-tier row and be handed an LLM summary of the internal analyst
  // copy, uncharged. A client caller's tier argument is ignored outright: their
  // summaries come from the published tier or not at all.
  const requested = isContextDocTier(tier) ? tier : null;
  const effectiveTier: ContextDocTier | null =
    user.role === "CLIENT_USER" ? "client" : requested;
  if (!effectiveTier) return [];

  const docs = await listClientContextDocs(clientId, effectiveTier);
  const doc = docs.find((d) => d.docType === docType);
  // No summary available for that tier — never reach for another one.
  if (!doc) return [];

  // Serve cached summary if the doc content hasn't changed since last generation.
  // No model call, no charge — which is the common case by a wide margin.
  if (doc.summary?.length && doc.summaryVersion === doc.version) {
    return doc.summary;
  }

  // ── FREE, PENDING A DECISION (finding #168) ──────────────────────────────
  // A cache MISS here runs one Haiku call and does not charge. That is a
  // DELIBERATE hold, not an oversight, and it is the open half of #168: the
  // choice is "1 credit" or "free and documented", and this is the documented
  // free half until Daniel rules. Do not price it in passing.
  //
  // What is on the record for that decision:
  //
  //  - NOBODY PRESSES THIS. The summary is generated when the document drawer
  //    OPENS, so a price here bills a client for reading a file they already
  //    own, with no button to decline at. A client with eight context documents
  //    would pay eight credits to read their own documents once.
  //  - THE CACHE KEY IS THE DOC VERSION, and a staff or cron intel refresh bumps
  //    it. So a charge here would land on a client who opened a document the
  //    team had just regenerated — paying for a change they did not ask for.
  //    That is the strongest argument for keeping it free, and it is the reason
  //    the cheaper-looking "just charge 1 credit" is not the safe default.
  //  - IF IT IS EVER PRICED, the honest form is not a charge on drawer open: it
  //    is generating the summary as part of the refresh that bumped the version
  //    (staff-side, uncharged), or an explicit "Summarise" the client presses
  //    with the price stated next to it.
  //
  // The exposure while it stays free is bounded by the cache above: one Haiku
  // call per document VERSION, not per view.
  const { generateText } = await import("ai");
  const { aiFor, usageFor } = await import("@/lib/ai/provider");
  const summaryUsageMeta = {
    clientId, agentId: null, agentName: "Executive Summary",
    ...usageFor("intel.actions"), operation: "doc_summary",
  };
  let text: string;
  let usage: { inputTokens?: number; outputTokens?: number };
  try {
    ({ text, usage } = await generateText({
      model: aiFor("intel.actions").model,
      system:
        "You are a strategic analyst. Distill the document into exactly 4-5 high-impact executive insights. " +
        "Return ONLY a valid JSON array of strings. No markdown, no preamble, no trailing text. " +
        "Each string: max 20 words, starts with an action verb or key noun, concrete and specific.",
      messages: [
        {
          role: "user",
          // Markers out before the slice: the brand sync block sits at the top of
          // the brand-voice document, so its sentinels were inside the 4,000
          // characters the summariser reads and could be echoed into a bullet the
          // client reads under "In short".
          content: stripPipelineMarkers(doc.content)
            .replace(/^---[\s\S]*?---\n?/, "")
            .slice(0, 4000),
        },
      ],
      maxOutputTokens: 450,
    }));
  } catch (err) {
    logger.logGenerationFailure(summaryUsageMeta, err);
    throw err;
  }

  let bullets: string[];
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\n?|\n?```$/g, "");
    const arr = JSON.parse(cleaned);
    bullets = Array.isArray(arr)
      ? arr.filter((s): s is string => typeof s === "string" && s.length > 4).slice(0, 5)
      : [];
  } catch {
    bullets = text
      .split("\n")
      .map((l) => l.replace(/^[-*\d."'\[\]]+\s*/, "").trim())
      .filter((l) => l.length > 8)
      .slice(0, 5);
  }

  // Parsed to nothing: the call succeeded but the panel has no bullets to show,
  // so there is nothing to cache. (Nothing to refund either while this call is
  // free — see the #168 note above.)
  if (bullets.length === 0) return [];

  const { id: docId, version: docVersion } = doc;
  after(async () => {
    // Persist summary so the next request is served from cache (no LLM call).
    await updateContextDocSummary(docId, bullets, docVersion);
    logger.logUsage({
      ...summaryUsageMeta,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    });
  });

  return bullets;
}

/**
 * Apply a client correction to a single, specific context document by its Firestore ID.
 * In-place surgical edit — does NOT touch any other document or re-run the pipeline.
 * Accessible by staff or the client themselves (for documents that belong to their clientId).
 *
 * Structural guardrails: applyDocCorrections validates section count and length ratio
 * before writing. If the LLM output looks corrupted it returns the original unchanged,
 * so this action never writes a truncated or hallucinated document.
 */
export async function applyTargetedDocCorrectionAction(
  documentId: string,
  corrections: string,
): Promise<{ ok: true; error?: never } | { ok?: never; error: string }> {
  // Errors (incl. credit denials) return as data — thrown server-action errors
  // are masked in production, which would hide the reason from the client UI.
  try {
    const { changed } = await applyTargetedDocCorrection(documentId, corrections);
    // A correction that failed the structural checks wrote nothing. Reporting
    // success here made the modal close the document as if it had worked, while
    // the old text — and a 2-credit charge — stayed exactly where they were.
    if (!changed) {
      return {
        error:
          "We could not apply that correction safely. Nothing was changed and you have not been charged. Try naming the fact more specifically.",
      };
    }
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to apply the correction" };
  }
}

async function applyTargetedDocCorrection(
  documentId: string,
  corrections: string,
): Promise<{ changed: boolean }> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (!corrections.trim()) throw new Error("Corrections text is required");

  const doc = await getClientContextDocById(documentId);
  if (!doc) throw new Error("Document not found");

  // Clients can only correct documents that belong to their own account.
  if (user.role === "CLIENT_USER" && user.clientId !== doc.clientId) {
    throw new Error("Forbidden");
  }

  const client = await getClient(doc.clientId);
  if (!client) throw new Error("Client not found");

  const charge = {
    user,
    clientId: doc.clientId,
    amount: CREDIT_COSTS.targetedCorrection,
    operation: "doc_correction" as const,
    // The ledger feed is rendered ungated to a CLIENT_USER in CreditsPanel, so
    // this string is client copy that happens to arrive through Firestore.
    reason: `Document correction · ${contextDocLabel(doc.docType)}`,
  };

  const outcome = await withClientModelCharge(charge, async ({ refund }) => {
    const { applyDocCorrections } = await import("@/lib/intel");
    const corrected = await applyDocCorrections(client, doc.docType, doc.content, corrections);

    // applyDocCorrections returns the original content when structural checks fail —
    // skip the write entirely rather than bumping the version with unchanged data.
    // The charge happens before the model call, so hand it back: a client must not
    // pay for a correction that was discarded. (The OTHER way this call can fail —
    // it throws — is refunded by the wrapper, not here.)
    if (corrected.trim() === doc.content.trim()) {
      await refund(`Refund · discarded document correction · ${contextDocLabel(doc.docType)}`);
      return { changed: false };
    }

    await updateContextDocContent(documentId, corrected);
    return { changed: true };
  });

  // A denial is surfaced the way this file has always surfaced one: thrown, and
  // caught by the exported action, which returns it as `{ error }` because a
  // thrown server-action error is masked in production.
  if (!outcome.ok) throw new Error(outcome.denied);
  if (!outcome.result.changed) return { changed: false };

  // Everything below is post-correction bookkeeping on a write that already
  // landed. It sits OUTSIDE the charge wrapper on purpose: the client paid for
  // the correction, they got the correction, and a failure to log an activity
  // row afterwards is not something to hand credits back for.
  const { applyDocCorrections } = await import("@/lib/intel");

  // A correction edits exactly one stored row — the one the viewer opened, which
  // the picker resolves to the client-facing copy. Its internal twin is what the
  // copilot and the agents read, so without this the AI keeps quoting the fact
  // the client just told us was wrong. Runs after the response so the modal is
  // not held open for a second model call, and never fails the correction that
  // already landed.
  const siblingTier: ContextDocTier | null =
    doc.tier === "client" ? "internal" : doc.tier === "internal" ? "client" : null;
  if (siblingTier) {
    const { clientId: docClientId, docType } = doc;
    after(async () => {
      try {
        const sibling = await getClientContextDocByTier(docClientId, docType, siblingTier);
        if (!sibling) return;
        const correctedSibling = await applyDocCorrections(
          client,
          docType,
          sibling.content,
          corrections,
        );
        if (correctedSibling.trim() !== sibling.content.trim()) {
          await updateContextDocContent(sibling.id, correctedSibling);
        }
      } catch (e) {
        console.error(`[intel] Could not propagate correction to ${siblingTier} ${docType}:`, e);
      }
    });
  }

  const actorRole = user.role === "CLIENT_USER" ? "client" : "staff";
  const now = Date.now();
  await Promise.all([
    logActivity({
      clientId: doc.clientId,
      timestamp: now,
      type: "CONTEXT_DOC_UPDATED",
      // `doc.docType` is stored kebab-case, and this row is on the CLIENT's
      // timeline: it read "branding-guidelines corrected (targeted)".
      title: `${contextDocLabel(doc.docType)} corrected`,
      description: corrections.length > 160 ? corrections.slice(0, 157) + "…" : corrections,
      actor: user.name,
      actorRole,
    }),
    logFeedback({
      agentId: "intel-report-agent",
      clientId: doc.clientId,
      feedbackText: corrections,
      docType: doc.docType,
      scope: "single_doc",
      createdAt: now,
      createdBy: user.uid,
      creatorRole: actorRole,
    }),
  ]);

  revalidatePath(`/clients/${doc.clientId}`);
  return { changed: true };
}

/**
 * Apply verified client corrections to a context document (Fix with Review feature).
 * Re-uses the document's current content without re-running the full research pipeline.
 * Also re-condenses the client-facing version so both tiers stay in sync.
 */
export async function applyDocCorrectionAction(
  clientId: string,
  docType: string,
  tier: string,
  corrections: string,
): Promise<void> {
  const user = await requireStaff();
  if (!corrections.trim()) throw new Error("Corrections text is required");

  const [client, doc] = await Promise.all([
    getClient(clientId),
    getClientContextDocByTier(clientId, docType, tier as import("@/lib/types").ContextDocTier),
  ]);
  if (!client) throw new Error("Client not found");
  if (!doc) throw new Error("Document not found");

  const { applyDocCorrections } = await import("@/lib/intel");
  const corrected = await applyDocCorrections(client, docType, doc.content, corrections);
  // Guard: skip write if the LLM returned the original unchanged (structural-check failure).
  if (corrected.trim() === doc.content.trim()) return;
  await updateContextDocContent(doc.id, corrected);

  // If we corrected an internal doc, apply the same corrections to the client-facing version too.
  if (tier === "internal") {
    const clientDoc = await getClientContextDocByTier(clientId, docType, "client");
    if (clientDoc) {
      const correctedClient = await applyDocCorrections(client, docType, clientDoc.content, corrections);
      await updateContextDocContent(clientDoc.id, correctedClient);
    }
  }

  const now = Date.now();
  await Promise.all([
    logActivity({
      clientId,
      timestamp: now,
      type: "CONTEXT_DOC_UPDATED",
      // Same row on the same client timeline. "Fix with Review" is the name of
      // the STAFF surface that applied it, which the client has never seen; what
      // distinguishes this row from the targeted one, in their terms, is that a
      // person checked it first.
      title: `${contextDocLabel(docType)} corrected after review`,
      description: corrections.length > 160 ? corrections.slice(0, 157) + "…" : corrections,
      actor: user.name,
      actorRole: "staff",
    }),
    logFeedback({
      agentId: "intel-report-agent",
      clientId,
      feedbackText: corrections,
      docType,
      scope: "single_doc",
      createdAt: now,
      createdBy: user.uid,
      creatorRole: "staff",
    }),
  ]);

  revalidatePath(`/clients/${clientId}`);
}

/**
 * Apply a client correction globally — scans every context document for this client
 * and updates any that contain the incorrect information, keeping all docs in sync.
 * Accessible by staff or the client themselves (for their own clientId).
 */
export async function applyGlobalDocCorrectionAction(
  clientId: string,
  corrections: string,
): Promise<{ ok: true; error?: never } | { ok?: never; error: string }> {
  try {
    await applyGlobalDocCorrection(clientId, corrections);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to apply the correction" };
  }
}

async function applyGlobalDocCorrection(clientId: string, corrections: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) throw new Error("Forbidden");
  if (!corrections.trim()) throw new Error("Corrections text is required");

  // CLIENT_USER may only correct their own client-visible docs; staff may correct all tiers.
  const tier = user.role === "CLIENT_USER" ? "client" : undefined;
  const [client, allDocs] = await Promise.all([
    getClient(clientId),
    listClientContextDocs(clientId, tier),
  ]);
  if (!client) throw new Error("Client not found");
  if (!allDocs.length) throw new Error("No documents found for this client");

  // Global corrections rewrite every context doc (one model call each) — the
  // most expensive client-triggerable action, priced accordingly. It is also
  // the one most likely to fail partway, which is why it runs inside the
  // charge wrapper: a Promise.all that rejects used to leave the client 15
  // credits down with no refund path at all.
  const outcome = await withClientModelCharge(
    {
      user,
      clientId,
      amount: CREDIT_COSTS.globalCorrection,
      operation: "doc_correction" as const,
      // Client copy: the ledger feed renders ungated to a CLIENT_USER.
      reason: "Global document correction",
    },
    async ({ refund }) => {
      const { applyDocCorrections } = await import("@/lib/intel");

      // Apply corrections to every doc in parallel — the prompt is instructed
      // to only modify facts it finds, so docs without the incorrect data are
      // returned unchanged and we skip the write.
      //
      // ALL-OR-NOTHING REFUND OVER A NOT-ALL-OR-NOTHING WRITE, stated because it
      // is a real hole and not one worth closing the other way. `Promise.all`
      // rejects on the FIRST failing document while its siblings keep going, and
      // the ones that already resolved have already written. The charge wrapper
      // then refunds the whole 15 credits for the throw — so a correction that
      // landed on four of five documents can end up free.
      //
      // Left as it is on purpose: it errs in the CLIENT's favour, and every
      // alternative errs against them (keep the 15 for a correction that half
      // failed, or refund proportionally for a run whose real cost is already
      // spent). The bound is 15 credits per failed global correction, and the
      // client sees the error and can re-run — the second run corrects only what
      // is still wrong, so nothing is lost but the credits we chose not to keep.
      const changes = await Promise.all(
        allDocs.map(async (doc) => {
          const corrected = await applyDocCorrections(client, doc.docType, doc.content, corrections);
          // Only write if the content actually changed to avoid spurious version bumps.
          if (corrected.trim() === doc.content.trim()) return false;
          await updateContextDocContent(doc.id, corrected);
          return true;
        }),
      );

      // Same rule the targeted path has always had, which this path never got:
      // a correction that changed no document is a correction the client did
      // not receive. Every doc came back unchanged ⇒ hand the credits back.
      if (!changes.some(Boolean)) {
        await refund("Refund · global correction changed nothing");
      }
    },
  );
  if (!outcome.ok) throw new Error(outcome.denied);

  const actorRole = user.role === "CLIENT_USER" ? "client" : "staff";
  const now = Date.now();
  await Promise.all([
    logActivity({
      clientId,
      timestamp: now,
      type: "CONTEXT_DOC_UPDATED",
      title: "Global correction applied across all documents",
      description: corrections.length > 160 ? corrections.slice(0, 157) + "…" : corrections,
      actor: user.name,
      actorRole,
    }),
    logFeedback({
      agentId: "intel-report-agent",
      clientId,
      feedbackText: corrections,
      scope: "global",
      createdAt: now,
      createdBy: user.uid,
      creatorRole: actorRole,
    }),
  ]);

  revalidatePath(`/clients/${clientId}`);
}

export async function deleteContextItemAction(id: string) {
  await requireStaff();
  const { getContextItem, deleteContextItem } = await import("@/lib/data");
  const { deleteObject } = await import("@/lib/storage");
  const item = await getContextItem(id);
  if (!item) return;
  await deleteObject(item.storagePath);
  await deleteContextItem(id);
  revalidatePath(`/clients/${item.clientId}`);
}

export async function updateContextItemNoteAction(id: string, note: string) {
  await requireStaff();
  const { getContextItem, updateContextItem } = await import("@/lib/data");
  const item = await getContextItem(id);
  if (!item) throw new Error("Context item not found");
  await updateContextItem(id, { note: note.trim() });
  revalidatePath(`/clients/${item.clientId}`);
}
