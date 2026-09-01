import "server-only";

import { aiFor, modelIdFor, type ResolvedAi } from "@/lib/ai/provider";
import type { Vendor } from "@/lib/ai/capabilities";

/**
 * SCRUM-387 — model routing for the portal-side context-document generation
 * step.
 *
 * ── Where the model call actually is (read this before touching anything) ──
 * `composeContextDocsFromAgentReports` (`agent-onboarding.ts`) — the function
 * SCRUM-387's own brief names as "the 13 context documents, produced
 * portal-side" — makes NO model call. It is pure string-templating over
 * fields already present on the two agent-engine deliverables (`intel-report`,
 * `seo-geo-report`); see that file's own header comment and this ticket's
 * report for the full trace. The real per-document model call in THIS
 * pipeline is one step later: `condenseOne` in `condense.ts`, which turns
 * each internal-tier document this module's caller produced into its
 * client-facing (~50%) condensation — one `streamText` call per document,
 * every onboarding run (`runAgentOnboarding` -> `deps.condense` ->
 * `condenseDocs`) and every monthly refresh (`refreshClientCondensedDocs`).
 * That is the step this module routes.
 *
 * ── What this is, and what it deliberately is not ──────────────────────────
 * Two different questions, same split agent-engine's own
 * `context-document-routing.ts` (ref-clone
 * `packages/core/src/router/context-document-routing.ts`, SCRUM-380/D1-v2)
 * already draws for its own, DIFFERENT call site (the Intel Report agent's
 * own draft generation) — cited here rather than re-derived, because two
 * independently-invented answers to the same question is how a heuristic like
 * this drifts:
 *
 *   - "the call I just made FAILED, what now?" — a transport question,
 *     answered by `routeContextDocCondensation`'s baseline branch trying
 *     Vertex then Anthropic, below.
 *   - "how hard is the document I am about to send?" — a model-selection
 *     question, answered by `assessContextDocComplexity` and the two
 *     escalation branches below.
 *
 * Both can be true at once and neither knows about the other.
 *
 * ── Why this is not a literal import of agent-engine's module ──────────────
 * `karos-portal`'s `package.json` has no dependency on any agent-engine
 * package (verified directly — no `@agent-engine/*` or `@karos/*` entry), and
 * the two repos are not linked by a workspace or submodule: agent-engine's
 * `context-document-routing.ts` is core-router code (`ModelPolicy`,
 * `ModelRouter` adapters) built for a completely different call shape than
 * this repo's Vercel AI SDK `streamText` / provider-resolution seam. There is no package
 * boundary to import through without inventing a new cross-repo dependency
 * (which this ticket's exec context says to flag loudly, not add quietly).
 * What IS reused, deliberately, to keep the two heuristics from diverging: the
 * same `CHARS_PER_TOKEN` estimate, the same two-branch decision order (fit,
 * then complexity), the same `CONTEXT_SAFETY_FRACTION`, and the same two named
 * escalation models (`claude-opus-4-8`, `gemini-2.5-pro`) — all cited at each
 * constant below, not re-derived from taste.
 */

/**
 * Estimated JSON/prose chars per token. Identical to agent-engine's
 * `context-document-routing.ts` `CHARS_PER_TOKEN` on purpose, so the two
 * independently-run estimates cannot drift into disagreeing about the same
 * class of prompt.
 */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Everything this module measures, named — the two things `condenseOne`
 * already has in hand before its first model call, and nothing invented to
 * fill out a bigger signal set. This call site has no competitor count, no
 * steer count, no revision round (those are Intel-Report-generation concepts,
 * not condensation ones) — the honest thing is to score what is actually
 * available here, not to borrow fields from a different step's shape.
 */
export interface ContextDocComplexitySignals {
  /**
   * `## ` headings in the INTERNAL document being condensed. Each one is a
   * section the condensation prompt's own contract already requires the
   * model to preserve while roughly halving the length ("COMPLETE ALL
   * SECTIONS — every section heading from the internal doc must appear in
   * the output. Never skip or drop a section.", `condense.ts`'s
   * `userMessage`) — more sections is not "more text to shrink", it is more
   * independent constraints to satisfy in the same pass, the same
   * "constraints compose worse than they add" argument agent-engine's
   * `steerCount` signal makes, applied to the one per-document structural
   * signal this call site actually has.
   */
  readonly sectionCount: number;
  /**
   * Characters of the internal document itself. Volume, not quality — a long
   * document is harder to condense faithfully whether or not any one part of
   * it is hard to read, exactly the argument agent-engine's `evidenceChars`
   * makes for its own (much larger) input.
   */
  readonly contentChars: number;
}

/**
 * Sections a routine internal document carries before the section COUNT
 * itself is the hard part — most of `composeContextDocsFromAgentReports`'s
 * eight document types render 2-4 sections when their source fields are
 * populated (see that function). Below this, extra structure is not what
 * makes condensing an instance difficult.
 */
const BASELINE_SECTIONS = 2;
const SECTION_WEIGHT = 1;
/**
 * One complexity point per this many estimated tokens of internal-document
 * content. A composed internal document is typically a few thousand words —
 * far smaller than the raw research evidence agent-engine's own
 * `evidenceChars` signal measures — so this is calibrated to that smaller
 * scale, not copied from agent-engine's 25,000-tokens-per-point figure (which
 * would never fire for anything this call site actually produces).
 */
const EVIDENCE_TOKENS_PER_POINT = 2_000;
const EVIDENCE_WEIGHT = 1;

/**
 * The one threshold, stateable in a sentence: an instance is `high` once its
 * measured inputs are worth about four extra sections of condensation work —
 * reachable by section count alone (6 sections: 4 above the 2-section
 * baseline), by content volume alone (~8,000 estimated tokens, ~28,000
 * chars), or by a smaller mix of both. Calibrated locally against this call
 * site's own typical document sizes, not tuned against any historical run.
 */
export const HIGH_COMPLEXITY_THRESHOLD = 4;

export type DocumentComplexityTier = "standard" | "high";

export interface ContextDocComplexity {
  readonly tier: DocumentComplexityTier;
  /** The weighted score itself, so a caller can log the number, not just the bucket. */
  readonly score: number;
  /** Estimated prompt tokens the internal document alone contributes. */
  readonly estimatedPromptTokens: number;
  /** Human-readable contributions, in the order they were added — for logs and test assertions. */
  readonly reasons: readonly string[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Scores one document. Pure, total, side-effect free: same signals in, same
 * tier out. Negative or non-finite inputs are clamped rather than thrown on —
 * this function's failure mode must never be "condensation dies before it
 * starts"; a caller that hands it a bad length should get a `standard`
 * document, not a crash.
 */
export function assessContextDocComplexity(
  signals: ContextDocComplexitySignals,
): ContextDocComplexity {
  const clamp = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

  const sectionCount = clamp(signals.sectionCount);
  const chars = clamp(signals.contentChars);
  const estimatedPromptTokens = Math.round(chars / CHARS_PER_TOKEN);
  const reasons: string[] = [];

  const sectionPoints = SECTION_WEIGHT * Math.max(0, sectionCount - BASELINE_SECTIONS);
  if (sectionPoints > 0) {
    reasons.push(`${sectionCount} sections (${BASELINE_SECTIONS} baseline) -> +${round2(sectionPoints)}`);
  }

  const evidencePoints = EVIDENCE_WEIGHT * (estimatedPromptTokens / EVIDENCE_TOKENS_PER_POINT);
  if (evidencePoints > 0) {
    reasons.push(`~${estimatedPromptTokens} estimated prompt tokens of internal document -> +${round2(evidencePoints)}`);
  }

  const score = round2(sectionPoints + evidencePoints);
  return {
    tier: score >= HIGH_COMPLEXITY_THRESHOLD ? "high" : "standard",
    score,
    estimatedPromptTokens,
    reasons,
  };
}

/** Derives the two measured signals directly off the internal document text. */
export function complexitySignalsForDocument(internalContent: string): ContextDocComplexitySignals {
  const sectionCount = (internalContent.match(/^## .+/gm) ?? []).length;
  return { sectionCount, contentChars: internalContent.length };
}

/**
 * How much of the base model's context window this is willing to plan to
 * fill before treating the document as one that does not fit. Identical to
 * agent-engine's `CONTEXT_SAFETY_FRACTION` — reserves headroom for the parts
 * of the prompt this estimate does not see (the condensation rules block,
 * the frontmatter instructions, the retry's appended CRITICAL line).
 */
const CONTEXT_SAFETY_FRACTION = 0.8;

/**
 * This repo has no model-capability catalog (unlike agent-engine's
 * `model-capabilities.ts`), so this is a locally-named constant rather than a
 * table lookup — but not a guess: both `claude-sonnet-4-6` and
 * `claude-opus-4-8` are catalogued at exactly this figure in agent-engine's
 * own verified `MODEL_CAPABILITIES` (ref-clone
 * `packages/core/src/router/model-capabilities.ts`), a cited fact.
 */
const CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * The premium same-vendor escalation for a `high`-tier document that still
 * fits the base model's window. Anthropic ONLY, deliberately: agent-engine's
 * own `MODEL_CAPABILITIES` catalog has no Vertex row for this id (`vendor:
 * "anthropic"` only), and this repo's own pricing table already prices it
 * the same way (`MODEL_PRICING_BY_VENDOR.anthropic["claude-opus-4-8"]`,
 * `src/lib/models/usage-log.ts`) — so there is no verified Vertex hop to
 * attempt for this model, and this module does not invent one. That pricing
 * row already existing, unused by any `MODEL_IDS` entry before this ticket,
 * is itself evidence this is the intended escalation target, not a guess.
 */
export const HIGH_COMPLEXITY_MODEL = "claude-opus-4-8";

/**
 * The large-context escalation, used only when the document (plus the
 * condensation's own reserved output) would not fit the base model's window.
 * `gemini-2.5-pro` is agent-engine's own verified 1,000,000-token-window
 * choice for exactly this situation, and is already priced under
 * `MODEL_PRICING_BY_VENDOR.google` here (same file) — reused, not
 * re-derived. Unlike `gemini-2.5-flash` (verified live against this portal's
 * own Vertex project per `chat-models.ts`'s `DEFAULT_CHAT_MODEL_KEY` note),
 * `-pro` has not been separately fired against this deployment; it is the
 * same model family on the same Vertex project/credentials, but that is an
 * inference, not a live-fire verification, and this module's docs say so
 * rather than implying it was checked.
 */
export const LARGE_CONTEXT_MODEL = "gemini-2.5-pro";

/** One candidate model resolution, in the order `routeContextDocCondensation` wants it tried. */
export interface CondensationModelAttempt {
  readonly vendor: Vendor;
  /** For logging/rationale only — the actual binding happens in `resolve()`. */
  readonly modelId: string;
  readonly resolve: () => ResolvedAi;
}

export interface ContextDocCondensationRoute {
  readonly complexity: ContextDocComplexity;
  /** Why this route, in one line — safe to log verbatim. */
  readonly rationale: string;
  /** True when the route escalated off the plain Sonnet baseline. */
  readonly escalated: boolean;
  /** Candidates to try, in order. The caller stops at the first that succeeds. */
  readonly attempts: readonly CondensationModelAttempt[];
}

/**
 * The whole decision for one document, in one call: score it, then pick a
 * route. Checked in the same order as agent-engine's own module, for the
 * same reason stated there — FIT is a capability question (no amount of
 * reasoning quality helps a call that fails on length), HARD is a quality
 * question, and a document that fits and is not hard gets the plain baseline,
 * completely unescalated.
 *
 * The baseline itself is where this ticket's Vertex-primary/Anthropic-fallback
 * criterion lives: `routeContextDocCondensation` always returns BOTH vendors
 * for a standard-tier document, Vertex first — a real runtime attempt order
 * the caller tries in sequence, not a static `AI_VENDOR` config pin (that
 * still governs every other role in `roles.ts`'s manifest; this one call site
 * needs its own explicit routing per this ticket). This is deliberately not
 * theoretical: AU73/SCRUM-375 measured 88-100% of production spend on two
 * verification runs served by agent-engine's OWN Anthropic-fallback hop, not
 * Vertex — the fallback branch below is written and tested as the commonly-hit
 * path, not a rare escape valve.
 */
export function routeContextDocCondensation(
  docType: string,
  internalContent: string,
  options: { maxOutputTokens?: number } = {},
): ContextDocCondensationRoute {
  const complexity = assessContextDocComplexity(complexitySignalsForDocument(internalContent));
  const maxOutputTokens = Number.isFinite(options.maxOutputTokens) ? Math.max(0, options.maxOutputTokens!) : 0;
  const usableWindow = Math.floor(CLAUDE_CONTEXT_WINDOW_TOKENS * CONTEXT_SAFETY_FRACTION);
  const needed = complexity.estimatedPromptTokens + maxOutputTokens;

  if (needed > usableWindow) {
    const rationale =
      `"${docType}": ~${needed} tokens needed (input + ${maxOutputTokens} reserved output) exceeds ` +
      `${usableWindow} usable of Claude's ${CLAUDE_CONTEXT_WINDOW_TOKENS}-token window — routed to ` +
      `"${LARGE_CONTEXT_MODEL}" (1,000,000-token window, vendor "google")`;
    return {
      complexity,
      rationale,
      escalated: true,
      attempts: [
        {
          vendor: "google",
          modelId: LARGE_CONTEXT_MODEL,
          resolve: () =>
            aiFor("intel.condense.context_overflow", { vendor: "google", modelId: LARGE_CONTEXT_MODEL }),
        },
      ],
    };
  }

  if (complexity.tier === "high") {
    const rationale =
      `"${docType}": complexity ${complexity.score} >= ${HIGH_COMPLEXITY_THRESHOLD} ` +
      `(${complexity.reasons.join("; ")}) — routed to "${HIGH_COMPLEXITY_MODEL}" (anthropic only)`;
    return {
      complexity,
      rationale,
      escalated: true,
      attempts: [
        {
          vendor: "anthropic",
          modelId: HIGH_COMPLEXITY_MODEL,
          resolve: () =>
            aiFor("intel.condense.complexity_escalation", { vendor: "anthropic", modelId: HIGH_COMPLEXITY_MODEL }),
        },
      ],
    };
  }

  const baseVendors: readonly Vendor[] = ["vertex", "anthropic"];
  const rationale =
    `"${docType}": complexity ${complexity.score} < ${HIGH_COMPLEXITY_THRESHOLD} — ` +
    `Vertex-primary, Anthropic-fallback on "${modelIdFor("intel.condense", "anthropic") ?? "?"}"`;
  return {
    complexity,
    rationale,
    escalated: false,
    attempts: baseVendors.map((vendor) => ({
      vendor,
      modelId: modelIdFor("intel.condense", vendor) ?? "unknown",
      resolve: () => aiFor("intel.condense", { vendor }),
    })),
  };
}
