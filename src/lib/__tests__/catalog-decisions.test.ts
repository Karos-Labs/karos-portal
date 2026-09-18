/**
 * SCRUM-497/498 — the client catalog says what the decisions log says.
 *
 * Karos decisions, 15 September 2026:
 *
 *   D07  SEO/GEO and Reputation are reporting systems, not agents. They must not
 *        be runnable agent cards in the client catalog.
 *   D08  TikTok is three agents: clipping, editing (today "Branded shorts", to
 *        be renamed), and content design.
 *   D09  The catalog has three bands. The band is a field on the agent, not a
 *        word inside its name.
 *   D20  "Beta" is a band, never part of an agent's name.
 *   D40  Campaign is not an agent — it only runs other agents, so it is never
 *        listed as an agent in the client catalog.
 *
 * WHAT THIS FILE IS FOR, and what it deliberately is not. Every assertion below
 * is about what a client is OFFERED and what the card SAYS. Nothing here asserts
 * that anything stopped running, because nothing did: every key named here keeps
 * its `customAgents` document, its row in `ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY`
 * and every schedule that names it. That is #135's rule, and the dispatch half
 * of it is pinned by `tiktok-three-agents-dispatch.test.ts`; the routing pin
 * below is here only so a future unlisting cannot quietly become an un-routing.
 *
 * The seeded roster (`scripts/sync-engine-agent-roster.ts`) is read as SOURCE,
 * the way `visibility-levers.test.ts` reads the routing table: it is a script,
 * not a module this app imports, and running it needs Firestore credentials.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  isNotAClientProductKey,
  isSubAgent,
  isSupersededAgentKey,
  isUnlistedAgent,
  listableAgents,
} from "@/lib/custom-agent-launch";
import { AGENT_BAND_LABEL, agentBand, isAgentBand, type AgentBand } from "@/lib/agent-bands";
import { rosterStatus } from "@/lib/client-agents";
import { resolveAgentEngineProductIdForCustomAgent } from "@/lib/agent-engine/product-mapping";

const REPO = path.resolve(__dirname, "../..", "..");
const ROSTER_SCRIPT = path.join(REPO, "scripts/sync-engine-agent-roster.ts");

/**
 * The seeded roster, parsed out of the script that writes it: one entry per row,
 * carrying the three fields the catalog is judged on.
 *
 * Deliberately a parse rather than an import. The script opens a Firestore
 * connection at module scope through `resolveScriptDatabaseId`, so importing it
 * in a unit test would either fail or reach a database.
 */
function seededRoster(): Array<{
  key: string;
  name: string;
  band: AgentBand | null;
  parentKey?: string;
}> {
  const src = readFileSync(ROSTER_SCRIPT, "utf8");
  const at = src.indexOf("const ROSTER: RosterDoc[]");
  expect(at, "the seeded roster was renamed or moved").toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf("\n];", at));
  // Split on the row boundary first and read fields WITHIN a row, rather than
  // matching a field sequence across the whole array: `parentKey` is what makes
  // a step a step, it is the last field on the rows that have it, and a pattern
  // that reached across rows would attribute it to the next agent — which is the
  // difference between a roster of ten cards and one of thirteen.
  const rows = body
    .split(/\n {2}\{\n/)
    .slice(1)
    .map((row) => {
      const field = (name: string) => row.match(new RegExp(`\\n {4}${name}: "([^"]+)"`))?.[1];
      const key = field("key");
      const name = field("name");
      const band = field("band");
      const parentKey = field("parentKey");
      expect(key, `a roster row parsed with no key:\n${row}`).toBeTruthy();
      expect(name, `roster row ${key} parsed with no name`).toBeTruthy();
      return {
        key: key!,
        name: name!,
        band: band && isAgentBand(band) ? band : null,
        ...(parentKey ? { parentKey } : {}),
      };
    });
  expect(rows.length, "no roster rows parsed — the row shape changed").toBeGreaterThan(10);
  return rows;
}

/** The roster as the portal would list it: what a client is actually offered. */
function listedRoster() {
  return listableAgents(seededRoster());
}

describe("D09/D20: the band is a field, and the name is just the name", () => {
  it("assigns every listed agent to one of the three bands", () => {
    // A listed card with no band renders a status word and nothing else, which
    // is not wrong so much as silent — the catalog would be showing a product
    // without saying how finished it is. Adding an agent to the roster without
    // deciding its band fails here.
    const unbanded = listedRoster().filter((row) => agentBand(row) === null);
    expect(unbanded.map((r) => r.key)).toEqual([]);
  });

  it("puts each listed agent in the band D09 gives it", () => {
    // D09, verbatim:
    //   up and running - X, LinkedIn, Reddit
    //   beta           - Instagram, TikTok clipping, TikTok editing,
    //                    TikTok content design
    //   coming soon    - Rebrand, Newsletter/Blog, Landing page,
    //                    Micro-influencers, Motion design, PR
    const byBand: Record<AgentBand, string[]> = {
      up_and_running: [],
      beta: [],
      coming_soon: [],
    };
    for (const row of listedRoster()) byBand[agentBand(row)!].push(row.key);

    expect(byBand.up_and_running.sort()).toEqual(
      ["karos-linkedin-writer-v2", "karos-reddit-runner", "karos-x-agent-v2"].sort(),
    );
    expect(byBand.beta.sort()).toEqual(
      [
        "karos-instagram-agent",
        "karos-tiktok-clipping",
        "karos-tiktok-content-design",
        "karos-tiktok-editing",
      ].sort(),
    );
    // Four of D09's coming-soon products — Rebrand, Micro-influencers, Motion
    // design and PR — have no agent in this repo at all, so there is nothing to
    // band. They join this list when they become agents.
    expect(byBand.coming_soon.sort()).toEqual(
      ["karos-blog-writer-v2", "karos-newsletter-writer-v2", "landing-builder"].sort(),
    );
  });

  it("keeps the seeded document and the code table in step", () => {
    // The script asserts this before it writes; this is the same check at review
    // time, so the disagreement is caught by CI rather than by an operator
    // halfway through a sync.
    for (const row of seededRoster()) {
      expect(row.band, row.key).toBe(agentBand({ key: row.key }));
    }
  });

  it("D20: no listed agent carries its band in its name", () => {
    // "TikTok content design (beta)" is the one this was written for, and the
    // check is deliberately wider than that one string: any spelling of beta in
    // any listed name is the same mistake.
    for (const row of listedRoster()) {
      expect(row.name, row.key).not.toMatch(/beta/i);
    }
    expect(seededRoster().find((r) => r.key === "karos-tiktok-content-design")?.name).toBe(
      "TikTok content design",
    );
  });

  it("spends `coming_soon` on the word the portal already had", () => {
    // The whole of the "extend, do not duplicate" rule: an unreleased product
    // takes the SAME rung an admin's pause takes, so there is one "Coming Soon"
    // in the portal and one row treatment behind it — never a second badge
    // beside a "Live" one.
    const paused = rosterStatus({ launchState: null, enabled: false });
    const unreleased = rosterStatus({ launchState: "live", band: "coming_soon" });
    expect(unreleased).toEqual(paused);
    expect(unreleased.tone).toBe("disabled");
    expect(unreleased.label).toBe(AGENT_BAND_LABEL.coming_soon);
  });

  it("leaves the other two bands out of the status word entirely", () => {
    // A beta agent that is producing is Live and must say so; the band is a
    // marker beside that word, not a replacement for it. Same for a banded agent
    // with a live launch state.
    const plain = rosterStatus({ launchState: "live" });
    expect(rosterStatus({ launchState: "live", band: "beta" })).toEqual(plain);
    expect(rosterStatus({ launchState: "live", band: "up_and_running" })).toEqual(plain);
    // And a refusal still outranks a band that is not `coming_soon`.
    const refused = rosterStatus({
      launchState: "live",
      band: "beta",
      scheduleRefusal: "Not enough credits",
      scheduleActive: true,
    });
    expect(refused.tone).toBe("attention");
  });

  it("gives `up_and_running` no badge of its own", () => {
    // The status word beside it already says Live or Runs on request, which is
    // what "up and running" means to the person reading it. Flagged in the PR as
    // the one place D09 left the client-facing wording open.
    expect(AGENT_BAND_LABEL.up_and_running).toBeNull();
    expect(AGENT_BAND_LABEL.beta).toBe("Beta");
  });

  it("prefers a stored band, and ignores a word that is not one of the three", () => {
    expect(agentBand({ key: "karos-x-agent-v2", band: "beta" })).toBe("beta");
    // Falls back rather than blanking: an unrecognised stored value cannot be
    // rendered and must not suppress the band the decisions log assigned.
    expect(agentBand({ key: "karos-x-agent-v2", band: "nearly-ready" as AgentBand })).toBe(
      "up_and_running",
    );
    expect(agentBand({ key: "karos-experiment-42" })).toBeNull();
  });
});

describe("D07/D40: what is not a product a client picks", () => {
  const NOT_PRODUCTS = [
    // D07
    "seo-geo-agent-v2",
    "karos-reputation-runner",
    // D40
    "karos-campaign-orchestrator",
  ];

  it("takes all three off every roster", () => {
    for (const key of NOT_PRODUCTS) {
      expect(isNotAClientProductKey(key), key).toBe(true);
      expect(isUnlistedAgent({ key }), key).toBe(true);
    }
    expect(listedRoster().map((r) => r.key)).not.toContain("karos-campaign-orchestrator");
  });

  it("calls each one what it is, and not what it is not", () => {
    // The three predicates behind `isUnlistedAgent` are kept apart because they
    // are different facts. Nothing replaced these and nothing fires them as a
    // step, so answering true to either of the other two would be a lie in the
    // data about what they are — the same objection the file already records
    // against giving a superseded agent a `parentKey`.
    for (const key of NOT_PRODUCTS) {
      expect(isSubAgent({ key }), key).toBe(false);
      expect(isSupersededAgentKey(key), key).toBe(false);
    }
  });

  it("leaves all three dispatchable, which is the point of unlisting", () => {
    // D40 is explicit that the engine's campaign-orchestrator stays, because the
    // button it becomes will call it. The same is true of the two reporting
    // systems: the SEO/GEO measurement feeds the Reporting tab and
    // `createTasksFromSeoGeoReportAction`, and a reputation pulse still runs.
    for (const key of NOT_PRODUCTS) {
      expect(resolveAgentEngineProductIdForCustomAgent(key), key).toBeTruthy();
    }
  });

  it("keeps the reputation SETUP step resolving through its parent", () => {
    // Unlisting the runner must not orphan the step that names it: the step is
    // hidden for its own, older reason and still routes to the same workflow.
    //
    // Read off the seeded row rather than hand-built, because the step's hiding
    // is STRUCTURAL — `isSubAgent` evaluates `parentKey` on the document, so an
    // assertion that omitted it would be testing a shape the portal never sees.
    const setup = seededRoster().find((r) => r.key === "karos-reputation-setup")!;
    expect(setup.parentKey).toBe("karos-reputation-runner");
    expect(isSubAgent(setup)).toBe(true);
    expect(isUnlistedAgent(setup)).toBe(true);
    expect(resolveAgentEngineProductIdForCustomAgent("karos-reputation-setup")).toBe(
      "reputation-agent",
    );
  });

  it("does not unlist anything else that was listed", () => {
    // The blast radius, pinned: exactly ten cards, and this is the list a client
    // sees. A change that adds or removes one has to say so here.
    expect(listedRoster().map((r) => r.key).sort()).toEqual(
      [
        "karos-blog-writer-v2",
        "karos-instagram-agent",
        "karos-linkedin-writer-v2",
        "karos-newsletter-writer-v2",
        "karos-reddit-runner",
        "karos-tiktok-clipping",
        "karos-tiktok-content-design",
        "karos-tiktok-editing",
        "karos-x-agent-v2",
        "landing-builder",
      ].sort(),
    );
  });
});

describe("SCRUM-498: the short-video card count", () => {
  /** Every roster key whose product is a short vertical video. */
  const SHORT_VIDEO = [
    "karos-tiktok-agent",
    "branded-shorts",
    "karos-tiktok-clipping",
    "karos-tiktok-editing",
    "karos-tiktok-content-design",
  ];

  it("is three: clipping, editing, content design", () => {
    const listed = listedRoster()
      .map((r) => r.key)
      .filter((key) => SHORT_VIDEO.includes(key));
    expect(listed.sort()).toEqual(
      ["karos-tiktok-clipping", "karos-tiktok-content-design", "karos-tiktok-editing"].sort(),
    );
    expect(listed).toHaveLength(3);
  });

  it("counts the two retired ones, so the before-and-after stays checkable", () => {
    // Five cards before #135 (all of SHORT_VIDEO), four after it retired the
    // monolithic agent, three once Branded Shorts goes. Both are retired for the
    // same reason and by the same mechanism.
    expect(SHORT_VIDEO.filter((key) => isSupersededAgentKey(key)).sort()).toEqual(
      ["branded-shorts", "karos-tiktok-agent"].sort(),
    );
  });

  it("D08: Branded Shorts IS the editing agent, so it is one card and not a fourth", () => {
    // "TikTok editing (today 'Branded shorts', to be renamed)". The rename went
    // to the NEW key rather than to this document, because repointing
    // `branded-shorts` would change what an in-flight schedule dispatches — so
    // the old key keeps its own engine product and simply stops being offered.
    expect(isSupersededAgentKey("branded-shorts")).toBe(true);
    expect(isUnlistedAgent({ key: "branded-shorts" })).toBe(true);
    expect(resolveAgentEngineProductIdForCustomAgent("branded-shorts")).toBe(
      "branded-shorts-agent",
    );
    expect(resolveAgentEngineProductIdForCustomAgent("karos-tiktok-editing")).toBe(
      "tiktok-editing-agent",
    );
    // The surviving card carries the name D08 gives the product, with no trace
    // of the old one.
    expect(seededRoster().find((r) => r.key === "karos-tiktok-editing")?.name).toBe(
      "TikTok editing",
    );
  });
});
