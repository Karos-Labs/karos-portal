import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { JobSpec } from "../../src/types.js";

/** Read-only client knowledge tools available to a production agent. */
export const KAROS_MCP_ALLOWED_TOOLS = [
  "mcp__karos__get_client",
  "mcp__karos__list_client_context",
  "mcp__karos__get_client_context_docs",
  "mcp__karos__list_assets",
  "mcp__karos__get_asset",
  "mcp__karos__list_jobs",
  "mcp__karos__get_job",
] as const;

export function karosMcpServers(spec: JobSpec): Record<string, McpServerConfig> | undefined {
  if (!spec.karosMcp) return undefined;
  return {
    karos: {
      type: "http",
      url: spec.karosMcp.url,
      headers: { Authorization: `Bearer ${spec.karosMcp.token}` },
      alwaysLoad: true,
      timeout: 60_000,
    },
  };
}
