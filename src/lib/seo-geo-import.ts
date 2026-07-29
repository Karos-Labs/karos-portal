/**
 * Validation for a hand-imported SEO/GEO snapshot (admin Ops Import).
 *
 * The refresh harness deliberately gave `refresh-apply.ts` no write path to
 * `clientSeoGeo` at all: those numbers are MACHINE-MEASURED, and a human
 * retyping them is how a portal starts reporting a position nobody measured.
 * Albert's directive overrides that — locally-run captures must be importable —
 * so this module carries the provenance the original ban existed to protect:
 *
 *   · A snapshot is accepted only if it validates against the stored capture
 *     shape (`SeoGeoInsights`), unknown keys included. A bundle from a different
 *     schema is refused, not coerced.
 *   · `capturedAt` comes from the BUNDLE, never from the clock. Importing a
 *     three-month-old capture must read as three months old — the staleness
 *     banner is computed from this field and would otherwise lie.
 *   · `pipelineVersion` is carried through EXACTLY as declared, and is never
 *     invented, upgraded, or defaulted. `buildSnapshotTrust` compares it
 *     strictly against SEO_GEO_PIPELINE_VERSION, so a bundle that omits it
 *     still renders the legacy banner — which is the honest outcome.
 *   · `importedFrom` is stamped by US, never accepted from the bundle. A file
 *     cannot declare its own provenance; that is the one claim the importer
 *     must own.
 *
 * Pure — no fs, no firebase, no clock. The caller passes `now`.
 */

import type { SeoGeoInsights } from "@/lib/seo-geo";

type Row = Record<string, unknown>;

/** Clock skew tolerated on `capturedAt` before it reads as a future capture. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Scalars every stored snapshot carries. Missing one means it isn't a snapshot. */
const REQUIRED_NUMBERS = [
  "capturedAt",
  "seoScore",
  "seoDataCoveragePct",
  "geoReadiness",
  "geoReadinessCoveragePct",
  "geoVisibilityIndex",
  "geoVisibilityCoveragePct",
  "geoVisibilityEnginesMeasured",
  "geoVisibilityEnginesScored",
  "geoVisibilityEnginesTotal",
  "rosterSharePct",
] as const;

const REQUIRED_ARRAYS = [
  "perEngine",
  "gaps",
  "recommendations",
  "seoChecks",
  "geoChecks",
  "promptSet",
  "intentPrompts",
  "answerGrid",
  "citationLeaderboard",
  "competitorsNamed",
  "roster",
] as const;

/** Optional arrays — absent on older captures, but must be arrays when present. */
const OPTIONAL_ARRAYS = ["visibilityHistory", "approvedRecIds", "discoveredBrands"] as const;

const COUNT_PAIRS = ["categoryPresence", "brandPresence"] as const;

/**
 * Every key `SeoGeoInsights` declares. Unknown keys are refused rather than
 * dropped: a bundle carrying fields this portal does not store is a bundle from
 * a different pipeline, and importing its recognised half would silently mix
 * two schemas in one document.
 */
const KNOWN_KEYS: readonly string[] = [
  "clientId",
  "pipelineVersion",
  // CD-J1: the question methodology a capture ran under. Optional and carried
  // through verbatim for the same reason pipelineVersion is — an absent stamp
  // means an unstamped capture, and inventing one would claim a standard the run
  // never followed. Listed here so a v2 bundle is not refused as foreign.
  "methodologyVersion",
  "geoVisibilityModel",
  "citationSummary",
  "updatedAt",
  ...REQUIRED_NUMBERS,
  ...REQUIRED_ARRAYS,
  ...OPTIONAL_ARRAYS,
  ...COUNT_PAIRS,
];

export interface SeoGeoImportContext {
  clientId: string;
  /** Display name of the admin performing the import. */
  importedBy?: string;
  /** Bundle filename, for the audit trail. */
  file?: string;
}

export type SeoGeoImportResult =
  | { ok: true; insights: SeoGeoInsights; warnings: string[] }
  | { ok: false; errors: string[] };

function isPlainObject(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate a parsed snapshot bundle and return the exact document to store.
 *
 * Returns every problem at once. `ok: false` means nothing may be written.
 */
export function validateSeoGeoSnapshot(
  raw: unknown,
  ctx: SeoGeoImportContext,
  now: number,
): SeoGeoImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["<root>: the snapshot must be a JSON object"] };
  }

  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(k)) {
      errors.push(
        k === "importedFrom"
          ? "importedFrom: a bundle may not declare its own provenance — the importer stamps this field"
          : `<root>: unknown key "${k}" — this is not a snapshot from this portal's pipeline`,
      );
    }
  }

  if (raw.clientId !== ctx.clientId) {
    errors.push(
      `clientId: snapshot targets "${String(raw.clientId)}" but this bundle is filed under "${ctx.clientId}" — refusing to cross-apply`,
    );
  }

  for (const f of REQUIRED_NUMBERS) {
    if (!isFiniteNumber(raw[f])) {
      errors.push(`${f}: expected a finite number, got ${JSON.stringify(raw[f])}`);
    }
  }

  // capturedAt is the measurement time and drives every staleness banner. It
  // must come from the capture, so a future value means the bundle is wrong.
  if (isFiniteNumber(raw.capturedAt)) {
    if (raw.capturedAt <= 0) {
      errors.push("capturedAt: expected epoch millis, got a non-positive number");
    } else if (raw.capturedAt > now + FUTURE_SKEW_MS) {
      errors.push(
        `capturedAt: ${new Date(raw.capturedAt).toISOString()} is in the future — a capture cannot postdate its import`,
      );
    }
  }

  for (const f of REQUIRED_ARRAYS) {
    if (!Array.isArray(raw[f])) errors.push(`${f}: expected an array, got ${typeof raw[f]}`);
  }
  for (const f of OPTIONAL_ARRAYS) {
    if (raw[f] !== undefined && !Array.isArray(raw[f])) {
      errors.push(`${f}: expected an array when present, got ${typeof raw[f]}`);
    }
  }

  for (const f of COUNT_PAIRS) {
    const v = raw[f];
    if (!isPlainObject(v) || !isFiniteNumber(v.named) || !isFiniteNumber(v.total)) {
      errors.push(`${f}: expected { named: number, total: number }`);
    }
  }

  if (typeof raw.geoVisibilityModel !== "string" || !raw.geoVisibilityModel.trim()) {
    errors.push("geoVisibilityModel: expected the scoring-model label string");
  }
  if (!isPlainObject(raw.citationSummary)) {
    errors.push("citationSummary: expected an object");
  }

  // Carried through verbatim — never invented. An absent stamp stays absent, and
  // the panel's legacy banner renders. That is the honest reading of a capture
  // whose pipeline version we cannot confirm.
  if (raw.pipelineVersion !== undefined && typeof raw.pipelineVersion !== "string") {
    errors.push("pipelineVersion: expected a string when present");
  }
  if (raw.pipelineVersion === undefined) {
    warnings.push(
      "No pipelineVersion — this snapshot will render with the legacy banner, as an unstamped capture should.",
    );
  }

  if (raw.updatedAt !== undefined && !isFiniteNumber(raw.updatedAt)) {
    errors.push("updatedAt: expected a finite number when present");
  }

  if (errors.length) return { ok: false, errors };

  const captured = raw.capturedAt as number;
  const ageDays = Math.floor((now - captured) / 86_400_000);
  if (ageDays >= 45) {
    warnings.push(
      `Capture is ${ageDays} days old — it will import as a ${ageDays}-day-old snapshot and show the staleness notice.`,
    );
  }

  // Rebuild rather than spread: only validated keys reach Firestore, and the
  // portal-owned fields are dropped so the data layer can recompute them
  // (visibilityHistory) or preserve them from the stored doc (approvedRecIds).
  const insights: SeoGeoInsights = {
    clientId: ctx.clientId,
    capturedAt: captured,
    ...(typeof raw.pipelineVersion === "string" ? { pipelineVersion: raw.pipelineVersion } : {}),
    ...(typeof raw.methodologyVersion === "string"
      ? { methodologyVersion: raw.methodologyVersion }
      : {}),
    seoScore: raw.seoScore as number,
    seoDataCoveragePct: raw.seoDataCoveragePct as number,
    geoReadiness: raw.geoReadiness as number,
    geoReadinessCoveragePct: raw.geoReadinessCoveragePct as number,
    geoVisibilityIndex: raw.geoVisibilityIndex as number,
    geoVisibilityCoveragePct: raw.geoVisibilityCoveragePct as number,
    geoVisibilityModel: raw.geoVisibilityModel as string,
    geoVisibilityEnginesMeasured: raw.geoVisibilityEnginesMeasured as number,
    geoVisibilityEnginesScored: raw.geoVisibilityEnginesScored as number,
    geoVisibilityEnginesTotal: raw.geoVisibilityEnginesTotal as number,
    rosterSharePct: raw.rosterSharePct as number,
    categoryPresence: raw.categoryPresence as SeoGeoInsights["categoryPresence"],
    brandPresence: raw.brandPresence as SeoGeoInsights["brandPresence"],
    perEngine: raw.perEngine as SeoGeoInsights["perEngine"],
    gaps: raw.gaps as SeoGeoInsights["gaps"],
    recommendations: raw.recommendations as SeoGeoInsights["recommendations"],
    seoChecks: raw.seoChecks as SeoGeoInsights["seoChecks"],
    geoChecks: raw.geoChecks as SeoGeoInsights["geoChecks"],
    promptSet: raw.promptSet as string[],
    intentPrompts: raw.intentPrompts as SeoGeoInsights["intentPrompts"],
    answerGrid: raw.answerGrid as SeoGeoInsights["answerGrid"],
    citationLeaderboard: raw.citationLeaderboard as SeoGeoInsights["citationLeaderboard"],
    citationSummary: raw.citationSummary as SeoGeoInsights["citationSummary"],
    competitorsNamed: raw.competitorsNamed as SeoGeoInsights["competitorsNamed"],
    ...(Array.isArray(raw.discoveredBrands)
      ? { discoveredBrands: raw.discoveredBrands as SeoGeoInsights["discoveredBrands"] }
      : {}),
    roster: raw.roster as string[],
    updatedAt: now,
    importedFrom: {
      source: "local-import",
      importedAt: now,
      ...(ctx.importedBy ? { importedBy: ctx.importedBy } : {}),
      ...(ctx.file ? { file: ctx.file } : {}),
    },
  };

  return { ok: true, insights, warnings };
}

/**
 * One-line provenance for the staff Ops Import page. Staff-only by placement:
 * the portal's SEO/GEO panel is shared with clients, and "imported by hand" is
 * an operations detail, not a client-facing caveat about the numbers.
 */
export function describeProvenance(insights: SeoGeoInsights | null): string {
  if (!insights) return "No snapshot stored yet.";
  const captured = new Date(insights.capturedAt).toISOString().slice(0, 10);
  if (!insights.importedFrom) return `Machine capture, measured ${captured}.`;
  const on = new Date(insights.importedFrom.importedAt).toISOString().slice(0, 10);
  const by = insights.importedFrom.importedBy ? ` by ${insights.importedFrom.importedBy}` : "";
  return `Imported ${on}${by} — measured ${captured}.`;
}
