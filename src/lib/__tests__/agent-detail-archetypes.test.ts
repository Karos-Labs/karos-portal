import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  Asset,
  ClientAgent,
  ClientAgentTemplate,
  Job,
  PlannedScheduledRun,
} from "@/lib/types";

vi.mock("server-only", () => ({}));

// The JOB half, imported to be asserted BLIND to the lab-import shape — the
// agreement tests below would otherwise pass for a reason nobody had checked.
const { jobDeliveredWork } = await import("@/lib/client-agents");

const {
  agentProducedAssets,
  agentsWithDeliveredWork,
  agentsWithUpcomingContent,
  buildClipMakerView,
  buildDailyFinderView,
  deliverableStamp,
  finderDays,
  templateDetails,
} = await import("@/lib/agent-detail-archetypes");

/**
 * CD-I1: the per-archetype RSC-boundary projections.
 *
 * The rules under test are the ones a client can be HARMED by getting wrong —
 * an unapproved draft surfacing as "found today", a batch's shared generation
 * instant printed under a gallery of a client's own clips, tomorrow's thread
 * arriving in a payload nobody paints. Every one of those is a boundary
 * decision, which is why they are asserted against the projection rather than
 * against a rendered component: a field that reaches the browser is readable
 * whether or not anything paints it.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const NOW = Date.UTC(2026, 6, 28, 12, 0, 0); // 2026-07-28T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    clientId: "c1",
    title: "Deliverable",
    content: "Body",
    createdBy: "staff-1",
    createdAt: NOW,
    updatedAt: NOW,
    status: "approved",
    type: "social_post",
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    clientId: "c1",
    agentId: "agent-service",
    agentName: "Clip Agent",
    status: "delivered",
    input: {},
    assetIds: [],
    createdBy: "staff-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Job;
}

/* ─────────────────────────── attribution ─────────────────────────── */

describe("agentProducedAssets", () => {
  const agent = { id: "ca-clip", name: "Clip Agent" };

  it("gives a CLIENT delivered work only, and staff everything", () => {
    const job = makeJob({ id: "j1", customAgentId: "ca-clip", assetIds: ["a-draft", "a-live"] });
    const draft = makeAsset({ id: "a-draft", status: "draft", jobId: "j1" });
    const live = makeAsset({ id: "a-live", status: "approved", jobId: "j1" });

    const forClient = agentProducedAssets({
      assets: [draft, live],
      jobs: [job],
      agent,
      umbrella: null,
      umbrellas: [],
      viewerIsClient: true,
      now: NOW,
    });
    expect(forClient.map((a) => a.id)).toEqual(["a-live"]);

    const forStaff = agentProducedAssets({
      assets: [draft, live],
      jobs: [job],
      agent,
      umbrella: null,
      umbrellas: [],
      viewerIsClient: false,
      now: NOW,
    });
    expect(forStaff.map((a) => a.id).sort()).toEqual(["a-draft", "a-live"]);
  });

  it("never returns another agent's work", () => {
    const mine = makeAsset({ id: "mine", jobId: "j1" });
    const theirs = makeAsset({ id: "theirs", jobId: "j2" });
    const jobs = [
      makeJob({ id: "j1", customAgentId: "ca-clip" }),
      makeJob({ id: "j2", customAgentId: "ca-other", agentName: "Someone Else" }),
    ];

    const out = agentProducedAssets({
      assets: [mine, theirs],
      jobs,
      agent,
      umbrella: null,
      umbrellas: [],
      viewerIsClient: false,
      now: NOW,
    });
    expect(out.map((a) => a.id)).toEqual(["mine"]);
  });

  it("keeps the pre-umbrella name rung, so a legacy agent is not shown as having made nothing", () => {
    // The flagship shape (CD-H8): a job carrying no customAgentId at all,
    // attributed by the name the RUN recorded.
    // `type: "note"` so no asset-derived label outranks the job's own name —
    // that fourth rung is what the flagship pre-umbrella agents rely on.
    const asset = makeAsset({ id: "legacy", jobId: "j-legacy", type: "note" });
    const job = makeJob({ id: "j-legacy", agentName: "Clip Agent" });
    delete (job as Partial<Job>).customAgentId;

    const out = agentProducedAssets({
      assets: [asset],
      jobs: [job],
      agent,
      umbrella: null,
      umbrellas: [],
      viewerIsClient: false,
      now: NOW,
    });
    expect(out.map((a) => a.id)).toEqual(["legacy"]);
  });

  it("matches a job's recorded name whatever case it was written in", () => {
    // The importer title-cases ("Instagram Agent"); a job fired before that
    // carries whatever the service sent ("karos-instagram-agent",
    // "instagram agent"). Comparing the strings verbatim is how a whole
    // pre-customAgentId run history disappears from a page.
    const asset = makeAsset({ id: "cased", jobId: "j-cased", type: "note" });
    const job = makeJob({ id: "j-cased", agentName: "  clip AGENT " });
    delete (job as Partial<Job>).customAgentId;

    const out = agentProducedAssets({
      assets: [asset],
      jobs: [job],
      agent,
      umbrella: null,
      umbrellas: [],
      viewerIsClient: false,
      now: NOW,
    });
    expect(out.map((a) => a.id)).toEqual(["cased"]);
  });

  /* ── the shape production is actually in ── */

  describe("the umbrella-less, jobless lab-import shape", () => {
    // EVERY client, today. `clientAgents` is empty (the backfill has never run)
    // so no client reaches the umbrella rung; lab imports are written with
    // `jobId: null` so they reach no job rung either; and the rung that was
    // left compared `agentLabelForAsset`'s SENTENCE case ("Instagram agent")
    // to the importer's TITLE case ("Instagram Agent"), which is false for
    // every multi-word agent name there is. All four rungs missed, so a client
    // opened a "Live" agent above an empty delivered-work section with months
    // of its posts sitting in their Workspace.
    const instagram = {
      id: "ca-ig",
      key: "karos-instagram-agent",
      name: "Instagram Agent",
    };

    const labAsset = (overrides: Partial<Asset> = {}, folder = "instagram-agent"): Asset =>
      makeAsset({
        jobId: null,
        agentId: null,
        meta: { source: "lab-import", labRun: `${folder}/run-1#post-1`, agentFolder: folder },
        ...overrides,
      });

    it("attributes a lab-imported asset to the agent whose folder it came from", () => {
      const out = agentProducedAssets({
        assets: [labAsset({ id: "lab-post" })],
        jobs: [],
        agent: instagram,
        umbrella: null,
        umbrellas: [],
        viewerIsClient: true,
        now: NOW,
      });
      expect(out.map((a) => a.id)).toEqual(["lab-post"]);
    });

    it("agrees across all three spellings of one agent, and only those", () => {
      // The normalisation's whole job: folder slug, title-cased name and
      // karos-prefixed key are one identity. Asserted through the function
      // rather than against the helper, because the helper is private on
      // purpose — there must be no second normaliser to drift from.
      for (const folder of [
        "instagram-agent",
        "Instagram Agent",
        "instagram_agent",
        "karos-instagram-agent",
      ]) {
        const out = agentProducedAssets({
          assets: [labAsset({ id: "lab-post" }, folder)],
          jobs: [],
          agent: instagram,
          umbrella: null,
          umbrellas: [],
          viewerIsClient: true,
          now: NOW,
        });
        expect(out.map((a) => a.id), folder).toEqual(["lab-post"]);
      }
    });

    it("still gives a CLIENT delivered work only — the folder rung does not bypass the archive", () => {
      // The visibility filter runs before attribution and nothing below it can
      // reach past it. A lab import lands as `status: "draft"`, so this is the
      // ordinary case rather than a contrived one: if the rung ran first, every
      // client would see the entire imported batch at generation time (A3/A4).
      const draft = labAsset({ id: "lab-draft", status: "draft" });
      const approved = labAsset({ id: "lab-approved", status: "approved" });
      const future = labAsset({
        id: "lab-future",
        status: "approved",
        scheduledAt: NOW + 3 * DAY,
      });

      const forClient = agentProducedAssets({
        assets: [draft, approved, future],
        jobs: [],
        agent: instagram,
        umbrella: null,
        umbrellas: [],
        viewerIsClient: true,
        now: NOW,
      });
      expect(forClient.map((a) => a.id)).toEqual(["lab-approved"]);

      const forStaff = agentProducedAssets({
        assets: [draft, approved, future],
        jobs: [],
        agent: instagram,
        umbrella: null,
        umbrellas: [],
        viewerIsClient: false,
        now: NOW,
      });
      expect(forStaff.map((a) => a.id).sort()).toEqual([
        "lab-approved",
        "lab-draft",
        "lab-future",
      ]);
    });

    it("does NOT credit one agent with another's lab runs — the instagram near-miss", () => {
      // F147's subject, and the reason the match is equality on a normalised
      // slug and nothing looser. This repo really does run
      // `karos-instagram-tiktok-content-agent` (the flagship feed engine) on the
      // same clients as plain instagram agents. Substring containment, prefix
      // matching or any edit-distance test unifies that pair and files one
      // agent's whole history under the other, where a client cannot tell it is
      // wrong. An empty list is a visible bug; a wrong list is an invisible one.
      const combined = {
        id: "ca-combined",
        key: "karos-instagram-tiktok-content-agent",
        name: "Instagram Tiktok Content Agent",
      };
      const assets = [
        labAsset({ id: "ig-post" }, "instagram-agent"),
        labAsset({ id: "combined-post" }, "karos-instagram-tiktok-content-agent"),
        labAsset({ id: "linkedin-post" }, "linkedin-agent"),
      ];
      const call = (agentArg: { id: string; key: string; name: string }) =>
        agentProducedAssets({
          assets,
          jobs: [],
          agent: agentArg,
          umbrella: null,
          umbrellas: [],
          viewerIsClient: false,
          now: NOW,
        }).map((a) => a.id);

      expect(call(instagram)).toEqual(["ig-post"]);
      expect(call(combined)).toEqual(["combined-post"]);
      // And neither of them collects the third agent's work either.
      expect(call(instagram)).not.toContain("linkedin-post");
      expect(call(combined)).not.toContain("linkedin-post");
    });

    it("does not let an asset's folder outrank a job that names another agent", () => {
      // The mirror of the rung order: a job we can hold has already been asked
      // the exact question. Letting a string in the asset's meta overrule it is
      // the same mis-credit arriving through the back door.
      const asset = makeAsset({
        id: "theirs",
        jobId: "j-other",
        meta: { agentFolder: "instagram-agent" },
      });
      const job = makeJob({ id: "j-other", customAgentId: "ca-other", agentName: "Someone Else" });

      const out = agentProducedAssets({
        assets: [asset],
        jobs: [job],
        agent: instagram,
        umbrella: null,
        umbrellas: [],
        viewerIsClient: false,
        now: NOW,
      });
      expect(out).toEqual([]);
    });

    it("lets the UMBRELLA decide once one exists", () => {
      // The path the backfill turns on. It stays exactly as it was: with an
      // umbrella the identity resolver is the only vote, so a folder slug can
      // neither add to nor subtract from what the umbrella owns.
      const umbrella = {
        id: "u-ig",
        clientId: "c1",
        customAgentId: "ca-ig",
        agentKey: "karos-instagram-agent",
        displayName: "Instagram",
        chainFamily: "social",
        launchState: "live",
      } as unknown as ClientAgent;

      const out = agentProducedAssets({
        // Same folder that matches on the umbrella-less path above.
        assets: [labAsset({ id: "lab-post", type: "note" })],
        jobs: [],
        agent: instagram,
        umbrella,
        umbrellas: [umbrella],
        viewerIsClient: false,
        now: NOW,
      });
      expect(out).toEqual([]);

      // And the umbrella's own link still attributes: same asset, linked job.
      const linked = agentProducedAssets({
        assets: [makeAsset({ id: "linked", jobId: "j-u" })],
        jobs: [makeJob({ id: "j-u", clientAgentId: "u-ig", agentName: "Someone Else" })],
        agent: instagram,
        umbrella,
        umbrellas: [umbrella],
        viewerIsClient: false,
        now: NOW,
      });
      expect(linked.map((a) => a.id)).toEqual(["linked"]);
    });
  });

  it("stays exact when one agent's slug is a strict PREFIX of another's", () => {
    // The instagram / instagram-tiktok pair above is a weak guard: it survives
    // prefix and containment matching too, so it cannot catch the loosening it
    // exists to prevent. This pair can: "instagram-agent" is a strict prefix of
    // "instagram-agent-pro", so `startsWith` or `includes` in either direction
    // would unify them and file one agent's entire history under the other.
    // Only equality keeps them apart.
    const base = { id: "ca-base", name: "Instagram Agent", key: "karos-instagram-agent" };
    const pro = { id: "ca-pro", name: "Instagram Agent Pro", key: "karos-instagram-agent-pro" };
    const lab = (id: string, folder: string): Asset =>
      makeAsset({
        id,
        jobId: null,
        agentId: null,
        meta: { source: "lab-import", labRun: `${folder}/run-1#post-1`, agentFolder: folder },
      });
    const assets = [lab("base-post", "instagram-agent"), lab("pro-post", "instagram-agent-pro")];
    const run = (agent: { id: string; name: string; key: string }) =>
      agentProducedAssets({
        assets,
        jobs: [],
        agent,
        umbrella: null,
        umbrellas: [],
        viewerIsClient: false,
        now: NOW,
      }).map((a) => a.id);

    expect(run(base)).toEqual(["base-post"]);
    expect(run(pro)).toEqual(["pro-post"]);
  });

});

/* ────────── the one delivered-work answer both surfaces read ────────── */

/**
 * `agentsWithDeliveredWork` is what the roster lists by AND what the agent
 * detail page gates and badges by. It is one function because the two were two:
 * a job-only join on both sides, blind to a lab import (`jobId: null`), which is
 * how an agent with 42 client-visible deliverables was absent from its client's
 * roster while the same page's counters printed them.
 */
describe("agentsWithDeliveredWork", () => {
  const CLIENT_SLUG = "karoslabs";
  const instagram = { id: "ca-ig", name: "Instagram Agent", key: "karos-instagram-agent" };
  /** "instagram-agent" is a STRICT PREFIX of this one's slug. Deliberate. */
  const pro = { id: "ca-pro", name: "Instagram Agent Pro", key: "karos-instagram-agent-pro" };

  const lab = (folder: string, overrides: Partial<Asset> = {}): Asset =>
    makeAsset({
      id: `lab-${folder}`,
      jobId: null,
      agentId: null,
      meta: { source: "lab-import", labRun: `${folder}/run-1#post-1`, agentFolder: folder },
      ...overrides,
    });

  const ask = (args: {
    assets?: Asset[];
    jobs?: Job[];
    agents?: readonly { id: string; name: string; key: string }[];
    umbrellas?: ClientAgent[];
    clientSlug?: string | null;
    viewerIsClient?: boolean;
  }): Set<string> =>
    agentsWithDeliveredWork({
      assets: args.assets ?? [],
      jobs: args.jobs ?? [],
      agents: args.agents ?? [instagram],
      umbrellas: args.umbrellas ?? [],
      clientSlug: args.clientSlug === undefined ? CLIENT_SLUG : args.clientSlug,
      viewerIsClient: args.viewerIsClient ?? true,
      now: NOW,
    });

  it("does not list an agent to a CLIENT on the strength of a run staff are still holding", () => {
    // `DELIVERED_JOB_STATUSES` includes `review`, and a review job's assets are
    // dropped by `getClientArchiveAssets` — so counting it listed the agent on the
    // client's roster with an empty page under it, which is the defect this rule
    // removes rather than a milder version of it. Staff keep `review`, because a
    // run awaiting their own review is the thing they most need to see.
    const customRun = (status: Job["status"], id: string): Job =>
      makeJob({
        id,
        status,
        customAgentId: instagram.id,
        // `makeJob` leaves `external` unset, and the job half skips anything that
        // is not a custom task — so without this the fixture attributes nothing
        // and the test passes for the wrong reason. It cost one red to find that,
        // which is the argument for the non-vacuity pair below.
        external: { taskType: "custom", serviceJobId: `svc-${id}` },
      });

    const inReview = customRun("review", "j-review");
    expect(ask({ jobs: [inReview], viewerIsClient: true }).has(instagram.id)).toBe(false);
    expect(ask({ jobs: [inReview], viewerIsClient: false }).has(instagram.id)).toBe(true);
    // Not vacuous: the SAME job shape at a status whose assets do reach the client
    // credits the agent for both viewers, so `review` is what is under test and
    // not the fixture failing to attribute at all.
    const delivered = customRun("delivered", "j-done");
    expect(ask({ jobs: [delivered], viewerIsClient: true }).has(instagram.id)).toBe(true);
    expect(ask({ jobs: [delivered], viewerIsClient: false }).has(instagram.id)).toBe(true);
  });

  it("gives the roster's list read and the detail page's single-agent read ONE answer for a lab import", () => {
    // The shape production is in: no job anywhere, attribution by folder alone.
    const assets = [lab("instagram-agent", { status: "approved" })];
    // The roster asks about its whole candidate list at once…
    const roster = ask({ assets, agents: [instagram, pro] });
    // …the detail page about the one agent it is about. Same question, and the
    // guarantee under test is that they cannot answer it differently.
    const detail = ask({ assets, agents: [instagram] });
    expect(roster.has(instagram.id)).toBe(detail.has(instagram.id));
    expect(detail.has(instagram.id)).toBe(true);
    // Not accidental agreement: the job half alone sees nothing here, which is
    // exactly why both surfaces used to say no.
    const jobHalf = jobDeliveredWork([]);
    expect(jobHalf.ids.size).toBe(0);
    expect(jobHalf.names.size).toBe(0);
  });

  it("gives the two surfaces ONE answer PER AGENT when two of them share a display name", () => {
    // The guarantee, asked as the closed question. A display name is not
    // unique-constrained, so two granted agents can carry the same one — and the
    // job half used to resolve the pre-`customAgentId` name rung through a
    // name→id map, which holds ONE entry per name. The roster builds that map over
    // its whole candidate list, so the first twin was shadowed by the second; the
    // detail page builds it for one agent, so nothing could shadow. The same
    // agent was therefore delivered on its own page and undelivered on the roster
    // that lists it — the disagreement this function exists to remove, arriving
    // through the function itself.
    //
    // RED under `new Map(bound.map((agent) => [agent.name, agent.id]))`: the
    // roster says no for twinA and its own page says yes.
    const twinA = { id: "ca-twin-a", name: "Instagram Agent", key: "karos-instagram-agent" };
    const twinB = { id: "ca-twin-b", name: "Instagram Agent", key: "karos-instagram-beta" };
    // The shape the name rung exists for: a delivered run with NO customAgentId,
    // recorded under a name both agents answer to.
    const nameless = makeJob({
      id: "j-nameless",
      status: "delivered",
      agentName: "Instagram Agent",
      external: { taskType: "custom", serviceJobId: "svc-run-1" },
    });
    expect("customAgentId" in nameless).toBe(false);

    const roster = ask({ jobs: [nameless], agents: [twinA, twinB] });
    // PER AGENT, not as a set: a set comparison passes when the roster credits
    // the wrong twin, which is exactly the shadowing this pins.
    for (const twin of [twinA, twinB]) {
      const detail = ask({ jobs: [nameless], agents: [twin] });
      expect(roster.has(twin.id), `roster vs own page: ${twin.id}`).toBe(detail.has(twin.id));
    }
    // And not vacuous agreement on "no": the run really is attributed to both,
    // because a job that names neither id cannot say which twin ran it. Crediting
    // one and not the other would be picking by list order.
    expect(roster.has(twinA.id)).toBe(true);
    expect(roster.has(twinB.id)).toBe(true);
    // The list order the shadowing depended on now changes nothing.
    expect([...ask({ jobs: [nameless], agents: [twinB, twinA] })].sort()).toEqual(
      [twinA.id, twinB.id].sort(),
    );
  });

  it("still counts a delivered JOB whose deliverables a client can no longer see", () => {
    // The other half, and why the asset rungs cannot replace the job join: a
    // client's archive is a 30-day window, so an agent that last delivered two
    // months ago would drop back to "Not set up yet" without this.
    const job = makeJob({
      id: "j-old",
      customAgentId: instagram.id,
      status: "delivered",
      assetIds: ["aged-out"],
      external: { taskType: "custom", serviceJobId: "svc-run-1" },
    });
    const agedOut = makeAsset({
      id: "aged-out",
      jobId: "j-old",
      status: "published",
      publishedAt: NOW - 60 * DAY,
    });
    // The premise, asserted rather than assumed: the asset half is EMPTY here,
    // so this test is about the job half and not about a fixture that happens
    // to be visible.
    expect(
      agentProducedAssets({
        assets: [agedOut],
        jobs: [job],
        agent: instagram,
        umbrella: null,
        umbrellas: [],
        viewerIsClient: true,
        now: NOW,
      }),
    ).toEqual([]);
    expect(ask({ assets: [agedOut], jobs: [job] }).has(instagram.id)).toBe(true);
  });

  it("says NO for an agent with no delivered work of any kind, for either viewer", () => {
    const failed = makeJob({
      id: "j-failed",
      customAgentId: instagram.id,
      status: "failed",
      external: { taskType: "custom", serviceJobId: "svc-run-1" },
    });
    const somebodyElses = lab("reddit-agent", { status: "approved" });
    for (const viewerIsClient of [true, false]) {
      const out = ask({ assets: [somebodyElses], jobs: [failed], viewerIsClient });
      expect(out.has(instagram.id), `viewerIsClient=${viewerIsClient}`).toBe(false);
      expect(out.size).toBe(0);
    }
  });

  it("never lets a CLIENT inherit an agent through work they may not see", () => {
    // Widening the roster must not widen what a client is told exists. A draft
    // and a future-dated post are both this agent's, and neither may put its
    // card on the client's roster — a card that appeared the day a batch was
    // generated is itself the churn tell (A3).
    const draft = lab("instagram-agent", { id: "unapproved", status: "draft" });
    const tomorrow = lab("instagram-agent", {
      id: "tomorrow",
      status: "scheduled",
      scheduledAt: NOW + 2 * DAY,
    });
    expect(ask({ assets: [draft, tomorrow], viewerIsClient: true }).has(instagram.id)).toBe(false);
    // Staff review drafts for a living, so for them the same work counts — the
    // split every other number on these pages already carries.
    expect(ask({ assets: [draft, tomorrow], viewerIsClient: false }).has(instagram.id)).toBe(true);
  });

  describe("a strict-prefix pair — only equality keeps them apart", () => {
    // Asked one asset at a time on purpose: with both agents' work present both
    // are delivered under ANY comparison, so the pair would survive the
    // loosening it exists to forbid.
    it("does not credit the shorter slug with the longer one's work", () => {
      // Red under `folder.startsWith(slug)` or `folder.includes(slug)`.
      const out = ask({
        assets: [lab("instagram-agent-pro", { status: "approved" })],
        agents: [instagram, pro],
      });
      expect(out.has(instagram.id)).toBe(false);
      expect(out.has(pro.id)).toBe(true);
    });

    it("does not credit the longer slug with the shorter one's work", () => {
      // Red under `slug.startsWith(folder)` or `slug.includes(folder)`.
      const out = ask({
        assets: [lab("instagram-agent", { status: "approved" })],
        agents: [instagram, pro],
      });
      expect(out.has(pro.id)).toBe(false);
      expect(out.has(instagram.id)).toBe(true);
    });
  });

  it("keeps a per-client instance off every client but its own, however much it has delivered", () => {
    // The binding outranks delivered work on both routes in — a grant and an
    // inherited run are equally unable to move an instance off the client its
    // key names. This is the second gate; the roster filters on the same
    // predicate before it lists anything.
    const instance = {
      id: "ca-li-xo",
      name: "LinkedIn Company Agent",
      key: "karos-linkedin-company-xodigital",
    };
    const jobs = [
      makeJob({
        id: "j-li",
        customAgentId: instance.id,
        status: "delivered",
        external: { taskType: "custom", serviceJobId: "svc-run-1" },
      }),
    ];
    const assets = [lab("linkedin-company-agent", { status: "approved" })];
    for (const viewerIsClient of [true, false]) {
      expect(
        ask({ assets, jobs, agents: [instance], clientSlug: CLIENT_SLUG, viewerIsClient }).size,
        `viewerIsClient=${viewerIsClient}`,
      ).toBe(0);
    }
    // The control: on its OWN client the same fixtures do read as delivered, so
    // the exclusion above is the binding and not a fixture that attributes
    // nothing. Both halves are exercised — the job and the folder.
    expect(ask({ assets, jobs, agents: [instance], clientSlug: "xodigital" }).size).toBe(1);
    expect(ask({ assets, agents: [instance], clientSlug: "xodigital" }).size).toBe(1);
  });
});

/* ─────────────── upcoming calendar content (AF-5) ─────────────── */

describe("agentsWithUpcomingContent", () => {
  // Albert: "if there's items on the calendar like Instagram or TikTok items, it
  // should show us live." The stream this answers for has no cron — we produce
  // its posts by hand and import them — so its own machinery says idle while the
  // client watches it fill next week.
  const CLIENT_SLUG = "karoslabs";
  const instagram = { id: "ca-ig", name: "Instagram Agent", key: "karos-instagram-agent" };
  const SOON = NOW + 3 * DAY;

  /** An imported post, attributed by folder — the shape that has no job at all. */
  const imported = (overrides: Partial<Asset> = {}): Asset =>
    makeAsset({
      id: "up-1",
      jobId: null,
      agentId: null,
      status: "approved",
      scheduledAt: SOON,
      meta: { source: "lab-import", agentFolder: "instagram-agent" },
      ...overrides,
    });

  const ask = (args: {
    assets?: Asset[];
    jobs?: Job[];
    agents?: readonly { id: string; name: string; key: string }[];
    umbrellas?: ClientAgent[];
    clientSlug?: string | null;
  }): Set<string> =>
    agentsWithUpcomingContent({
      assets: args.assets ?? [],
      jobs: args.jobs ?? [],
      agents: args.agents ?? [instagram],
      umbrellas: args.umbrellas ?? [],
      clientSlug: args.clientSlug === undefined ? CLIENT_SLUG : args.clientSlug,
      now: NOW,
    });

  it("finds an imported post scheduled for a day that has not happened", () => {
    expect(ask({ assets: [imported()] }).has(instagram.id)).toBe(true);
  });

  it("answers the same for both readers, because the WORD is the client's", () => {
    // There is no viewer argument by design: a staff roster asking a
    // staff-flavoured version of this question would call one agent idle on one
    // screen and live on the other, which is the disagreement the shared
    // attribution rungs exist to remove.
    expect(agentsWithUpcomingContent.length).toBe(1);
    expect(source("src/lib/agent-detail-archetypes.ts")).not.toMatch(
      /agentsWithUpcomingContent[\s\S]{0,600}viewerIsClient/,
    );
  });

  it("ignores a post that has already gone out, or is due in the past", () => {
    // Upcoming means upcoming. A past-due scheduled post is one that did NOT go
    // out, which is not a reason to call an agent live.
    expect(ask({ assets: [imported({ scheduledAt: NOW - DAY })] }).size).toBe(0);
    expect(
      ask({ assets: [imported({ status: "published", publishedAt: NOW - DAY })] }).size,
    ).toBe(0);
  });

  it("ignores a draft, which never reaches a client's calendar", () => {
    expect(ask({ assets: [imported({ status: "draft" })] }).size).toBe(0);
  });

  it("ignores launch and test-run output, which is on nobody's calendar", () => {
    expect(
      ask({
        assets: [
          imported({
            meta: { source: "lab-import", agentFolder: "instagram-agent", launchDeliverable: true },
          }),
        ],
      }).size,
    ).toBe(0);
    expect(
      ask({
        assets: [
          imported({
            meta: { source: "lab-import", agentFolder: "instagram-agent", testRun: true },
          }),
        ],
      }).size,
    ).toBe(0);
  });

  it("counts a placeholder, which is still an item on the day", () => {
    // Karos never publishes one, but the client sees it on the calendar for a
    // future day, and that is the trigger in the ruling.
    expect(
      ask({ assets: [imported({ publishMode: "placeholder" })] }).has(instagram.id),
    ).toBe(true);
  });

  it("does not credit one agent's upcoming stream to another", () => {
    // The same rungs `agentProducedAssets` uses, so the F147 rule holds here:
    // normalisation, never fuzz. "instagram-agent" is a strict prefix of the
    // other key and must not match it.
    const pro = { id: "ca-pro", name: "Instagram Agent Pro", key: "karos-instagram-agent-pro" };
    const found = ask({ assets: [imported()], agents: [instagram, pro] });
    expect(found.has(instagram.id)).toBe(true);
    expect(found.has(pro.id)).toBe(false);
  });

  it("drops a per-client instance belonging to somebody else", () => {
    // The binding wins here as everywhere: no amount of upcoming work moves an
    // instance off the client its key names.
    const instance = {
      id: "ca-li",
      name: "LinkedIn Agent",
      key: "karos-linkedin-company-xodigital",
    };
    const theirs = imported({
      meta: { source: "lab-import", agentFolder: "linkedin-company-xodigital" },
    });
    expect(ask({ assets: [theirs], agents: [instance], clientSlug: "xodigital" }).size).toBe(1);
    expect(ask({ assets: [theirs], agents: [instance], clientSlug: CLIENT_SLUG }).size).toBe(0);
  });

  it("returns ids and nothing else — no count, no date, no title", () => {
    // The whole boundary contract. A caller can learn that SOME upcoming item
    // exists and not one thing about it, so a client is told only what their own
    // calendar already shows them (A3/A4).
    const found = ask({
      assets: [
        imported({ id: "u1", title: "Next Tuesday's post" }),
        imported({ id: "u2", title: "Next Thursday's post" }),
      ],
    });
    expect(found).toBeInstanceOf(Set);
    expect([...found]).toEqual([instagram.id]);
    expect(JSON.stringify([...found])).not.toContain("Tuesday");
  });
});

describe("deliverableStamp", () => {
  it("gives a client the DELIVERY moment and staff the generation instant", () => {
    // The batch tell in its purest form: seven posts generated in one minute,
    // delivered across a week. createdAt would print all seven as "3 hours ago".
    const asset = makeAsset({ createdAt: 1_000, updatedAt: 9_000 });
    expect(deliverableStamp(asset, true)).toBe(9_000);
    expect(deliverableStamp(asset, false)).toBe(1_000);
  });

  it("prefers the posting time once work is published", () => {
    const asset = makeAsset({ createdAt: 1_000, updatedAt: 9_000, publishedAt: 5_000 });
    expect(deliverableStamp(asset, true)).toBe(5_000);
  });
});

/* ─────────────────── the template click-through (CD-K1) ────────────────── */

describe("templateDetails", () => {
  const templates: ClientAgentTemplate[] = [
    {
      key: "numbers",
      name: "By The Numbers",
      rationale: "Your audience responds to hard figures.",
      status: "active",
      position: 0,
      source: "launch",
      addedAt: NOW - 40 * DAY,
    },
    {
      key: "story",
      name: "Founder Story",
      status: "paused",
      position: 1,
      source: "manual",
      addedAt: NOW - 10 * DAY,
    },
  ];

  it("joins posts on Asset.templateKey and stamps them for this viewer", () => {
    const details = templateDetails({
      templates,
      assets: [
        makeAsset({ id: "n1", templateKey: "numbers", createdAt: 1_000, updatedAt: 5_000 }),
        makeAsset({ id: "n2", templateKey: "numbers", createdAt: 1_000, updatedAt: 9_000 }),
        makeAsset({ id: "s1", templateKey: "story", createdAt: 2_000, updatedAt: 2_000 }),
      ],
      viewerIsClient: true,
    });
    // Newest first, by the stamp this viewer reads — a batch shares one
    // createdAt, so ordering on it would shuffle a client's list arbitrarily.
    expect(details.numbers.posts.map((p) => p.id)).toEqual(["n2", "n1"]);
    expect(details.numbers.posts[0].at).toBe(9_000);
    expect(details.numbers.postCount).toBe(2);
    expect(details.story.posts.map((p) => p.id)).toEqual(["s1"]);
  });

  it("gives staff the generation instant for the same rows", () => {
    const details = templateDetails({
      templates,
      assets: [makeAsset({ id: "n1", templateKey: "numbers", createdAt: 1_000, updatedAt: 9_000 })],
      viewerIsClient: false,
    });
    expect(details.numbers.posts[0].at).toBe(1_000);
  });

  it("ignores assets that belong to no template, and never invents a key", () => {
    // A deliverable with no templateKey is not "unfiled under this format" —
    // it belongs to no stream, and bucketing it anywhere would credit a post to
    // a format that did not produce it (the F147 shape, one level down).
    const details = templateDetails({
      templates,
      assets: [
        makeAsset({ id: "loose" }),
        makeAsset({ id: "other", templateKey: "not-in-registry" }),
      ],
      viewerIsClient: true,
    });
    expect(Object.keys(details).sort()).toEqual(["numbers", "story"]);
    expect(details.numbers.postCount).toBe(0);
    expect(details.numbers.posts).toEqual([]);
  });

  it("caps the list but keeps the true count beside it", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      makeAsset({ id: `a${i}`, templateKey: "numbers", updatedAt: 1_000 + i }),
    );
    const details = templateDetails({ templates, assets: many, viewerIsClient: true, perTemplate: 3 });
    expect(details.numbers.posts).toHaveLength(3);
    expect(details.numbers.postCount).toBe(9);
    expect(details.numbers.posts.map((p) => p.id)).toEqual(["a8", "a7", "a6"]);
  });

  it("carries the registry's own dates and nothing a client may not read", () => {
    const details = templateDetails({ templates, assets: [], viewerIsClient: true });
    expect(details.numbers.addedAt).toBe(NOW - 40 * DAY);
    expect(details.numbers.rationale).toBe("Your audience responds to hard figures.");
    expect(details.story.source).toBe("manual");
    // No status, no draft marker, no "ready" field anywhere in the projection:
    // anything that told a pre-generated post from a day-of one would put the
    // batch shape back on the page the archive filter took it off (A3/A4).
    expect(Object.keys(details.numbers).sort()).toEqual([
      "addedAt",
      "key",
      "postCount",
      "posts",
      "rationale",
      "source",
    ]);
  });

  /* ── AF-6: an example of each format, without opening it ── */

  it("carries the newest delivered post as the format's example", () => {
    // Albert asked to see "the different templates we produce for that client
    // and an example of each". The example is the FIRST row of the list the
    // format opens onto, so what a reader sees closed and what they see open
    // cannot be two different posts.
    const details = templateDetails({
      templates,
      assets: [
        makeAsset({ id: "n1", title: "Older", templateKey: "numbers", updatedAt: 5_000 }),
        makeAsset({ id: "n2", title: "Newest", templateKey: "numbers", updatedAt: 9_000 }),
      ],
      viewerIsClient: true,
    });
    expect(details.numbers.example).toEqual({ id: "n2", title: "Newest", at: 9_000 });
    expect(details.numbers.example!.id).toBe(details.numbers.posts[0].id);
  });

  it("carries a thumbnail when the example has one, and no meta with it", () => {
    // One URL off `assetImages`, never the asset's meta: a lab-imported post's
    // meta holds the folder it came from and whatever else the importer wrote.
    const details = templateDetails({
      templates,
      assets: [
        makeAsset({
          id: "n1",
          templateKey: "numbers",
          updatedAt: 9_000,
          meta: { images: ["https://cdn.example/one.png"], agentFolder: "instagram-agent" },
        }),
      ],
      viewerIsClient: true,
    });
    expect(details.numbers.example?.imageUrl).toBe("https://cdn.example/one.png");
    expect(Object.keys(details.numbers.example!).sort()).toEqual([
      "at",
      "id",
      "imageUrl",
      "title",
    ]);
    expect(JSON.stringify(details)).not.toContain("agentFolder");
    // A text-only format says so by absence rather than by an empty frame.
    expect(details.story.example).toBeUndefined();
  });

  it("has no example for a format that has delivered this viewer nothing", () => {
    // The set is already archive-filtered upstream (`agentProducedAssets`), so a
    // format whose only work is undelivered has nothing to show and must not
    // borrow another format's post to fill the space.
    const details = templateDetails({ templates, assets: [], viewerIsClient: true });
    expect(details.numbers.example).toBeUndefined();
    expect(details.numbers.postCount).toBe(0);
  });

  it("never lets the example outlive the row it was drawn from", () => {
    // The example must be a post this VIEWER may see: it is taken from the same
    // filtered list, so a capped list still examples its own newest row.
    const many = Array.from({ length: 9 }, (_, i) =>
      makeAsset({ id: `a${i}`, templateKey: "numbers", updatedAt: 1_000 + i }),
    );
    const details = templateDetails({
      templates,
      assets: many,
      viewerIsClient: true,
      perTemplate: 3,
    });
    expect(details.numbers.example?.id).toBe("a8");
    // And the row objects themselves stay the two-field shape — the asset the
    // example was resolved from must not ride along on every post.
    for (const post of details.numbers.posts) {
      expect(Object.keys(post).sort()).toEqual(["at", "id", "title"]);
    }
  });

  it("pins a post row to exactly three fields", () => {
    // The sibling of the assertion above, and the one that was missing: the
    // key-set pin was being run against an EMPTY ARRAY, so `Object.keys(...)`
    // was 0 for reasons that had nothing to do with the projection. A post row
    // is where a `status` or a "ready" marker would most plausibly be added,
    // and it is the field that would hand a client the batch shape under the
    // one heading that groups work by the stream that produced it (A3/A4).
    const details = templateDetails({
      templates,
      assets: [makeAsset({ id: "a1", templateKey: "numbers" })],
      viewerIsClient: true,
    });
    expect(details.numbers.posts).toHaveLength(1);
    expect(Object.keys(details.numbers.posts[0]).sort()).toEqual(["at", "id", "title"]);
  });

  it("keeps a retired template's history reachable", () => {
    // A client with posts under a stream that was later retired still needs
    // somewhere for them to appear. WHICH templates are offered is
    // visibleTemplates' decision, upstream of this.
    const retired: ClientAgentTemplate = { ...templates[0], key: "gone", status: "retired" };
    const details = templateDetails({
      templates: [retired],
      assets: [makeAsset({ id: "old", templateKey: "gone" })],
      viewerIsClient: true,
    });
    expect(details.gone.postCount).toBe(1);
  });
});

/* ─────────────────────────── clip maker ─────────────────────────── */

describe("buildClipMakerView", () => {
  it("partitions playable clips from everything else the agent wrote", () => {
    const clip = makeAsset({ id: "clip", videoUrl: "https://cdn.example/a.mp4" });
    const metaClip = makeAsset({
      id: "meta-clip",
      meta: { files: [{ name: "cut-1.mp4", url: "https://cdn.example/cut-1.mp4" }] },
    });
    const doc = makeAsset({ id: "doc", content: "A caption, not a clip." });

    const view = buildClipMakerView({ assets: [clip, metaClip, doc], run: null, now: NOW });
    expect(view.clips.map((a) => a.id)).toEqual(["clip", "meta-clip"]);
    expect(view.documents.map((a) => a.id)).toEqual(["doc"]);
  });

  it("cannot render a clip for a locked asset", () => {
    // redactLockedAsset builds by whitelist and does not carry videoUrl, so a
    // future-dated clip resolves to zero videos even if one reached this far.
    const redacted = makeAsset({
      id: "locked",
      title: "Upcoming post",
      content: "",
      meta: { locked: true },
      imageUrl: null,
      locked: true,
    });
    const view = buildClipMakerView({ assets: [redacted], run: null, now: NOW });
    expect(view.clips).toEqual([]);
  });

  it("has no schedule days without a schedule, and no template field at all", () => {
    const view = buildClipMakerView({ assets: [], run: null, now: NOW });
    expect(view.scheduledDays).toEqual([]);
    // The archetype's hard rule: NO TEMPLATE ROWS EVER. It holds because the
    // view has no template field to render one from.
    expect(Object.keys(view).sort()).toEqual(["clips", "documents", "scheduledDays"]);
  });
});

/* ────────────────────────── daily finder ────────────────────────── */

/**
 * The pinned batch structure, trimmed from the fixture reddit-drafts.test.ts
 * holds. Same shape on purpose: if the agent's output format moves, both
 * fixtures have to move, and a private near-miss here would let this file keep
 * passing against a document the real reader can no longer parse.
 */
const REDDIT_BATCH = `# Reddit answer drafts — Karos Labs

## Account 1 · Karos Labs — company account (u/karos-al) · warming
*Value-only program-wide until the account earns history.*

### Draft 1 · Thorough value answer
*P5 early growth, the account's earned lane.*

- **Thread:** [How do you guys ACTUALLY market your SaaS?](https://www.reddit.com/r/SaaS/comments/1uqssai/how_do_you_guys_actually_market_your_saas/)
- **Subreddit:** r/SaaS — value-only, never mention
- **Thread posted:** 2026-07-28, same-day and active
- **Why this thread:** nobody names the core problem

> At a month in with 150 users, the problem is not a missing channel.

\`742 chars\`
`;

describe("buildDailyFinderView", () => {
  const zone = "UTC";

  it("puts TODAY's finds in `today` and everything older in `earlier`", () => {
    const today = makeAsset({
      id: "find-today",
      content: REDDIT_BATCH,
      updatedAt: NOW,
      createdAt: NOW,
    });
    const yesterday = makeAsset({
      id: "find-yesterday",
      content: REDDIT_BATCH,
      updatedAt: NOW - DAY,
      createdAt: NOW - DAY,
    });

    const view = buildDailyFinderView({
      assets: [today, yesterday],
      jobs: [],
      run: null,
      viewerIsClient: true,
      now: NOW,
      zone,
    });

    expect(view.today.map((b) => b.assetId)).toEqual(["find-today"]);
    expect(view.earlier.map((b) => b.assetId)).toEqual(["find-yesterday"]);
    expect(view.todayKey).toBe("2026-07-28");
  });

  it("never puts a FUTURE day's find in `today` (churn A3/A4)", () => {
    // The one fact the model exists to keep indistinguishable. A find stamped
    // tomorrow is not today's, whatever else is true of it.
    const tomorrow = makeAsset({
      id: "find-tomorrow",
      content: REDDIT_BATCH,
      updatedAt: NOW + DAY,
      createdAt: NOW + DAY,
    });
    const view = buildDailyFinderView({
      assets: [tomorrow],
      jobs: [],
      run: null,
      viewerIsClient: true,
      now: NOW,
      zone,
    });
    expect(view.today).toEqual([]);
  });

  it("routes an asset that is not a draft batch to documents, not to an empty find", () => {
    const report = makeAsset({ id: "report", content: "# Weekly summary\n\nNo threads." });
    const view = buildDailyFinderView({
      assets: [report],
      jobs: [],
      run: null,
      viewerIsClient: true,
      now: NOW,
      zone,
    });
    expect(view.today).toEqual([]);
    expect(view.earlier).toEqual([]);
    expect(view.documents.map((a) => a.id)).toEqual(["report"]);
  });

  it("parses at the boundary and sends the parsed shape, not the raw document", () => {
    const asset = makeAsset({ id: "find", content: REDDIT_BATCH, updatedAt: NOW });
    const view = buildDailyFinderView({
      assets: [asset],
      jobs: [],
      run: null,
      viewerIsClient: true,
      now: NOW,
      zone,
    });
    const batch = view.today[0];
    expect(batch.accounts).toHaveLength(1);
    expect(batch.accounts[0].drafts[0].subreddit).toBe("r/SaaS");
    expect(batch.accounts[0].mode).toBe("warming");
    // The batch carries no asset content field of its own — the payload is the
    // parsed shape.
    expect(Object.keys(batch).sort()).toEqual(["accounts", "assetId", "at"]);
  });

  it("stamps a client's finds with delivery, not with the shared generation instant", () => {
    const asset = makeAsset({ id: "find", content: REDDIT_BATCH, createdAt: 1_000, updatedAt: NOW });
    const forClient = buildDailyFinderView({
      assets: [asset],
      jobs: [],
      run: null,
      viewerIsClient: true,
      now: NOW,
      zone,
    });
    expect(forClient.today[0].at).toBe(NOW);

    const forStaff = buildDailyFinderView({
      assets: [asset],
      jobs: [],
      run: null,
      viewerIsClient: false,
      now: NOW,
      zone,
    });
    // Staff keep the generation instant, so for them the same asset is old.
    expect(forStaff.today).toEqual([]);
    expect(forStaff.earlier[0].at).toBe(1_000);
  });
});

describe("finderDays", () => {
  const zone = "UTC";

  it("paints no days at all for an agent nobody has scheduled", () => {
    // It used to return the lookback window plus today whatever the schedule
    // was, so an agent that had never run rendered four dated chips under
    // "WHEN IT LOOKS" while the panel above said "Not looking yet" — days on
    // which it demonstrably did not look. The empty list is what DailyStrip
    // turns into "No schedule yet".
    expect(finderDays({ run: null, now: NOW, zone })).toEqual([]);
  });

  it("projects forward from the agent's own schedule", () => {
    const run = {
      id: "run-1",
      clientId: "c1",
      customAgentId: "ca-reddit",
      cadence: "weekly",
      status: "active",
      hour: 9,
      minute: 0,
      weekdays: [1, 2, 3, 4, 5],
      nextRunAt: NOW + DAY,
      timeZone: zone,
    } as unknown as PlannedScheduledRun;

    const days = finderDays({ run, now: NOW, zone, horizonDays: 7 });
    expect(days.some((d) => d.dateKey > "2026-07-28")).toBe(true);
    // Today and the lookback survive the no-schedule early return: `nextRunAt`
    // only ever points forward, so a projection alone would render a strip that
    // begins in the future and never contains today.
    expect(days.find((d) => d.isToday)?.dateKey).toBe("2026-07-28");
    expect(days.some((d) => d.isPast)).toBe(true);
    expect(days.filter((d) => d.isPast).every((d) => d.dateKey < "2026-07-28")).toBe(true);
    // Weekday-only: the Reddit agent fires at most five days a week, so a
    // seven-day strip would promise two days it never works.
    const weekend = days.filter((d) => {
      const [y, m, dd] = d.dateKey.split("-").map(Number);
      const day = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
      return day === 0 || day === 6;
    });
    expect(weekend.every((d) => d.dateKey <= "2026-07-28")).toBe(true);
  });
});

/* ───────────────────────────── wiring ───────────────────────────── */

describe("wiring", () => {
  const route = () => source("src/app/(app)/clients/[id]/agents/[agentId]/page.tsx");

  it("the detail route builds every archetype view through the server-only module", () => {
    const src = route();
    expect(src).toContain("agentProducedAssets");
    expect(src).toContain("buildClipMakerView");
    expect(src).toContain("buildDailyFinderView");
  });

  it("keeps the staff run history and its prompt off a client payload", () => {
    const src = route();
    // toRunRows only fills `prompt`/`href` for staff, and the route must not
    // build the rows at all for a client viewer.
    expect(src).toContain("const agentRuns = isStaff");
    expect(src).toContain("const economics = isStaff");
  });

  it("mounts every staff capability the retired card grid carried", () => {
    const src = route();
    for (const symbol of ["StaffAgentControls", "CurationPane", "AgentEconomicsCard", "AgentRunHistory"]) {
      expect(src, symbol).toContain(symbol);
    }
    // The bind control is the one that belongs to the roster, not to an agent.
    expect(source("src/app/(app)/clients/[id]/agents/page.tsx")).toContain("BindAgentControl");
  });

  it("recovers a Reddit setup refusal with the link, not with contact-us", () => {
    // The three submit cores gate the same way, so the staff-side refusal
    // helper has to name all three prefixes.
    const src = source("src/components/custom-agents.tsx");
    const fn = src.slice(src.indexOf("function refusalNamesSetup"));
    expect(fn.slice(0, 400)).toContain("REDDIT_SETUP_REQUIRED_PREFIX");
    expect(fn.slice(0, 400)).toContain("X_SETUP_REQUIRED_PREFIX");
    expect(fn.slice(0, 400)).toContain("LINKEDIN_SETUP_REQUIRED_PREFIX");
  });

  it("tells staff the runs are paused too", () => {
    // The outage notice was mounted on the CLIENT branch only, so an operator
    // opened a roster of enabled Run controls with nothing on the page saying
    // the service was down — they found out by pressing one.
    const src = source("src/app/(app)/clients/[id]/agents/page.tsx");
    expect(src).toContain("enabledAgents.length > 0 && !agentServiceConfigured");
    // Both rosters read delivered work the same way, so one cannot call an
    // agent "Not set up yet" while the other calls it "Runs on request".
    expect(src).toContain("hasDelivered: completedAgentIds.has(agent.id)");
    expect(src).toContain("hasDelivered: staffDeliveredAgentIds.has(agent.id)");
  });

  it("leaves ONE home for 'has this agent delivered' — no surface owns a second copy", () => {
    const surfaces = {
      roster: "src/app/(app)/clients/[id]/agents/page.tsx",
      detail: "src/app/(app)/clients/[id]/agents/[agentId]/page.tsx",
    };
    for (const [name, file] of Object.entries(surfaces)) {
      const src = source(file);
      expect(src, name).toContain("agentsWithDeliveredWork(");
      // Nothing a page may spell for itself: not the job half, not the lab-import
      // folder key. Each of those is the rule written a second time, and a second
      // time is how this page and the one it links came to disagree about the
      // same agent.
      expect(src, name).not.toContain("jobDeliveredWork");
      expect(src, name).not.toContain("agentFolder");

      // NOR A FRESH INLINE COPY, which the checks above do not reach: an
      // `agentsWithDeliveredWork` call can sit on the page for one consumer while
      // another consumer grows its own job scan beside it.
      //
      // SCOPE, stated because the previous version of this comment claimed a
      // second answer had "nowhere to be written" and a review pass wrote one.
      // These two checks forbid the two spellings an inline copy most naturally
      // takes; they are NOT a proof that no inline copy is expressible. A scan
      // constrained by NEGATIVE status exclusions (`status !== "failed" &&
      // status !== "queued"`) satisfies (a) and never names a delivered status,
      // so it walks past both. What actually closes the gate — the consumer this
      // matters for — is the exact-shape assertion at the end of this test; these
      // two are a cheap net over the rest of the page, not a guarantee.
      //
      // (a) A custom-job scan with no STATUS constraint. The page's other job
      //     questions all pin one (the staff review queue, the in-flight run
      //     banner); an unconstrained scan is asking "has this ever produced".
      for (const match of src.matchAll(/taskType\s*[!=]==?\s*["']custom["']/g)) {
        const stop = src.indexOf(";", match.index);
        const statement = src.slice(match.index, stop === -1 ? src.length : stop);
        expect(statement, `${name}: custom-job scan with no status constraint`).toMatch(
          /\bstatus\b/,
        );
      }
      // (b) The delivered statuses, in any spelling or order. "approved" and
      //     "delivered" have no other business on either page at all; "review" is
      //     the staff queue's own status and may appear alone, but never beside
      //     one of the others. So a copy that DOES constrain status dies here.
      expect(src, name).not.toMatch(/"(?:approved|delivered)"/);
      expect(src, name).not.toMatch(
        /"(?:review|approved|delivered)"[\s\S]{0,60}"(?:review|approved|delivered)"/,
      );
    }

    // THE CLIENT GATE ITSELF, asked as the closed question. It is the consumer a
    // second copy is most tempting for — it needs one boolean, early, before the
    // page's data is arranged — and an inline copy there while the strip keeps
    // calling the shared function is the gate and the badge answering one question
    // two ways: a 404 on the page a client's own roster linked them to.
    const detail = source(surfaces.detail);
    expect(detail).toMatch(/const hasDelivered = agentsWithDeliveredWork\(/);
    // EXACT SHAPE, not a substring of it. The condition may hold precisely these
    // two terms, so ANY third term — `&& !earnedInline`, a hoisted scan, a second
    // helper — fails here whatever it is spelled like. `\s*` throughout so
    // prettier reformatting the condition across lines does not fail the test for
    // the wrong reason: the previous version anchored on
    // `indexOf("if (viewerIsClient")`, which resolved to -1 the moment the `if`
    // wrapped, and then reported a missing `!hasDelivered` instead of a moved gate.
    expect(
      detail,
      "the client gate may ask exactly two things: the grant, and the shared answer",
    ).toMatch(
      /if\s*\(\s*viewerIsClient\s*&&\s*!\(client\.customAgentIds \?\? \[\]\)\.includes\(agent\.id\)\s*&&\s*!hasDelivered\s*\)/,
    );

    // AND THE STRIP MAY NEVER CONTRADICT THE LIST UNDER IT.
    //
    // A source assertion, and labelled as one: both values are locals inside a
    // server component, so the invariant lives in this page's wiring and there is
    // nothing importable to test. It is here because removing the guard is silent
    // — `agentsWithDeliveredWork` applies the `agentKeyMatchesClientSlug` binding
    // that `agentProducedAssets` does not, so for an agent whose key does not match
    // this client's slug the verdict goes false while the list stays non-empty, and
    // the strip reads "Not set up yet" above a shelf of delivered work. A review
    // pass constructed that twice after the two answers were merged.
    expect(detail, "the strip's verdict must be floored by the list it sits above").toMatch(
      /const stripHasDelivered = hasDelivered \|\| produced\.length > 0;/,
    );
    expect(detail, "rosterStatus must read the floored verdict, not the raw one").toMatch(
      /hasDelivered:\s*stripHasDelivered,/,
    );

    // The job half has exactly one caller in the app: the one home. Asserted by
    // sweeping src/ rather than by reading a line, so a new surface that calls
    // it — the exact regression — fails here.
    const files = readdirSync(path.join(REPO, "src"), { recursive: true, encoding: "utf8" })
      .filter((rel) => /\.tsx?$/.test(rel) && !rel.includes("__tests__"))
      .map((rel) => `src/${rel}`.split(path.sep).join("/"));
    expect(files.length).toBeGreaterThan(100); // the sweep found the tree at all
    const callers = files.filter((rel) => source(rel).includes("jobDeliveredWork")).sort();
    expect(callers).toEqual([
      // where it is defined…
      "src/lib/client-agents.ts",
      // …and its only caller, which unions it with the asset rungs.
      "src/lib/agent-detail-archetypes.ts",
    ].sort());

    // And the normaliser stays unexported, so no second surface can grow its own
    // comparison of agent identities. The SHAPE, not one spelling of it: a bare
    // `export { attributionSlug }` beside the function exports it just as well as
    // an `export function` does.
    expect(source("src/lib/agent-detail-archetypes.ts")).not.toMatch(
      /export\s+(?:function\s+attributionSlug|\{[^}]*\battributionSlug\b)/,
    );
  });

  it("no longer ships the retired all-in-one card grid", () => {
    expect(source("src/components/custom-agents.tsx")).not.toContain("export function ClientCustomAgents");
  });

  it("renders the finds through the existing reader, keeping its pinned strip rules", () => {
    // reddit-drafts.test.ts pins which fields RedditDraftsBatch strips and
    // which two it must never strip. A second reader would be a second copy
    // of those rules.
    expect(source("src/components/client-agents/daily-finder-panel.tsx")).toContain(
      "RedditDraftsBatch",
    );
  });

  it("renders clips through the modal that owns the F150 video path", () => {
    const gallery = source("src/components/client-agents/clip-gallery.tsx");
    expect(gallery).toContain("AssetDetailModal");
    expect(gallery).toContain("assetVideos");
    // No second player.
    expect(gallery).not.toContain("<video");
  });
});
