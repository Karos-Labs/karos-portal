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
      company: makeIntake({ offLimits: "Never mention the lawsuit", cvUrl: "https://secret" }),
      seats: [],
      intake: [],
      news: [],
      takes: [],
    });
    const company = rows.find((r) => r.id === "company");
    expect(company?.label).toBe("Company profile");
    expect(company?.detail).toBe("@karoslabs");
    expect(company?.updatedAt).toBe(NOW - 2 * DAY);
    // The whole payload, not just the painted parts. `offLimits` is the
    // client's own answer and `createdBy` is a uid; both belong on the intake
    // page behind the client-safe views, not in a second payload with a second
    // set of rules to keep in step.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("lawsuit");
    expect(serialized).not.toContain("uid-staff");
    expect(serialized).not.toContain("secret");
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

  it("gives Reddit no seats and no news drop", () => {
    // e15 has no seat model and its intake surface renders none. Empty seat
    // rows would promise a per-person product that does not exist, and the
    // shared news drop is consumed by X and LinkedIn only.
    const rows = toAgentInputRows({
      agent: "reddit",
      company: makeIntake({ agent: "reddit", handle: "u/karoslabs" }),
      seats: [makeSeat()],
      intake: [],
      news: [{ id: "n1", clientId: "c1", title: "Launch", date: "2026-07-01", createdBy: "u", createdAt: NOW }],
      takes: [],
    });
    expect(rows.map((r) => r.id)).toEqual(["company"]);
    expect(rows[0].label).toBe("Your Reddit account");
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

  it("gives LinkedIn the news drop but never the X takes box", () => {
    const rows = toAgentInputRows({
      agent: "linkedin",
      company: null,
      seats: [],
      intake: [],
      news: [],
      takes: [{ id: "t1", clientId: "c1", seatId: "s", take: "x", date: "2026-07-25", createdBy: "u", createdAt: NOW }],
    });
    expect(rows.map((r) => r.id)).toEqual(["company", "news"]);
  });
});

describe("intakeFamilyFor", () => {
  it("places the three intake agents and nothing else", () => {
    expect(intakeFamilyFor("karos-x-agent")).toBe("x");
    expect(intakeFamilyFor("karos-reddit-agent")).toBe("reddit");
    expect(intakeFamilyFor("karos-linkedin-company-geektime")).toBe("linkedin");
    // A clip maker runs on files, not on a form — it must get no inputs band
    // rather than an empty one implying it needs answers nobody has given.
    expect(intakeFamilyFor("branded-shorts")).toBeNull();
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
    expect(src).toContain("<AgentStatusStrip status={status}");
    expect(code(source("src/components/client-agents/agent-sections.tsx"))).not.toContain(
      "launchState",
    );
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
