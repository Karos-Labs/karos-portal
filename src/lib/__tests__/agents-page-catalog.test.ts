import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ONE CATALOG ON /agents, NOT TWO.
 *
 * The page used to render the engine catalog above the lab-imported
 * `customAgents` library. Every product in that library now has an engine
 * workflow, so the two lists had grown into two cards per product — one with
 * stages, prompt versions, a model and a Studio link, one without — and nothing
 * on either saying which one to press. The libraries run on different
 * executors, so it was not even a cosmetic duplication.
 *
 * A source scan rather than a render: this is a server component whose module
 * graph reaches Firestore and the auth cookie, and what is being asserted is
 * which component the page mounts — a structural fact the source states
 * directly.
 */

const PAGE = path.join(process.cwd(), "src/app/(app)/agents/page.tsx");
const source = readFileSync(PAGE, "utf8");

describe("/agents renders the engine catalog and nothing legacy", () => {
  it("does not mount the lab-library hub", () => {
    // Neither imported nor rendered. The name still appears in the page's own
    // header comment, explaining where the hub went and why — a scan for the
    // bare name would fail on the explanation, which is the wrong thing to
    // forbid.
    expect(source).not.toMatch(/import\s*\{[^}]*CustomAgentsHub/);
    expect(source).not.toContain("<CustomAgentsHub");
  });

  it("does not pay for the library read that only the hub needed", () => {
    // `listCustomAgents` fed the hub's rows and the per-key control-plane
    // enrichment behind its version badges. With the hub gone, keeping the call
    // would be a Firestore read plus one prompt lookup per agent for a badge
    // nothing draws.
    expect(source).not.toContain("listCustomAgents");
    expect(source).toContain("loadControlPlane([])");
  });

  it("still mounts the engine card for every agent the control plane returns", () => {
    expect(source).toContain("buildEngineAgentCards(snapshot.agents)");
    expect(source).toContain("<EngineAgentCard");
    // Unfiltered: every active client is offered for every agent, which is what
    // "available to all clients" means here.
    expect(source).toContain("clients={activeClients.map(");
  });

  it("distinguishes an empty catalog from having no clients", () => {
    // The two empty states send someone to fix different things — a missing
    // client is their own to add, an empty catalog means the control plane is
    // unreachable — and one message for both would misdirect half the time.
    expect(source).toContain("No active clients");
    expect(source).toContain("No agents available");
    expect(source).toContain("agent-middleware is reachable");
  });
});
