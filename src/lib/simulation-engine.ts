/**
 * Pre-Flight Impact Simulation — dynamic stakeholder panel.
 *
 * Persona selection is generated per request from client context + post format.
 * No fixed static persona roster is used for production runs.
 */

import "server-only";
import { generateObject, generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { after } from "next/server";
import { MODELS } from "@/lib/constants";
import { logger } from "@/services/logger";

export const MAX_PERSONAS = 4;

/** The artifact under test — text copy, article, email, script, etc. */
export interface SimulationArtifact {
  title: string;
  content: string;
  type: string;
  format: string;
  channels?: string[];
}

/** Client/profile metadata used to tailor persona generation. */
export interface SimulationContext {
  clientId: string;
  clientName: string;
  industry?: string | null;
  category?: string | null;
  toneOfVoice?: string | null;
  targetMarket?: string | null;
  businessModel?: "B2B" | "B2C" | "MIXED" | null;
}

/** Runtime persona used for one simulation run. */
export interface SyntheticPersona {
  id: string;
  name: string;
  archetype: string;
  perspective: string;
  painPoints: string[];
  voice: string;
  evaluationFocus: string;
}

const personaPlanSchema = z.object({
  personas: z.array(
    z.object({
      id: z.string().min(1).max(80),
      name: z.string().min(2).max(120),
      archetype: z.string().min(2).max(220),
      perspective: z.string().min(8).max(320),
      painPoints: z.array(z.string().min(3).max(160)).min(2).max(4),
      voice: z.string().min(3).max(120),
      evaluationFocus: z.string().min(8).max(320),
    }),
  ).min(2).max(MAX_PERSONAS),
});

/** Shared discipline appended to every generated persona prompt. */
const SHARED_DISCIPLINE = `
You are role-playing a specific audience member reacting to a piece of marketing content BEFORE it is published. Stay 100% in character.
Rules:
- Judge ONLY from your persona's point of view — your priorities, biases, and skepticism.
- Be specific and highly critical. Reference concrete words, claims, or structure in the content. Never give generic praise.
- Your critique must contain at least one concrete, actionable piece of advice from your professional/consumer perspective.
- The score (1-10) must reflect how likely YOU personally are to act on / engage with this content (1 = would ignore or be put off, 10 = would immediately act).
- Sentiment must agree with the score: 1-4 → negative, 5-6 → neutral, 7-10 → positive.
- Return ONLY the structured object. No preamble.`;

export const personaResultSchema = z.object({
  score: z.number().int().min(1).max(10).describe("1 = would ignore/be put off, 10 = would act immediately"),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  critique: z
    .string()
    .min(1)
    .max(600)
    .describe("Specific feedback from this persona, including concrete pain points seen in the post."),
  actionableSuggestion: z
    .string()
    .min(1)
    .max(240)
    .describe("One practical next change to improve the post for this persona."),
});

export type PersonaVerdict = z.infer<typeof personaResultSchema>;
const personaResultFallbackSchema = z.object({
  score: z.coerce.number().min(0).max(10),
  sentiment: z.string().optional(),
  critique: z.string().optional(),
  feedback: z.string().optional(),
  actionableSuggestion: z.string().min(1).max(320).optional(),
  suggestion: z.string().optional(),
});

export interface PersonaSimulationResult {
  personaId: string;
  personaName: string;
  archetype: string;
  perspective: string;
  painPoints: string[];
  verdict?: PersonaVerdict;
  error?: string;
}

function normalizePersonaId(rawId: string, fallbackName: string, index: number): string {
  const source = rawId.trim() || fallbackName.trim() || `persona-${index + 1}`;
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return normalized || `persona_${index + 1}`;
}

function buildPersonaPlannerPrompt(artifact: SimulationArtifact, ctx: SimulationContext): string {
  const channels = (artifact.channels ?? []).join(", ") || "n/a";
  return `Generate a panel of 2 to 4 DISTINCT personas for marketing feedback.

CLIENT CONTEXT
- Brand: ${ctx.clientName}
- Industry: ${ctx.industry ?? "unknown"}
- Category: ${ctx.category ?? "unknown"}
- Tone of voice: ${ctx.toneOfVoice ?? "unknown"}
- Target market: ${ctx.targetMarket ?? "unknown"}
- Business model: ${ctx.businessModel ?? "unknown"}

POST CONTEXT
- Type: ${artifact.type}
- Format: ${artifact.format}
- Channels: ${channels}
- Title: ${artifact.title}

Requirements:
1) Personas must be meaningfully different and adapted to THIS client + THIS post format.
2) Include role-appropriate perspectives (for example: technical decision maker, financial approver, practitioner, casual viewer, loyalist, skeptic, competitor) based on context.
3) Each persona needs clear perspective, pain points, and evaluation focus.
4) Keep to 2-4 personas only.

Return only the JSON object.`;
}

function buildPersonaSystemPrompt(persona: SyntheticPersona): string {
  return `You are ${persona.name} (${persona.archetype}).

Your worldview:
- Perspective: ${persona.perspective}
- Pain points: ${persona.painPoints.map((p) => `• ${p}`).join("\n")}
- Evaluation focus: ${persona.evaluationFocus}
- Voice: ${persona.voice}

${SHARED_DISCIPLINE}`;
}

function buildUserPrompt(artifact: SimulationArtifact, ctx: SimulationContext): string {
  const channels = (artifact.channels ?? []).join(", ") || "n/a";
  return `BRAND: ${ctx.clientName}
BUSINESS MODEL: ${ctx.businessModel ?? "unknown"}
INDUSTRY: ${ctx.industry ?? "unknown"}
CATEGORY: ${ctx.category ?? "unknown"}
TARGET MARKET: ${ctx.targetMarket ?? "unknown"}
TONE OF VOICE: ${ctx.toneOfVoice ?? "unknown"}

POST TYPE: ${artifact.type}
POST FORMAT: ${artifact.format}
CHANNELS: ${channels}
TITLE: ${artifact.title}

CONTENT UNDER REVIEW:
"""
${artifact.content}
"""

React as your persona. Return score, sentiment, critique, and one actionable suggestion.`;
}

function normalizeVerdict(raw: z.infer<typeof personaResultFallbackSchema>): PersonaVerdict {
  const roundedScore = Math.max(1, Math.min(10, Math.round(raw.score)));
  const normalizedSentiment = (raw.sentiment ?? "").trim().toLowerCase();
  const sentiment: PersonaVerdict["sentiment"] =
    normalizedSentiment === "positive" || normalizedSentiment === "negative" || normalizedSentiment === "neutral"
      ? normalizedSentiment
      : roundedScore >= 7
        ? "positive"
        : roundedScore >= 5
          ? "neutral"
          : "negative";
  const critique = (raw.critique ?? raw.feedback ?? "").trim() || "Useful reaction, but please add more specific proof points for this audience.";
  const suggestion =
    raw.actionableSuggestion?.trim() ||
    raw.suggestion?.trim() ||
    `Refine the message to address this persona's top concern directly and concretely.`;
  return {
    score: roundedScore,
    sentiment,
    critique,
    actionableSuggestion: suggestion,
  };
}

function coerceFallbackPayload(input: unknown): z.infer<typeof personaResultFallbackSchema> | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const score =
    obj.score ??
    obj.rating ??
    obj.finalScore ??
    obj["final_score"] ??
    obj["score_out_of_10"];
  const sentiment = obj.sentiment ?? obj.tone ?? obj.reaction;
  const critique = obj.critique ?? obj.feedback ?? obj.analysis ?? obj.reasoning ?? obj.notes;
  const actionableSuggestion =
    obj.actionableSuggestion ??
    obj.actionable_suggestion ??
    obj.suggestion ??
    obj["next_step"] ??
    obj["nextAction"] ??
    obj["recommendation"];
  const parsed = personaResultFallbackSchema.safeParse({
    score,
    sentiment,
    critique,
    actionableSuggestion,
    suggestion: actionableSuggestion,
  });
  return parsed.success ? parsed.data : null;
}

/** Pull the first JSON object out of a model response (tolerates prose/code-fences). */
function extractJsonObject(text: string): string | null {
  const unfenced = text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const start = unfenced.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return unfenced.slice(start, i + 1).trim();
    }
  }
  return null;
}

/** JSON.parse that tolerates trailing commas (common LLM formatting miss). */
function tolerantJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
  }
}

function parseVerdictFromText(text: string): PersonaVerdict | null {
  const cleaned = text.trim();
  if (!cleaned) return null;

  // 1) JSON object embedded in prose.
  const json = extractJsonObject(cleaned);
  if (json) {
    try {
      const payload = coerceFallbackPayload(tolerantJsonParse(json));
      if (payload) return normalizeVerdict(payload);
    } catch {
      // continue to non-JSON heuristics
    }
  }

  // 2) Heuristic plain-text parsing.
  const scoreMatch =
    cleaned.match(/(?:score|rating)\s*[:\-]?\s*(10|[0-9](?:\.[0-9])?)/i) ??
    cleaned.match(/\b(10|[0-9](?:\.[0-9])?)\s*\/\s*10\b/i);
  const score = scoreMatch ? Number(scoreMatch[1]) : 6;

  const sentimentMatch = cleaned.match(/\b(positive|neutral|negative)\b/i);
  const sentiment = sentimentMatch?.[1]?.toLowerCase() ?? (score >= 7 ? "positive" : score >= 5 ? "neutral" : "negative");

  // Non-greedy + lookahead: stop the critique capture at the next labeled field
  // (e.g. "Actionable suggestion:") instead of swallowing the rest of the response.
  const nextLabel = /\n\s*(?:actionable suggestion|suggestion|next step|recommendation|improve)\s*[:\-]/i;
  const critiqueMatch =
    cleaned.match(new RegExp(`(?:critique|feedback|analysis|why)\\s*[:\\-]\\s*([\\s\\S]{20,}?)(?=${nextLabel.source}|\\n{2,}|$)`, "i")) ??
    cleaned.match(new RegExp(`(?:overall|verdict)\\s*[:\\-]\\s*([\\s\\S]{20,}?)(?=${nextLabel.source}|\\n{2,}|$)`, "i"));
  const suggestionMatch =
    cleaned.match(/(?:actionable suggestion|suggestion|next step|recommendation|improve)\s*[:\-]\s*([\s\S]{8,})/i);

  const critique = (critiqueMatch?.[1] ?? cleaned)
    .split(/\n{2,}/)[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  const actionableSuggestion = (
    suggestionMatch?.[1] ??
    "Refine the message to address this persona's top concern directly and concretely."
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

  const parsed = personaResultSchema.safeParse({
    score: Math.max(1, Math.min(10, Math.round(score))),
    sentiment,
    critique: critique || "Useful reaction, but needs more concrete audience-specific detail.",
    actionableSuggestion,
  });
  return parsed.success ? parsed.data : null;
}

/** Dynamically generates 2–4 personas from client and post context. */
export async function buildSimulationPersonas(
  artifact: SimulationArtifact,
  ctx: SimulationContext,
): Promise<SyntheticPersona[]> {
  const { object } = await generateObject({
    model: anthropic(MODELS.HAIKU),
    schema: personaPlanSchema,
    prompt: buildPersonaPlannerPrompt(artifact, ctx),
  });
  return object.personas.map((p, i) => ({
    id: normalizePersonaId(p.id, p.name, i),
    name: p.name.trim(),
    archetype: p.archetype.trim(),
    perspective: p.perspective.trim(),
    painPoints: p.painPoints.map((x) => x.trim()).filter(Boolean).slice(0, 4),
    voice: p.voice.trim(),
    evaluationFocus: p.evaluationFocus.trim(),
  }));
}

export async function simulatePersona(
  persona: SyntheticPersona,
  artifact: SimulationArtifact,
  ctx: SimulationContext,
): Promise<PersonaSimulationResult> {
  const system = buildPersonaSystemPrompt(persona);
  const prompt = buildUserPrompt(artifact, ctx);
  const simUsageMeta = {
    clientId: ctx.clientId, agentId: null, agentName: `Simulation: ${persona.name}`,
    modelName: MODELS.HAIKU, operation: "audience_simulation",
  };
  let verdict: PersonaVerdict;
  let usage: { inputTokens?: number; outputTokens?: number };
  try {
    const first = await generateObject({
      model: anthropic(MODELS.HAIKU),
      schema: personaResultSchema,
      system,
      prompt,
    });
    verdict = first.object;
    usage = first.usage;
  } catch (firstError) {
    // Tier 1 (strict schema) spent real tokens even though it failed
    // validation/generation — log it before falling through to tier 2, or it
    // simply vanishes once a later tier succeeds and logs its own usage.
    logger.logGenerationFailure(simUsageMeta, firstError);
    try {
      const second = await generateObject({
        model: anthropic(MODELS.HAIKU),
        schema: personaResultFallbackSchema,
        system,
        prompt,
      });
      verdict = normalizeVerdict(second.object);
      usage = second.usage;
    } catch (secondError) {
      logger.logGenerationFailure(simUsageMeta, secondError);
      try {
        const third = await generateText({
          model: anthropic(MODELS.HAIKU),
          system,
          prompt: `${prompt}

Return ONLY one JSON object with keys:
- score (1..10 number)
- sentiment ("positive" | "neutral" | "negative")
- critique (string)
- actionableSuggestion (string)

No markdown, no code fences, no extra text.`,
        });
        const fromText = parseVerdictFromText(third.text);
        if (!fromText) throw new Error("Text fallback could not produce a valid verdict");
        verdict = fromText;
        usage = third.usage ?? {};
      } catch (thirdError) {
        logger.logGenerationFailure(simUsageMeta, thirdError);
        // All three tiers failed — surface the original (strict schema) error; it's
        // the one most likely to reflect the real root cause (model/network failure),
        // while the fallback tiers exist purely to rescue malformed-but-valid responses.
        throw firstError instanceof Error ? firstError : new Error("Persona evaluation failed");
      }
    }
  }

  after(() =>
    logger.logUsage({
      ...simUsageMeta,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }),
  );

  return {
    personaId: persona.id,
    personaName: persona.name,
    archetype: persona.archetype,
    perspective: persona.perspective,
    painPoints: persona.painPoints,
    verdict,
  };
}

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
      perspective: persona.perspective,
      painPoints: persona.painPoints,
      error: res.reason instanceof Error ? res.reason.message : "Simulation failed",
    };
  });
}
