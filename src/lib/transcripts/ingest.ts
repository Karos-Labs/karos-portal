import "server-only";

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";

import { createTranscript, findDuplicateTranscript, getClientContextDoc, listClients, listUsers, upsertClientContextDoc } from "@/lib/data";
import { createActionItemDocsForTranscript } from "@/lib/action-items";
import { MODELS } from "@/lib/constants";
import { logger } from "@/services/logger";
import type { FirefliesTranscript } from "@/lib/transcripts/fireflies";
import type { AppUser, Client, Transcript } from "@/lib/types";

const analysisSchema = z.object({
  summary: z.string().describe("A concise 3-5 sentence summary of the meeting."),
  actionItems: z.array(z.string()).describe("Concrete action items / next steps."),
  keywords: z.array(z.string()).describe("Topics, brands, products or campaigns mentioned."),
});

/** Produce summary/action-items/keywords, preferring the AI pass but falling back to provider data. */
async function analyze(t: FirefliesTranscript, clientId: string | null) {
  const model = process.env.TRANSCRIPT_MODEL || MODELS.SONNET;
  try {
    const { object, usage } = await generateObject({
      model: anthropic(model),
      schema: analysisSchema,
      system:
        "You are an analyst for a marketing agency. Summarise client meeting transcripts and extract action items and key topics that the agency should act on.",
      prompt: `Meeting: ${t.title}\nParticipants: ${t.participants.join(", ")}\n\nTranscript:\n${t.text.slice(0, 18000)}`,
    });
    logger.logUsage({
      clientId, agentId: null, agentName: "Transcript Analysis",
      modelName: model, operation: "transcript_analysis",
      inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
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
 * Parse a flat action items array into a Record<ownerName, tasks[]>.
 * Recognises patterns: "Name: task", "@name — task", "Action for Name: task".
 * Unrecognised items fall under "Unassigned".
 */
export function parseActionItemsByOwner(items: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const patterns = [
    /^([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?):\s+(.+)$/,
    /^@([A-Za-z]+(?:\s[A-Za-z]+)?)\s+[—–-]\s+(.+)$/,
    /^Action (?:for|item|items?) (?:for )?([A-Za-z]+(?:\s[A-Za-z]+)?):\s+(.+)$/i,
  ];

  for (const item of items) {
    let matched = false;
    for (const pattern of patterns) {
      const m = item.match(pattern);
      if (m) {
        const owner = m[1].trim();
        const task = m[2].trim();
        if (!result[owner]) result[owner] = [];
        result[owner].push(task);
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (!result["Unassigned"]) result["Unassigned"] = [];
      result["Unassigned"].push(item);
    }
  }
  return result;
}

/**
 * Derive a parallel actionItemOwners[] array from a flat actionItems[] and an owner grouping.
 * Used for backward-compat when only actionItemsByOwner is stored.
 */
export function deriveActionItemOwners(
  actionItems: string[],
  actionItemsByOwner: Record<string, string[]>,
): (string | null)[] {
  return actionItems.map((item) => {
    for (const [owner, tasks] of Object.entries(actionItemsByOwner)) {
      if (tasks.includes(item)) return owner === "Unassigned" ? null : owner;
    }
    return null;
  });
}

/**
 * Build actionItemsByOwner snapshot from a flat parallel structure.
 * Used to keep the snapshot in sync when individual items are reassigned.
 */
export function buildActionItemsByOwner(
  actionItems: string[],
  owners: (string | null)[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  actionItems.forEach((item, i) => {
    const owner = owners[i] ?? "Unassigned";
    if (!result[owner]) result[owner] = [];
    result[owner].push(item);
  });
  return result;
}

/** Extract the first name component from a display name or email prefix. */
function extractFirstName(nameOrEmail: string): string {
  const base = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0] : nameOrEmail;
  return base.split(/[\s._-]/)[0].toLowerCase();
}

/**
 * Match owner names (from parsed action items) to AppUser accounts.
 * Dedup invariant: exactly 1 first-name match required; 0 or ≥2 → not matched.
 */
function matchOwnersToUsers(
  ownerGroups: Record<string, string[]>,
  users: AppUser[],
): Record<string, string> {
  const userMap: Record<string, string> = {};
  for (const ownerName of Object.keys(ownerGroups)) {
    if (ownerName === "Unassigned") continue;
    const ownerFirst = extractFirstName(ownerName);
    const matched = users.filter((u) => {
      const userFirst = extractFirstName(u.name ?? u.email);
      return userFirst === ownerFirst;
    });
    if (matched.length === 1) {
      userMap[ownerName] = matched[0].uid;
    }
    // 0 or ≥2 matches → dedup invariant: skip
  }
  return userMap;
}

/**
 * Match a transcript to a client by scanning its title and the first 2000 chars of text
 * for an exact (case-insensitive) client company name.
 * Default is unassigned; unambiguous single match only.
 */
async function matchClientByCompanyName(
  title: string,
  text: string,
  clients: Client[],
): Promise<Client | null> {
  const haystack = `${title} ${text.slice(0, 2000)}`;
  const matches = clients.filter((c) => {
    const name = c.name.trim();
    if (name.length < 8) return false;
    // Escape regex special chars; use word boundary + case-insensitive for precision
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Append a meeting transcript as a dated signal to the client's "meeting-notes" context doc.
 * Creates the doc if it doesn't exist yet. Tier is always "internal-only".
 */
export async function appendMeetingSignalToContextDoc(
  clientId: string,
  transcript: Transcript & { id: string },
): Promise<void> {
  const date = new Date(transcript.meetingDate ?? transcript.createdAt).toISOString().slice(0, 10);
  const ownerGroups =
    transcript.actionItemsByOwner ??
    (transcript.actionItems?.length ? parseActionItemsByOwner(transcript.actionItems) : {});

  const actionBlock = Object.entries(ownerGroups)
    .map(([owner, tasks]) => `**${owner}:**\n${tasks.map((t) => `- ${t}`).join("\n")}`)
    .join("\n\n");

  const lines = [
    "",
    "---",
    "",
    `## Meeting Signal - ${date}`,
    `**Title:** ${transcript.title}`,
  ];
  if (transcript.participants.length) lines.push(`**Participants:** ${transcript.participants.join(", ")}`);
  if (transcript.durationMin) lines.push(`**Duration:** ${transcript.durationMin} min`);
  if (transcript.summary) lines.push("", `**Summary:** ${transcript.summary}`);
  if (actionBlock) lines.push("", `### Action Items by Owner`, "", actionBlock);
  if (transcript.keywords?.length) lines.push("", `**Topics:** ${transcript.keywords.join(", ")}`);

  const signal = lines.join("\n");
  // meeting-notes is written back as "internal-only" below — read the same tier.
  const existingDoc = await getClientContextDoc(clientId, "meeting-notes", "internal-only");
  const now = Date.now();

  await upsertClientContextDoc({
    clientId,
    docType: "meeting-notes",
    tier: "internal-only",
    content: existingDoc
      ? existingDoc.content + signal
      : `# Meeting Notes & Signals\n\n_Auto-generated from transcripts. Read by the AI pipeline on regeneration._${signal}`,
    version: (existingDoc?.version ?? 0) + 1,
    sources: existingDoc?.sources,
    createdAt: existingDoc?.createdAt ?? now,
    updatedAt: now,
  });
}

/**
 * Full ingestion: analyse the transcript, match client by company name (text-based, unambiguous),
 * and persist. Returns the created transcript id and the match.
 *
 * Duplicate guard: skips only when the same recording (externalId) already exists —
 * same-title recurring meetings are always ingested as separate meetings, since only
 * externalId identifies a specific recording. Returns `duplicate: true` with the existing id.
 *
 * Default assignment is "unassigned". Client is only set when exactly one client name is found
 * in the transcript title/text.
 */
export async function ingestTranscript(
  t: FirefliesTranscript,
  source: Transcript["source"] = "fireflies",
): Promise<{ id: string; clientId: string | null; matched: boolean; duplicate?: boolean }> {
  const existing = await findDuplicateTranscript({
    externalId: t.externalId,
    title: t.title,
    meetingDate: t.date,
  });
  if (existing) {
    return { id: existing.id, clientId: existing.clientId ?? null, matched: !!existing.clientId, duplicate: true };
  }

  // clientId is resolved by name-matching further below; transcript analysis runs
  // before that match, so it is logged as an unattributed (system) ingestion cost.
  const analysis = await analyze(t, null);
  const actionItemsByOwner = parseActionItemsByOwner(analysis.actionItems);

  // Build per-item parallel owners array
  const actionItemOwners: (string | null)[] = analysis.actionItems.map((item) => {
    for (const [owner, tasks] of Object.entries(actionItemsByOwner)) {
      if (tasks.includes(item)) return owner === "Unassigned" ? null : owner;
    }
    return null;
  });

  // Text-based client matching (default: unassigned)
  const [clients, users] = await Promise.all([listClients(), listUsers()]);
  const matchedClient = await matchClientByCompanyName(t.title, t.text, clients);

  // Map owner names to user accounts
  const actionItemUserMap = matchOwnersToUsers(actionItemsByOwner, users);

  const transcriptData = {
    title: t.title,
    source,
    externalId: t.externalId,
    clientId: matchedClient?.id ?? null,
    assignment: matchedClient ? "auto" : ("unassigned" as const),
    meetingDate: t.date,
    durationMin: t.durationMin,
    participants: t.participants,
    rawText: t.text,
    summary: analysis.summary,
    actionItems: analysis.actionItems,
    actionItemsByOwner,
    actionItemOwners,
    actionItemUserMap,
    keywords: analysis.keywords,
    createdAt: Date.now(),
  } satisfies Omit<Transcript, "id">;

  const id = await createTranscript(transcriptData);

  // Promote extracted items to managed action-item docs (status / comments / history).
  try {
    await createActionItemDocsForTranscript(id, transcriptData);
  } catch (e) {
    console.error("[ingest] managed action-item creation failed (transcript stored)", e);
  }

  return { id, clientId: matchedClient?.id ?? null, matched: !!matchedClient };
}

