import { describe, expect, it } from "vitest";
import type { JobSpec } from "../src/types.js";
import { KAROS_MCP_ALLOWED_TOOLS, karosMcpServers } from "../runner/src/mcp.js";

function spec(): JobSpec {
  return {
    jobId: "job-1",
    taskType: "social_post",
    clientId: "client-1",
    brief: {},
    contextFiles: [],
    timeoutMs: 1000,
    callbackBaseUrl: "http://api:8080",
    runnerToken: "runner-token",
    attempt: 1,
    maxAttempts: 2,
  };
}

describe("Karos runner MCP", () => {
  it("configures authenticated streamable HTTP from the job spec", () => {
    const servers = karosMcpServers({
      ...spec(),
      karosMcp: { url: "https://app.example.com/api/mcp", token: "job-secret" },
    });
    expect(servers).toEqual({
      karos: {
        type: "http",
        url: "https://app.example.com/api/mcp",
        headers: { Authorization: "Bearer job-secret" },
        alwaysLoad: true,
        timeout: 60_000,
      },
    });
  });

  it("exposes client information tools but no write or job-submission tools", () => {
    expect(KAROS_MCP_ALLOWED_TOOLS).toContain("mcp__karos__get_client");
    expect(KAROS_MCP_ALLOWED_TOOLS.some((tool) => /upload|create|submit/.test(tool))).toBe(false);
    expect(karosMcpServers(spec())).toBeUndefined();
  });
});
