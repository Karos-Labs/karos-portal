/**
 * Usage and error log types, plus the Anthropic pricing matrix.
 * Kept separate from types.ts so this file can be imported in server-only
 * service modules without pulling in all domain types.
 */

/* ── Log records ─────────────────────────────────────────────────── */

/** Model vendor behind a call. Drives which pricing table row applies. */
export type ProviderId = "anthropic" | "openai" | "google";

export interface UsageLog {
  id: string;
  clientId: string | null;
  agentId: string | null;
  agentName: string;
  /** Coarse billing family. Derived from `vendor` (or, for legacy rows, `modelName`) when not supplied. */
  provider: ProviderId;
  /**
   * The vendor that actually SERVED the call — `ResolvedAi.vendor`. Together
   * with `modelName` this is the pair pricing is keyed on (AU70/SCRUM-370).
   * Optional because rows written before 2026-08 do not carry it; every row
   * written by `logUsage` since does.
   */
  vendor?: PricingVendor;
  /**
   * The RESOLVED model id the request carried — `ResolvedAi.modelId`, not a
   * `MODELS.*` tier constant. On Vertex the two differ, and logging the
   * constant is what billed Vertex inference at first-party rates.
   */
  modelName: string;
  /**
   * The feature/surface that triggered the run — the analytics `featureContext`.
   * e.g. "intel_report" | "intel_research" | "seo_audit" | "geo_capture" |
   * "chat_copilot" | "branding_extraction" | "competitor_analysis" | "task_execution".
   */
  operation: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Anthropic server-side web_search invocations billed on top of tokens
   * (web_fetch is included, no per-call charge). 0 for providers/calls without it.
   */
  webSearchCount?: number;
  estimatedCostUsd: number;
  jobId?: string | null;
  /** Dynamic Agent Studio only — which step of `jobId`'s run this row's tokens belong to. Absent on every non-step-level row (the run-level rows this codebase has always written, and every other operation). */
  stepId?: string;
  durationMs?: number;
  timestamp: number;
  /**
   * Omitted/undefined on historic docs is treated as "success" everywhere
   * this is read. "cancelled" is kept distinct from "failed" (mirroring
   * `JobStatus`'s own split) so a deliberate Force Cancel doesn't inflate the
   * Agent Leaderboard's failure count the way a genuine breakage should —
   * both still count toward totalCostUsd/totalRuns (the spend is real
   * either way), only the failedRuns/failedCostUsd reliability signal cares
   * about the distinction.
   */
  status?: "success" | "failed" | "cancelled";
  /** Set when status is "failed"/"cancelled" — the thrown error or upstream failure/cancellation reason. */
  errorMessage?: string;
  /**
   * True when `priceFor()` refused this row's `(vendor, modelName)` pair and
   * `estimatedCostUsd` was written as 0 rather than a real price — see
   * `logUsage`'s catch branch. AU70/SCRUM-370 removed the flat `_default`
   * pricing row specifically so an unpriced pair could no longer be quietly
   * substituted with Sonnet's rate; the tradeoff is that some callers outside
   * `aiFor`/`usageFor` — the agent-service webhook and reconcile-job, whose
   * `modelName` comes from an external payload or an admin-typed
   * `stepModels` override, never from `ResolvedAi` — can hit an unpriced pair
   * too. Without this flag that row would look like a genuinely free run
   * everywhere the row is read; with it, a dashboard or query can tell "we
   * do not know the price" apart from "this cost nothing" instead of the two
   * being silently indistinguishable. Absent/false on every other row.
   */
  pricingUnresolved?: boolean;
}

export interface ErrorLog {
  id: string;
  clientId: string | null;
  agentId: string | null;
  operation: string;
  errorMessage: string;
  stackTrace?: string;
  severity: "WARN" | "ERROR" | "FATAL";
  timestamp: number;
}

/**
 * Pre-computed running totals maintained by the logger via FieldValue.increment().
 * Document IDs: "global" or "client_{clientId}".
 * Per-model fields are flattened: model_{sanitizedName}_{metric}.
 * This gives O(1) reads for the admin dashboard KPIs.
 */
export interface AnalyticsSnapshot {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRuns: number;
  totalErrors: number;
  /** Overlay on the totals above — spend/runs already counted in totalCostUsd/totalRuns that failed. */
  failedRuns?: number;
  failedCostUsd?: number;
  lastUpdated: number;
  [key: string]: number | undefined; // model_* flattened fields
}

/* ── Pricing matrix ──────────────────────────────────────────────── */
/**
 * Per-token pricing (USD per 1 million tokens), keyed on the PAIR
 * `(vendor, resolved model id)` — never on a tier constant.
 *
 * ── Why the pair, and why there is no `_default` row (AU70 / SCRUM-370) ──────
 * Until 2026-08 this was a flat `Record<modelName, price>` ending in
 * `_default: { 3.00, 15.00 }`, and `computeCostUsd` did
 * `MODEL_PRICING[modelName] ?? MODEL_PRICING._default`. That lookup could not
 * fail. Two consequences, both silent:
 *
 *   1. Call sites log a TIER CONSTANT (`MODELS.SONNET`), not the id the request
 *      actually carried. On first-party Anthropic the two strings agree, so the
 *      bug is invisible. With `AI_VENDOR=vertex` they diverge — `MODELS.HAIKU`
 *      is `claude-haiku-4-5-20251001` while Vertex served
 *      `claude-haiku-4-5@20251001` — and the flat lookup still RESOLVED, on the
 *      constant, billing Vertex inference at first-party rates.
 *   2. `claude-haiku-4-5@20251001` was not a key at all, so any site that did
 *      pass the resolved id fell to `_default` and was costed at Sonnet's
 *      $3.00/$15.00 instead of Haiku's $0.80/$4.00 — a 3.75x overstatement.
 *
 * Keying on the pair makes both of those a THROW (`PricingLookupError`) rather
 * than a plausible number. `("vertex", "claude-haiku-4-5-20251001")` is an
 * inconsistent pair and is refused by name; the correct pair prices correctly.
 * `priceFor` is therefore a check that can fail, and
 * `__tests__/pricing-vendor-pair.test.ts` watches it fail.
 *
 * Sonnet is spelled identically on both vendors. That is a coincidence of
 * Google's id scheme, not a design property, so it is written out per vendor
 * here rather than shared.
 */
export interface ModelPrice {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
}

/** The vendor that SERVED a call — the routing fact `ResolvedAi.vendor` carries. */
export type PricingVendor = "anthropic" | "vertex" | "openai" | "google";

export const PRICING_VENDORS: readonly PricingVendor[] = ["anthropic", "vertex", "openai", "google"];

export const MODEL_PRICING_BY_VENDOR: Readonly<
  Record<PricingVendor, Readonly<Record<string, ModelPrice>>>
> = {
  // Anthropic first-party (Claude). Dated snapshots use a `-` separator.
  anthropic: {
    "claude-opus-4-8":            { inputPer1M: 15.00, outputPer1M: 75.00 },
    "claude-opus-4-7":            { inputPer1M: 15.00, outputPer1M: 75.00 },
    "claude-sonnet-4-6":          { inputPer1M: 3.00,  outputPer1M: 15.00 },
    "claude-haiku-4-5-20251001":  { inputPer1M: 0.80,  outputPer1M: 4.00  },
    "claude-3-5-sonnet-20241022": { inputPer1M: 3.00,  outputPer1M: 15.00 },
    "claude-3-opus-20240229":     { inputPer1M: 15.00, outputPer1M: 75.00 },
    "claude-3-haiku-20240307":    { inputPer1M: 0.25,  outputPer1M: 1.25  },
  },
  // Claude on Vertex. Same list price today, DIFFERENT ids: dated snapshots are
  // addressed with `@`. See src/lib/ai/provider.ts's MODEL_IDS — the two tables
  // are cross-checked by test, so adding a tier there without pricing it here
  // fails rather than falling back.
  vertex: {
    "claude-sonnet-4-6":          { inputPer1M: 3.00,  outputPer1M: 15.00 },
    "claude-haiku-4-5@20251001":  { inputPer1M: 0.80,  outputPer1M: 4.00  },
    // Dateless spelling. Cross-referenced against agent-engine's own
    // MODEL_PRICING (packages/core/src/telemetry/pricing.ts): "the spelling
    // Agent Platform uses verbatim for the 4.6-and-later generation (where a
    // dateless id is itself a pinned snapshot, not a moving pointer)". Real
    // traffic can carry this id — it is also the literal example
    // (`"claude-haiku-4-5"`) given for an admin-typed `stepModels` override in
    // docs/one-pagers/x-agent-v2-integration-contract.md — so it is priced
    // here rather than left to fall through to `pricingUnresolved`.
    "claude-haiku-4-5":           { inputPer1M: 0.80,  outputPer1M: 4.00  },
  },
  // OpenAI (SEO/GEO "chatgpt" engine)
  openai: {
    "gpt-4o-mini":                { inputPer1M: 0.15,  outputPer1M: 0.60  },
    "gpt-4o":                     { inputPer1M: 2.50,  outputPer1M: 10.00 },
  },
  // Google (SEO/GEO "gemini" engine)
  google: {
    "gemini-2.5-flash":           { inputPer1M: 0.30,  outputPer1M: 2.50  },
    "gemini-2.5-pro":             { inputPer1M: 1.25,  outputPer1M: 10.00 },
  },
};

/**
 * Flattened id -> price view, for DISPLAY of historic aggregates only
 * (`data-analytics.ts` renders a rate column next to already-stored spend).
 * Never use this to price a call: it has no vendor, which is the whole point of
 * AU70. It also has no `_default` — a miss is a miss.
 *
 * Built rather than written so it cannot drift, and it REFUSES to build if two
 * vendors price the same id differently: that would make the flat view a lie,
 * and a display that quietly picks one is the defect this file just removed.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = (() => {
  const flat: Record<string, ModelPrice> = {};
  for (const vendor of PRICING_VENDORS) {
    for (const [id, price] of Object.entries(MODEL_PRICING_BY_VENDOR[vendor])) {
      const seen = flat[id];
      if (seen && (seen.inputPer1M !== price.inputPer1M || seen.outputPer1M !== price.outputPer1M)) {
        throw new Error(
          `MODEL_PRICING: "${id}" is priced differently by more than one vendor ` +
            `(${seen.inputPer1M}/${seen.outputPer1M} vs ${price.inputPer1M}/${price.outputPer1M}). ` +
            `The flat view cannot represent that — price on the pair via priceFor().`,
        );
      }
      flat[id] = price;
    }
  }
  return Object.freeze(flat);
})();

/**
 * Anthropic server-side web_search pricing: $10 per 1,000 searches → $0.01 each.
 * web_fetch carries no per-call charge (only the tokens it feeds into context).
 */
export const WEB_SEARCH_COST_PER_CALL = 10 / 1_000;

/**
 * Thrown when `(vendor, modelId)` does not name a priced model.
 *
 * Always a wiring/logging mistake, never a runtime condition: either a call site
 * logged a tier constant instead of the resolved id, or a new model id was added
 * to `provider.ts` without a price. Both are fixed in source, so this is loud on
 * purpose.
 */
export class PricingLookupError extends Error {
  constructor(
    readonly vendor: string,
    readonly modelId: string,
    message: string,
  ) {
    super(message);
    this.name = "PricingLookupError";
  }
}

/** Which vendors, if any, price this id. Used to make the refusal message say WHY. */
export function vendorsPricing(modelId: string): PricingVendor[] {
  return PRICING_VENDORS.filter((v) => modelId in MODEL_PRICING_BY_VENDOR[v]);
}

/**
 * THE LOOKUP THAT CAN FAIL. Price a call by the pair that actually served it.
 *
 * Throws `PricingLookupError` when the pair is unknown, and says which vendor
 * (if any) does price that id — because the overwhelmingly likely cause is a
 * call site logging `MODELS.HAIKU` while the request went to Vertex.
 */
export function priceFor(vendor: PricingVendor, modelId: string): ModelPrice {
  const table = MODEL_PRICING_BY_VENDOR[vendor];
  if (!table) {
    throw new PricingLookupError(vendor, modelId, `Unknown pricing vendor "${vendor}".`);
  }
  const price = table[modelId];
  if (price) return price;

  const elsewhere = vendorsPricing(modelId);
  throw new PricingLookupError(
    vendor,
    modelId,
    elsewhere.length > 0
      ? `Model id "${modelId}" is not a "${vendor}" id — it is priced only under ` +
        `${elsewhere.map((v) => `"${v}"`).join(", ")}. This is the AU70 shape: a call ` +
        `site logged a tier constant instead of the id "${vendor}" actually served. ` +
        `Log ResolvedAi.modelId and ResolvedAi.vendor together.`
      : `No price for model id "${modelId}" under vendor "${vendor}". Add it to ` +
        `MODEL_PRICING_BY_VENDOR.${vendor} — there is deliberately no default row, ` +
        `because a default is how Vertex inference got billed at first-party rates.`,
  );
}

/**
 * Cost of one call, priced on `(vendor, modelId)`.
 *
 * THROWS on an unpriced pair. Callers on the generation path must not let that
 * reach the user — `services/logger.ts` catches it, records the row at cost 0
 * and emits a structured ERROR naming the pair. Zero-with-an-error is visibly
 * wrong; a Sonnet-rate number is silently wrong, and that is the whole ticket.
 */
export function computeCostUsd(
  vendor: PricingVendor,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  webSearchCount = 0,
): number {
  const p = priceFor(vendor, modelId);
  const raw =
    (inputTokens * p.inputPer1M + outputTokens * p.outputPer1M) / 1_000_000 +
    webSearchCount * WEB_SEARCH_COST_PER_CALL;
  return Math.round(raw * 1_000_000) / 1_000_000; // 6 decimal precision
}

/**
 * Rate to SHOW beside an already-stored historic aggregate. `null` when the id
 * is not priced — the caller renders that as unknown. It must never substitute
 * Sonnet's rate: three copies of `?? { inputPer1M: 3.0, outputPer1M: 15.0 }` in
 * data-analytics.ts did exactly that, printing a confident wrong rate.
 */
export function displayRateFor(modelName: string): ModelPrice | null {
  return MODEL_PRICING[modelName] ?? null;
}

/** Infer the coarse billing family from a model id. Used for `UsageLog.provider`. */
export function providerForModel(modelName: string): ProviderId {
  if (modelName.startsWith("gpt-") || modelName.startsWith("o1") || modelName.startsWith("o3")) return "openai";
  if (modelName.startsWith("gemini")) return "google";
  return "anthropic";
}

/**
 * The billing family a serving vendor belongs to. Claude on Vertex is invoiced
 * by Google, not by Anthropic — `providerForModel` cannot know that from the id
 * alone (it sees `claude-…` and says "anthropic"), which is why the vendor is
 * now carried explicitly.
 */
export function providerForVendor(vendor: PricingVendor): ProviderId {
  return vendor === "vertex" ? "google" : vendor;
}

/**
 * Sanitize a model id for use as a Firestore field key segment (no dots or dashes).
 *
 * VENDOR-QUALIFIED for Vertex, because `-` and `@` sanitize to the same `_`:
 * `claude-haiku-4-5-20251001` and `claude-haiku-4-5@20251001` both collapse to
 * `claude_haiku_4_5_20251001`, which would silently merge first-party and Vertex
 * spend into one snapshot series. Anthropic/OpenAI/Google keep today's spelling
 * so the existing `model_*` fields keep accumulating unbroken.
 */
export function sanitizeModelKey(modelName: string, vendor: PricingVendor = "anthropic"): string {
  const base = modelName.replace(/[^a-zA-Z0-9]/g, "_");
  return vendor === "vertex" ? `vertex_${base}` : base;
}

/** Reverse-map a sanitized key back to the closest known model id. */
export function resolveModelName(sanitizedKey: string): string {
  for (const vendor of PRICING_VENDORS) {
    for (const id of Object.keys(MODEL_PRICING_BY_VENDOR[vendor])) {
      if (sanitizeModelKey(id, vendor) === sanitizedKey) return id;
    }
  }
  return sanitizedKey.replace(/^vertex_/, "").replace(/_/g, "-");
}
