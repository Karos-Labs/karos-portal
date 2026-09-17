/**
 * HOW FAR ALONG A CATALOG AGENT IS — D09's three bands, as a field rather than
 * as a word inside a name.
 *
 * Decisions log, 15 September 2026:
 *
 *   D09  The catalog has three bands:
 *          up and running - X, LinkedIn, Reddit
 *          beta           - Instagram, TikTok clipping, TikTok editing,
 *                           TikTok content design
 *          coming soon    - Rebrand, Newsletter/Blog, Landing page,
 *                           Micro-influencers, Motion design, PR
 *        The band is a field on the agent, not a word inside its name.
 *   D20  "Beta" is a band, never part of an agent's name.
 *
 * WHY THIS IS NOT A STATUS. `rosterStatus` answers "is this working for me right
 * now" — Live, Needs attention, Runs on request. A band answers "how finished is
 * this product", which is the same answer for every client on the account and
 * cannot be derived from anything in their workspace. Fusing them would make a
 * beta agent that is genuinely producing read as unfinished, and a client with
 * no runs yet read as beta.
 *
 * THE ONE EXCEPTION, AND IT IS DELIBERATE: `coming_soon`. A product that is not
 * released has no per-client state to report, and the portal already has exactly
 * one rendering for that — `rosterStatus`'s `enabled: false` short-circuit, which
 * paints "Coming Soon" and takes the row's controls away. The band feeds THAT
 * rung rather than adding a second badge beside it, because a card that says
 * "Live" and "Coming soon" at once is the contradiction the single rendering
 * exists to prevent. See `rosterStatus` in client-agents.ts.
 *
 * PURE and client-safe: no Firestore, no `server-only`, no React.
 */

/** D09's three bands. Stored on the agent; see `agentBand` for precedence. */
export type AgentBand = "up_and_running" | "beta" | "coming_soon";

/**
 * D09's assignment, by agent key — the ONE place it is written.
 *
 * `scripts/sync-engine-agent-roster.ts` declares the same value on each of its
 * roster rows so the seeded document is self-describing, and asserts the two
 * agree before it writes anything; the card reads this table through
 * `agentBand`. A key absent here has no band, which is why this map is not
 * `Record<string, AgentBand>` over every known key: an agent nobody has banded
 * makes no claim about how finished it is, and silence is the only honest
 * default. It is NOT read as "up and running".
 *
 * Four of D09's coming-soon products have no entry because they have no agent
 * in this repo at all: Rebrand, Micro-influencers, Motion design and PR have no
 * `customAgents` key and no agent-engine product, so there is nothing here to
 * band. They become rows when they become agents.
 *
 * The keys D07 and D40 took out of the catalog (`seo-geo-agent-v2`,
 * `karos-reputation-runner`, `karos-campaign-orchestrator`) are absent for the
 * same reason a setup step is: they are not products a client picks, so they
 * never reach a card that could paint a band. See `isNotAClientProductKey`.
 */
const BAND_BY_AGENT_KEY: Record<string, AgentBand> = {
  // ── up and running ──
  "karos-x-agent-v2": "up_and_running",
  "karos-linkedin-writer-v2": "up_and_running",
  "karos-reddit-runner": "up_and_running",
  // ── beta ──
  "karos-instagram-agent": "beta",
  // D08's three. Content design carried its band in its NAME ("TikTok content
  // design (beta)") until D20 ruled that out; this row is where the marker went.
  "karos-tiktok-clipping": "beta",
  "karos-tiktok-editing": "beta",
  "karos-tiktok-content-design": "beta",
  // ── coming soon ──
  // D09 names "Newsletter/Blog" as one product; this repo has an agent for each
  // half, and both are in the same band.
  "karos-blog-writer-v2": "coming_soon",
  "karos-newsletter-writer-v2": "coming_soon",
  // D09's "Landing page".
  "landing-builder": "coming_soon",
};

/** What a band lookup is asked about: the agent's key, and its stored band. */
export interface AgentBandFields {
  key: string;
  band?: AgentBand | null;
}

/** Is this one of D09's three words? Guards a value read off a stored document. */
export function isAgentBand(value: unknown): value is AgentBand {
  return value === "up_and_running" || value === "beta" || value === "coming_soon";
}

/**
 * This agent's band, or null when nobody has assigned one.
 *
 * STORED FIELD FIRST, then the table — the same precedence `clientAgentBlurb`
 * uses for the same reason: the document is what an operator can edit, and a
 * field that nothing reads is a control that lies about being one. The roster
 * script writes the table's own value, so a script-owned document always agrees
 * with the code and the precedence never actually fires; it exists for the day
 * someone needs to band one agent differently without a deploy.
 *
 * A stored value that is not one of the three is ignored rather than trusted,
 * and falls through to the table: an unrecognised word cannot be rendered and
 * must not silently suppress the band the decisions log assigned.
 */
export function agentBand(agent: AgentBandFields): AgentBand | null {
  if (isAgentBand(agent.band)) return agent.band;
  return BAND_BY_AGENT_KEY[agent.key] ?? null;
}

/**
 * The word a client reads, per band.
 *
 * `coming_soon` is byte-identical to `rosterStatus`'s own paused label, because
 * it IS that label: the band routes into that rung rather than painting a second
 * badge. If one of the two is ever reworded the other must move with it, which
 * is why they are pinned against each other by a test rather than left to match
 * by coincidence.
 *
 * `up_and_running` has no word. The status badge beside it already says Live or
 * Runs on request, which is what "up and running" means to the person reading
 * it; a second badge repeating the first is furniture. Flagged in the PR as the
 * one place D09 left the client-facing wording open.
 */
export const AGENT_BAND_LABEL = {
  up_and_running: null,
  beta: "Beta",
  coming_soon: "Coming Soon",
} as const satisfies Record<AgentBand, string | null>;
