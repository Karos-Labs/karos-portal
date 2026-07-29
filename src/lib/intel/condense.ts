import "server-only";

import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { Client, ContextDocType } from "@/lib/types";
import { CONDENSATION_RULES } from "./brain";
import { MODELS, CONDENSE_MAX_TOKENS } from "@/lib/constants";
import { stripPreamble, stripTrailingMetaCommentary } from "@/lib/text-utils";
import { logger } from "@/services/logger";

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

  const condenseStream = streamText({
    model: anthropic(MODELS.SONNET),
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    maxOutputTokens: CONDENSE_MAX_TOKENS,
  });
  const text = await condenseStream.text;
  logger.trackStream(condenseStream, {
    clientId: client.id, agentId: null, agentName: `Condense: ${docType}`,
    modelName: MODELS.SONNET, operation: "doc_condense",
  });

  // Detect truncation/omission: the condensed doc must include both the first and last ## sections.
  const internalSections = internalContent.match(/^## .+/gm) ?? [];
  const firstInternalSection = internalSections[0]?.replace(/^## /, "").trim();
  const lastInternalSection = internalSections[internalSections.length - 1]?.replace(/^## /, "").trim();

  // Strip model preamble, then any trailing meta-commentary the model appended
  // after the document ("If you intended a different template…").
  const condensed = stripTrailingMetaCommentary(stripPreamble(text));
  // Match the heading boundary (## prefix) to avoid substring false-positives.
  const missingFirst = firstInternalSection && !condensed.includes(`## ${firstInternalSection}`);
  const missingLast = lastInternalSection && !condensed.includes(`## ${lastInternalSection}`);

  if (missingFirst || missingLast) {
    // Retry as a fresh call — do not include the truncated assistant turn, which anchors
    // the model to the incomplete first output and defeats a full-rewrite instruction.
    const condenseRetryStream = streamText({
      model: anthropic(MODELS.SONNET),
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
    });
    const cont = await condenseRetryStream.text;
    logger.trackStream(condenseRetryStream, {
      clientId: client.id, agentId: null, agentName: `Condense (retry): ${docType}`,
      modelName: MODELS.SONNET, operation: "doc_condense",
    });
    const rewritten = stripTrailingMetaCommentary(stripPreamble(cont));
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
