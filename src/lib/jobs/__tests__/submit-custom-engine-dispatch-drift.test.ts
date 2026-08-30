import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SCRUM-249 (T-B5): `submit-custom.ts`'s three-part "does this run actually
 * dispatch to agent-engine" gate (`isAgentEngineDispatchEnabled() &&
 * client.agentsRepoSlug && isClientEnabledForEngineCustomAgents(...)`, then
 * `resolveAgentEngineProductIdForCustomAgent(agent.key)`) used to be
 * INLINED HERE ONLY — the copilot chat route re-derived its own, narrower
 * copy of the same idea (missing the client-cutover check), and the two
 * silently disagreed. A client told "attached as source media" by the chat
 * route could have that run fall through to the legacy agent-service path
 * right here, which never reads `mediaAssets`.
 *
 * The fix moves the decision into one function
 * (`resolveDispatchedAgentEngineProductId`, agent-engine/health.ts) that both
 * `submit-custom.ts` and the chat route now call. This test is the guard
 * against the fix being silently undone by a future edit that re-inlines the
 * predicate here instead of calling through — the shared function's own
 * behavior is exercised in agent-engine/__tests__/health.test.ts.
 */
const REPO = join(__dirname, "..", "..", "..", "..");
const SUBMIT_CUSTOM = "src/lib/jobs/submit-custom.ts";
const source = () => readFileSync(join(REPO, SUBMIT_CUSTOM), "utf8");

describe("submit-custom.ts derives engineProductId from the shared dispatch gate, not its own inline copy", () => {
  it("imports resolveDispatchedAgentEngineProductId from agent-engine/health", () => {
    expect(source()).toMatch(
      /import\s*\{\s*resolveDispatchedAgentEngineProductId\s*\}\s*from\s*["']@\/lib\/agent-engine\/health["']/,
    );
  });

  it("computes engineProductId by calling the shared function with (agent.key, client.agentsRepoSlug)", () => {
    const src = source();
    expect(src).toMatch(
      /const\s+engineProductId\s*=\s*resolveDispatchedAgentEngineProductId\(\s*agent\.key\s*,\s*client\.agentsRepoSlug\s*\)/,
    );
  });

  it("no longer re-derives the three-part predicate inline (isAgentEngineDispatchEnabled/isClientEnabledForEngineCustomAgents are not referenced directly in this file)", () => {
    const src = source();
    expect(src).not.toMatch(/isAgentEngineDispatchEnabled\(\)/);
    expect(src).not.toMatch(/isClientEnabledForEngineCustomAgents\(/);
  });
});
