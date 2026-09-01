import "server-only";

import { streamText } from "ai";
import type { Client, ContextDocType } from "@/lib/types";
import { CONDENSATION_RULES } from "./brain";
import { CONDENSE_MAX_TOKENS } from "@/lib/constants";
import { stripPreamble, stripTrailingMetaCommentary } from "@/lib/text-utils";
import { logger } from "@/services/logger";
import { logStructured } from "@/lib/telemetry/structured-log";
import type { ResolvedAi } from "@/lib/ai/provider";
import {
  routeContextDocCondensation,
  type CondensationModelAttempt,
} from "./context-doc-routing";

export interface CondensedDoc {
  docType: ContextDocType;
  content: string;
}

/**
 * Condense a set of internal-tier docs into client-facing (~50%) versions.
 * Runs all condensation calls in parallel.
 *
 * @param client       The client (used for context in the prompt)
 * @param docTypes     The doc types to condense (must be client-visible docs only)
 * @param internalDocs Map of docType → internal markdown content
 * @param rules        Core research rules (prepended to every condensation prompt)
 */
export async function condenseDocs(
  client: Client,
  docTypes: ContextDocType[],
  internalDocs: Record<string, string>,
  rules: string,
): Promise<CondensedDoc[]> {
  const results = await Promise.all(
    docTypes.map((docType) => condenseOne(client, docType, internalDocs[docType] ?? "", rules)),
  );
  return results;
}

async function condenseOne(
  client: Client,
  docType: ContextDocType,
  internalContent: string,
  rules: string,
): Promise<CondensedDoc> {
  if (!internalContent.trim()) {
    return { docType, content: "" };
  }

  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = `${rules}\n\n${CONDENSATION_RULES}\n\nYou are preparing a client-facing version of an internal analyst document.`;
  const userMessage = `Condense this internal ${docType} document for ${client.name} into a client-facing version.

## INTERNAL DOCUMENT
${internalContent}

## YOUR TASK
Apply the condensation contract:
- COMPLETE ALL SECTIONS — every section heading from the internal doc must appear in the output. Never skip or drop a section.
- Keep positioning, voice rules, competitive leaders, measured metrics (with sources), visual basics, strategy headline
- Remove internal methodology notes, agent routing tables, product_ids, internal reminders
- Remove competitor-derogatory labels (replace with neutral factual observations)
- Never invent content not in the internal doc
- Never soften or omit compliance/regulatory hard gates
- Target ~50% of the original length by condensing WITHIN each section — not by dropping sections

Update the frontmatter:
- Set status to: published
- Set last_updated to: ${today}
- Add a line: published_at: ${today}

Return ONLY the condensed markdown document. No preamble, no explanation.`;

  // SCRUM-387 — routes this document to a model BEFORE the first call: Vertex-
  // primary/Anthropic-fallback for a standard document, or an escalation to
  // Opus (high complexity) / Gemini (does not fit Claude's window) — see
  // context-doc-routing.ts for the full design and citations. Both passes
  // below (initial, and the truncation-triggered retry) reuse the SAME route:
  // the document being condensed has not changed, so neither has its
  // complexity.
  const route = routeContextDocCondensation(docType, internalContent, {
    maxOutputTokens: CONDENSE_MAX_TOKENS,
  });
  logStructured("INFO", `context-doc condensation route: ${route.rationale}`, {
    event: "context_document.route",
    clientId: client.id,
    docType,
    tier: route.complexity.tier,
    score: route.complexity.score,
    escalated: route.escalated,
  });

  const first = await runCondensationAttempts(
    route.attempts,
    (resolved) =>
      streamText({
        model: resolved.model,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        maxOutputTokens: CONDENSE_MAX_TOKENS,
      }),
    { clientId: client.id, docType, agentName: `Condense: ${docType}` },
  );

  // Detect truncation/omission: the condensed doc must include both the first and last ## sections.
  const internalSections = internalContent.match(/^## .+/gm) ?? [];
  const firstInternalSection = internalSections[0]?.replace(/^## /, "").trim();
  const lastInternalSection = internalSections[internalSections.length - 1]?.replace(/^## /, "").trim();

  // Strip model preamble, then any trailing meta-commentary the model appended
  // after the document ("If you intended a different template…").
  const condensed = stripTrailingMetaCommentary(stripPreamble(first.text));
  // Match the heading boundary (## prefix) to avoid substring false-positives.
  const missingFirst = firstInternalSection && !condensed.includes(`## ${firstInternalSection}`);
  const missingLast = lastInternalSection && !condensed.includes(`## ${lastInternalSection}`);

  if (missingFirst || missingLast) {
    // Retry as a fresh call — do not include the truncated assistant turn, which anchors
    // the model to the incomplete first output and defeats a full-rewrite instruction.
    const retry = await runCondensationAttempts(
      route.attempts,
      (resolved) =>
        streamText({
          model: resolved.model,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content:
                userMessage +
                "\n\nCRITICAL: You MUST condense every section from the original document. Do not stop before reaching the last section.",
            },
          ],
          maxOutputTokens: CONDENSE_MAX_TOKENS,
        }),
      { clientId: client.id, docType, agentName: `Condense (retry): ${docType}` },
    );
    const rewritten = stripTrailingMetaCommentary(stripPreamble(retry.text));
    // Fall back to the first-pass result if the rewrite returned empty content,
    // or if it covers fewer of the internal doc's sections — a retry must never
    // be allowed to hand back less than the pass that triggered it.
    const coverage = (doc: string) => internalSections.filter((h) => doc.includes(h)).length;
    const keepRewrite = rewritten.length > 0 && coverage(rewritten) >= coverage(condensed);
    return { docType, content: keepRewrite ? rewritten : condensed };
  }

  return { docType, content: condensed };
}

/**
 * Executes `build` against each of `route`'s candidate model resolutions IN
 * ORDER, returning the first that succeeds (SCRUM-387). For the baseline
 * (standard-complexity) route this is the Vertex-primary/Anthropic-fallback
 * attempt: `attempts[0]` is Vertex, `attempts[1]` is direct Anthropic — a real
 * retry across vendors at call time, not a config pin. For an escalated route
 * (Opus / Gemini) `attempts` has exactly one candidate, so this degrades to a
 * plain call with no fallback — there is nothing else verified to fall back
 * to for those models (see context-doc-routing.ts).
 *
 * A candidate's OWN failure (network error, refused wiring, upstream error —
 * anything `resolve()` or the `streamText` call throws) is caught and logged,
 * then the next candidate is tried; only when every candidate has failed does
 * this throw, and it throws the LAST candidate's error, since that is the one
 * whose failure is still live.
 */
async function runCondensationAttempts(
  attempts: readonly CondensationModelAttempt[],
  build: (resolved: ResolvedAi) => ReturnType<typeof streamText>,
  ctx: { clientId: string; docType: string; agentName: string },
): Promise<{ text: string; resolved: ResolvedAi }> {
  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    try {
      const resolved = attempt.resolve();
      const stream = build(resolved);
      const text = await stream.text;
      logger.trackStream(stream, {
        clientId: ctx.clientId,
        agentId: null,
        agentName: ctx.agentName,
        modelName: resolved.modelId,
        vendor: resolved.vendor,
        operation: "doc_condense",
      });
      if (i > 0) {
        logStructured(
          "WARNING",
          `context-doc condensation: primary vendor "${attempts[0]!.vendor}" was bypassed — ` +
            `"${ctx.docType}" served by fallback vendor "${attempt.vendor}"`,
          {
            event: "context_document.condense_fallback",
            docType: ctx.docType,
            from: attempts[0]!.vendor,
            to: attempt.vendor,
          },
        );
      }
      return { text, resolved };
    } catch (err) {
      lastErr = err;
      const more = i < attempts.length - 1;
      logStructured(
        more ? "WARNING" : "ERROR",
        `context-doc condensation: vendor "${attempt.vendor}" (model "${attempt.modelId}") failed for ` +
          `"${ctx.docType}"${more ? " — falling back" : " — no remaining vendors"}`,
        {
          event: "context_document.condense_attempt_failed",
          docType: ctx.docType,
          vendor: attempt.vendor,
          modelId: attempt.modelId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`context-doc condensation: all vendor attempts failed for "${ctx.docType}"`);
}

/**
 * Re-condense existing internal docs for a client (monthly refresh light pass).
 * Reads from the provided internal docs map, does not re-run the full research pipeline.
 */
export async function refreshClientCondensedDocs(
  client: Client,
  internalDocs: Record<string, string>,
  rules: string,
): Promise<CondensedDoc[]> {
  const clientVisibleDocTypes: ContextDocType[] = [
    "brand-voice",
    "market-strategy",
    "competitor-analysis",
    "product-information",
    "branding-guidelines",
    "target-audience",
  ];
  return condenseDocs(client, clientVisibleDocTypes, internalDocs, rules);
}
