import { describe, expect, it } from "vitest";
import { railAgentsForClient } from "@/lib/rail-agents";
import type { Client, CustomAgent } from "@/lib/types";

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
