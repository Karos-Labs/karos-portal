"use server";

import { opsImportTitle } from "@/lib/activity-titles";
import { revalidatePath } from "next/cache";

import { adminDb } from "@/lib/firebase/admin";
import { isAiProcessingLockActive } from "@/lib/constants";
import {
  getClient,
  getClientSeoGeo,
  listAssets,
  listClientCompetitors,
  listClientContextDocs,
  listClients,
  upsertClientSeoGeo,
} from "@/lib/data";
import {
  buildWriteOps,
  validateProposal,
  type CurrentState,
  type RefreshPlan,
  type Row,
} from "@/lib/refresh-apply-core";
import { isOpsInboxConfigured, readInboxProposal, readInboxSeoGeo } from "@/lib/ops-inbox";
import {
  isLabOutputsConfigured,
  labRepoName,
  listLabOutputRuns,
  listLabRefreshProposals,
  normalizeLabSlug,
  readLabRefreshProposal,
} from "@/lib/lab-outputs";
import { describeProvenance, validateSeoGeoSnapshot } from "@/lib/seo-geo-import";
import { SEO_GEO_PIPELINE_VERSION } from "@/lib/seo-geo";
import { logActivity, requireAdmin } from "./_shared";

/**
 * Admin Ops Import — land locally-produced bundles in the live portal.
 *
 * Two discovery sources, one write path:
 *   · "lab"   — proposals committed to the karos-agents repo at
 *               clients/<slug>/refresh/*.json, found by "Check for updates".
 *   · "inbox" — proposals dropped in OPS_IMPORT_DIR on the server.
 *
 * Both produce the SAME plan cards through the SAME validator, because every
 * write here goes through src/lib/refresh-apply-core.ts — the module
 * scripts/refresh-apply.ts uses. The safety contract (no deletes, shrink
 * floors, docType/tier no-leak table, fill-only profile fields, palette gates)
 * is identical by construction rather than by review.
 *
 * PLAN FIRST IS STRUCTURAL, NOT COPY: `applyOpsBundleAction` re-reads and
 * re-validates the bundle from its source and refuses on ANY error. The plan
 * the page showed is a rendering of that same validation, never a token that
 * authorizes a write. A bundle edited between preview and click is re-judged.
 *
 * Runbook: docs/qa-sweep-2026-07/refresh/OPS-IMPORT.md
 */

/* ── Wire shapes ─────────────────────────────────────────────────────── */

export type BundleOrigin = "inbox" | "lab";

/** Where a bundle came from. `ref` is a filename (inbox) or a repo path (lab). */
export interface BundleRef {
  origin: BundleOrigin;
  ref: string;
}

/**
 * What the browser gets. Deliberately NOT the RefreshPlan: that carries every
 * validated document body, and shipping ~200KB of markdown per client into the
 * RSC payload to render a line saying "12,400 → 13,900 chars" would be absurd.
 */
export interface PlanSummary {
  origin: BundleOrigin;
  ref: string;
  /** Short display name — the filename, either way. */
  label: string;
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

export type PlanResult =
  | { ok: true; plan: PlanSummary }
  | { ok: false; errors: string[]; origin: BundleOrigin; ref: string };

export interface ApplyOutcome {
  origin: BundleOrigin;
  ref: string;
  clientName: string;
  /** Honest per-half reporting — a green refresh next to a refused snapshot. */
  refresh: { applied: boolean; docs: number; competitors: number; client: number; error: string | null };
  seoGeo: { applied: boolean; skippedReason: string | null; error: string | null };
}

/* ── Discovery ("Check for updates") ─────────────────────────────────── */

export interface ScannedProposal {
  ref: string;
  name: string;
  /** clientId the file declares — a mismatch shows up before any plan runs. */
  declaredClientId: string | null;
  error: string | null;
}

export interface ScannedClient {
  clientId: string;
  clientName: string;
  slug: string;
  proposals: ScannedProposal[];
  /** Committed runs with client deliverables that have never been imported. */
  newRuns: Array<{ agentFolder: string; runName: string }>;
  error: string | null;
}

export interface UpdateScan {
  configured: boolean;
  repo: string | null;
  scannedAt: number;
  /** Clients with something new. Quiet clients are counted, not listed. */
  clients: ScannedClient[];
  checked: number;
  error: string | null;
}

function truncate(v: unknown, n = 80): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Bounded parallelism — a fleet scan should not open 30 GitHub sockets at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * One click, one answer: "is there anything new anywhere?"
 *
 * Scans every client with a lab repo slug for (a) committed refresh proposals
 * and (b) output runs that have never been imported. Read-only — it lists what
 * exists and writes nothing. Clients with nothing new are counted, not listed,
 * so the result is a short answer rather than a fleet inventory.
 */
export async function scanLabForUpdatesAction(): Promise<UpdateScan> {
  await requireAdmin();
  const scannedAt = Date.now();

  // Named explicitly: the AI Agents tab silently hides its import button when
  // this is unset, which cost Albert a debugging session (coordinator note).
  if (!isLabOutputsConfigured()) {
    return {
      configured: false,
      repo: null,
      scannedAt,
      clients: [],
      checked: 0,
      error: "AGENTS_REPO_GITHUB_TOKEN is not set — the lab repo cannot be read.",
    };
  }

  const clients = (await listClients())
    .map((c) => ({ id: c.id, name: c.name, slug: normalizeLabSlug(c.agentsRepoSlug) }))
    .filter((c): c is { id: string; name: string; slug: string } => !!c.slug)
    .sort((a, b) => a.name.localeCompare(b.name));

  const scanned = await mapLimit(clients, 4, async (c): Promise<ScannedClient> => {
    const row: ScannedClient = {
      clientId: c.id,
      clientName: c.name,
      slug: c.slug,
      proposals: [],
      newRuns: [],
      error: null,
    };
    try {
      const [files, runs, assets] = await Promise.all([
        listLabRefreshProposals(c.slug),
        listLabOutputRuns(c.slug),
        listAssets({ clientId: c.id }),
      ]);

      // Read each proposal only far enough to name its client. Full validation
      // happens in the plan card, where the diff can be shown alongside it.
      row.proposals = await mapLimit(files, 4, async (f): Promise<ScannedProposal> => {
        try {
          const parsed = await readLabRefreshProposal(f.path);
          const declared = (parsed as { clientId?: unknown })?.clientId;
          return {
            ref: f.path,
            name: f.name,
            declaredClientId: typeof declared === "string" ? declared : null,
            error: null,
          };
        } catch (e) {
          return {
            ref: f.path,
            name: f.name,
            declaredClientId: null,
            error: e instanceof Error ? e.message : "Could not read this proposal.",
          };
        }
      });

      // "New" means never imported, which is exactly what meta.labRun records —
      // the same key importLabRunAction writes and de-duplicates against.
      const imported = new Set(
        assets
          .map((a) => (a.meta as { labRun?: string } | undefined)?.labRun)
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.split("#")[0]!),
      );
      row.newRuns = runs
        .filter((r) => r.hasClientFolder && !imported.has(`${r.agentFolder}/${r.runName}`))
        .map((r) => ({ agentFolder: r.agentFolder, runName: r.runName }));
    } catch (e) {
      row.error = e instanceof Error ? e.message : "Could not scan this client.";
    }
    return row;
  });

  return {
    configured: true,
    repo: labRepoName(),
    scannedAt,
    clients: scanned.filter((c) => c.proposals.length > 0 || c.newRuns.length > 0 || c.error),
    checked: scanned.length,
    error: null,
  };
}

/* ── Shared plumbing ─────────────────────────────────────────────────── */

/** Reads a bundle from whichever source it came from. */
async function readBundle(b: BundleRef): Promise<unknown> {
  return b.origin === "inbox" ? readInboxProposal(b.ref) : readLabRefreshProposal(b.ref);
}

function labelFor(b: BundleRef): string {
  return b.origin === "inbox" ? b.ref : (b.ref.split("/").pop() ?? b.ref);
}

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

function summarize(b: BundleRef, plan: RefreshPlan, lockedReason: string | null): PlanSummary {
  return {
    origin: b.origin,
    ref: b.ref,
    label: labelFor(b),
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
    brandingFills: plan.client.brandingFill.map((bf) => bf.field),
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

/**
 * Validates the client's seo-geo bundle, if one is filed. Never writes.
 *
 * Snapshots live in the inbox only — the lab convention covers proposals. With
 * no inbox configured there is simply no snapshot half, which is not an error.
 */
async function planSeoGeo(clientId: string, now: number): Promise<SeoGeoPlanSummary | null> {
  if (!isOpsInboxConfigured()) return null;

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
 * Dry run for one bundle, from either source. Reads Firestore, writes nothing.
 * Every refusal the apply would hit shows up here first — that is the whole
 * point of the card.
 */
export async function planOpsBundleAction(bundle: BundleRef): Promise<PlanResult> {
  await requireAdmin();
  const now = Date.now();
  const { origin, ref } = bundle;

  let proposal: unknown;
  try {
    proposal = await readBundle(bundle);
  } catch (e) {
    return { ok: false, origin, ref, errors: [e instanceof Error ? e.message : "Could not read the bundle."] };
  }

  const clientId = (proposal as { clientId?: unknown })?.clientId;
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, origin, ref, errors: ["clientId: the bundle does not name a client."] };
  }

  const state = await loadCurrentState(clientId);
  if (!state.ok) return { ok: false, origin, ref, errors: [state.error] };

  const result = validateProposal(proposal, state.current);
  if (!result.ok) return { ok: false, origin, ref, errors: result.errors };

  const summary = summarize(bundle, result.plan, state.lockedReason);
  summary.seoGeo = await planSeoGeo(clientId, now);
  return { ok: true, plan: summary };
}

/**
 * Apply one bundle: the refresh proposal, and the SEO/GEO snapshot when the
 * client has one filed in the inbox.
 *
 * Re-validates from source — the preview grants nothing. The refresh half
 * commits in a single atomic batch, exactly as the CLI does; the snapshot is a
 * separate transactional upsert, so one half failing is reported, not hidden.
 */
export async function applyOpsBundleAction(input: {
  origin: BundleOrigin;
  ref: string;
  includeSeoGeo: boolean;
}): Promise<
  { ok: true; outcome: ApplyOutcome } | { ok: false; errors: string[]; origin: BundleOrigin; ref: string }
> {
  const user = await requireAdmin();
  const now = Date.now();
  const bundle: BundleRef = { origin: input.origin, ref: input.ref };
  const { origin, ref } = input;

  let proposal: unknown;
  try {
    proposal = await readBundle(bundle);
  } catch (e) {
    return { ok: false, origin, ref, errors: [e instanceof Error ? e.message : "Could not read the bundle."] };
  }

  const clientId = (proposal as { clientId?: unknown })?.clientId;
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, origin, ref, errors: ["clientId: the bundle does not name a client."] };
  }

  const state = await loadCurrentState(clientId);
  if (!state.ok) return { ok: false, origin, ref, errors: [state.error] };
  if (state.lockedReason) return { ok: false, origin, ref, errors: [state.lockedReason] };

  const result = validateProposal(proposal, state.current);
  if (!result.ok) return { ok: false, origin, ref, errors: result.errors };

  const plan = result.plan;
  const label = labelFor(bundle);
  const outcome: ApplyOutcome = {
    origin,
    ref,
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
  if (input.includeSeoGeo && isOpsInboxConfigured()) {
    try {
      const raw = await readInboxSeoGeo(clientId);
      if (raw === null) {
        outcome.seoGeo.skippedReason = "No snapshot bundle filed for this client.";
      } else {
        const res = validateSeoGeoSnapshot(
          raw,
          { clientId, importedBy: user.name, file: `seo-geo/${clientId}.json` },
          now,
        );
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

  const sourceLabel = origin === "lab" ? `lab repo ${ref}` : label;
  if (outcome.refresh.applied && plan.counts.totalWrites > 0) {
    void logActivity({
      clientId,
      timestamp: Date.now(),
      type: "CONTEXT_DOC_UPDATED",
      title: opsImportTitle(
        sourceLabel,
        `${plan.counts.docWrites} document(s), ${plan.counts.compWrites} competitor row(s)` +
          (plan.counts.clientTouched ? ", client profile" : "") +
          (outcome.seoGeo.applied ? ", SEO/GEO snapshot" : ""),
      ),
      actor: user.name,
      actorRole: "staff",
      metadata: {
        origin,
        ref,
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
      title: opsImportTitle(sourceLabel, "SEO/GEO snapshot (imported, not machine-measured)"),
      actor: user.name,
      actorRole: "staff",
      metadata: { origin, ref, seoGeoImported: true },
    });
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/admin/ops");
  return { ok: true, outcome };
}
