import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE PRICE THAT GATES THE LAUNCH, ON THE CARD THAT SELLS THE AGENT (#111).
 *
 * The staff agent library printed one number — credits per client run — which
 * gates nothing, and printed nothing at all for `launchCreditCost`, which gates
 * everything: with it unset, `evaluateLaunchGate` refuses on its pricing rung
 * and a client's self-serve Launch stays disabled. A fully-priced agent and one
 * no client can launch rendered the same line, next to a badge column that
 * already flagged a missing blurb.
 *
 * Asked of the RENDER, in both directions. A source scan for "Setup not priced"
 * is satisfied by the string existing anywhere in the file and cannot tell a
 * conditional badge from an unconditional one — and an unconditional warning on
 * a priced agent is its own false statement, which is why the priced case
 * asserts the absence.
 *
 * NO EXPECTED NUMBER IS WRITTEN HERE. What those prices should be is still
 * Daniel's call (#167); this file only proves the unset state is visible and
 * that a set one is quoted from the stored value.
 */

vi.mock("server-only", () => ({}));
// The library's module graph reaches the server-action barrel and two of its
// siblings. The card under test calls none of them.
vi.mock("@/lib/actions", () => ({
  createCustomAgentAction: vi.fn(),
  deleteCustomAgentAction: vi.fn(),
  importCustomAgentsAction: vi.fn(),
  listCustomAgentImportCandidatesAction: vi.fn(),
  runCustomAgentAction: vi.fn(),
  runCustomAgentTestAction: vi.fn(),
  setClientCustomAgentsAction: vi.fn(),
  updateCustomAgentAction: vi.fn(),
}));
vi.mock("@/lib/actions/planned-run-actions", () => ({
  configureClientAgentScheduleAction: vi.fn(),
  setPlannedRunStatusAction: vi.fn(),
}));
vi.mock("@/lib/actions/external-job-actions", () => ({
  cancelClientAgentJobAction: vi.fn(),
  refreshJobStatusAction: vi.fn(),
  retryJobAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { CREDIT_COSTS, creditsLabel } from "@/lib/credits";
import { CustomAgentsHub } from "@/components/custom-agents";
import type { CustomAgent } from "@/lib/types";

const UNSET_FLAG = /Setup not priced/;

function agent(overrides: Partial<CustomAgent> & { id: string }): CustomAgent {
  return {
    key: "karos-demo-agent",
    name: "Demo agent",
    description: "Internal manifest blurb.",
    clientBlurb: "Drafts posts for your team to review.",
    icon: "Sparkles",
    color: "#A3E635",
    entrySkillDir: "products/live/demo-agent",
    skillRoots: [],
    includeClientSkills: true,
    instructions: "Do the thing.",
    creditCost: null,
    launchCreditCost: null,
    enabled: true,
    source: null,
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as CustomAgent;
}

function libraryMarkup(agents: CustomAgent[]): string {
  return renderToStaticMarkup(
    <CustomAgentsHub
      agents={agents}
      clients={[{ id: "c1", name: "Acme", agentsRepoSlug: "acme" }]}
      isAdmin
      importConfigured
      serviceConfigured
    />,
  );
}

/** Markup text with the tags and React's numeric entities taken back out. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** How many times a phrase appears — `String.match` with a non-global regex
 *  answers 1 for "twice", which is the difference this file is measuring. */
function occurrences(text: string, phrase: string): number {
  return text.split(phrase).length - 1;
}

describe("#111 the library shows the price that decides whether a client can launch", () => {
  it("flags an agent whose setup price nobody has set, in both places", () => {
    const text = textOf(libraryMarkup([agent({ id: "a1", launchCreditCost: null })]));
    // TWO, counted: the badge in the status column, which is what an admin
    // scans a grid of cards for, and the price line at the foot, which is what
    // they read on the one card they stop at. Either alone leaves the gap #111
    // is about — a card that reads as priced — on one of the two paths.
    expect(occurrences(text, "Setup not priced")).toBe(2);
    expect(text).toContain("clients cannot launch it themselves");
  });

  it("does not flag one that is priced, and quotes the stored number", () => {
    // The direction an unconditional badge would fail: warning that a priced
    // agent is unpriced is the same defect pointing the other way.
    const text = textOf(libraryMarkup([agent({ id: "a2", launchCreditCost: 40 })]));
    expect(text).not.toMatch(UNSET_FLAG);
    expect(text).toContain(`${creditsLabel(40)} one-time setup`);
  });

  it("still prints the per-run price in both states", () => {
    // The line that was already there must not have been traded away for the
    // new one — it is what a run costs, and it is still the honest answer to
    // that question.
    for (const cost of [null, 40]) {
      const text = textOf(libraryMarkup([agent({ id: "a3", launchCreditCost: cost })]));
      const expected = `${creditsLabel(CREDIT_COSTS.customAgentRun)} per client run`;
      expect(text, `launchCreditCost=${cost}`).toContain(expected);
    }
  });

  it("reads each agent's own field rather than the first card's", () => {
    // Two cards in one grid, one priced and one not. Counted rather than merely
    // found: a flag hoisted out of the map, or a value resolved once above it,
    // paints both cards the same and gives 2/0 or 0/2. The two phrases are the
    // mutually exclusive branches of the price line, one per card.
    const text = textOf(
      libraryMarkup([
        agent({ id: "a4", name: "Priced agent", launchCreditCost: 40 }),
        agent({ id: "a5", name: "Unpriced agent", launchCreditCost: null }),
      ]),
    );
    expect(occurrences(text, "one-time setup")).toBe(1);
    expect(occurrences(text, "clients cannot launch it themselves")).toBe(1);
    expect(text).toContain(`${creditsLabel(40)} one-time setup`);
  });

  it("keeps the blurb flag it sits beside, and the two stay independent", () => {
    // Sibling badge, and the one #111 measured the gap against: an agent can be
    // missing either, both, or neither.
    const priced = textOf(
      libraryMarkup([agent({ id: "a6", clientBlurb: null, launchCreditCost: 40 })]),
    );
    expect(priced).toContain("No client blurb");
    expect(priced).not.toMatch(UNSET_FLAG);

    const blurbed = textOf(
      libraryMarkup([agent({ id: "a7", clientBlurb: "A written line.", launchCreditCost: null })]),
    );
    expect(blurbed).not.toContain("No client blurb");
    expect(blurbed).toMatch(UNSET_FLAG);
  });
});
