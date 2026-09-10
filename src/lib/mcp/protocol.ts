import "server-only";

import { z } from "zod";
import type { McpActor, McpActorKind } from "./auth";

/**
 * A minimal, dependency-free MCP server over Streamable HTTP (stateless mode):
 * plain JSON-RPC 2.0 request→response, no sessions, no SSE. That's all the
 * Karos tool surface needs, and it runs on any runtime (Cloud Run friendly)
 * without the `mcp-handler`/Redis machinery the old server carried.
 *
 * This module is the transport-agnostic core — it turns one decoded JSON-RPC
 * message plus an authenticated actor into a response object (or null for
 * notifications). The route handler (`src/app/api/mcp/route.ts`) owns HTTP.
 */

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "karos", title: "Karos CMO", version: "1.0.0" } as const;

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  /** Which actor kinds may list and call this tool. */
  actors: McpActorKind[];
  /** Zod schema — validates arguments and is emitted as the JSON Schema `inputSchema`. */
  schema: z.ZodType;
  handler: (args: unknown, actor: McpActor) => Promise<ToolResult>;
}

/** Throw from a tool handler to return a clean `isError` result the model can recover from. */
export class ToolError extends Error {}

export function textResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

type JsonRpcId = string | number | null;

interface RpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: JsonRpcId, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function fail(id: JsonRpcId, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function inputSchema(tool: McpTool): Record<string, unknown> {
  const js = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  delete js.$schema; // MCP wants a bare JSON Schema object
  return js;
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null when there
 * is nothing to send back (notifications — which carry no `id`).
 */
export async function dispatch(
  message: unknown,
  ctx: { tools: McpTool[]; actor: McpActor },
): Promise<RpcResponse | null> {
  if (
    !message ||
    typeof message !== "object" ||
    (message as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
    typeof (message as { method?: unknown }).method !== "string"
  ) {
    // A malformed frame with an id gets an error; anything else is ignored.
    const rawId = (message as { id?: JsonRpcId } | null)?.id;
    return rawId === undefined ? null : fail(rawId ?? null, -32600, "Invalid Request");
  }

  const { method, id, params } = message as { method: string; id?: JsonRpcId; params?: Record<string, unknown> };
  const isNotification = id === undefined;

  switch (method) {
    case "initialize": {
      const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return ok(id ?? null, {
        // Echo the client's protocol version when it sends one — best compatibility.
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return isNotification ? null : ok(id ?? null, {});

    case "tools/list": {
      if (isNotification) return null;
      const tools = ctx.tools
        .filter((t) => t.actors.includes(ctx.actor.kind))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t) }));
      return ok(id ?? null, { tools });
    }

    case "tools/call": {
      if (isNotification) return null;
      const name = (params as { name?: unknown } | undefined)?.name;
      const tool = ctx.tools.find((t) => t.name === name);
      if (!tool) return ok(id ?? null, errorResult(`Unknown tool: ${String(name)}`));
      if (!tool.actors.includes(ctx.actor.kind)) {
        return ok(id ?? null, errorResult(`Tool "${tool.name}" is not available for your credentials.`));
      }
      const parsed = tool.schema.safeParse((params as { arguments?: unknown } | undefined)?.arguments ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return ok(id ?? null, errorResult(`Invalid arguments — ${detail}`));
      }
      try {
        return ok(id ?? null, await tool.handler(parsed.data, ctx.actor));
      } catch (e) {
        const msg = e instanceof ToolError ? e.message : e instanceof Error ? e.message : "Tool failed";
        return ok(id ?? null, errorResult(msg));
      }
    }

    default:
      return isNotification ? null : fail(id ?? null, -32601, `Method not found: ${method}`);
  }
}
