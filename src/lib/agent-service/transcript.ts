import "server-only";

import { agentServiceFetchHeaders } from "./client";
import type { Job } from "../types";

/**
 * Fetches and normalizes the full SDK run transcript for a managed job.
 *
 * The agent service streams every SDK message (assistant turns, reasoning,
 * tool calls, tool results) as NDJSON and seals it into `external.transcriptUrl`
 * — a GCS signed URL in production (fetchable directly, no auth, ~7-day TTL) or
 * an agent-service URL in local dev (needs the bearer token). We parse that into
 * a compact turn list the UI can render so staff can see what the agent thought
 * and how it produced its deliverables.
 */

export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; name: string; input: unknown; id?: string }
  | { kind: "tool_result"; text: string; isError: boolean; toolUseId?: string };

export interface TranscriptTurn {
  role: "assistant" | "user";
  blocks: TranscriptBlock[];
}

export type TranscriptResult =
  | { ok: true; turns: TranscriptTurn[]; truncated: boolean; rawUrl?: string }
  | { ok: false; reason: string; rawUrl?: string };

/** Guard against a runaway transcript blowing up the page. */
const MAX_TURNS = 600;
const MAX_BYTES = 8 * 1024 * 1024;

export async function fetchJobTranscript(job: Job): Promise<TranscriptResult> {
  const url = job.external?.transcriptUrl;
  if (!url) return { ok: false, reason: "No transcript was captured for this run." };

  let text: string;
  try {
    const res = await fetch(url, {
      headers: agentServiceFetchHeaders(url),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason:
          res.status === 403 || res.status === 404
            ? "The transcript link has expired or is no longer available."
            : `Could not load the transcript (HTTP ${res.status}).`,
        rawUrl: url,
      };
    }
    text = await res.text();
  } catch {
    return { ok: false, reason: "Could not reach the transcript store.", rawUrl: url };
  }

  const truncatedBytes = text.length > MAX_BYTES;
  if (truncatedBytes) text = text.slice(0, MAX_BYTES);

  const turns: TranscriptTurn[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (turns.length >= MAX_TURNS) break;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // partial trailing line from a byte-cap slice, or corrupt row
    }
    const turn = parseMessage(msg);
    if (turn) turns.push(turn);
  }

  return {
    ok: true,
    turns,
    truncated: truncatedBytes || turns.length >= MAX_TURNS,
    rawUrl: url,
  };
}

function parseMessage(msg: unknown): TranscriptTurn | null {
  if (!msg || typeof msg !== "object") return null;
  const type = (msg as { type?: unknown }).type;
  if (type !== "assistant" && type !== "user") return null; // drop system/init + result noise

  const content = (msg as { message?: { content?: unknown } }).message?.content;
  const blocks: TranscriptBlock[] = [];

  if (typeof content === "string") {
    if (content.trim()) blocks.push({ kind: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (typeof raw === "string") {
        if (raw.trim()) blocks.push({ kind: "text", text: raw });
        continue;
      }
      if (!raw || typeof raw !== "object") continue;
      const b = raw as Record<string, unknown>;
      switch (b.type) {
        case "text":
          if (typeof b.text === "string" && b.text.trim()) blocks.push({ kind: "text", text: b.text });
          break;
        case "thinking":
          if (typeof b.thinking === "string" && b.thinking.trim())
            blocks.push({ kind: "thinking", text: b.thinking });
          break;
        case "redacted_thinking":
          blocks.push({ kind: "thinking", text: "[redacted reasoning]" });
          break;
        case "tool_use":
          blocks.push({
            kind: "tool_use",
            name: typeof b.name === "string" ? b.name : "tool",
            input: b.input,
            ...(typeof b.id === "string" ? { id: b.id } : {}),
          });
          break;
        case "tool_result":
          blocks.push({
            kind: "tool_result",
            text: toolResultText(b.content),
            isError: b.is_error === true,
            ...(typeof b.tool_use_id === "string" ? { toolUseId: b.tool_use_id } : {}),
          });
          break;
      }
    }
  }

  if (blocks.length === 0) return null;
  return { role: type, blocks };
}

function toolResultText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const o = c as Record<string, unknown>;
          if (o.type === "text" && typeof o.text === "string") return o.text;
          if (o.type === "image") return "[image]";
          return JSON.stringify(o);
        }
        return String(c);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}
