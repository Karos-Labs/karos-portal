import "server-only";

/**
 * Thin client for the Anthropic Managed Agents API (beta).
 * The agent itself is a persisted, versioned object created in the Claude
 * Console — we only start sessions against it and read the event stream.
 * Docs: platform.claude.com/docs/en/managed-agents
 */

const API_BASE = "https://api.anthropic.com/v1";

/**
 * "Instagram/TikTok Content Agent" + its environment (Claude Console, org
 * workspace). The agent is client-agnostic: it reads brand context from the
 * attached memory store + files at runtime, and its credential vault injects
 * the external service keys its skills use (Apify, Unsplash, …). Without the
 * memory store + vault attached it falls back to DRY-RUN sample output.
 */
export const MANAGED_AGENT_ID =
  process.env.KAROS_MANAGED_AGENT_ID ?? "agent_01Q3FdoRFCuJd8Zq1oXZiooB";
export const MANAGED_AGENT_ENV_ID =
  process.env.KAROS_MANAGED_AGENT_ENV_ID ?? "env_01Pdktr1ZWKELTs63sdAvYT7";
/** "ig-tt-mem" — shipped-post ledger, format rotation, topic pool. */
export const MANAGED_AGENT_MEMORY_ID =
  process.env.KAROS_MANAGED_AGENT_MEMORY_ID ?? "memstore_01LggEFGs1ovotXSCm6FtDT4";
/** "tiktok_insta_vault" — APIFY_API, UNSPLASH_ACCESS_KEY, etc. */
export const MANAGED_AGENT_VAULT_ID =
  process.env.KAROS_MANAGED_AGENT_VAULT_ID ?? "vlt_011CcZhqSWkSHG7ocGCtq7Hx";

function headers() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "managed-agents-2026-04-01",
    "content-type": "application/json",
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export type ManagedSessionStatus = "idle" | "running" | "rescheduling" | "terminated";

interface SessionEvent {
  id: string;
  type: string;
  content?: Array<{ type: string; text?: string }>;
  name?: string;
  stop_reason?: { type: string };
  error?: { message?: string };
}

/** Create a session against the managed agent and send the kickoff message. */
export async function startManagedAgentSession(input: {
  title: string;
  kickoff: string;
}): Promise<{ sessionId: string }> {
  const session = await api<{ id: string }>("/sessions", {
    method: "POST",
    body: JSON.stringify({
      agent: MANAGED_AGENT_ID,
      environment_id: MANAGED_AGENT_ENV_ID,
      title: input.title,
      // Memory store must be attached at create time (not addable later).
      resources: [
        {
          type: "memory_store",
          memory_store_id: MANAGED_AGENT_MEMORY_ID,
          access: "read_write",
        },
      ],
      vault_ids: [MANAGED_AGENT_VAULT_ID],
    }),
  });

  await sendManagedAgentMessage(session.id, input.kickoff);

  return { sessionId: session.id };
}

/** Send a follow-up user message to a session (e.g. approving drafts). */
export async function sendManagedAgentMessage(sessionId: string, text: string): Promise<void> {
  await api(`/sessions/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
}

export interface ManagedAgentRunSnapshot {
  status: ManagedSessionStatus;
  /** True once the agent has finished (idle without pending action, or terminated). */
  done: boolean;
  /** Agent text output, in order. */
  messages: string[];
  /** Most recent tool the agent used — for lightweight progress display. */
  lastTool?: string;
  error?: string;
}

/** Poll a session: current status + all agent text messages so far. */
export async function getManagedAgentSnapshot(
  sessionId: string,
): Promise<ManagedAgentRunSnapshot> {
  const [session, events] = await Promise.all([
    api<{ status: ManagedSessionStatus }>(`/sessions/${sessionId}`),
    api<{ data: SessionEvent[] }>(`/sessions/${sessionId}/events?limit=1000`),
  ]);

  const messages: string[] = [];
  let lastTool: string | undefined;
  let error: string | undefined;
  let awaitingAction = false;

  for (const ev of events.data) {
    if (ev.type === "agent.message") {
      const text = (ev.content ?? [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("");
      if (text) messages.push(text);
    } else if (ev.type === "agent.tool_use" && ev.name) {
      lastTool = ev.name;
    } else if (ev.type === "session.error") {
      error = ev.error?.message ?? "Agent session error";
    } else if (ev.type === "session.status_idle") {
      awaitingAction = ev.stop_reason?.type === "requires_action";
    }
  }

  const done =
    session.status === "terminated" || (session.status === "idle" && !awaitingAction);

  return { status: session.status, done, messages, lastTool, error };
}
