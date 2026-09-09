import "server-only";

import { streamText } from "ai";
import type { Client } from "@/lib/types";
import { DOC_MAX_TOKENS } from "@/lib/constants";
import { stripPreamble } from "@/lib/text-utils";
import { logger } from "@/services/logger";
import { aiFor, usageFor } from "@/lib/ai/provider";

/**
 * SCRUM-274 (T-B19) — extracted verbatim out of the now-deleted
 * `src/lib/intel/pipeline.ts` (the hardcoded onboarding pipeline D1 killed).
 *
 * `applyDocCorrections` is NOT part of "the hardcoded onboarding pipeline" —
 * it is the targeted single-doc/global "Fix with Review" correction path
 * (`src/lib/actions/intel-actions.ts`), which regenerates neither research
 * nor the document from scratch. It has its own callers outside
 * `runOnboardPipeline` (see `intel-actions.ts`), so cutover moves it to its
 * own module rather than deleting it along with the pipeline it used to live
 * beside. Behavior is unchanged — this is a pure file move.
 */

/**
 * Apply verified client corrections to an existing context document.
 * Used by targeted single-doc correction and global "Fix with Review".
 * Does NOT re-run research.
 *
 * Guardrails built into the prompt + validated after generation:
 *  - Section count must be preserved (same number of ## headings)
 *  - Output length must stay within 85–115% of input length
 * If either check fails, the caller receives the ORIGINAL content unchanged.
 */
export async function applyDocCorrections(
  client: Client,
  docType: string,
  currentContent: string,
  corrections: string,
): Promise<string> {
  const inputCharCount = currentContent.length;
  const inputSectionCount = (currentContent.match(/^## /gm) ?? []).length;

  const systemPrompt = `You are a SURGICAL DOCUMENT EDITOR. Your only job is to apply a small, precise set of client corrections to an existing strategy document.

## VERIFIED CLIENT CORRECTIONS — ABSOLUTE GROUND TRUTH
The client confirmed these facts directly. They override all other information.

${corrections.trim()}

## SURGICAL EDIT RULES (NON-NEGOTIABLE)

**ONLY change what is explicitly stated above.** Every other word, sentence, heading, table, bullet, and formatting character must remain byte-for-byte identical to the input.

- Find EVERY occurrence of the corrected facts and update them all for internal consistency.
- Do NOT add new content, expand any section, rewrite any sentence that wasn't explicitly corrected, or improve phrasing.
- Do NOT remove any content, truncate any section, or drop any heading.
- Preserve ALL markdown: every \`##\` heading, every table, every bullet, every \`---\` divider, all YAML frontmatter.
- The output must be the COMPLETE document — not a diff, not a summary, not a partial excerpt.

## STRUCTURAL INTEGRITY CHECK
- This document has ${inputSectionCount} section headings (lines starting with \`## \`). Your output MUST contain exactly ${inputSectionCount} such headings.
- The input is ${inputCharCount} characters. Your output should be approximately ${inputCharCount} characters — within ±15% (${Math.round(inputCharCount * 0.85)}–${Math.round(inputCharCount * 1.15)} chars). A dramatically shorter output means you truncated the document, which is a critical failure.

## OUTPUT FORMAT
Return ONLY the corrected document. Start immediately with the first character of the document (the opening \`---\` of the YAML frontmatter, if present). No preamble, no explanation, no "Here is the corrected document:" prefix.`;

  const corrStream = streamText({
    model: aiFor("intel.pipeline.synthesis").model,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Apply the verified corrections to this ${docType} document for ${client.name}. Return the complete corrected document:\n\n${currentContent}`,
      },
    ],
    maxOutputTokens: DOC_MAX_TOKENS,
  });
  const text = await corrStream.text;
  logger.trackStream(corrStream, {
    clientId: client.id, agentId: null, agentName: `Doc Correction: ${docType}`,
    ...usageFor("intel.pipeline.synthesis"), operation: "doc_correction",
  });

  const result = text.trim();

  // Structural validation — if the LLM truncated or hallucinated sections, return original.
  const outputSectionCount = (result.match(/^## /gm) ?? []).length;
  const lengthRatio = result.length / inputCharCount;

  if (
    (inputSectionCount > 0 && outputSectionCount !== inputSectionCount) ||
    lengthRatio < 0.75 ||
    lengthRatio > 1.4
  ) {
    // Correction failed structural checks — attempt a continuation pass before giving up.
    if (result.length < inputCharCount * 0.75) {
      const corrContStream = streamText({
        model: aiFor("intel.pipeline.synthesis").model,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Apply the verified corrections to this ${docType} document for ${client.name}. Return the complete corrected document:\n\n${currentContent}`,
          },
          { role: "assistant", content: result },
          {
            role: "user",
            content:
              "Your output was truncated — the document is incomplete. Continue from exactly where you left off and complete the remaining sections. Do NOT repeat any content already written:",
          },
        ],
        maxOutputTokens: DOC_MAX_TOKENS,
      });
      const cont = await corrContStream.text;
      logger.trackStream(corrContStream, {
        clientId: client.id, agentId: null, agentName: `Doc Correction (continuation): ${docType}`,
        ...usageFor("intel.pipeline.synthesis"), operation: "doc_correction",
      });
      const recovered = (result + cont).trim();
      const recoveredSections = (recovered.match(/^## /gm) ?? []).length;
      const recoveredRatio = recovered.length / inputCharCount;
      if (
        (inputSectionCount === 0 || recoveredSections === inputSectionCount) &&
        recoveredRatio >= 0.75 &&
        recoveredRatio <= 1.4
      ) {
        return stripPreamble(recovered);
      }
    }
    // All recovery attempts failed — return unchanged to avoid data loss.
    return currentContent;
  }

  return stripPreamble(result);
}
