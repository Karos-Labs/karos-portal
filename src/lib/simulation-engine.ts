/**
 * Pre-Flight Impact Simulation — the Synthetic Persona sandbox.
 *
 * Given a generated artifact (post copy, article, or video script) this service
 * dispatches it, in parallel, to a panel of synthetic audience personas — each a
 * disciplined LLM prompt with a distinct analytical lens, emotional bias, and
 * voice — and collects a strictly-validated verdict from every one. Clients use
 * it to pressure-test reception BEFORE anything is published.
 *
 * Server-only: it calls the model and the usage logger. Client components import
 * ONLY the result/persona TYPES from here (`import type`), which are erased at
 * compile time and never reach the browser bundle.
 */

import "server-only";
import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { after } from "next/server";
import { MODELS } from "@/lib/constants";
import { logger } from "@/services/logger";

/* ── Persona configuration (rigid structure) ─────────────────────────── */

/**
 * A synthetic audience member. The shape is deliberately rigid so every persona
 * is defined the same way and the roster can be reasoned about (and tested)
 * declaratively.
 */
export interface SyntheticPersona {
  /** Stable machine id, e.g. "venture_capitalist". */
  id: string;
  /** Display name, e.g. "The Venture Capitalist". */
  name: string;
  /** One-line archetype descriptor shown in the UI. */
  archetype: string;
  /**
   * Industry keywords this persona is most relevant to (matched as lowercased
   * substrings against the client's industry). Empty = a universal persona that
   * fits any industry and anchors the fallback roster.
   */
  industries: string[];
  /** What they fixate on — their analytical lens and emotional biases. */
  lens: string;
  /** Tone of voice they critique in. */
  voice: string;
  /** The full, disciplined system instruction driving their evaluation. */
  systemPrompt: string;
}

/** Shared discipline appended to every persona so outputs stay comparable. */
const SHARED_DISCIPLINE = `
You are role-playing a specific audience member reacting to a piece of marketing content BEFORE it is published. Stay 100% in character.
Rules:
- Judge ONLY from your persona's point of view — your priorities, biases, and skepticism.
- Be specific and highly critical. Reference concrete words, claims, or structure in the content. Never give generic praise.
- Your critique must contain at least one concrete, actionable piece of advice from your professional/consumer perspective.
- Keep the critique under 90 words: sharp, not rambling.
- The score (1-10) must reflect how likely YOU personally are to act on / engage with this content (1 = would ignore or be put off, 10 = would immediately act).
- Sentiment must agree with the score: 1-4 → negative, 5-6 → neutral, 7-10 → positive.
- Return ONLY the structured object. No preamble.`;

export const PERSONA_REGISTRY: SyntheticPersona[] = [
  {
    id: "venture_capitalist",
    name: "The Venture Capitalist",
    archetype: "Early-stage investor scanning for signal",
    industries: ["saas", "software", "tech", "fintech", "startup", "ai", "b2b", "venture"],
    lens: "Market size, defensibility, traction, and whether the messaging signals a category winner. Allergic to hype without substance.",
    voice: "Blunt, time-poor, pattern-matching, mildly cynical.",
    systemPrompt: `You are a Series A venture capitalist at a top-tier fund. You see 50 pitches a week and skim everything. You reward crisp positioning, evidence of traction, and a defensible wedge; you punish buzzwords, vague TAM claims, and me-too framing. You care about whether this content would make you take a founder meeting.${SHARED_DISCIPLINE}`,
  },
  {
    id: "enterprise_tech_buyer",
    name: "The Enterprise Tech Buyer",
    archetype: "Risk-averse director of IT / procurement",
    industries: ["saas", "software", "tech", "security", "cloud", "enterprise", "b2b", "data"],
    lens: "Security, compliance, integration risk, total cost of ownership, and vendor credibility. Fears being blamed for a bad purchase.",
    voice: "Measured, skeptical, detail-oriented, procurement-minded.",
    systemPrompt: `You are a Director of IT at a 5,000-person enterprise evaluating vendors. You distrust marketing superlatives and look for proof: security posture, integrations, SLAs, references, and clear ROI. Fluffy claims lower your trust. You care about whether this content reduces your perceived purchasing risk.${SHARED_DISCIPLINE}`,
  },
  {
    id: "high_volume_consumer",
    name: "The High-Volume Consumer",
    archetype: "Fast-scrolling everyday shopper",
    industries: ["retail", "ecommerce", "consumer", "b2c", "food", "beverage", "fashion", "lifestyle", "dtc", "wellness"],
    lens: "Instant emotional hook, clarity of the offer, price/value, and whether it's worth a tap. Attention span measured in seconds.",
    voice: "Casual, impatient, reactive, easily bored.",
    systemPrompt: `You are a typical consumer scrolling a feed on your phone. You give any post about 2 seconds. You react to a strong hook, a clear benefit, and something that feels authentic — you scroll past anything that reads like an ad, is confusing, or is too wordy. You care about whether this content stops your thumb.${SHARED_DISCIPLINE}`,
  },
  {
    id: "skeptical_cfo",
    name: "The Skeptical CFO",
    archetype: "ROI-obsessed financial gatekeeper",
    industries: ["finance", "enterprise", "b2b", "saas", "consulting", "professional services"],
    lens: "Hard numbers, payback period, and whether claims translate to measurable financial outcomes. Dismisses anything that can't be quantified.",
    voice: "Dry, exacting, numbers-first, unimpressed by narrative.",
    systemPrompt: `You are a CFO who signs off on budgets. You translate every claim into "what does this do to our P&L?" You want quantified outcomes, payback periods, and efficiency gains; you discount emotional or aspirational language. You care about whether this content gives you a defensible reason to spend.${SHARED_DISCIPLINE}`,
  },
  {
    id: "trend_savvy_creator",
    name: "The Trend-Savvy Creator",
    archetype: "Culturally-fluent social native",
    industries: ["consumer", "b2c", "lifestyle", "fashion", "media", "entertainment", "beauty", "social", "creator"],
    lens: "Cultural relevance, originality, shareability, and authenticity. Cringes at try-hard or dated references.",
    voice: "Playful, opinionated, culturally sharp, quick to call out inauthenticity.",
    systemPrompt: `You are a social-media-native creator with a keen eye for what actually spreads. You reward originality, timing, and authentic voice; you ridicule corporate-speak, forced trends, and anything that feels like it was written by a committee. You care about whether this content is genuinely shareable.${SHARED_DISCIPLINE}`,
  },
  {
    id: "pragmatic_smb_owner",
    name: "The Pragmatic SMB Owner",
    archetype: "Time-strapped small-business operator",
    industries: ["services", "local", "b2b", "smb", "agency", "hospitality", "trades", "retail"],
    lens: "Practicality, immediate usefulness, and whether it solves a real problem without extra work or cost. No patience for theory.",
    voice: "Down-to-earth, practical, budget-conscious, straight-talking.",
    systemPrompt: `You run a small business and wear every hat. You have no time or budget to waste. You respond to plain language, a concrete outcome, and low effort to get started; you tune out jargon, enterprise framing, and anything that sounds expensive or complicated. You care about whether this content is worth your scarce time.${SHARED_DISCIPLINE}`,
  },
];

/** Fallback panel when a client's industry matches nothing specific — a broad, balanced trio. */
const DEFAULT_PERSONA_IDS = ["venture_capitalist", "enterprise_tech_buyer", "high_volume_consumer"];

/** How many personas to run per simulation — keeps the panel focused and cost bounded. */
export const MAX_PERSONAS = 4;

/**
 * Choose the persona panel for a client's industry. Matches personas whose
 * `industries` keywords appear in the industry string, always includes the
 * universal personas, and falls back to a balanced default trio when nothing
 * matches — so the panel is never empty. Deterministic (registry order), capped
 * at MAX_PERSONAS.
 */
export function selectPersonasForIndustry(industry?: string | null): SyntheticPersona[] {
  const needle = (industry ?? "").toLowerCase().trim();
  // Whole-word / phrase match so short keywords ("ai", "b2b") don't match inside
  // unrelated words ("retail", "email"). Keywords are trusted constants but escaped anyway.
  const matchesKeyword = (kw: string) =>
    new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(needle);
  let matched = needle
    ? PERSONA_REGISTRY.filter(
        (p) => p.industries.length === 0 || p.industries.some(matchesKeyword),
      )
    : [];

  if (matched.length === 0) {
    matched = PERSONA_REGISTRY.filter((p) => DEFAULT_PERSONA_IDS.includes(p.id));
  }
  return matched.slice(0, MAX_PERSONAS);
}

/* ── Output schema (strict) ──────────────────────────────────────────── */

export const personaResultSchema = z.object({
  score: z.number().int().min(1).max(10).describe("1 = would ignore/be put off, 10 = would act immediately"),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  critique: z
    .string()
    .min(1)
    .max(600)
    .describe("Sharp, specific, actionable critique from this persona's perspective"),
});

export type PersonaVerdict = z.infer<typeof personaResultSchema>;

/** A single persona's result (or failure) in a simulation run. */
export interface PersonaSimulationResult {
  personaId: string;
  personaName: string;
  archetype: string;
  /** Present on success. */
  verdict?: PersonaVerdict;
  /** Present when this persona's evaluation failed — the others still return. */
  error?: string;
}

/** The artifact under test — text copy or a video script. */
export interface SimulationArtifact {
  title: string;
  content: string;
  /** Asset type, e.g. "social_post" | "article" | "video_script". */
  type: string;
}

export interface SimulationContext {
  clientId: string;
  clientName: string;
  industry?: string | null;
}

/* ── Runtime ─────────────────────────────────────────────────────────── */

function buildUserPrompt(artifact: SimulationArtifact, ctx: SimulationContext): string {
  const isScript = /video|script|reel|tiktok/i.test(artifact.type);
  return `BRAND: ${ctx.clientName}${ctx.industry ? ` — ${ctx.industry}` : ""}
CONTENT TYPE: ${artifact.type.replace(/_/g, " ")}${isScript ? " (this is a video/short-form script — imagine it performed)" : ""}
TITLE: ${artifact.title}

CONTENT UNDER REVIEW:
"""
${artifact.content}
"""

React as your persona. Return your score, sentiment, and critique.`;
}

/**
 * Run one persona's evaluation of the artifact. Strictly validated by Zod via
 * generateObject (the model is forced to satisfy `personaResultSchema`). Usage is
 * logged fire-and-forget. Throws on model/parse failure — callers decide whether
 * to isolate the failure (see `runSimulation`).
 */
export async function simulatePersona(
  persona: SyntheticPersona,
  artifact: SimulationArtifact,
  ctx: SimulationContext,
): Promise<PersonaSimulationResult> {
  const { object, usage } = await generateObject({
    model: anthropic(MODELS.HAIKU),
    schema: personaResultSchema,
    system: persona.systemPrompt,
    prompt: buildUserPrompt(artifact, ctx),
  });

  after(() =>
    logger.logUsage({
      clientId: ctx.clientId,
      agentId: null,
      agentName: `Simulation: ${persona.name}`,
      modelName: MODELS.HAIKU,
      operation: "audience_simulation",
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }),
  );

  return {
    personaId: persona.id,
    personaName: persona.name,
    archetype: persona.archetype,
    verdict: object,
  };
}

/**
 * Dispatch the artifact to every persona in the panel IN PARALLEL and collect
 * their verdicts. Resilient by design: one persona's failure (model error,
 * schema-validation miss) is isolated into that persona's `error` field via
 * `Promise.allSettled`, so the rest of the panel still returns. Never throws for
 * a per-persona failure — the run always resolves with one entry per persona.
 */
export async function runSimulation(
  artifact: SimulationArtifact,
  personas: SyntheticPersona[],
  ctx: SimulationContext,
): Promise<PersonaSimulationResult[]> {
  const settled = await Promise.allSettled(
    personas.map((p) => simulatePersona(p, artifact, ctx)),
  );
  return settled.map((res, i) => {
    if (res.status === "fulfilled") return res.value;
    const persona = personas[i];
    return {
      personaId: persona.id,
      personaName: persona.name,
      archetype: persona.archetype,
      error: res.reason instanceof Error ? res.reason.message : "Simulation failed",
    };
  });
}
