import "server-only";

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { Client, ContextDocType } from "@/lib/types";
import { CONDENSATION_RULES } from "@/lib/onboard-templates";
import { MODELS, CONDENSE_MAX_TOKENS } from "@/lib/constants";
import { stripPreamble } from "@/lib/text-utils";

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

  const { text } = await generateText({
    model: anthropic(MODELS.SONNET),
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    maxOutputTokens: CONDENSE_MAX_TOKENS,
  });

  // Detect truncation: the condensed doc should include the last ## section from the internal doc.
  const internalSections = internalContent.match(/^## .+/gm) ?? [];
  const lastInternalSection = internalSections[internalSections.length - 1]?.replace(/^## /, "").trim();

  if (lastInternalSection && !text.includes(lastInternalSection)) {
    const { text: cont } = await generateText({
      model: anthropic(MODELS.SONNET),
      system: systemPrompt,
      messages: [
        { role: "user", content: userMessage },
        { role: "assistant", content: text },
        {
          role: "user",
          content:
            "You stopped before covering all sections. Continue the condensed document from exactly where you left off. Do not repeat any content already written. Continue immediately:",
        },
      ],
      maxOutputTokens: 8000,
    });
    return { docType, content: stripPreamble(text + cont) };
  }

  return { docType, content: stripPreamble(text) };
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
  ];
  return condenseDocs(client, clientVisibleDocTypes, internalDocs, rules);
}
