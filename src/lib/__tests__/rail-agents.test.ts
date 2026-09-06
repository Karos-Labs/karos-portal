import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { railAgentsForClient } from "@/lib/rail-agents";
import type { Client, CustomAgent } from "@/lib/types";

/** Source read for wiring assertions: the rail is a "use client" module whose
 *  import graph reaches the Admin SDK, and the action is `"use server"`. */
const src = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

/**
 * ONE ROSTER, TWO SHELLS (parity pass 2026-09, ruling D3).
 *
 * The client portal's rail and the staff shell's client-context arm both render
 * the "AI agents" dropdown for the same client. The filter behind it used to be
 * inline in the `(app)` layout, so giving the staff shell the same roster meant
 * either a second copy of five clauses or this helper. The clauses are what the
 * assertions below pin: which of them is a GRANT boundary (loosened by a star)
 * and which are data-integrity fences (never loosened by anything).
 */

function agent(over: Partial<CustomAgent> & Pick<CustomAgent, "id" | "key">): CustomAgent {
  return {
    name: `${over.key} agent`,
    description: "Internal lab blurb, product codes and all.",
    icon: "Bot",
    color: "#ff6b2c",
    entrySkillDir: "skills/entry",
    skillRoots: [],
    includeClientSkills: false,
    instructions: "",
    enabled: true,
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as CustomAgent;
}

/** Only the three fields the helper reads — it takes a Pick, not a document. */
const client = (
  over: Partial<Pick<Client, "customAgentIds" | "starredAgentIds" | "agentsRepoSlug">> = {},
): Pick<Client, "customAgentIds" | "starredAgentIds" | "agentsRepoSlug"> => ({
  customAgentIds: [],
  starredAgentIds: [],
  agentsRepoSlug: "acme",
  ...over,
});

const GRANTED = agent({ id: "a-granted", key: "karos-x-agent" });
const UNGRANTED = agent({ id: "a-ungranted", key: "karos-instagram-agent" });
const DISABLED = agent({ id: "a-disabled", key: "karos-tiktok-agent", enabled: false });
const SUB_AGENT = agent({ id: "a-sub", key: "karos-x-agent-step", parentKey: "karos-x-agent" });
const SUPERSEDED = agent({ id: "a-old", key: "karos-linkedin-agent" });
/** Bound to a lab folder that is not this client's — and superseded besides. */
const OTHER_CLIENT_INSTANCE = agent({ id: "a-bravo", key: "karos-linkedin-company-bravo" });

const ALL = [GRANTED, UNGRANTED, DISABLED, SUB_AGENT, SUPERSEDED, OTHER_CLIENT_INSTANCE];

const ids = (agents: { id: string }[]) => agents.map((a) => a.id);

describe("railAgentsForClient", () => {
  it("lists the granted agents and nothing else, by default", () => {
    const rail = railAgentsForClient(ALL, client({ customAgentIds: ["a-granted"] }));
    expect(ids(rail)).toEqual(["a-granted"]);
  });

  it("lists a starred agent that was never granted", () => {
    // The 2026-08 loosening, and the reason it exists: an agent's detail page
    // opens on EITHER a grant OR delivered work, and it can be starred from
    // there. A star that writes successfully but can never render a pinned row
    // is a broken control, not a scoped one. Karos Labs' own Instagram Agent is
    // the case in the field — it predates the grant model entirely.
    const rail = railAgentsForClient(ALL, client({ starredAgentIds: ["a-ungranted"] }));
    expect(ids(rail)).toEqual(["a-ungranted"]);
  });

  it("never lists a disabled, sub- or superseded agent, grant or star regardless", () => {
    // The fences the star does NOT loosen. Each one is asked with BOTH keys
    // set, so a rule that only survives the ungranted path would fail here.
    const everythingOn = client({
      customAgentIds: ["a-disabled", "a-sub", "a-old", "a-bravo"],
      starredAgentIds: ["a-disabled", "a-sub", "a-old", "a-bravo"],
    });
    expect(railAgentsForClient(ALL, everythingOn)).toEqual([]);
  });

  it("never lists another client's per-client instance", () => {
    // A per-client agent runs an entry skill baked under ONE client's lab
    // folder (#132). Asserted from both sides: bravo's instance is refused for
    // acme, and a client with NO folder matches no instance at all — "no
    // folder" must not read as "every folder".
    // `Client.agentsRepoSlug` is optional, never null — undefined and "" are
    // the two shapes "no lab folder" actually takes in a document.
    for (const slug of ["acme", undefined, ""] as const) {
      const rail = railAgentsForClient(
        ALL,
        client({ customAgentIds: ["a-bravo"], agentsRepoSlug: slug }),
      );
      expect(ids(rail), `slug ${String(slug)}`).not.toContain("a-bravo");
    }
  });

  it("lists an unbound agent for a client with no lab folder", () => {
    // The other direction of the same gate: a filter that refused everything
    // would satisfy the case above and empty every rail in the product.
    const rail = railAgentsForClient(
      ALL,
      client({ customAgentIds: ["a-granted"], agentsRepoSlug: undefined }),
    );
    expect(ids(rail)).toEqual(["a-granted"]);
  });

  it("projects to the four fields that may cross into the browser", () => {
    // The boundary, not a convenience shape. ClientRailAgentsNav is a "use
    // client" component, so anything returned here is serialized into the RSC
    // payload of every page that mounts the rail — and `description` is the lab
    // manifest blurb: product codes, pipeline architecture, staff-only (see
    // CustomAgent's own note on the field).
    const [row] = railAgentsForClient(ALL, client({ customAgentIds: ["a-granted"] }));
    expect(row).toEqual({
      id: "a-granted",
      key: "karos-x-agent",
      name: "karos-x-agent agent",
      icon: "Bot",
    });
    expect(Object.keys(row!)).toEqual(["id", "key", "name", "icon"]);
  });

  it("reads an absent grant list and an absent star list as empty, not as everything", () => {
    // Legacy documents carry neither field. Failing OPEN here would put every
    // agent in the lab on a client's rail.
    expect(railAgentsForClient(ALL, { agentsRepoSlug: "acme" })).toEqual([]);
  });

  it("preserves the catalogue's order, so both shells sort identically", () => {
    // The dropdown promotes starred agents itself, with a STABLE sort — which
    // only means anything if the array it is handed has a defined order to be
    // stable about.
    const rail = railAgentsForClient(ALL, client({ customAgentIds: ["a-ungranted", "a-granted"] }));
    expect(ids(rail)).toEqual(["a-granted", "a-ungranted"]);
  });
});

/**
 * THE STAR IS A WRITE, AND THE READ RULE IS THE WRITE RULE (review wave,
 * 2026-09).
 *
 * `toggleStarredAgentAction` authorized the WRITER — a client for their own
 * client, staff who pass `canViewClient` — and then took the `agentId` on
 * trust. Nothing broke visibly, because `railAgentsForClient` above re-applies
 * its fences on every read and silently drops what does not pass; the ids just
 * accumulated in the document, unpaintable and unremovable through the UI (a
 * row that never renders has no star to click).
 */
describe("toggleStarredAgentAction validates what is being pinned", () => {
  const action = flat(src("lib/actions/client-actions.ts"));

  it("asks the same three questions the rail's own read asks", () => {
    expect(action).toContain("const agent = await getCustomAgent(agentId);");
    expect(action).toContain(
      "if (!agent || !agent.enabled || !agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug))",
    );
    // The same fence, from the same module, as the read helper this file tests.
    expect(src("lib/rail-agents.ts")).toContain("agentKeyMatchesClientSlug(a.key, client.agentsRepoSlug)");
  });

  it("caps the pinned array, which nothing downstream bounds", () => {
    // UNSTARRED_AGENT_CAP bounds the OTHER group; pinned rows are deliberately
    // uncapped in the rail, so the ceiling has to be at the write.
    expect(action).toContain("const MAX_STARRED_AGENTS = 24;");
    expect(action).toContain(
      "if (!current.includes(agentId) && current.length >= MAX_STARRED_AGENTS)",
    );
    expect(src("components/client-rail-agents-nav.tsx")).toContain("const UNSTARRED_AGENT_CAP = 6;");
  });

  it("never blocks an UNPIN", () => {
    // Refusing to remove a pin because the agent behind it was disabled or
    // retired is exactly how a document gets stuck with one. The whole
    // validation block is inside `if (starred)`.
    expect(action).toMatch(/if \(starred\) \{ const agent = await getCustomAgent/);
  });
});

/**
 * The rail's agents block (round 6: marks and names, and nothing else).
 */
describe("the rail's agent list", () => {
  const nav = src("components/client-rail-agents-nav.tsx");

  // round 6: INVERTED. This used to pin H3's fix — an optimistic star array in
  // the rail plus a write-back into the staff shell's active-client context, so
  // a pin toggled from a rail row on /jobs did not flip back when the refresh
  // re-read a context nothing had updated. There is no toggle in the rail any
  // more (think-agents §3: the stars were four spends of the rationed accent in
  // a nav, and a grey glyph that means nothing until hovered), so the whole
  // mechanism goes with it. The remaining pin control is the agent page's, which
  // only ever renders under `/clients/[id]` — the subtree whose layout DOES
  // mount ClientContextSync, which is why it needs no write-back of its own.
  it("carries no star control, and so no optimistic star machinery", () => {
    expect(nav, "the rail stars agents again").not.toContain("toggleStarredAgentAction");
    expect(nav).not.toContain("useOptimistic");
    expect(nav).not.toContain("useActiveClient");
    expect(nav, "a star glyph is back in the rail").not.toContain('name="Star"');
    // `starredIds` survives as ORDER: pinned rows first, and only the unpinned
    // group is capped.
    expect(nav).toContain("const starredSet = new Set(starredIds);");
    // The one place a client pins an agent.
    expect(src("components/client-agents/agent-star-button.tsx")).toContain(
      "toggleStarredAgentAction(clientId, agentId, next)",
    );
  });

  it("marks exactly one row as current", () => {
    // The parent "AI agents" row was filled for every `/agents/*` path and the
    // child row was filled too, so two rows read as current at once.
    expect(nav).toContain("const onAgentsRoot = pathname === agentsRoot;");
    expect(flat(nav)).toContain('{...(onAgentsRoot ? { "aria-current": "page" as const } : {})}');
    expect(flat(nav)).toContain('{...(active ? { "aria-current": "page" as const } : {})}');
  });

  it("offers the roster instead of a dead sentence when there are no rows", () => {
    expect(nav, "the dead sentence is back").not.toContain("No agents set up yet.");
    expect(nav).toContain("See your agents");
  });

  it("counts the rows the 'View all' control actually reveals", () => {
    // L4. It counted `agents.length` — the whole roster, pinned rows included —
    // so a client with 4 pinned and 8 unpinned was offered "View all 12 agents"
    // by a button that uncovers 2 more rows on a list already showing 10.
    expect(nav).toContain("`View all ${unstarredAgents.length} agents`");
    expect(nav).not.toContain("`View all ${agents.length} agents`");
    // The cap it is paired with is the unstarred group's, which is the reason.
    expect(nav).toContain("unstarredAgents.length > UNSTARRED_AGENT_CAP");
  });
});

/**
 * The one-time onboarding default stars — WHICH two, and said out loud.
 */
describe("the layout's default-star pick", () => {
  const layout = flat(readFileSync(join(process.cwd(), "src/app/(app)/layout.tsx"), "utf8"));

  it("orders the roster before taking the first two", () => {
    // L6. `railAgents.slice(0, 2)` was quietly alphabetical — it inherits
    // listCustomAgents()'s name sort — a pick nothing stated and any change to
    // that upstream sort would silently rewrite. The order is the setup
    // ladder's now, the same ranking the client's own Home walks them through.
    expect(layout).toContain("orderSetupLadderAgents(railAgents, ladderOrder) .slice(0, 2)");
    expect(layout).not.toContain("railAgents.slice(0, 2)");
    // Stored at onboarding when it exists; recomputed deterministically when it
    // does not, which is the same answer a moment later, not a second policy.
    expect(layout).toContain("client.setupLadderOrder?.length ? client.setupLadderOrder : rankSetupLadder(");
  });

  it("still fires exactly once per client, and says that it is a render write", () => {
    // `=== undefined`, not `.length === 0`: a client who unpins back down to
    // zero has made a choice, and the action always writes a real array.
    expect(layout).toContain("if (client.starredAgentIds === undefined && railAgents.length > 0)");
    expect(layout).toContain("AND THIS IS A WRITE DURING RENDER, deliberately kept.");
  });
});
