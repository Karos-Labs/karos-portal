import { readFileSync } from "node:fs";
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

const {
  agentProducedAssets,
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
