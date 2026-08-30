import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./source-scan";

/**
 * SCRUM-251 [T-B7]: `run_agent_now` (the copilot chat tool that actually
 * dispatches a custom-agent run) used to decide whether to run purely on
 * `customAgents.find((a) => a.name.toLowerCase().includes(q))` — a bare
 * substring test against the agent's name, with no regard for whether the
 * matched agent could produce what was asked or had the inputs it needed to
 * start. The real routing logic (capability/platform gates,
 * required-input check, and non-substring name resolution) now lives in
 * `src/lib/agent-router.ts` — see `agent-router.test.ts` for behavioural
 * proof of the gates themselves. This file pins the WIRING at the
 * run-dispatching call site: the substring line is gone and `routeAgentRun`
 * is what decides instead — matching the existing source-scan precedent for
 * this same 1700+ line file (chat-route-run-agent-now.test.ts,
 * chat-route-agent-guard.test.ts).
 *
 * SCOPE NOTE: `setAgentFocusTool` (the `focus`/`clear` tool, further down the
 * same file) has its own, similar-looking
 * `customAgents.find((a) => a.name.toLowerCase().includes(q))` line. It is
 * deliberately OUT OF SCOPE for this ticket and left untouched: it never
 * dispatches a run, never touches credits, and never needs a capability or
 * required-input check — it only decides which agent's name the *chat UI*
 * conversationally centers on. Routing-by-capability has no meaning for an
 * action that doesn't execute anything. This test only asserts on
 * `runAgentNowTool`'s body, not the whole file, so it does not accidentally
 * demand that unrelated line's removal.
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

describe("run_agent_now no longer decides by substring name match", () => {
  it("the bare substring-match line is gone from run_agent_now's body", () => {
    const body = stripComments(runAgentNowToolBody(source()));
    // The exact shape of the old defect: `.find(... a.name...includes(q))`.
    expect(body).not.toMatch(/\.find\(\s*\(?[^)]*\)?\s*=>\s*[^)]*\.name[^)]*\.includes\(/);
    // Belt: the old query-normalization variable name is gone too, not just
    // relocated under a different predicate that still substring-matches.
    expect(body).not.toMatch(/const\s+q\s*=\s*agentQuery\.trim\(\)\.toLowerCase\(\)/);
  });

  it("run_agent_now routes through routeAgentRun instead", () => {
    const body = runAgentNowToolBody(source());
    expect(body).toMatch(/routeAgentRun\(\s*customAgents\s*,/);
  });

  it("imports routeAgentRun from the new agent-router module", () => {
    expect(source()).toMatch(/import\s*\{\s*routeAgentRun\s*\}\s*from\s*"@\/lib\/agent-router"/);
  });

  it("still threads contextItemIds/briefValues through to runCustomAgentAction (no regression on T-B8's wiring)", () => {
    const body = runAgentNowToolBody(source());
    const callStart = body.indexOf("runCustomAgentAction({");
    expect(callStart, "runCustomAgentAction call not found").toBeGreaterThan(-1);
    const call = body.slice(callStart, body.indexOf("});", callStart));
    expect(call).toMatch(/contextItemIds/);
    expect(call).toMatch(/briefValues/);
  });
});

describe("the OTHER similar-looking substring match (setAgentFocusTool) is deliberately untouched", () => {
  it("still exists, unchanged in shape, because focusing is not a routable action", () => {
    const src = source();
    const start = src.indexOf("const setAgentFocusTool");
    expect(start, "setAgentFocusTool not found").toBeGreaterThan(-1);
    const end = src.indexOf("/* ── onFinish", start);
    const body = src.slice(start, end === -1 ? undefined : end);
    expect(body).toMatch(/customAgents\.find\(\(a\)\s*=>\s*a\.name\.toLowerCase\(\)\.includes\(q\)\)/);
  });
});
