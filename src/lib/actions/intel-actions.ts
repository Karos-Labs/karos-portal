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
  chargeClientCredits,
  creditClientCredits,
  tryAcquireAiProcessingLock,
  releaseAiProcessingLock,
  approveSeoGeoRecommendation,
} from "@/lib/data";
import { logger } from "@/services/logger";
import { getCurrentUser } from "@/lib/auth";
import type { AppUser, ContextDocTier } from "@/lib/types";
import { requireStaff, requireAdmin, logActivity } from "./_shared";
import { MODELS } from "@/lib/constants";
import { CREDIT_COSTS, isBillableClientActor } from "@/lib/credits";
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
 * Charge a client user for a doc correction (staff + impersonated sessions are
 * free). Throws CreditError on denial. Returns the charge timestamp when a
 * charge actually happened, so a no-op correction can be refunded against the
 * right spend window; null means nothing was charged.
 */
async function chargeDocCorrection(
  user: AppUser,
  clientId: string,
  amount: number,
  reason: string,
): Promise<number | null> {
  if (!isBillableClientActor(user)) return null;
  const chargedAt = Date.now();
  await chargeClientCredits({
    clientId,
    amount,
    operation: "doc_correction",
    reason,
    actorUid: user.uid,
    actorName: user.name,
  });
  return chargedAt;
}

/** Hand back a doc-correction charge for a correction that changed nothing. */
async function refundDocCorrection(
  user: AppUser,
  clientId: string,
  amount: number,
  reason: string,
  chargedAt: number,
) {
  await creditClientCredits({
    clientId,
    amount,
    kind: "refund",
    chargedAt,
    operation: "doc_correction",
    reason,
    actorUid: user.uid,
    actorName: user.name,
  });
}

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

  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const MODEL = MODELS.HAIKU;
  const { text, usage } = await generateText({
    model: anthropic(MODEL),
    system:
      "Write a plain, factual company description in exactly two short sentences (about two lines total). " +
      "Describe what the company does and who it serves. " +
      "Do NOT use em dashes (—). Do NOT use marketing hype or adjectives like 'leading' or 'innovative'. " +
      "Return only the description text, no preamble.",
    messages: [{ role: "user", content: `Company: ${client.name}\n\n${source}` }],
    maxOutputTokens: 160,
  });

  after(() =>
    logger.logUsage({
      clientId,
      agentId: null,
      agentName: "Company Brief",
      modelName: MODEL,
      operation: "client_brief",
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }),
  );

  const brief = text
    .trim()
    .replace(/\s*[—–]\s*/g, ", ") // strip em/en dashes
    .replace(/^["']|["']$/g, "")
    .slice(0, 320);

  if (!brief) return { ok: false, error: "Could not generate a description." };

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
export async function approveSeoGeoRecommendationAction(
  clientId: string,
  recId: string,
  title: string,
): Promise<{ ok: true; approved: string[] } | { ok?: never; error: string }> {
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
    revalidatePath(`/clients/${clientId}`);
    return { ok: true, approved };
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
  await requireStaff();
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
      const ctxNote = runSpecificContext?.trim()
        ? ` - with run-specific context: "${runSpecificContext.trim().slice(0, 100)}${runSpecificContext.trim().length > 100 ? "…" : ""}"`
        : "";
      await logActivity({
        clientId,
        timestamp: Date.now(),
        type: "INTEL_GENERATION",
        title: "Intel Report generated",
        description: `Full competitive intelligence pipeline completed (5 core research agents + SEO/GEO multi-model vertical)${ctxNote}`,
        actor: "System AI",
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
  if (doc.summary?.length && doc.summaryVersion === doc.version) {
    return doc.summary;
  }

  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const MODEL = MODELS.HAIKU;
  const { text, usage } = await generateText({
    model: anthropic(MODEL),
    system:
      "You are a strategic analyst. Distill the document into exactly 4-5 high-impact executive insights. " +
      "Return ONLY a valid JSON array of strings — no markdown, no preamble, no trailing text. " +
      "Each string: max 20 words, starts with an action verb or key noun, concrete and specific.",
    messages: [
      {
        role: "user",
        content: doc.content.replace(/^---[\s\S]*?---\n?/, "").slice(0, 4000),
      },
    ],
    maxOutputTokens: 450,
  });

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

  const { id: docId, version: docVersion } = doc;
  after(async () => {
    // Persist summary so the next request is served from cache (no LLM call).
    await updateContextDocSummary(docId, bullets, docVersion);
    logger.logUsage({
      clientId,
      agentId: null,
      agentName: "Executive Summary",
      modelName: MODEL,
      operation: "doc_summary",
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
          "We could not apply that correction safely — nothing was changed and you have not been charged. Try naming the fact more specifically.",
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

  const chargedAt = await chargeDocCorrection(
    user,
    doc.clientId,
    CREDIT_COSTS.targetedCorrection,
    `Doc correction · ${doc.docType}`,
  );

  const { applyDocCorrections } = await import("@/lib/intel");
  const corrected = await applyDocCorrections(client, doc.docType, doc.content, corrections);

  // applyDocCorrections returns the original content when structural checks fail —
  // skip the write entirely rather than bumping the version with unchanged data.
  // The charge happens before the model call, so hand it back: a client must not
  // pay for a correction that was discarded.
  if (corrected.trim() === doc.content.trim()) {
    if (chargedAt !== null) {
      await refundDocCorrection(
        user,
        doc.clientId,
        CREDIT_COSTS.targetedCorrection,
        `Refund · discarded doc correction · ${doc.docType}`,
        chargedAt,
      );
    }
    return { changed: false };
  }

  await updateContextDocContent(documentId, corrected);

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
      title: `${doc.docType} corrected (targeted)`,
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
      title: `${docType} corrected via Fix with Review`,
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
  // most expensive client-triggerable action, priced accordingly.
  await chargeDocCorrection(
    user,
    clientId,
    CREDIT_COSTS.globalCorrection,
    "Global doc correction",
  );

  const { applyDocCorrections } = await import("@/lib/intel");

  // Apply corrections to every doc in parallel — the prompt is instructed
  // to only modify facts it finds, so docs without the incorrect data are
  // returned unchanged and we skip the write.
  await Promise.all(
    allDocs.map(async (doc) => {
      const corrected = await applyDocCorrections(client, doc.docType, doc.content, corrections);
      // Only write if the content actually changed to avoid spurious version bumps.
      if (corrected.trim() !== doc.content.trim()) {
        await updateContextDocContent(doc.id, corrected);
      }
    }),
  );

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

/** Upload a PDF report file to Firebase Storage and return its durable download URL. */
export async function uploadReportPdfAction(
  clientId: string,
  bytes: number[],
): Promise<string> {
  await requireStaff();
  const { uploadBytes } = await import("@/lib/storage");
  const buffer = Buffer.from(bytes);
  const path = `clients/${clientId}/reports/${Date.now()}_intel.pdf`;
  const { url } = await uploadBytes({ bytes: buffer, path, contentType: "application/pdf" });
  return url;
}
