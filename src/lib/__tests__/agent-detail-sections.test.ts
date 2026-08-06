import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentIntake, ClientAgent, ClientAgentTemplate, ClientSeat, XNewsUpdate, XTake } from "@/lib/types";

vi.mock("server-only", () => ({}));

const { buildAgentSetupFacts, intakeFamilyFor, toAgentInputRows } = await import(
  "@/lib/agent-detail-sections"
);

/**
 * CD-K1: the inputs and settings bands of the agent detail hub.
 *
 * Both are RSC-boundary projections, so the rules worth pinning are the ones a
 * reader can be HARMED by getting wrong: an intake document's private fields
 * riding into a payload nobody paints, and a client being handed the two
 * numbers that multiply out to their week's batch shape (A3/A4). Neither is
 * visible in a rendered component — a field that reaches the browser is
 * readable whether or not anything paints it — which is why they are asserted
 * against the projection.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");
/** Comments explain the rules; only the code may be asserted absent of them. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const NOW = Date.UTC(2026, 6, 29, 12, 0, 0); // 2026-07-29T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;

function makeIntake(overrides: Partial<AgentIntake> = {}): AgentIntake {
  return {
    id: "intake-1",
    clientId: "c1",
    agent: "x",
    seatId: null,
    handle: "@karoslabs",
    offLimits: "No politics",
    roster: [],
    createdBy: "uid-staff",
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 2 * DAY,
    ...overrides,
  };
}

function makeSeat(overrides: Partial<ClientSeat> = {}): ClientSeat {
  return {
    id: "seat-1",
    clientId: "c1",
    name: "Maya Cohen",
    slug: "maya-cohen",
    createdBy: "uid-staff",
    createdAt: NOW - 21 * DAY,
    updatedAt: NOW - 21 * DAY,
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<ClientAgentTemplate> = {}): ClientAgentTemplate {
  return {
    key: "by-the-numbers",
    name: "By The Numbers",
    status: "active",
    position: 0,
    source: "launch",
    addedAt: NOW - 40 * DAY,
    ...overrides,
  };
}

type UmbrellaFacts = Parameters<typeof buildAgentSetupFacts>[0]["umbrella"];

function makeUmbrella(overrides: Partial<UmbrellaFacts> = {}): UmbrellaFacts {
  return {
    launchState: "live" as ClientAgent["launchState"],
    launchStartedAt: NOW - 41 * DAY,
    launchCompletedAt: NOW - 40 * DAY,
    createdAt: NOW - 42 * DAY,
    updatedAt: NOW - DAY,
    rotation: [],
    ...overrides,
  };
}

/* ─────────────────────────── inputs (directive 1) ─────────────────────── */

describe("toAgentInputRows", () => {
  it("carries a label, a summary and a date — and none of the document's private fields", () => {
    const rows = toAgentInputRows({
      agent: "x",
      company: makeIntake({
        offLimits: "Never mention the lawsuit",
        cvUrl: "https://secret",
        cvPath: "clients/c1/private/cv.pdf",
      }),
      seats: [],
      intake: [],
      news: [],
      takes: [],
    });
    const company = rows.find((r) => r.id === "company");
    expect(company?.label).toBe("Company profile");
    expect(company?.detail).toBe("@karoslabs");
    expect(company?.updatedAt).toBe(NOW - 2 * DAY);
    // AF-7 MOVED THE LINE, and it is worth naming where it moved to. `offLimits`
    // is the CLIENT'S OWN ANSWER, and Albert's ruling is that their answers show
    // on the agent page rather than behind a button — so it is carried now, by
    // way of `toXIntakeView`, the very whitelist the intake page renders.
    expect(company?.answers).toEqual([
      { label: "Account", value: "@karoslabs" },
      { label: "Never post about", value: "Never mention the lawsuit" },
    ]);
    // What did NOT move: the document's own private fields. A uid, the CV's
    // storage path and its signed URL are not answers to anything the client was
    // asked, and no view carries them — asserted over the whole payload, because
    // a field that reaches the browser is readable whether or not it is painted.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("uid-staff");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("cv.pdf");
    expect(serialized).not.toContain("createdBy");
    expect(serialized).not.toContain("seatId");
  });

  it("shows a seat only its OWN answers, never a colleague's", () => {
    // The three families share one `agentIntake` collection and the band renders
    // one row per seat, so the join that goes wrong here does not leak a private
    // field — it puts one person's account and one person's off-limits list under
    // another person's name, on a page they can both read.
    const rows = toAgentInputRows({
      agent: "linkedin",
      company: null,
      seats: [makeSeat(), makeSeat({ id: "seat-2", name: "Dana Levi", slug: "dana-levi" })],
      intake: [
        makeIntake({
          id: "i-maya",
          agent: "linkedin",
          seatId: "seat-1",
          handle: "@maya",
          offLimits: "Maya's line",
        }),
        makeIntake({
          id: "i-dana",
          agent: "linkedin",
          seatId: "seat-2",
          handle: "@dana",
          offLimits: "Dana's line",
        }),
      ],
      news: [],
      takes: [],
    });
    const maya = JSON.stringify(rows.find((r) => r.id === "seat-seat-1"));
    expect(maya).toContain("@maya");
    expect(maya).toContain("Maya&#39;s line".replace("&#39;", "'"));
    expect(maya).not.toContain("@dana");
    expect(maya).not.toContain("Dana");
  });

  it("reads answers through the client-safe views, never the document", () => {
    // The rule AF-7 rests on: one whitelist, on the intake surface, and this band
    // downstream of it. A field the view does not carry cannot be labelled into
    // existence here — `cvName` crosses because `toLiIntakeView` decided it is
    // safe, while `cvPath` and `cvUrl` beside it do not.
    const rows = toAgentInputRows({
      agent: "linkedin",
      company: makeIntake({
        agent: "linkedin",
        handle: "@karoslabs",
        role: "Founder",
        cvName: "albert-cv.pdf",
        cvPath: "clients/c1/private/albert-cv.pdf",
        cvUrl: "https://signed.example/albert",
      }),
      seats: [],
      intake: [],
      news: [],
      takes: [],
    });
    const company = rows.find((r) => r.id === "company");
    expect(company?.answers).toContainEqual({ label: "CV on file", value: "albert-cv.pdf" });
    expect(company?.answers).toContainEqual({ label: "Role", value: "Founder" });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("clients/c1/private");
    expect(serialized).not.toContain("signed.example");
  });

  it("pins an input row to exactly its seven fields", () => {
    // The not-contains assertions above catch a leak of the values these
    // fixtures happen to carry; they would sail past a narrowly added field —
    // a `seatId`, a `createdBy`, a `cvPath` on a document that has one. The
    // whitelist is the rule, so the key set is what the test asserts.
    //
    // `answers` is the seventh and is OPTIONAL, which is itself part of the
    // contract: a row with nothing saved stays a plain link to its form rather
    // than growing a disclosure that opens onto nothing.
    const rows = toAgentInputRows({
      agent: "x",
      company: makeIntake(),
      seats: [makeSeat()],
      intake: [],
      news: [],
      takes: [],
    });
    const allowed = ["answers", "detail", "filled", "icon", "id", "label", "updatedAt"];
    for (const row of rows) {
      expect(Object.keys(row).sort().every((key) => allowed.includes(key))).toBe(true);
      // And every answer is exactly a question and an answer — no id, no raw
      // field name, nothing that names the document it came out of.
      for (const entry of row.answers ?? []) {
        expect(Object.keys(entry).sort()).toEqual(["label", "value"]);
      }
    }
    // The seat's form is empty in this fixture, so it carries no drawer at all.
    expect(rows.find((r) => r.id === "seat-seat-1")?.answers).toBeUndefined();
  });

  it("lists a seat whose form was never filled in, dated from the seat itself", () => {
    // The question this band exists to answer: who has a seat and no answers.
    // A null date there would read as "just added" for a seat three weeks old.
    const rows = toAgentInputRows({
      agent: "linkedin",
      company: null,
      seats: [makeSeat()],
      intake: [],
      news: [],
      takes: [],
    });
    const seat = rows.find((r) => r.id === "seat-seat-1");
    expect(seat?.label).toBe("Maya Cohen");
    expect(seat?.filled).toBe(false);
    expect(seat?.updatedAt).toBe(NOW - 21 * DAY);
    expect(rows.find((r) => r.id === "company")?.filled).toBe(false);
    expect(rows.find((r) => r.id === "company")?.updatedAt).toBeNull();
  });

  it("prefers the seat's own intake date once its form exists", () => {
    const rows = toAgentInputRows({
      agent: "linkedin",
      company: null,
      seats: [makeSeat()],
      intake: [
        makeIntake({
          id: "intake-seat",
          agent: "linkedin",
          seatId: "seat-1",
          handle: "linkedin.com/in/maya",
          updatedAt: NOW - 3 * DAY,
        }),
      ],
      news: [],
      takes: [],
    });
    const seat = rows.find((r) => r.id === "seat-seat-1");
    expect(seat?.filled).toBe(true);
    expect(seat?.detail).toBe("linkedin.com/in/maya");
    expect(seat?.updatedAt).toBe(NOW - 3 * DAY);
  });

  it("gives Reddit and the newsletter no seats and no news drop", () => {
    // Neither has a seat model, and neither intake surface renders one: e15
    // drafts as one account, and a newsletter issue goes out from the business
    // rather than from a person. Empty seat rows would promise a per-person
    // product that does not exist, and the shared news drop is consumed by X
    // and LinkedIn only — the newsletter's seven-day scan FINDS what happened.
    //
    // FED THE ROWS THEY MUST IGNORE, which is the whole test: a seat and a news
    // update are passed in, so a guard that let either family through would
    // produce extra rows here rather than passing on an empty fixture. This is
    // the case the old `agent !== "reddit"` negative list got wrong — it
    // answered "yes, you have seats" for every family nobody had thought about.
    const cases: Array<[AgentIntake["agent"], string]> = [
      ["reddit", "Your Reddit account"],
      ["newsletter", "Your newsletter details"],
    ];
    for (const [agent, label] of cases) {
      const rows = toAgentInputRows({
        agent,
        company: makeIntake({ agent, handle: agent === "reddit" ? "u/karoslabs" : null }),
        seats: [makeSeat()],
        intake: [
          makeIntake({ id: "intake-seat", agent, seatId: "seat-1", handle: "someone" }),
        ],
        news: [{ id: "n1", clientId: "c1", title: "Launch", date: "2026-07-01", createdBy: "u", createdAt: NOW }],
        takes: [{ id: "t1", clientId: "c1", seatId: "s", take: "x", date: "2026-07-25", createdBy: "u", createdAt: NOW }],
        directionRequests: [
          {
            id: "d1",
            clientId: "c1",
            account: "company",
            request: "talk about pricing",
            date: "2026-08-04",
            status: "open",
            createdBy: "u",
            createdAt: NOW,
          },
        ],
      });
      expect(rows.map((r) => r.id), agent).toEqual(["company"]);
      expect(rows[0].label, agent).toBe(label);
    }
  });

  it("leaves the newsletter's company row a bare dated link, with no empty drawer", () => {
    // `intakeAnswersFor` returns [] for this family on purpose: the newsletter's
    // intake is scheduling and compliance configuration, not the per-account
    // identity answers the other three show inline, and a half-filled drawer
    // would imply this page is where a client reads their newsletter setup.
    // `answersOf` drops an empty list rather than attaching one, so the row
    // stays the plain link to the surface that IS the place to read it.
    const rows = toAgentInputRows({
      agent: "newsletter",
      company: makeIntake({ agent: "newsletter", handle: null, updatedAt: NOW - 2 * DAY }),
      seats: [],
      intake: [],
      news: [],
      takes: [],
    });
    const company = rows.find((r) => r.id === "company");
    expect(company?.answers).toBeUndefined();
    expect(company?.filled).toBe(true);
    expect(company?.updatedAt).toBe(NOW - 2 * DAY);
    // No handle on this family, and the fallback copy has to say so without
    // implying an account name is coming.
    expect(company?.detail).toBe("Saved — no account name yet");
    // Never "Company profile": there is no profile and no account here, and
    // that label would send a reader looking for an identity page.
    expect(company?.label).toBe("Your newsletter details");
    expect(company?.icon).toBe("Mail");
  });

  it("dates the drops from their newest row, and says so when they are empty", () => {
    const news: XNewsUpdate[] = [
      { id: "n1", clientId: "c1", title: "Series A", date: "2026-07-20", createdBy: "u", createdAt: NOW - DAY },
      { id: "n2", clientId: "c1", title: "Hire", date: "2026-07-01", createdBy: "u", createdAt: NOW - 20 * DAY },
    ];
    const takes: XTake[] = [
      { id: "t1", clientId: "c1", seatId: "seat-1", take: "Agents are the new SaaS", date: "2026-07-25", createdBy: "u", createdAt: NOW - 4 * DAY },
    ];
    const rows = toAgentInputRows({ agent: "x", company: null, seats: [], intake: [], news, takes });
    expect(rows.find((r) => r.id === "news")?.detail).toBe("2 updates on file");
    expect(rows.find((r) => r.id === "news")?.updatedAt).toBe(NOW - DAY);
    expect(rows.find((r) => r.id === "takes")?.detail).toBe("1 take on file");

    const empty = toAgentInputRows({ agent: "x", company: null, seats: [], intake: [], news: [], takes: [] });
    // "Never saved" and "saved a long time ago" are different facts, so the
    // empty case gets a null date rather than an epoch the row would humanise.
    expect(empty.find((r) => r.id === "news")?.updatedAt).toBeNull();
    expect(empty.find((r) => r.id === "takes")?.filled).toBe(false);
  });

  it("gives LinkedIn the news drop and its own steering wheel, but never the X takes box", () => {
    const rows = toAgentInputRows({
      agent: "linkedin",
      company: null,
      seats: [],
      intake: [],
      news: [],
      takes: [{ id: "t1", clientId: "c1", seatId: "s", take: "x", date: "2026-07-25", createdBy: "u", createdAt: NOW }],
    });
    // `direction` is LinkedIn v2's Section A0 ("what to cover next"), which is
    // NOT the shared news drop and NOT X's takes box: the drop says what
    // happened, a take is a person's opinion for X, and this says what the next
    // LinkedIn post should be about.
    expect(rows.map((r) => r.id)).toEqual(["company", "news", "direction"]);
  });

  it("gives X the takes box but never LinkedIn's steering wheel", () => {
    const rows = toAgentInputRows({
      agent: "x",
      company: null,
      seats: [],
      intake: [],
      news: [],
      takes: [],
      directionRequests: [
        {
          id: "d1",
          clientId: "c1",
          account: "company",
          request: "talk about pricing",
          date: "2026-08-04",
          status: "open",
          createdBy: "u",
          createdAt: NOW,
        },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["company", "news", "takes"]);
  });

  it("counts only OPEN direction requests as filled — a covered row is history", () => {
    const row = (id: string, status: "open" | "covered") => ({
      id,
      clientId: "c1",
      account: "company",
      request: `r-${id}`,
      date: "2026-08-04",
      status,
      createdBy: "u",
      createdAt: NOW,
    });
    const base = { agent: "linkedin" as const, company: null, seats: [], intake: [], news: [], takes: [] };
    const covered = toAgentInputRows({ ...base, directionRequests: [row("d1", "covered")] });
    expect(covered.find((r) => r.id === "direction")?.filled).toBe(false);
    expect(covered.find((r) => r.id === "direction")?.answers).toBeUndefined();
    const open = toAgentInputRows({ ...base, directionRequests: [row("d2", "open")] });
    expect(open.find((r) => r.id === "direction")?.filled).toBe(true);
    expect(open.find((r) => r.id === "direction")?.answers).toEqual([
      { label: "2026-08-04", value: "r-d2" },
    ]);
  });
});

describe("intakeFamilyFor", () => {
  it("places the four intake agents and nothing else", () => {
    expect(intakeFamilyFor("karos-x-agent-v2")).toBe("x");
    expect(intakeFamilyFor("karos-reddit-agent")).toBe("reddit");
    expect(intakeFamilyFor("karos-linkedin-company-geektime")).toBe("linkedin");
    expect(intakeFamilyFor("karos-newsletter-writer-v2")).toBe("newsletter");
    // A clip maker runs on files, not on a form — it must get no inputs band
    // rather than an empty one implying it needs answers nobody has given.
    expect(intakeFamilyFor("branded-shorts")).toBeNull();
  });

  it("places only the newsletter WRITER, not its three steps", () => {
    // Same rule the run gate and the roster use: the writer is the agent a
    // person means, and setup / manager / compliance-lock are its steps. Giving
    // a step its own inputs band would put a second "What it runs on" section on
    // a card nothing lists, for data the reader never chose to open.
    for (const step of [
      "karos-newsletter-setup-v2",
      "karos-newsletter-manager-v2",
      "karos-compliance-lock-v2",
    ]) {
      expect(intakeFamilyFor(step), step).toBeNull();
    }
  });
});

/* ────────────────────────── settings (directive 2) ────────────────────── */

describe("buildAgentSetupFacts", () => {
  const templates = [
    makeTemplate({ key: "numbers", name: "By The Numbers", position: 1 }),
    makeTemplate({ key: "story", name: "Founder Story", position: 0 }),
    makeTemplate({ key: "old", name: "Retired One", position: 2, status: "retired" }),
  ];
  const schedule = {
    status: "active" as const,
    postsPerWeek: 3,
    outputsPerRun: 5,
    nextRunAt: NOW + DAY,
  };

  it("never hands a client the two numbers that multiply into their batch", () => {
    // "3 runs a week × 5 outputs each" states outright that the week arrives in
    // lumps — the one fact the slot model exists to keep indistinguishable, and
    // the same rule that gives the pace dialog its paceOnly face.
    const facts = buildAgentSetupFacts({
      umbrella: makeUmbrella(),
      templates,
      schedule,
      viewerIsClient: true,
    });
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain("5 outputs");
    expect(serialized).not.toContain("runs/week");
    expect(facts.find((f) => f.label === "Schedule")?.value).toBe("Running");
    expect(facts.find((f) => f.label === "Pace")).toBeUndefined();
    expect(facts.find((f) => f.label === "Next fire")).toBeUndefined();
    // Firing internals are operator truth, and this row projection is the
    // client's.
    expect(facts.find((f) => f.label === "Chain family")).toBeUndefined();
  });

  it("gives staff the arithmetic, the next fire and the family", () => {
    const facts = buildAgentSetupFacts({
      umbrella: makeUmbrella({ chainFamily: "social" }),
      templates,
      schedule,
      viewerIsClient: false,
    });
    expect(facts.find((f) => f.label === "Pace")?.value).toBe("3 runs/week · 5 outputs each");
    expect(facts.find((f) => f.label === "Next fire")?.at).toBe(NOW + DAY);
    expect(facts.find((f) => f.label === "Chain family")?.value).toBe("social");
  });

  it("prints the rotation in firing order and counts only what is not retired", () => {
    const facts = buildAgentSetupFacts({
      umbrella: makeUmbrella(),
      templates: [...templates, makeTemplate({ key: "paused", name: "Paused One", position: 3, status: "paused" })],
      schedule: null,
      viewerIsClient: true,
    });
    // Sorted by position, exactly as the format rows above it are — the two
    // must never describe different sequences.
    expect(facts.find((f) => f.label === "Rotation")?.value).toBe(
      "Founder Story → By The Numbers → Paused One",
    );
    expect(facts.find((f) => f.label === "Formats")?.value).toBe("2 running of 3");
  });

  it("says what an options-mode umbrella actually does, and offers no rotation", () => {
    // The X product has no template streams by design; a rotation row for it
    // would be inventing formats the agent does not have.
    const facts = buildAgentSetupFacts({
      umbrella: makeUmbrella({ slotMode: "options" }),
      templates: [],
      schedule: null,
      viewerIsClient: true,
    });
    expect(facts.find((f) => f.label === "Rotation")).toBeUndefined();
    expect(facts.find((f) => f.label === "Formats")).toBeUndefined();
    expect(facts.find((f) => f.label === "How it fills a day")?.value).toContain("One post a day");
  });

  it("falls back to the bind date when nothing has been launched", () => {
    const facts = buildAgentSetupFacts({
      umbrella: makeUmbrella({
        launchState: "not_launched",
        launchStartedAt: null,
        launchCompletedAt: null,
      }),
      templates: [],
      schedule: null,
      viewerIsClient: false,
    });
    expect(facts.find((f) => f.label === "Set up")).toBeUndefined();
    expect(facts.find((f) => f.label === "Added")?.at).toBe(NOW - 42 * DAY);
    expect(facts.find((f) => f.label === "Last changed")?.at).toBe(NOW - DAY);
  });
});

/* ──────────────────────────────── wiring ──────────────────────────────── */

describe("wiring", () => {
  const route = () => source("src/app/(app)/clients/[id]/agents/[agentId]/page.tsx");

  it("mounts all three bands on the agent's own page", () => {
    const src = route();
    for (const symbol of ["AgentStatusStrip", "AgentInputsSection", "AgentSetupSection"]) {
      expect(src, symbol).toContain(symbol);
    }
  });

  it("builds the settings band from the REDACTED registry, never the stored one", () => {
    // umbrella.templates while `curating` holds what the setup run proposed and
    // staff have not confirmed. The row projection empties it for a client; a
    // second reader that went to the document directly would undo that.
    const src = route();
    expect(src).toContain("templates: row?.templates ?? []");
    expect(src).not.toMatch(/templates:\s*umbrella\.templates/);
  });

  it("opens a template onto the same set the archive rides", () => {
    // `produced` is agentProducedAssets output, which runs a client through
    // getClientArchiveAssets. Joining raw `assets` here would hand a client
    // every draft in the batch the moment they opened a format.
    const src = route();
    expect(src).toMatch(/templateDetails\(\{ templates: row\?\.templates \?\? \[\], assets: produced/);
    expect(src).not.toMatch(/templateDetails\(\{[^}]*assets: assets/);
  });

  it("never announces a scheduled fire as work happening now", () => {
    // A cron tick is not something the reader just asked for, and saying it is
    // running states that production is not day-of.
    const src = route();
    expect(src).toContain("const running = Boolean(row?.activeRun || legacyRun)");
  });

  it("reads its LIVE state from rosterStatus rather than re-deriving it", () => {
    // The rule that a schedule refusal outranks Live (F24/F129) lives in
    // rosterStatus. A strip that decided its own tone from launchState would be
    // a second answer that quietly disagrees with the badge beside it.
    const src = route();
    // Whitespace-tolerant: the element gained AF-5's staff note and wraps over
    // several lines now, and this test is about where the value COMES FROM.
    expect(src).toMatch(/<AgentStatusStrip\s+status=\{status\}/);
    expect(code(source("src/components/client-agents/agent-sections.tsx"))).not.toContain(
      "launchState",
    );
  });

  it("shows AF-5's operational truth to staff and to nobody else", () => {
    // The client-facing word is the same for both readers by ruling; what staff
    // get extra is the sentence explaining why it disagrees with the schedule
    // row under it. Gated at the boundary that knows the viewer, so the line is
    // absent from a client's HTML rather than merely unpainted.
    const src = route();
    expect(src).toMatch(/isStaff && status\.staffNote \? \{ staffNote: status\.staffNote \}/);
    const strip = source("src/components/client-agents/agent-sections.tsx");
    expect(strip).toContain("{staffNote}");
  });

  it("links the existing intake pages instead of forking their forms", () => {
    const strip = source("src/components/client-agents/agent-sections.tsx");
    // The href comes from AgentSetupState, which is the one place that knows
    // where each family's form lives.
    expect(strip).toContain("href={view.href}");
    for (const form of ["XAgentIntake", "LinkedInAgentIntake", "RedditAgentIntake"]) {
      expect(strip, form).not.toContain(form);
    }
  });

  it("makes ONE setup ask per screen — the band, not a hero that repeats it", () => {
    // The bounce: the generic "Not set up yet — your Karos team sets this up"
    // EmptyState rendered above the inputs band regardless, so an intake-driven
    // agent contradicted itself twice on one screen (a hero denying setup over
    // a green READY TO RUN badge), and the Reddit page asked for setup five
    // times in five voices. The band holds the readiness the submit core gates
    // on, so it is the one that speaks.
    const src = route();
    expect(src).toContain(") : inputs ? (");
    expect(src).toMatch(/inputs \? \(\s*\/\*[\s\S]*?\*\/\s*null/);
    // And the finder's sidebar card stands down while its intake is empty:
    // with nothing saved it has no answers to show and is a fourth "Set it up".
    expect(src).toContain('archetype === "daily_finder" && setup && !(inputs && !inputs.ready)');
  });

  it("stacks off the CONTAINER, so the Copilot dock cannot crush the content column", () => {
    // `lg:` only knows the window is 1024+; at 1280 with the dock out the main
    // column is 644px and the grid computed 236px of content beside a 320px
    // rail. The (app) shells wrap every page in @container (CD-H7a's idiom).
    const src = route();
    expect(src).toContain("@4xl:grid-cols-[minmax(0,1fr)_320px]");
    expect(src).not.toContain("lg:grid-cols-[minmax(0,1fr)_320px]");
    // And the run card's label keeps a basis wide enough for its sentence:
    // flex-1 is basis-0, which let it shrink to about 30px in that column.
    const panel = source("src/components/client-agents/legacy-agent-panel.tsx");
    expect(panel).toContain("basis-56 grow");
  });

  it("says the outage once — the page banner, not the banner and the gate", () => {
    // Two warning-styled paragraphs 150px apart, in two wordings, read as two
    // separate problems. The banner is the page-level statement; the gate's own
    // service_down paragraph gives way when it has already been made.
    const src = route();
    expect(src).toContain("outageAnnounced={!agentServiceConfigured}");
    const panel = source("src/components/client-agents/legacy-agent-panel.tsx");
    expect(panel).toContain('!(outageAnnounced && gate.code === "service_down")');
  });

  it("speaks the client's vocabulary on client surfaces, not 'agent data'", () => {
    // "Manage X agent data" / "Reddit agent data — NEEDED" asks a client to
    // maintain a system's records. AgentSetupState carries both names; the
    // client-facing surfaces read clientLabel and the staff ones keep `label`.
    const rows = source("src/lib/client-agent-rows.ts");
    expect(rows).toContain('const clientLabel = "Your X details"');
    expect(rows).toContain("setupLabel: setup.clientLabel");
    const strip = source("src/components/client-agents/agent-sections.tsx");
    expect(strip).not.toContain("Manage {view.label}");
    const gates = source("src/lib/client-agent-runs.ts");
    expect(gates).not.toMatch(/setup\.label/);
  });

  it("keeps every animation CSS-grade and behind prefers-reduced-motion", () => {
    const strip = source("src/components/client-agents/agent-sections.tsx");
    expect(strip).toContain("animate-pulse-ring");
    // No library, no hydration: these bands are server components.
    expect(strip).not.toContain('"use client"');
    const css = source("src/app/globals.css");
    expect(css).toContain("@keyframes pulse-ring");
    const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
    expect(reduced).toContain(".animate-pulse-ring");
  });
});
