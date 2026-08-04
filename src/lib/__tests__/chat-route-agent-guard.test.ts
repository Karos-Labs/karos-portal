import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Both agent-triggered task-creation flows — the copilot chat's `create_tasks`
 * tool and the Strategy War Room / Agent Swarm (persistSwarmTasks, pinned by
 * agent-swarm.test.ts's "ignores a hallucinated customAgentId" case) — must
 * never let a task's metadata.customAgentId name a DISABLED custom agent.
 *
 * The swarm path is already fully proven by two existing tests together:
 * agent-roster.test.ts shows `getClientCustomAgents` drops disabled agents
 * from its result, and agent-swarm.test.ts shows `persistSwarmTasks` drops
 * any customAgentId not present in that same result. This file closes the
 * other half — the chat route has no dedicated test, and it is 1000+ lines
 * with a heavy Firestore dependency graph, so (matching the existing
 * source-scan precedent in credit-attribution.test.ts for this same file)
 * this pins the STRUCTURE rather than driving the route end-to-end: the
 * tool's executor allowlist must be built from `getClientCustomAgents` (the
 * one function proven to exclude disabled agents), and every write of
 * `metadata.customAgentId` must be gated on that same allowlist.
 */

const REPO = join(__dirname, "..", "..", "..");
const CHAT_ROUTE = "src/app/api/clients/[id]/chat/route.ts";
const source = () => readFileSync(join(REPO, CHAT_ROUTE), "utf8");

describe("copilot chat's create_tasks tool only assigns agents the client may actually run", () => {
  it("resolves its custom-agent roster through getClientCustomAgents (enabled + granted only)", () => {
    const src = source();
    expect(src).toContain("getClientCustomAgents(clientId)");
    // The destructured `customAgents` binding is what the executor allowlist,
    // the price list and the @mention roster all read from — so this one
    // call is the route's single source of "which custom agents exist" here.
    expect(src).toMatch(/const \[[^\]]*\bcustomAgents\b[^\]]*\]\s*=\s*\n?\s*await Promise\.all/);
  });

  it("builds create_tasks's executor allowlist from that same customAgents binding", () => {
    const src = source();
    expect(src).toMatch(/customAgentsById\s*=\s*new Map\(customAgents\.map/);
  });

  it("re-checks every agentId against that allowlist before dedup AND before the write", () => {
    const src = source();
    const toolStart = src.indexOf("const createTasksTool");
    const toolEnd = src.indexOf("/* ── Capability-matrix");
    expect(toolStart, "createTasksTool not found").toBeGreaterThan(-1);
    expect(toolEnd, "capability-matrix section marker not found").toBeGreaterThan(toolStart);
    const body = src.slice(toolStart, toolEnd);
    // Dedup-time: a client-lacking or disabled agentId must not shadow a
    // later duplicate as though it were a real, assignable executor.
    expect(body).toMatch(/customAgentsById\.has\(t\.agentId\)/);
    // Persist-time: the actual metadata.customAgentId write.
    expect(body).toMatch(/customAgentsById\.get\(t\.agentId\)/);
  });

  it("the @mention focus default cannot bypass the allowlist - it only fills a gap the write-time check still re-validates", () => {
    const src = source();
    const toolStart = src.indexOf("const createTasksTool");
    const toolEnd = src.indexOf("/* ── Capability-matrix");
    const body = src.slice(toolStart, toolEnd);
    // withFocusDefault assigns focusedAgent.customAgentId when nothing was
    // named explicitly, but that assignment still flows through the same
    // `customAgentsById.get(t.agentId)` gate a few lines later - proven by
    // the previous test. This test only pins that the default exists and
    // precedes the allowlist checks (not a separate, unguarded write path).
    const focusDefaultIndex = body.indexOf("withFocusDefault");
    const allowlistIndex = body.indexOf("customAgentsById.has(t.agentId)");
    expect(focusDefaultIndex, "focus default assignment not found").toBeGreaterThan(-1);
    expect(allowlistIndex).toBeGreaterThan(focusDefaultIndex);
  });
});
