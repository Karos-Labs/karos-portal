import { describe, expect, it, vi } from "vitest";
import type { Asset, Client, ClientAgent, CustomAgent, Job, PlannedScheduledRun } from "@/lib/types";

/**
 * THE ROSTER DERIVATION, EXTRACTED (round 6, 2026-09).
 *
 * `buildClientRosterEntries` is `app/(app)/clients/[id]/agents/page.tsx`'s own
 * client-branch assembly, lifted out unchanged so Reporting's "What we are
 * doing to improve your SEO and GEO" section can read the SAME rows. The bug
 * that motivated it is worth restating, because it is what these assertions are
 * for: `rosterStatus`'s rungs are order-sensitive and interdependent, and a
 * second page assembling its inputs by hand is how "Live" comes to mean two
 * things on two screens ("we pre-created content ... yet the page says runs on
 * request").
 *
 * So the closed questions here are about the rungs a caller could get wrong,
 * not about `rosterStatus` itself (`client-agents.test.ts` owns that): which
 * agents are listed at all, which word each one gets, and the three facts and
 * one flag the round-6 row prints beside the word.
 */

vi.mock("server-only", () => ({}));

// The data layer is reached only by `buildAgentSetup`, and only for the three
// intake-driven families. Every agent in these fixtures runs on no intake, so
// the mocks exist to keep the module graph off Firestore rather than to answer
// anything.
vi.mock("@/lib/data", () => ({
  getAsset: vi.fn(),
  getAgentIntake: vi.fn(async () => null),
  listClientSeats: vi.fn(async () => []),
  listPlannedScheduledRuns: vi.fn(async () => []),
}));
vi.mock("@/lib/data-client-agents", () => ({ listClientAgentFeedback: vi.fn(async () => []) }));
vi.mock("@/lib/client-agent-slots", () => ({ upcomingSlots: vi.fn(() => []) }));
vi.mock("@/lib/agent-service/x-agent-context", () => ({ hasXAgentIntake: vi.fn(async () => false) }));
vi.mock("@/lib/agent-service/linkedin-agent-context", () => ({
  hasLinkedInAgentIntake: vi.fn(async () => false),
  hasLinkedInV2Setup: vi.fn(async () => false),
}));
vi.mock("@/lib/agent-service/reddit-agent-context", () => ({
  hasRedditAgentIntake: vi.fn(async () => false),
}));

const { buildClientRosterEntries } = await import("@/lib/client-roster");

const NOW = Date.UTC(2026, 8, 4, 12, 0);
const DAY = 86_400_000;

const CLIENT = {
  customAgentIds: ["a-granted"],
  agentsRepoSlug: "acme",
} as unknown as Pick<Client, "customAgentIds" | "agentsRepoSlug">;

function agent(over: Partial<CustomAgent> & { id: string; name: string }): CustomAgent {
  return {
    key: "karos-instagram-agent",
    enabled: true,
    icon: null,
    color: null,
    creditCost: null,
    clientBlurb: null,
    ...over,
  } as unknown as CustomAgent;
}

async function build(over: {
  allAgents: CustomAgent[];
  jobs?: Job[];
  plannedRuns?: PlannedScheduledRun[];
  umbrellas?: ClientAgent[];
  assets?: Asset[];
  client?: Pick<Client, "customAgentIds" | "agentsRepoSlug">;
  scope?: "client" | "staff";
}) {
  return buildClientRosterEntries({
    clientId: "c-1",
    client: over.client ?? CLIENT,
    // round 6 review (C1): `viewerIsClient` is gone — the status inputs are
    // ALWAYS the client's, and `scope` only widens the candidate set.
    ...(over.scope ? { scope: over.scope } : {}),
    now: NOW,
    data: {
      allAgents: over.allAgents,
      jobs: over.jobs ?? [],
      plannedRuns: over.plannedRuns ?? [],
      umbrellas: over.umbrellas ?? [],
      assets: over.assets ?? [],
    },
  });
}

/** A client-visible post on a day that has not happened yet (the AF-5 rung). */
function upcomingPost(over: Partial<Asset> & { id: string }): Asset {
  return {
    clientId: "c-1",
    jobId: null,
    title: "Founder mode",
    status: "scheduled",
    scheduledAt: NOW + 2 * DAY,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    type: "social_post",
    meta: {},
    ...over,
  } as unknown as Asset;
}

describe("who is on the roster at all", () => {
  it("lists a granted agent and says it is granted", () => {
    return build({ allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })] }).then((entries) => {
      expect(entries).toHaveLength(1);
      expect(entries[0].customAgentId).toBe("a-granted");
      expect(entries[0].granted).toBe(true);
      expect(entries[0].agentKey).toBe("karos-instagram-agent");
      expect(entries[0].agentName).toBe("Instagram Agent");
      expect(entries[0].enabled).toBe(true);
    });
  });

  it("leaves out an agent this client neither has nor was delivered", async () => {
    const entries = await build({
      allAgents: [agent({ id: "a-other", name: "Other Agent" })],
    });
    expect(entries).toEqual([]);
  });

  it("keeps an agent off the roster when its instance belongs to another client", async () => {
    // The binding rung, applied before either route in can widen the list: a
    // per-client instance runs a skill baked under one client's lab folder, so
    // a run of it here would draft the wrong company.
    // The one key shape that names a single client: `karos-linkedin-company-…`
    // carries the lab slug its skill is baked under.
    const entries = await build({
      allAgents: [
        agent({ id: "a-granted", name: "Rival Page", key: "karos-linkedin-company-rival" }),
      ],
    });
    expect(entries).toEqual([]);
  });

  it("keeps a paused agent on the roster, badged and not granted-blind", async () => {
    const entries = await build({
      allAgents: [agent({ id: "a-granted", name: "Instagram Agent", enabled: false })],
    });
    // Paused agents stay rather than vanishing and leaving the client
    // wondering where an agent they were told about went.
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toEqual({ tone: "disabled", label: "Coming Soon" });
    expect(entries[0].enabled).toBe(false);
    expect(entries[0].granted).toBe(true);
  });
});

describe("the word each row gets", () => {
  it("says Not set up yet for a granted agent with nothing behind it", async () => {
    const [entry] = await build({ allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })] });
    expect(entry.status.label).toBe("Not set up yet");
  });

  it("says Live for an agent whose posts are already on the calendar (AF-5)", async () => {
    // The rung Albert's bug report was about: content we produce internally has
    // no schedule of its own to read Live from, and the client can see it
    // filling next week's calendar.
    const [entry] = await build({
      allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })],
      assets: [upcomingPost({ id: "asset-1", meta: { source: "lab-import", agentFolder: "instagram-agent" } })],
    });
    expect(entry.status).toMatchObject({ tone: "live", label: "Live" });
  });

  it("keeps the staff note off a client's row", async () => {
    // `rosterStatus` sets `staffNote` unconditionally (it takes no viewer
    // argument, by design) and the CALLER decides whether to paint it. What a
    // client's branch must never do is paint it — and a fail-safe here is that
    // `viewerIsStaff: false` also skips the failed-run rung entirely.
    const [entry] = await build({
      allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })],
      jobs: [
        {
          id: "j-1",
          clientId: "c-1",
          agentName: "Instagram Agent",
          customAgentId: "a-granted",
          status: "failed",
          createdAt: NOW - DAY,
          updatedAt: NOW - DAY,
          assetIds: [],
        } as unknown as Job,
      ],
    });
    expect(entry.status.label).toBe("Not set up yet");
    expect(entry.status.staffNote).toBeUndefined();
  });
});

describe("an agent that delivered work but was never granted", () => {
  const delivered = () =>
    build({
      allAgents: [agent({ id: "a-inherited", name: "Instagram Agent" })],
      assets: [
        {
          id: "asset-old",
          clientId: "c-1",
          jobId: null,
          title: "Founder mode",
          status: "approved",
          scheduledAt: NOW - 3 * DAY,
          publishedAt: NOW - 3 * DAY,
          createdAt: NOW - 4 * DAY,
          updatedAt: NOW - 3 * DAY,
          type: "social_post",
          meta: { source: "lab-import", agentFolder: "instagram-agent" },
        } as unknown as Asset,
      ],
    });

  it("is listed, because Not set up yet beside delivered work is a contradiction", async () => {
    const entries = await delivered();
    expect(entries.map((e) => e.customAgentId)).toEqual(["a-inherited"]);
    expect(entries[0].status.label).toBe("Runs on request");
  });

  it("reports granted:false, which is what costs it a destination", async () => {
    // A client opening an ungranted agent's page gets `notFound()`, so
    // Reporting offers those rows Support instead of "Open {agent}". The flag
    // is the whole reason the extraction returns one.
    const entries = await delivered();
    expect(entries[0].granted).toBe(false);
  });

  it("is not the staff-view `notGranted` marker, which a client never sets", async () => {
    const entries = await delivered();
    expect(entries[0].notGranted).toBeUndefined();
  });
});

describe("the facts the row prints beside the word", () => {
  it("names the newest thing the client can actually see, and when", async () => {
    const entries = await build({
      allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })],
      assets: [
        {
          id: "asset-older",
          clientId: "c-1",
          jobId: null,
          title: "Older post",
          status: "approved",
          scheduledAt: NOW - 5 * DAY,
          publishedAt: NOW - 5 * DAY,
          createdAt: NOW - 6 * DAY,
          updatedAt: NOW - 5 * DAY,
          type: "social_post",
          meta: { source: "lab-import", agentFolder: "instagram-agent" },
        } as unknown as Asset,
        {
          id: "asset-newer",
          clientId: "c-1",
          jobId: null,
          title: "Newer post",
          status: "approved",
          scheduledAt: NOW - 2 * DAY,
          publishedAt: NOW - 2 * DAY,
          createdAt: NOW - 3 * DAY,
          updatedAt: NOW - 2 * DAY,
          type: "social_post",
          meta: { source: "lab-import", agentFolder: "instagram-agent" },
        } as unknown as Asset,
      ],
    });
    expect(entries[0].lastMade?.title).toBe("Newer post");
  });

  it("carries the next planned DAY and nothing about what is on it", async () => {
    const [entry] = await build({
      allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })],
      assets: [
        upcomingPost({
          id: "asset-1",
          title: "Do not print me",
          scheduledAt: NOW + 3 * DAY,
          meta: { source: "lab-import", agentFolder: "instagram-agent" },
        }),
        upcomingPost({
          id: "asset-2",
          scheduledAt: NOW + 5 * DAY,
          meta: { source: "lab-import", agentFolder: "instagram-agent" },
        }),
      ],
    });
    // The EARLIEST day, and a number rather than a title or a count.
    expect(entry.nextAt).toBe(NOW + 3 * DAY);
  });

  it("has no next day when nothing is planned and no schedule is firing", async () => {
    const [entry] = await build({ allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })] });
    expect(entry.nextAt).toBeNull();
    expect(entry.lastMade).toBeNull();
  });

  it("never claims a credits fix it cannot see", async () => {
    // round 6 review (D7): the roster still does not read the credit BALANCE
    // (#130) — what it reads is the denial the scheduler stored when it refused
    // a fire, so an agent with no refusal at all cannot be a credits row. See
    // the attentionReason block at the end of this file for the case that can.
    const entries = await build({
      allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })],
    });
    expect(entries[0].attentionReason).not.toBe("credits");
  });
});

/**
 * round 6 review (C1/C2/C3/C8): ONE ASSEMBLER, ONE WORD.
 *
 * `buildClientRosterEntries` is the only place `rosterStatus`'s inputs are
 * assembled now — the staff branch of the agents page, Home's setup ladder and
 * Reporting all read what it returns. These two are the closed questions that
 * makes true: the word cannot depend on the reader, and the case Albert reported
 * twice has to come out "Live".
 */
describe("the word is the same for every reader", () => {
  const fixtures = {
    allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })],
    assets: [
      upcomingPost({
        id: "asset-1",
        meta: { source: "lab-import", agentFolder: "instagram-agent" },
      }),
    ],
  };

  it("gives staff and client scope the identical status word on the same inputs", async () => {
    const [clientEntry] = await build({ ...fixtures });
    const [staffEntry] = await build({ ...fixtures, scope: "staff" });
    // Same word, same tone. The staff scope may only ADD — here the AF-5
    // Internal sentence, which is what it is for.
    expect(clientEntry.status.label).toBe(staffEntry.status.label);
    expect(clientEntry.status.tone).toBe(staffEntry.status.tone);
    expect(clientEntry.status.label).toBe("Live");
    // `rosterStatus` resolves `staffNote` whatever the reader is (it is a fact
    // about the agent, not about the viewer); what the scope decides is whether
    // it is PAINTED — the `note` the row renders behind an "Internal" marker.
    expect(clientEntry.note).toBeUndefined();
    expect(staffEntry.note).toContain("Schedule is not firing");
  });

  it("agrees on the idle words too, where the staff branch used to widen the join", async () => {
    // The staff branch asked the delivered-work join with `viewerIsClient:
    // false`, which keeps drafts and aged-out work in scope. So one lab import
    // the client could see and one they could not produced the same word by
    // accident and different words as soon as the two sets diverged. Both
    // scopes ask the CLIENT's question now.
    const delivered = {
      allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })],
      assets: [
        {
          id: "asset-draft",
          clientId: "c-1",
          jobId: null,
          title: "Not for them yet",
          status: "draft",
          scheduledAt: null,
          createdAt: NOW - 2 * DAY,
          updatedAt: NOW - 2 * DAY,
          type: "social_post",
          meta: { source: "lab-import", agentFolder: "instagram-agent" },
        } as unknown as Asset,
      ],
    };
    const [clientEntry] = await build(delivered);
    const [staffEntry] = await build({ ...delivered, scope: "staff" });
    expect(clientEntry.status.label).toBe("Not set up yet");
    expect(staffEntry.status.label).toBe(clientEntry.status.label);
  });

  it("lists the ungranted superset for staff, and marks it, without moving a word", async () => {
    const two = {
      allAgents: [
        agent({ id: "a-granted", name: "Instagram Agent" }),
        agent({ id: "a-ungranted", name: "Other Agent" }),
      ],
    };
    expect((await build(two)).map((e) => e.customAgentId)).toEqual(["a-granted"]);
    const staff = await build({ ...two, scope: "staff" });
    expect(staff.map((e) => e.customAgentId)).toEqual(["a-granted", "a-ungranted"]);
    expect(staff[0].notGranted).toBeUndefined();
    expect(staff[1].notGranted).toBe(true);
    expect(staff[1].granted).toBe(false);
  });
});

/**
 * round 6 review (C1): THE CASE ALBERT REPORTED, TWICE.
 *
 * An intake-driven agent whose form is unsaved, which has ALREADY DELIVERED, and
 * which has a client-visible draft on a future day. The AF-5 rung promotes it to
 * "Live" because delivered work is past setup — and Home read "We are setting up
 * your first agent" over it, because the ladder's own hand assembly of
 * `rosterStatus`'s inputs omitted `hasDelivered`. Home maps THESE entries now,
 * so there is one answer and this is it.
 */
describe("an unsaved intake with delivered work and a future draft", () => {
  const unsavedIntakeWithHistory = {
    allAgents: [agent({ id: "a-granted", name: "X Agent", key: "karos-x-agent-v2" })],
    assets: [
      // Delivered, and inside the client's archive window.
      {
        id: "asset-delivered",
        clientId: "c-1",
        jobId: null,
        title: "Shipped last week",
        status: "approved",
        scheduledAt: NOW - 3 * DAY,
        publishedAt: NOW - 3 * DAY,
        createdAt: NOW - 4 * DAY,
        updatedAt: NOW - 3 * DAY,
        type: "social_post",
        meta: { source: "lab-import", agentFolder: "x-agent" },
      } as unknown as Asset,
      // A client-visible DRAFT on a day that has not happened (decision 1).
      upcomingPost({
        id: "asset-draft",
        status: "draft",
        scheduledAt: NOW + 2 * DAY,
        meta: { source: "lab-import", agentFolder: "x-agent" },
      }),
    ],
  };

  it("reads Live, for the client and for staff", async () => {
    const [clientEntry] = await build(unsavedIntakeWithHistory);
    const [staffEntry] = await build({ ...unsavedIntakeWithHistory, scope: "staff" });
    // `hasXAgentIntake` is mocked false, so this agent's `setup.ready` is false
    // — the state `agentNeedsSetup` blocks the AF-5 promotion for. Delivered
    // work is the escape, and it is the same escape the detail page's
    // `needsSetup` takes.
    expect(clientEntry.status.label).toBe("Live");
    expect(staffEntry.status.label).toBe("Live");
  });

  it("hands Home the same entry it hands the roster", async () => {
    // What Home reads off it: `status.tone === "live"` becomes the ladder's
    // `live`, which ticks step 3 instead of narrating a setup that is finished.
    const [entry] = await build(unsavedIntakeWithHistory);
    expect(entry.status.tone).toBe("live");
  });
});

/** round 6 review (E11): the caller that prints no facts pays for none. */
describe("withRowFacts", () => {
  const withHistory = {
    allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })],
    assets: [
      upcomingPost({
        id: "asset-1",
        meta: { source: "lab-import", agentFolder: "instagram-agent" },
      }),
    ],
  };

  it("resolves the row facts by default", async () => {
    const [entry] = await build(withHistory);
    expect(entry.nextAt).toBe(NOW + 2 * DAY);
  });

  it("resolves none of them when the caller says it prints none", async () => {
    const entries = await buildClientRosterEntries({
      clientId: "c-1",
      client: CLIENT,
      withRowFacts: false,
      now: NOW,
      data: {
        allAgents: withHistory.allAgents,
        jobs: [],
        plannedRuns: [],
        umbrellas: [],
        assets: withHistory.assets,
      },
    });
    // The WORD is unaffected — it is not a row fact.
    expect(entries[0].status.label).toBe("Live");
    expect(entries[0].lastMade).toBeUndefined();
    expect(entries[0].nextAt).toBeUndefined();
  });
});

/**
 * round 6 review (D7): the verb an attention row offers has to name what
 * produced the tone.
 */
describe("attentionReason names the thing that caused the attention", () => {
  const refusing = (lastError: string, lastErrorAt: number) => ({
    allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })],
    plannedRuns: [
      {
        id: "run-1",
        clientId: "c-1",
        customAgentId: "a-granted",
        status: "active",
        cadence: "daily",
        weekdays: [1, 2, 3, 4, 5],
        outputsPerRun: 1,
        hour: 9,
        minute: 0,
        nextRunAt: NOW + DAY,
        lastError,
        lastErrorAt,
      } as unknown as PlannedScheduledRun,
    ],
  });

  it("says credits when the stored refusal IS the credit denial", async () => {
    // The roster does not read the balance (#130) and does not need to: the
    // scheduler wrote the denial it refused with, `clientSafeRefusal` passes
    // credit denials through verbatim, and `isCreditDenialMessage` recognises
    // every house style the line has been minted in.
    const [entry] = await build(
      refusing("Not enough credits. This action costs 25 credits and 3 are left.", NOW - 60_000),
    );
    expect(entry.status.label).toBe("Needs attention");
    expect(entry.attentionReason).toBe("credits");
  });

  it("does not name credits for a refusal that has aged out of the badge", async () => {
    // Same window the WORD was resolved through: a refusal too old to force
    // "Needs attention" is too old to choose the verb either.
    const [entry] = await build(
      refusing(
        "Not enough credits. This action costs 25 credits and 3 are left.",
        NOW - 10 * DAY,
      ),
    );
    expect(entry.status.label).not.toBe("Needs attention");
    expect(entry.attentionReason).not.toBe("credits");
  });

  it("names no lever it cannot resolve", async () => {
    // An agent with no refusal, no intake and no failed launch offers "Open",
    // and the page behind the row is where the reason lives.
    const [entry] = await build({
      allAgents: [agent({ id: "a-granted", name: "Instagram Agent" })],
    });
    expect(entry.attentionReason).toBeNull();
  });
});
