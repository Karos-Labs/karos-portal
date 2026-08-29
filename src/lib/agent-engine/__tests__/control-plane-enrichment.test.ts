import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import { loadControlPlane, loadControlPlaneFacts } from "../control-plane-enrichment";
import { __resetMiddlewareTokenCache } from "../middleware-http";

const BASE = "https://agent-middleware-abc-uc.a.run.app";
const originalEnv = { ...process.env };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function agentRow(slug: string, extra: Record<string, unknown> = {}) {
  return { id: slug, slug, name: slug, status: "active", model: "claude-sonnet-4-6", ...extra };
}

beforeEach(() => {
  process.env.AGENT_MIDDLEWARE_URL = BASE;
  process.env.AGENT_MIDDLEWARE_DISPATCH_ENABLED = "true";
  delete process.env.AGENT_MIDDLEWARE_AUDIENCE;
  __resetMiddlewareTokenCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/** Answers the agent listing and per-agent active-prompt reads. */
function routeFetch(agents: unknown[], prompts: Record<string, unknown | Error> = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/prompts/active")) {
      const slug = url.split("/agents/")[1]!.split("/")[0]!;
      const entry = prompts[slug];
      if (entry instanceof Error) throw entry;
      if (entry === undefined) return new Response("no prompt", { status: 404 });
      return json(entry);
    }
    return json({ items: agents, limit: 100, offset: 0, has_more: false });
  });
}

describe("loadControlPlaneFacts", () => {
  it("enriches only the agents the control plane actually holds", async () => {
    routeFetch([agentRow("x-agent")], { "x-agent": { id: "p2", agent_id: "x-agent", version: 2, content: "c", is_active: true } });

    const index = await loadControlPlaneFacts(["karos-x-agent-v2", "karos-newsletter-writer-v2"]);

    // Keyed by customAgents.key, so a caller looks up with what it already has.
    expect(index.get("karos-x-agent-v2")).toMatchObject({ agentId: "x-agent", activePromptVersion: 2 });
    // Untouched: the catalog's spine is customAgents, and an agent the control
    // plane never heard of must still render.
    expect(index.has("karos-newsletter-writer-v2")).toBe(false);
  });

  it("does not enrich an agent whose key maps to no engine product", async () => {
    // The manager variants have no engine workflow — karos-blog-manager-v2
    // runs on two clocks and rewrites the generators' inputs, and the engine has
    // neither a scheduler nor a write path for that. Claiming a control-plane
    // lineage for one would be a lie the runtime does not honour. (The
    // standalone LinkedIn manager card that used to illustrate this same point,
    // karos-linkedin-manager-v2, was retired in full 2026-08-29,
    // SCRUM-377/T-B25a — it is not merely unmapped now, it no longer exists.)
    routeFetch([agentRow("linkedin-agent")]);

    const index = await loadControlPlaneFacts(["karos-blog-manager-v2"]);

    expect(index.size).toBe(0);
  });

  it("enriches an onboarding key, now that it routes to the agent that absorbed it", async () => {
    // `karos-linkedin-setup-v2` used to map to `linkedin-setup-agent`, a
    // separate engine product, and this file asserted it enriched to nothing.
    // The setup routine is now linkedin-agent's `00-channel-setup` pre-flight,
    // so the key maps to a real workflow and its row is genuinely the one the
    // control plane holds.
    routeFetch([agentRow("linkedin-agent")]);

    const index = await loadControlPlaneFacts(["karos-linkedin-setup-v2"]);

    expect(index.get("karos-linkedin-setup-v2")).toMatchObject({ agentId: "linkedin-agent" });
  });

  it("still lists the control plane when no library key maps, because the union needs it", async () => {
    // This used to assert no call at all. That was right while enrichment was
    // the only consumer; the catalog union also needs agents the library has
    // NO key for (intel-report-agent), and short-circuiting here would hide
    // exactly the rows the union exists to surface. Enrichment is still empty.
    const mock = routeFetch([agentRow("intel-report-agent")]);

    const index = await loadControlPlaneFacts(["karos-newsletter-writer-v2", "karos-blog-writer-v2"]);

    expect(index.size).toBe(0);
    expect(mock).toHaveBeenCalled();
  });

  it("returns an agent with no prompt yet, rather than dropping it", async () => {
    // Existing in the control plane and having a prompt are different facts.
    routeFetch([agentRow("x-agent")], {});

    const index = await loadControlPlaneFacts(["karos-x-agent-v2"]);

    expect(index.get("karos-x-agent-v2")).toMatchObject({ agentId: "x-agent", activePromptVersion: null });
  });

  it("degrades to no enrichment when the control plane is unreachable", async () => {
    // The catalog is how a client reaches their agents. A control plane that
    // is down costs them a badge, never the page.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(loadControlPlaneFacts(["karos-x-agent-v2"])).resolves.toEqual(new Map());
  });

  it("keeps enriching other agents when one agent's prompt read fails", async () => {
    routeFetch(
      [agentRow("x-agent"), agentRow("linkedin-agent")],
      {
        "x-agent": new Error("boom"),
        "linkedin-agent": { id: "p1", agent_id: "linkedin-agent", version: 1, content: "c", is_active: true },
      },
    );

    const index = await loadControlPlaneFacts(["karos-x-agent-v2", "karos-linkedin-writer-v2"]);

    expect(index.get("karos-x-agent-v2")?.activePromptVersion).toBeNull();
    expect(index.get("karos-linkedin-writer-v2")?.activePromptVersion).toBe(1);
  });

  it("enriches nothing when the control plane is not configured", async () => {
    delete process.env.AGENT_MIDDLEWARE_DISPATCH_ENABLED;
    const mock = routeFetch([agentRow("x-agent")]);

    await expect(loadControlPlaneFacts(["karos-x-agent-v2"])).resolves.toEqual(new Map());
    expect(mock).not.toHaveBeenCalled();
  });

  it("carries the control-plane status through, so a disabled agent is visible as one", async () => {
    routeFetch([agentRow("x-agent", { status: "disabled" })], {});

    const index = await loadControlPlaneFacts(["karos-x-agent-v2"]);

    expect(index.get("karos-x-agent-v2")?.status).toBe("disabled");
  });
});

describe("loadControlPlane (snapshot)", () => {
  it("returns every control-plane agent, not just the enriched ones", async () => {
    routeFetch([agentRow("x-agent"), agentRow("intel-report-agent")], {
      "x-agent": { id: "p1", agent_id: "x-agent", version: 1, content: "c", is_active: true },
    });

    const snapshot = await loadControlPlane(["karos-x-agent-v2"]);

    expect(snapshot.agents.map((a) => a.slug).sort()).toEqual(["intel-report-agent", "x-agent"]);
    expect(snapshot.facts.size).toBe(1);
  });

  it("returns an empty snapshot when the control plane is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const snapshot = await loadControlPlane(["karos-x-agent-v2"]);

    expect(snapshot.agents).toEqual([]);
    expect(snapshot.facts.size).toBe(0);
  });
});
