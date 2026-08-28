import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SCRUM-252 [T-B8]: the copilot chat's `run_agent_now` tool must be the same
 * job-submitting primitive MCP's `run_agent` already proved out (contextItemIds
 * + briefValues in, jobId out) — not a second, thinner path that drops all
 * three on the floor.
 *
 * Verified against the code before writing this (per the ticket's own
 * instruction): MCP's `run_agent` (src/lib/mcp/tools.ts) is `actors: ["staff"]`
 * and reached only via a bearer PAT (`resolveActor` in src/lib/mcp/auth.ts) —
 * a CLIENT_USER can never hold one, so promoting that PAT-gated tool itself
 * into the client-reachable chat surface is not the fix. The already-correct,
 * already-session-authorized primitive is `runCustomAgentAction`
 * (src/lib/actions/custom-agent-actions.ts) — it already accepts
 * `contextItemIds` and `briefValues` and already resolves `{ jobId }` via
 * `requireClientAccess`, no PAT involved. `run_agent_now`'s executor was
 * simply not threading either input through, and was discarding `result.jobId`
 * from its response. This file pins that the wiring exists, not the whole
 * route (matching the existing source-scan precedent in
 * chat-route-agent-guard.test.ts for this same 1000+ line file).
 *
 * This is a plumbing fix only — it does not depend on SCRUM-249 (file upload
 * in chat) or SCRUM-251 (required-input prompting) actually being wired up
 * yet; it makes the tool CAPABLE of carrying those values through once a
 * caller supplies them, and fixes the jobId drop, which is true today
 * regardless of either dependency's status.
 */

const REPO = join(__dirname, "..", "..", "..");
const CHAT_ROUTE = "src/app/api/clients/[id]/chat/route.ts";
const source = () => readFileSync(join(REPO, CHAT_ROUTE), "utf8");

function runAgentNowToolBody(src: string): string {
  const start = src.indexOf("const runAgentNowTool");
  expect(start, "runAgentNowTool not found").toBeGreaterThan(-1);
  const end = src.indexOf("const rescheduleOutputTool", start);
  expect(end, "rescheduleOutputTool (end marker) not found").toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("copilot chat's run_agent_now promotes the same primitive MCP's run_agent proved out", () => {
  it("accepts contextItemIds (files) in its input schema", () => {
    const body = runAgentNowToolBody(source());
    expect(body).toMatch(/contextItemIds\s*:\s*z\s*\.\s*array\(z\.string\(\)\)\s*\.optional\(\)/);
  });

  it("accepts briefValues (the brief) in its input schema", () => {
    const body = runAgentNowToolBody(source());
    expect(body).toMatch(/briefValues\s*:\s*z\s*\.\s*record\(/);
  });

  it("threads contextItemIds through to runCustomAgentAction", () => {
    const body = runAgentNowToolBody(source());
    const callStart = body.indexOf("runCustomAgentAction({");
    expect(callStart, "runCustomAgentAction call not found").toBeGreaterThan(-1);
    const callEnd = body.indexOf("});", callStart);
    const call = body.slice(callStart, callEnd);
    expect(call).toMatch(/contextItemIds/);
  });

  it("threads briefValues through to runCustomAgentAction", () => {
    const body = runAgentNowToolBody(source());
    const callStart = body.indexOf("runCustomAgentAction({");
    const callEnd = body.indexOf("});", callStart);
    const call = body.slice(callStart, callEnd);
    expect(call).toMatch(/briefValues/);
  });

  it("returns the new job id on a successful run instead of discarding it", () => {
    const body = runAgentNowToolBody(source());
    // The success-path return (after the `if (result.error)` branch) must
    // reference result.jobId — not just a generic confirmation string.
    const errorBranchEnd = body.indexOf("}", body.indexOf("if (result.error)"));
    const successReturn = body.slice(errorBranchEnd);
    expect(successReturn).toMatch(/result\.jobId/);
  });
});
