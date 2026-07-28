import "server-only";

import { randomUUID } from "crypto";

import { listClientAgentFeedback } from "@/lib/data-client-agents";
import {
  FEEDBACK_CONTEXT_FILENAME,
  renderFeedbackMarkdown,
} from "@/lib/client-agent-feedback";
import { uploadBytes } from "@/lib/storage";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type { ClientAgent } from "@/lib/types";

/**
 * The two-level feedback a LIVE client agent carries into every run (§5).
 *
 * Deliberately the SAME seam the X agent's intake already uses — build a
 * markdown file, upload it, attach it as a `context_file` — rather than a
 * second mechanism. The agent service needs no change for this to work
 * (§8.1: context_files exist today), and the lab contract already treats
 * attached portal files as authoritative over repo copies.
 *
 * Returns [] when there is nothing active, so the submit core can append
 * unconditionally.
 */
export async function buildClientAgentFeedbackFiles(
  umbrella: Pick<ClientAgent, "id" | "clientId" | "displayName" | "templates">,
): Promise<AgentServiceContextFile[]> {
  const rows = await listClientAgentFeedback({ clientAgentId: umbrella.id, status: "active" });
  const markdown = renderFeedbackMarkdown({
    agentName: umbrella.displayName,
    rows,
    templates: umbrella.templates,
  });
  if (!markdown) return [];

  const { url } = await uploadBytes({
    bytes: Buffer.from(markdown, "utf8"),
    path: `clients/${umbrella.clientId}/client-agents/${umbrella.id}/feedback/${randomUUID()}/${FEEDBACK_CONTEXT_FILENAME}`,
    contentType: "text/markdown",
  });
  return [
    {
      name: FEEDBACK_CONTEXT_FILENAME,
      url,
      content_type: "text/markdown",
      description: `Standing feedback this client has given about their ${umbrella.displayName} — global direction first, then per-template notes. Apply all of it; it outranks generic guidance that contradicts it.`,
    },
  ];
}
