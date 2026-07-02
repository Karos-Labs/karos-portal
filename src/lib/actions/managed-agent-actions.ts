"use server";

import { getClient } from "@/lib/data";
import {
  startManagedAgentSession,
  getManagedAgentSnapshot,
  sendManagedAgentMessage,
  type ManagedAgentRunSnapshot,
} from "@/lib/anthropic/managed-agents";
import { requireStaff } from "./_shared";

/**
 * NOTE: these actions return errors as data ({ error }) instead of throwing.
 * Thrown server-action errors are masked in production builds ("An error
 * occurred in the Server Components render…"), which hides the real cause
 * from the UI. Returning them keeps the message visible to staff.
 */

export async function startManagedAgentRunAction(input: {
  clientId: string;
  instructions?: string;
}): Promise<{ sessionId: string; error?: never } | { sessionId?: never; error: string }> {
  try {
    await requireStaff();
    const client = await getClient(input.clientId);
    if (!client) return { error: "Client not found" };

    const context = [
      `Client: ${client.name}`,
      client.website ? `Website: ${client.website}` : null,
      client.industry ? `Industry: ${client.industry}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    // The agent's own system prompt defines the content loop (FIND → SCRIPT →
    // approve → SOURCE → RENDER → QA) — the kickoff just hands over the client
    // and any run-specific steering from staff. It pauses for draft approval;
    // reply via sendManagedAgentMessageAction.
    const task =
      input.instructions?.trim() ||
      "Run your content loop for this client and present the next batch of drafts for approval.";

    const kickoff = `${context}\n\n${task}`;

    return await startManagedAgentSession({
      title: `IG/TikTok content — ${client.name}`,
      kickoff,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to start the agent run" };
  }
}

/** Reply to a paused run — e.g. approving or revising the presented drafts. */
export async function sendManagedAgentMessageAction(
  sessionId: string,
  text: string,
): Promise<{ ok: true; error?: never } | { ok?: never; error: string }> {
  try {
    await requireStaff();
    if (!text.trim()) return { error: "Message is empty" };
    await sendManagedAgentMessage(sessionId, text.trim());
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to send the message" };
  }
}

/** Poll a managed-agent session for status and output. */
export async function getManagedAgentRunAction(
  sessionId: string,
): Promise<ManagedAgentRunSnapshot> {
  try {
    await requireStaff();
    return await getManagedAgentSnapshot(sessionId);
  } catch (e) {
    return {
      status: "terminated",
      done: true,
      messages: [],
      error: e instanceof Error ? e.message : "Failed to poll the agent run",
    };
  }
}
