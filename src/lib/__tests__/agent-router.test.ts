import { describe, expect, it } from "vitest";
import { resolveAgentByName, routeAgentRun } from "@/lib/agent-router";
import type { ClientCustomAgentSummary } from "@/lib/agent-roster";

/**
 * SCRUM-251 [T-B7]: routing tests for the C4-capability-aware replacement of
 * `run_agent_now`'s old bare substring name match. See agent-router.ts's own
 * doc comment for the full design; this file is the behavioural proof the
 * ticket's acceptance criteria ask for.
 */

function agent(patch: Partial<ClientCustomAgentSummary>): ClientCustomAgentSummary {
  return {
    id: "ca_1",
    key: "ca-1",
    name: "Video Agent",
    description: "does things",
    ...patch,
  };
}

describe("resolveAgentByName — exact, not substring", () => {
  const agents = [agent({ id: "ca_1", name: "Video Agent" }), agent({ id: "ca_2", name: "Instagram Poster" })];

  it("matches on exact name (case/whitespace-insensitive)", () => {
    expect(resolveAgentByName(agents, "  video agent  ")?.id).toBe("ca_1");
    expect(resolveAgentByName(agents, "INSTAGRAM POSTER")?.id).toBe("ca_2");
  });

  it("does NOT match a query that is merely a substring of the name", () => {
    // The old code (`a.name.toLowerCase().includes(q)`) would have matched
    // "video" against "Video Agent". Exact resolution must not.
    expect(resolveAgentByName(agents, "video")).toBeUndefined();
    expect(resolveAgentByName(agents, "insta")).toBeUndefined();
  });

  it("does NOT match a query for which the name is merely a substring either", () => {
    expect(resolveAgentByName(agents, "video agent extended")).toBeUndefined();
  });
});

describe("routeAgentRun — capability gate (AC #2: a video request is refused, not fallen back to name)", () => {
  it("refuses a produce_video request against an agent that lacks produce_video, with a stated reason", () => {
    const agents = [agent({ id: "ca_1", name: "Blog Writer", capabilities: ["produce_text"] })];
    const outcome = routeAgentRun(agents, { agentQuery: "Blog Writer", requestedCapability: "produce_video" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.kind).toBe("capability_mismatch");
    // A stated reason — names the agent, says it can't do video, says what it CAN do.
    expect(outcome.reason).toContain("Blog Writer");
    expect(outcome.reason.toLowerCase()).toContain("video");
    expect(outcome.reason).toContain("text");
  });

  it("runs when the matched agent DOES declare the requested capability", () => {
    const agents = [agent({ id: "ca_1", name: "Video Agent", capabilities: ["produce_video", "produce_text"] })];
    const outcome = routeAgentRun(agents, { agentQuery: "Video Agent", requestedCapability: "produce_video" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.agent.id).toBe("ca_1");
  });

  it("does not gate on capability at all when the caller doesn't name one (generic run request)", () => {
    const agents = [agent({ id: "ca_1", name: "Blog Writer", capabilities: ["produce_text"] })];
    const outcome = routeAgentRun(agents, { agentQuery: "Blog Writer" });
    expect(outcome.ok).toBe(true);
  });

  /**
   * The distinction the ticket asked to be stated explicitly: "no descriptor"
   * (empty capabilities — T-B6's honest "not yet described" state) is NOT
   * ROUTABLE, a different outcome from "genuinely doesn't do this"
   * (capability_mismatch above). Conflating the two would either wrongly run
   * an unconfigured agent or wrongly tell an unconfigured agent's owner it
   * "can't do video" when the truth is nobody has said what it can do yet.
   */
  it("treats an agent with capabilities: [] (no descriptor at all) as NOT ROUTABLE — a different outcome from a genuine mismatch", () => {
    const agents = [agent({ id: "ca_1", name: "Mystery Agent", capabilities: [] })];
    const outcome = routeAgentRun(agents, { agentQuery: "Mystery Agent", requestedCapability: "produce_video" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.kind).toBe("not_routable");
    expect(outcome.kind).not.toBe("capability_mismatch");
    expect(outcome.reason).toContain("Mystery Agent");
  });

  it("also treats capabilities left null/undefined (custom agent, pre-population) as not routable", () => {
    const agents = [agent({ id: "ca_1", name: "Mystery Agent", capabilities: null })];
    const outcome = routeAgentRun(agents, { agentQuery: "Mystery Agent", requestedCapability: "produce_video" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.kind).toBe("not_routable");
  });

  it("never falls back to running the name-matched agent when the capability gate fails", () => {
    const agents = [agent({ id: "ca_1", name: "Blog Writer", capabilities: ["produce_text"] })];
    const outcome = routeAgentRun(agents, { agentQuery: "Blog Writer", requestedCapability: "produce_video" });
    expect(outcome.ok).toBe(false);
  });
});

describe("routeAgentRun — platform gate", () => {
  it("refuses a platform the matched agent's non-empty platforms list doesn't include", () => {
    const agents = [agent({ id: "ca_1", name: "IG Agent", platforms: ["instagram"] })];
    const outcome = routeAgentRun(agents, { agentQuery: "IG Agent", requestedPlatform: "tiktok" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.kind).toBe("platform_mismatch");
    expect(outcome.reason).toContain("tiktok");
  });

  it("is permissive when platforms is empty/absent — agnostic, not 'not yet described'", () => {
    const agents = [agent({ id: "ca_1", name: "Any Agent", platforms: [] })];
    const outcome = routeAgentRun(agents, { agentQuery: "Any Agent", requestedPlatform: "tiktok" });
    expect(outcome.ok).toBe(true);
    const agents2 = [agent({ id: "ca_1", name: "Any Agent", platforms: null })];
    expect(routeAgentRun(agents2, { agentQuery: "Any Agent", requestedPlatform: "tiktok" }).ok).toBe(true);
  });
});

describe("routeAgentRun — required-input check (AC #3: missing inputs prompt instead of proceeding)", () => {
  it("blocks the run and asks for the specific missing keys when requiredInputs are not all present", () => {
    const agents = [agent({ id: "ca_1", name: "Landing Page Agent", requiredInputs: ["page_goal", "offer"] })];
    const outcome = routeAgentRun(agents, {
      agentQuery: "Landing Page Agent",
      briefValues: { page_goal: "collect signups" },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.kind).toBe("missing_inputs");
    expect(outcome.reason).toContain("offer");
    expect(outcome.reason).not.toContain("page_goal, offer");
  });

  it("blocks the run when briefValues is omitted entirely and inputs are required", () => {
    const agents = [agent({ id: "ca_1", name: "Landing Page Agent", requiredInputs: ["page_goal"] })];
    const outcome = routeAgentRun(agents, { agentQuery: "Landing Page Agent" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.kind).toBe("missing_inputs");
  });

  it("proceeds once every required key is present", () => {
    const agents = [agent({ id: "ca_1", name: "Landing Page Agent", requiredInputs: ["page_goal", "offer"] })];
    const outcome = routeAgentRun(agents, {
      agentQuery: "Landing Page Agent",
      briefValues: { page_goal: "collect signups", offer: "20% off", extra_ignored: "x" },
    });
    expect(outcome.ok).toBe(true);
  });

  it("has nothing to require when requiredInputs is empty/absent — runs with no briefValues at all", () => {
    const agents = [agent({ id: "ca_1", name: "No Input Agent", requiredInputs: [] })];
    expect(routeAgentRun(agents, { agentQuery: "No Input Agent" }).ok).toBe(true);
    const agents2 = [agent({ id: "ca_1", name: "No Input Agent", requiredInputs: null })];
    expect(routeAgentRun(agents2, { agentQuery: "No Input Agent" }).ok).toBe(true);
  });
});

describe("routeAgentRun — not found (message parity with the pre-T-B7 behavior)", () => {
  it("names the client's available agents when there are some", () => {
    const agents = [agent({ id: "ca_1", name: "Video Agent" })];
    const outcome = routeAgentRun(agents, { agentQuery: "Nonexistent" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.kind).toBe("not_found");
    expect(outcome.reason).toContain("Video Agent");
  });

  it("says the client has no agents at all when the roster is empty", () => {
    const outcome = routeAgentRun([], { agentQuery: "anything" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.kind).toBe("not_found");
    expect(outcome.reason).toBe("This client has no AI agents assigned yet.");
  });
});
