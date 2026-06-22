import "server-only";

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";

import { createTranscript, matchClientByDomains } from "@/lib/data";
import { domainFromEmail } from "@/lib/utils";
import type { FirefliesTranscript } from "@/lib/transcripts/fireflies";
import type { Transcript } from "@/lib/types";

const analysisSchema = z.object({
  summary: z.string().describe("A concise 3-5 sentence summary of the meeting."),
  actionItems: z.array(z.string()).describe("Concrete action items / next steps."),
  keywords: z.array(z.string()).describe("Topics, brands, products or campaigns mentioned."),
});

/** Produce summary/action-items/keywords, preferring the AI pass but falling back to provider data. */
async function analyze(t: FirefliesTranscript) {
  try {
    const { object } = await generateObject({
      model: anthropic(process.env.TRANSCRIPT_MODEL || "claude-sonnet-4-6"),
      schema: analysisSchema,
      system:
        "You are an analyst for a marketing agency. Summarise client meeting transcripts and extract action items and key topics that the agency should act on.",
      prompt: `Meeting: ${t.title}\nParticipants: ${t.participants.join(", ")}\n\nTranscript:\n${t.text.slice(0, 18000)}`,
    });
    return object;
  } catch {
    return {
      summary: t.providerSummary ?? "",
      actionItems: t.providerActionItems ?? [],
      keywords: [] as string[],
    };
  }
}

/**
 * Full ingestion: analyse the transcript, auto-assign it to a client by participant
 * email domains, and persist it. Returns the created transcript id and the match.
 */
export async function ingestTranscript(
  t: FirefliesTranscript,
  source: Transcript["source"] = "fireflies",
): Promise<{ id: string; clientId: string | null; matched: boolean }> {
  const analysis = await analyze(t);

  const domains = Array.from(
    new Set(t.participants.map((p) => domainFromEmail(p)).filter(Boolean) as string[]),
  );
  const matchedClient = await matchClientByDomains(domains);

  const id = await createTranscript({
    title: t.title,
    source,
    externalId: t.externalId,
    clientId: matchedClient?.id ?? null,
    assignment: matchedClient ? "auto" : "unassigned",
    meetingDate: t.date,
    durationMin: t.durationMin,
    participants: t.participants,
    rawText: t.text,
    summary: analysis.summary,
    actionItems: analysis.actionItems,
    keywords: analysis.keywords,
    createdAt: Date.now(),
  });

  return { id, clientId: matchedClient?.id ?? null, matched: !!matchedClient };
}
