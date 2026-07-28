"use server";

import { revalidatePath } from "next/cache";

import { adminDb } from "@/lib/firebase/admin";
import { isAiProcessingLockActive } from "@/lib/constants";
import {
  getClient,
  getClientSeoGeo,
  listClientCompetitors,
  listClientContextDocs,
  upsertClientSeoGeo,
} from "@/lib/data";
import {
  buildWriteOps,
  validateProposal,
  type CurrentState,
  type RefreshPlan,
  type Row,
} from "@/lib/refresh-apply-core";
import { readInboxProposal, readInboxSeoGeo } from "@/lib/ops-inbox";
import { describeProvenance, validateSeoGeoSnapshot } from "@/lib/seo-geo-import";
import { SEO_GEO_PIPELINE_VERSION } from "@/lib/seo-geo";
import { logActivity, requireAdmin } from "./_shared";

/**
 * Admin Ops Import — land locally-produced bundles in the live portal.
 *
 * Every write here goes through src/lib/refresh-apply-core.ts, the same module
 * scripts/refresh-apply.ts uses. The safety contract (no deletes, shrink floors,
 * docType/tier no-leak table, fill-only profile fields, palette gates) is
 * therefore identical by construction rather than by review.
 *
 * PLAN FIRST IS STRUCTURAL, NOT COPY: `applyOpsBundleAction` re-reads and
 * re-validates the bundle from disk and refuses on ANY error. The plan the page
 * showed is a rendering of that same validation, never a token that authorizes
 * a write. A file edited between preview and click is re-judged, not trusted.
 *
 * Runbook: docs/qa-sweep-2026-07/refresh/OPS-IMPORT.md
 */

/* ── Wire shapes ─────────────────────────────────────────────────────── */

/**
 * What the browser gets. Deliberately NOT the RefreshPlan: that carries every
 * validated document body, and shipping ~200KB of markdown per client into the
 * RSC payload to render a line saying "12,400 → 13,900 chars" would be absurd.
 */
export interface PlanSummary {
  file: string;
  clientId: string;
  clientName: string;
  docs: Array<{
    label: string;
    action: "create" | "update" | "unchanged";
    detail: string;
    verifyTokens: number;
  }>;
  competitors: Array<{ company: string; action: "create" | "update" | "unchanged"; fields: string[] }>;
  profileFills: Array<{ field: string; to: string }>;
  skippedProfile: Array<{ field: string; reason: string }>;
  brandingFills: string[];
  colors: { from: string[]; to: string[] } | null;
  warnings: string[];
  counts: RefreshPlan["counts"];
  /** The SEO/GEO half, when <inbox>/seo-geo/<clientId>.json exists. */
  seoGeo: SeoGeoPlanSummary | null;
  /** Set when the client is mid-pipeline: the apply buttons stay disabled. */
  lockedReason: string | null;
}

export interface SeoGeoPlanSummary {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Provenance of what is stored TODAY, so staff see what they are replacing. */
  storedProvenance: string;
  /** Measurement date of the incoming capture (ISO day), when it validates. */
  capturedOn: string | null;
  /** Whether the incoming capture will render with the legacy banner. */
  willReadAsLegacy: boolean;
}

export type PlanResult = { ok: true; plan: PlanSummary } | { ok: false; errors: string[]; file: string };

export interface ApplyOutcome {
  file: string;
  clientName: string;
  /** Honest per-half reporting — a green refresh next to a refused snapshot. */
  refresh: { applied: boolean; docs: number; competitors: number; client: number; error: string | null };
  seoGeo: { applied: boolean; skippedReason: string | null; error: string | null };
}

function truncate(v: unknown, n = 80): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/* ── Shared plumbing ─────────────────────────────────────────────────── */

/** Reads the stored state a proposal is validated against. */
async function loadCurrentState(clientId: string): Promise<
  { ok: true; current: CurrentState; lockedReason: string | null } | { ok: false; error: string }
> {
  const client = await getClient(clientId);
  if (!client) return { ok: false, error: `No client with id ${clientId} — is this bundle for another environment?` };

  const [docs, competitors] = await Promise.all([
    listClientContextDocs(clientId),
    listClientCompetitors(clientId),
  ]);

  const docMap = new Map<string, Row>();
  for (const d of docs) docMap.set(`${d.docType}@${d.tier}`, d as unknown as Row);

  return {
    ok: true,
    current: {
      clientId,
      clientName: client.name ?? clientId,
      client: client as unknown as Row,
      docs: docMap,
      competitors: competitors as unknown as Row[],
    },
    // A pipeline run holds this lock while it rewrites the very documents a
    // proposal targets. Interleaving the two is how half a refresh survives.
    lockedReason: isAiProcessingLockActive(client)
      ? "An AI pipeline run is in progress for this client. Importing now could interleave with its writes — wait for it to finish."
      : null,
  };
}

function summarize(file: string, plan: RefreshPlan, lockedReason: string | null): PlanSummary {
  return {
    file,
    clientId: plan.clientId,
    clientName: plan.clientName,
    docs: plan.docs.map((d) => ({
      label: `${d.docType} · ${d.tier}`,
      action: d.action,
      detail:
        d.action === "create"
          ? `new · ${d.toChars.toLocaleString()} chars · ${d.toSections} sections`
          : d.action === "unchanged"
            ? "identical to what is stored"
            : `${d.fromChars.toLocaleString()} → ${d.toChars.toLocaleString()} chars · ` +
              `${d.fromSections} → ${d.toSections} sections · v${d.fromVersion} → v${d.toVersion}`,
      verifyTokens: d.verifyTokens,
    })),
    competitors: plan.competitors.map((c) => ({
      company: c.company,
      action: c.action,
      fields: c.changes.map((ch) => ch.field),
    })),
    profileFills: plan.client.profile.map((p) => ({ field: p.field, to: truncate(p.to) })),
    skippedProfile: plan.client.skippedProfile,
    brandingFills: plan.client.brandingFill.map((b) => b.field),
    colors: plan.client.colors
      ? {
          from: plan.client.colors.from.map((c) => String(c.hex)),
          to: plan.client.colors.to.map((c) => String(c.hex)),
        }
      : null,
    warnings: plan.warnings,
    counts: plan.counts,
    seoGeo: null,
    lockedReason,
  };
}

/** Validates the client's seo-geo bundle, if one is filed. Never writes. */
async function planSeoGeo(clientId: string, now: number): Promise<SeoGeoPlanSummary | null> {
  let raw: unknown;
  try {
    raw = await readInboxSeoGeo(clientId);
  } catch (e) {
    return {
      ok: false,
      errors: [e instanceof Error ? e.message : "Could not read the snapshot bundle."],
      warnings: [],
      storedProvenance: describeProvenance(await getClientSeoGeo(clientId)),
      capturedOn: null,
      willReadAsLegacy: true,
    };
  }
  if (raw === null) return null;

  const stored = await getClientSeoGeo(clientId);
  const res = validateSeoGeoSnapshot(raw, { clientId }, now);
  if (!res.ok) {
    return {
      ok: false,
      errors: res.errors,
      warnings: [],
      storedProvenance: describeProvenance(stored),
      capturedOn: null,
      willReadAsLegacy: true,
    };
  }
  return {
    ok: true,
    errors: [],
    warnings: res.warnings,
    storedProvenance: describeProvenance(stored),
    capturedOn: new Date(res.insights.capturedAt).toISOString().slice(0, 10),
    willReadAsLegacy: res.insights.pipelineVersion !== SEO_GEO_PIPELINE_VERSION,
  };
}

/* ── Actions ─────────────────────────────────────────────────────────── */

/**
 * Dry run for one bundle. Reads Firestore, writes nothing. Every refusal the
 * apply would hit shows up here first — that is the whole point of the card.
 */
export async function planOpsBundleAction(file: string): Promise<PlanResult> {
  await requireAdmin();
  const now = Date.now();

  let proposal: unknown;
  try {
    proposal = await readInboxProposal(file);
  } catch (e) {
    return { ok: false, file, errors: [e instanceof Error ? e.message : "Could not read the bundle."] };
  }

  const clientId = (proposal as { clientId?: unknown })?.clientId;
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, file, errors: ["clientId: the bundle does not name a client."] };
  }

  const state = await loadCurrentState(clientId);
  if (!state.ok) return { ok: false, file, errors: [state.error] };

  const result = validateProposal(proposal, state.current);
  if (!result.ok) return { ok: false, file, errors: result.errors };

  const summary = summarize(file, result.plan, state.lockedReason);
  summary.seoGeo = await planSeoGeo(clientId, now);
  return { ok: true, plan: summary };
}

/**
 * Apply one bundle: the refresh proposal, and the SEO/GEO snapshot when the
 * client has one filed.
 *
 * Re-validates from disk — the preview grants nothing. The refresh half commits
 * in a single atomic batch, exactly as the CLI does; the snapshot is a separate
 * transactional upsert, so one half failing is reported rather than hidden.
 */
export async function applyOpsBundleAction(input: {
  file: string;
  includeSeoGeo: boolean;
}): Promise<{ ok: true; outcome: ApplyOutcome } | { ok: false; errors: string[]; file: string }> {
  const user = await requireAdmin();
  const now = Date.now();
  const { file } = input;

  let proposal: unknown;
  try {
    proposal = await readInboxProposal(file);
  } catch (e) {
    return { ok: false, file, errors: [e instanceof Error ? e.message : "Could not read the bundle."] };
  }

  const clientId = (proposal as { clientId?: unknown })?.clientId;
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, file, errors: ["clientId: the bundle does not name a client."] };
  }

  const state = await loadCurrentState(clientId);
  if (!state.ok) return { ok: false, file, errors: [state.error] };
  if (state.lockedReason) return { ok: false, file, errors: [state.lockedReason] };

  const result = validateProposal(proposal, state.current);
  if (!result.ok) return { ok: false, file, errors: result.errors };

  const plan = result.plan;
  const outcome: ApplyOutcome = {
    file,
    clientName: plan.clientName,
    refresh: {
      applied: false,
      docs: plan.counts.docWrites,
      competitors: plan.counts.compWrites,
      client: plan.counts.clientTouched ? 1 : 0,
      error: null,
    },
    seoGeo: { applied: false, skippedReason: null, error: null },
  };

  /* ── Refresh half — one atomic batch, same ops as the CLI ── */
  if (plan.counts.totalWrites === 0) {
    outcome.refresh.error = null;
    outcome.refresh.applied = true; // nothing to do IS success, and says so in the counts
  } else {
    try {
      const db = adminDb();
      const batch = db.batch();
      for (const op of buildWriteOps(plan, now)) {
        if (op.kind === "create") {
          batch.set(db.collection(op.collection).doc(), op.data);
        } else {
          batch.set(db.collection(op.collection).doc(op.id), op.data, { merge: true });
        }
      }
      await batch.commit();
      outcome.refresh.applied = true;
    } catch (e) {
      outcome.refresh.error = e instanceof Error ? e.message : "The batch write failed.";
    }
  }

  /* ── SEO/GEO half — separate transactional upsert ── */
  if (input.includeSeoGeo) {
    try {
      const raw = await readInboxSeoGeo(clientId);
      if (raw === null) {
        outcome.seoGeo.skippedReason = "No snapshot bundle filed for this client.";
      } else {
        const res = validateSeoGeoSnapshot(raw, { clientId, importedBy: user.name, file: `seo-geo/${clientId}.json` }, now);
        if (!res.ok) {
          outcome.seoGeo.error = res.errors.join(" · ");
        } else {
          const stored = await getClientSeoGeo(clientId);
          // upsertClientSeoGeo silently drops an older capture to protect a
          // fresher one. Say so rather than reporting a write that never happened.
          if (stored && stored.capturedAt > res.insights.capturedAt) {
            outcome.seoGeo.skippedReason =
              `The stored snapshot was captured ${new Date(stored.capturedAt).toISOString().slice(0, 10)}, ` +
              `newer than this bundle's ${new Date(res.insights.capturedAt).toISOString().slice(0, 10)} — kept the newer one.`;
          } else {
            await upsertClientSeoGeo(res.insights);
            outcome.seoGeo.applied = true;
          }
        }
      }
    } catch (e) {
      outcome.seoGeo.error = e instanceof Error ? e.message : "The snapshot import failed.";
    }
  }

  if (outcome.refresh.applied && plan.counts.totalWrites > 0) {
    void logActivity({
      clientId,
      timestamp: Date.now(),
      type: "CONTEXT_DOC_UPDATED",
      title:
        `Ops import from ${file}: ${plan.counts.docWrites} document(s), ` +
        `${plan.counts.compWrites} competitor row(s)` +
        (plan.counts.clientTouched ? ", client profile" : "") +
        (outcome.seoGeo.applied ? ", SEO/GEO snapshot" : ""),
      actor: user.name,
      actorRole: "staff",
      metadata: {
        file,
        docs: plan.counts.docWrites,
        competitors: plan.counts.compWrites,
        clientTouched: plan.counts.clientTouched,
        seoGeoImported: outcome.seoGeo.applied,
      },
    });
  } else if (outcome.seoGeo.applied) {
    void logActivity({
      clientId,
      timestamp: Date.now(),
      type: "CONTEXT_DOC_UPDATED",
      title: `Ops import from ${file}: SEO/GEO snapshot (imported, not machine-measured)`,
      actor: user.name,
      actorRole: "staff",
      metadata: { file, seoGeoImported: true },
    });
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/admin/ops");
  return { ok: true, outcome };
}
