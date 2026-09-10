/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, ClientAgent, CustomAgent, Job, PlannedScheduledRun } from "@/lib/types";

/**
 * #131 — THE BIND DROPDOWN OFFERED AGENTS THE BIND ACTION REFUSES.
 *
 * A per-client agent instance (`karos-linkedin-company-<slug>`) runs an entry
 * skill baked under ONE client's lab folder, so the pair is fixed.
 * `bindClientAgentAction` refuses the mismatched pair outright, before it writes
 * anything, and the roster on the staff agents page already dropped those
 * instances. The bind `<select>` rendered directly above that roster did not: it
 * asked "enabled, and not already bound" and nothing else. Two lists on one
 * screen disagreed about which agents exist for this client, and choosing the
 * extra one returned an error paragraph and wrote nothing.
 *
 * WHAT THIS FILE ASSERTS, and why it is shaped this way.
 *
 * The property is not "the page calls a filter" — a source scan for the
 * predicate's name passes on an import line and says nothing about which list
 * the filter governs. The property is OFFER ⟹ ACCEPT: every agent the offer
 * projection hands the control is one the real action does not refuse. Both
 * halves are driven for real here, over one catalogue, against a mocked data
 * layer — so the guard is keyed to the ARGUMENTS (an agent key and a client
 * slug), not to a spelling or a position in a file.
 *
 * `agentKeyMatchesClientSlug` is deliberately NOT mocked on either side. The
 * defect was two answers to one question; a test that stubs the answer cannot
 * see it.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/auth");
vi.mock("@/lib/client-agent-slots", () => ({
  ensureSlotHorizon: vi.fn(),
  upcomingSlots: vi.fn(async () => []),
}));
vi.mock("@/lib/jobs/submit-custom", () => ({
  isCustomAgentGrantedToClient: vi.fn(async () => true),
  submitCustomAgentJob: vi.fn(async () => ({ jobId: "job-new" })),
}));
vi.mock("@/lib/agent-service/x-agent-context", () => ({ hasXAgentIntake: vi.fn(async () => true) }));
vi.mock("@/lib/agent-service/linkedin-agent-context", () => ({
  hasLinkedInAgentIntake: vi.fn(async () => true),
}));
vi.mock("@/lib/agent-service/reddit-agent-context", () => ({
  hasRedditAgentIntake: vi.fn(async () => true),
}));

import * as data from "@/lib/data";
import * as clientAgentData from "@/lib/data-client-agents";
import { getCurrentUser } from "@/lib/auth";
import { bindableAgents } from "@/lib/client-agent-rows";

const CLIENT_SLUG = "acme";

const STAFF = {
  uid: "u-staff",
  email: "tomer@karoslabs.com",
  name: "Tomer",
  role: "KAROS_EMPLOYEE" as const,
  createdAt: 0,
};

/** A catalogue entry. The internal fields are real, so the projection has something to drop. */
const agent = (over: Partial<CustomAgent> & Pick<CustomAgent, "id" | "key" | "name">): CustomAgent =>
  ({
    description: "Master content-social skill. Given a brand's guidelines…",
    clientBlurb: null,
    icon: "Bot",
    color: "#00ff88",
    entrySkillDir: "products/live/linkedin-agent",
    skillRoots: [],
    includeClientSkills: true,
    instructions: "INTERNAL: the agent's system prompt.",
    enabled: true,
    ...over,
  }) as unknown as CustomAgent;

/**
 * One catalogue, holding every shape the offer has to decide about: an agent
 * bound to no client, THIS client's own instance, ANOTHER client's instance, a
 * disabled agent, and one this client already has an umbrella for.
 */
const OWN_INSTANCE = agent({
  id: "ca-li-acme",
  key: `karos-linkedin-company-${CLIENT_SLUG}`,
  name: "LinkedIn Company Page (Acme)",
});
const FOREIGN_INSTANCE = agent({
  id: "ca-li-bravo",
  key: "karos-linkedin-company-bravo",
  name: "LinkedIn Company Page (Bravo)",
});
const UNBOUND = agent({ id: "ca-ig", key: "karos-instagram-agent", name: "Instagram Agent" });
const X_AGENT = agent({ id: "ca-x", key: "karos-x-agent", name: "X Agent" });
const DISABLED = agent({
  id: "ca-off",
  key: "karos-tiktok-agent",
  name: "TikTok Agent",
  enabled: false,
});
const ALREADY_BOUND = agent({
  id: "ca-reddit",
  key: "karos-reddit-agent",
  name: "Reddit Agent",
});

const CATALOGUE = [OWN_INSTANCE, FOREIGN_INSTANCE, UNBOUND, X_AGENT, DISABLED, ALREADY_BOUND];
const BOUND_IDS = new Set([ALREADY_BOUND.id]);

const offers = (clientSlug: string | null = CLIENT_SLUG) =>
  bindableAgents({ agents: CATALOGUE, clientSlug, boundAgentIds: BOUND_IDS });

function world(
  over: {
    assets?: Asset[];
    jobs?: Job[];
    schedules?: PlannedScheduledRun[];
    umbrellas?: ClientAgent[];
  } = {},
) {
  vi.mocked(data.listAssets).mockResolvedValue(over.assets ?? []);
  vi.mocked(data.listJobs).mockResolvedValue(over.jobs ?? []);
  vi.mocked(data.listPlannedScheduledRuns).mockResolvedValue(over.schedules ?? []);
  vi.mocked(clientAgentData.listClientAgents).mockResolvedValue(over.umbrellas ?? []);
}

/** Run the REAL bind action for one catalogue agent against this client. */
async function bind(target: CustomAgent) {
  vi.mocked(data.getCustomAgent).mockResolvedValue(target as any);
  const { bindClientAgentAction } = await import("@/lib/actions/client-agent-actions");
  return bindClientAgentAction({ clientId: "c1", customAgentId: target.id });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(STAFF as any);
  vi.mocked(data.getClient).mockResolvedValue({
    id: "c1",
    name: "Acme",
    agentsRepoSlug: CLIENT_SLUG,
  } as any);
  vi.mocked(clientAgentData.upsertClientAgent).mockResolvedValue({ id: "c1__x", created: true });
  world();
});

/* ─────────────────── the contract: offer ⟹ accept ─────────────────── */

describe("the bind dropdown cannot offer what the bind action refuses", () => {
  it("every offered agent binds — none of them comes back refused", async () => {
    const offered = new Set(offers().map((a) => a.id));

    for (const candidate of CATALOGUE) {
      if (!offered.has(candidate.id)) continue;
      const result = await bind(candidate);
      expect(
        result.error,
        `${candidate.key} is in the dropdown but the action refuses it`,
      ).toBeUndefined();
      // `alreadyProducing` is a legitimate non-error outcome that carries no id,
      // so "an id came back" is not the contract — "the action did not refuse it"
      // is. Asserting truthiness here passes today only because `world()` leaves
      // jobs, assets and schedules empty, which makes `isAgentProducingForClient`
      // permanently false; the first fixture with a producing agent would fail
      // this line on entirely correct behaviour.
      expect(
        result.id || result.alreadyProducing,
        `${candidate.key} was offered, was not refused, and yet nothing came back`,
      ).toBeTruthy();
    }
  });

  it("and the action really does refuse something in this catalogue", async () => {
    // Non-vacuity, both ways round. Without this the loop above passes on a
    // world where nothing is refusable (and on an offer list that is empty).
    const refused: string[] = [];
    for (const candidate of CATALOGUE) {
      const result = await bind(candidate);
      if (result.error) refused.push(candidate.key);
    }
    expect(refused).toContain(FOREIGN_INSTANCE.key);

    const offered = offers().map((a) => a.id);
    expect(offered.length).toBeGreaterThan(0);
    for (const key of refused) {
      const id = CATALOGUE.find((a) => a.key === key)!.id;
      expect(offered, `${key} is refused by the action but still offered`).not.toContain(id);
    }
  });
});

/* ─────────────────── the projection, asked directly ─────────────────── */

describe("bindableAgents", () => {
  it("drops the instance baked under another client's lab folder", () => {
    expect(offers().map((a) => a.id)).not.toContain(FOREIGN_INSTANCE.id);
  });

  it("keeps this client's own instance and every agent bound to no client", () => {
    // The other direction: a filter that refused everything would satisfy the
    // assertion above and empty the dropdown for every client.
    const ids = offers().map((a) => a.id);
    expect(ids).toContain(OWN_INSTANCE.id);
    expect(ids).toContain(UNBOUND.id);
    expect(ids).toContain(X_AGENT.id);
  });

  it("offers no instance at all to a client with no lab folder", () => {
    // "No folder" must not read as "every folder" — the same edge the launch
    // gate and both submit cores answer this way.
    const ids = offers(null).map((a) => a.id);
    expect(ids).not.toContain(OWN_INSTANCE.id);
    expect(ids).not.toContain(FOREIGN_INSTANCE.id);
    expect(ids).toContain(UNBOUND.id);
  });

  it("still drops disabled agents and ones already bound here", () => {
    const ids = offers().map((a) => a.id);
    expect(ids).not.toContain(DISABLED.id);
    expect(ids).not.toContain(ALREADY_BOUND.id);
  });

  it("hands the control id and name only", () => {
    // The `<select>` is a client component, so every field on these objects is
    // serialized into the RSC payload whether or not it is painted. The
    // manifest description, the instructions and the skill dir must not be in
    // it (F127/CD-G2).
    const payload = JSON.stringify(offers());
    expect(payload).not.toContain("Master content-social skill");
    expect(payload).not.toContain("INTERNAL: the agent's system prompt.");
    expect(payload).not.toContain("products/live/linkedin-agent");
    for (const entry of offers()) {
      expect(Object.keys(entry).sort()).toEqual(["id", "name"]);
    }
  });
});
