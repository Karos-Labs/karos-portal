import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as data from "@/lib/data";
import { engineOwnsSetup, engineOwnsSetupForClient } from "@/lib/agent-engine/setup-ownership";
import type { Client, CustomAgent } from "@/lib/types";

/**
 * SETUP THE ENGINE OWNS (A3).
 *
 * Every agent runs on agent-engine now, and each channel's setup is inlined
 * into its drafting workflow as a pre-flight (`00-channel-setup`,
 * `00-roster-setup`). The portal's stand-up rungs, however, still read state
 * rows only the deleted agent-service webhook ever wrote — `liAgentState`
 * "foundation", `seatVoiceProfiles`, `newsletterAgentState` "issue-index",
 * `blogAgentState` "post-index" — so on the engine path they refuse a run for
 * a row nothing can produce any more.
 *
 * These pin both halves of the fix: an engine-routed client with NO state rows
 * is not gated, and a client with no lab slug (whose run does not reach the
 * engine) is gated exactly as before.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");

const LINKEDIN_WRITER = "karos-linkedin-writer-v2";
const LINKEDIN_SETUP = "karos-linkedin-setup-v2";
const NEWSLETTER_WRITER = "karos-newsletter-writer-v2";
const BLOG_WRITER = "karos-blog-writer-v2";

const {
  hasXAgentIntakeMock,
  hasLinkedInAgentIntakeMock,
  hasLinkedInV2SetupMock,
  listLinkedInReadySeatIdsMock,
  hasRedditAgentIntakeMock,
  hasNewsletterAgentIntakeMock,
  hasNewsletterV2SetupMock,
  hasBlogAgentIntakeMock,
  hasBlogV2SetupMock,
} = vi.hoisted(() => ({
  hasXAgentIntakeMock: vi.fn(async () => true),
  hasLinkedInAgentIntakeMock: vi.fn(async () => true),
  hasLinkedInV2SetupMock: vi.fn(async () => false),
  listLinkedInReadySeatIdsMock: vi.fn(async (): Promise<string[]> => []),
  hasRedditAgentIntakeMock: vi.fn(async () => true),
  hasNewsletterAgentIntakeMock: vi.fn(async () => true),
  hasNewsletterV2SetupMock: vi.fn(async () => false),
  hasBlogAgentIntakeMock: vi.fn(async () => true),
  hasBlogV2SetupMock: vi.fn(async () => false),
}));

// The state reads are stubbed; every predicate that DECIDES (which key is a v2
// agent, which is the setup skill, and the engine gate itself) stays real —
// those are the subject.
vi.mock("@/lib/agent-service/x-agent-context", async (original) => ({
  ...(await original<typeof import("@/lib/agent-service/x-agent-context")>()),
  hasXAgentIntake: hasXAgentIntakeMock,
}));
vi.mock("@/lib/agent-service/linkedin-agent-context", async (original) => ({
  ...(await original<typeof import("@/lib/agent-service/linkedin-agent-context")>()),
  hasLinkedInAgentIntake: hasLinkedInAgentIntakeMock,
  hasLinkedInV2Setup: hasLinkedInV2SetupMock,
  listLinkedInReadySeatIds: listLinkedInReadySeatIdsMock,
}));
vi.mock("@/lib/agent-service/reddit-agent-context", async (original) => ({
  ...(await original<typeof import("@/lib/agent-service/reddit-agent-context")>()),
  hasRedditAgentIntake: hasRedditAgentIntakeMock,
}));
vi.mock("@/lib/agent-service/newsletter-agent-context", async (original) => ({
  ...(await original<typeof import("@/lib/agent-service/newsletter-agent-context")>()),
  hasNewsletterAgentIntake: hasNewsletterAgentIntakeMock,
  hasNewsletterV2Setup: hasNewsletterV2SetupMock,
}));
vi.mock("@/lib/agent-service/blog-agent-context", async (original) => ({
  ...(await original<typeof import("@/lib/agent-service/blog-agent-context")>()),
  hasBlogAgentIntake: hasBlogAgentIntakeMock,
  hasBlogV2Setup: hasBlogV2SetupMock,
}));

const { unfireableScheduleReason } = await import("@/lib/jobs/schedule-gate");
const { buildAgentSetup } = await import("@/lib/client-agent-rows");
const { buildBlogAgentIntakeView, buildLinkedInAgentIntakeView, buildNewsletterAgentIntakeView } =
  await import("@/lib/agent-intake-views");

const client = (overrides: Partial<Client> = {}): Client =>
  ({ id: "c1", name: "Acme", agentsRepoSlug: "acme", ...overrides }) as Client;

const agent = (key: string): CustomAgent => ({ id: "a1", key, name: "LinkedIn agent" }) as CustomAgent;

beforeEach(() => {
  vi.stubEnv("AGENT_ENGINE_DISPATCH_ENABLED", "true");
  vi.mocked(data.getClient).mockResolvedValue(client());
  hasLinkedInAgentIntakeMock.mockResolvedValue(true);
  hasLinkedInV2SetupMock.mockResolvedValue(false);
  hasNewsletterAgentIntakeMock.mockResolvedValue(true);
  hasNewsletterV2SetupMock.mockResolvedValue(false);
  hasBlogAgentIntakeMock.mockResolvedValue(true);
  hasBlogV2SetupMock.mockResolvedValue(false);
  listLinkedInReadySeatIdsMock.mockResolvedValue([]);
});

describe("engineOwnsSetup — the shared question, asked the way the submit core asks it", () => {
  it("is true for every writer whose runs agent-engine takes", () => {
    for (const key of [LINKEDIN_WRITER, LINKEDIN_SETUP, NEWSLETTER_WRITER, BLOG_WRITER]) {
      expect(engineOwnsSetup(key, "acme"), key).toBe(true);
    }
  });

  it("is false without a lab slug, with dispatch off, or for an agent the engine has no workflow for", () => {
    // The three parts of the gate, each on its own. A client with no slug does
    // not reach the engine, so nothing about their gating may change.
    expect(engineOwnsSetup(LINKEDIN_WRITER, undefined)).toBe(false);
    vi.stubEnv("AGENT_ENGINE_DISPATCH_ENABLED", "false");
    expect(engineOwnsSetup(LINKEDIN_WRITER, "acme")).toBe(false);
    vi.stubEnv("AGENT_ENGINE_DISPATCH_ENABLED", "true");
    // The e10 generation has no engine route of its own.
    expect(engineOwnsSetup("karos-linkedin-company-acme", "acme")).toBe(false);
  });

  it("reads the client's slug for a caller that holds only an id", async () => {
    await expect(engineOwnsSetupForClient("c1", LINKEDIN_WRITER)).resolves.toBe(true);
    vi.mocked(data.getClient).mockResolvedValue(client({ agentsRepoSlug: undefined }));
    await expect(engineOwnsSetupForClient("c1", LINKEDIN_WRITER)).resolves.toBe(false);
    vi.mocked(data.getClient).mockResolvedValue(null);
    await expect(engineOwnsSetupForClient("c1", LINKEDIN_WRITER)).resolves.toBe(false);
  });
});

describe("the schedule gate", () => {
  it("lets an engine-routed client schedule the LinkedIn writer with no foundation row", async () => {
    // The row is never written on that path — `00-channel-setup` stands the
    // channel up on the run — so refusing on it turns every fire away forever.
    await expect(unfireableScheduleReason(client(), agent(LINKEDIN_WRITER))).resolves.toBeNull();
  });

  it("still refuses a client whose runs do not reach the engine", async () => {
    const reason = await unfireableScheduleReason(
      client({ agentsRepoSlug: undefined }),
      agent(LINKEDIN_WRITER),
    );
    expect(reason).toContain("has not been set up");
    vi.stubEnv("AGENT_ENGINE_DISPATCH_ENABLED", "false");
    await expect(unfireableScheduleReason(client(), agent(LINKEDIN_WRITER))).resolves.toContain(
      "has not been set up",
    );
  });

  it("still refuses on the INTAKE, which the engine does not write either way", async () => {
    // The form is what the pre-flight resolves from, so it is the one gate that
    // must survive the engine carve-out.
    hasLinkedInAgentIntakeMock.mockResolvedValue(false);
    await expect(unfireableScheduleReason(client(), agent(LINKEDIN_WRITER))).resolves.toContain(
      "Open this agent on your AI agents page",
    );
  });

  it("keeps the setup skill exempt on both paths", async () => {
    await expect(unfireableScheduleReason(client(), agent(LINKEDIN_SETUP))).resolves.toBeNull();
    await expect(
      unfireableScheduleReason(client({ agentsRepoSlug: undefined }), agent(LINKEDIN_SETUP)),
    ).resolves.toBeNull();
  });
});

describe("the client's agent cards", () => {
  const setupFor = async (key: string) => (await buildAgentSetup("c1", [{ id: "a1", key }]))["a1"];

  it("reads as stood up for an engine-routed client with no state rows at all", async () => {
    const linkedin = await setupFor(LINKEDIN_WRITER);
    expect(linkedin.ready).toBe(true);
    expect(linkedin.standUpDone).toBe(true);
    // The newsletter and the blog fold their index rung into `ready` instead.
    expect((await setupFor(NEWSLETTER_WRITER)).ready).toBe(true);
    expect((await setupFor(BLOG_WRITER)).ready).toBe(true);
  });

  it("still demands the stand-up from a client without a lab slug", async () => {
    vi.mocked(data.getClient).mockResolvedValue(client({ agentsRepoSlug: undefined }));
    expect((await setupFor(LINKEDIN_WRITER)).standUpDone).toBe(false);
    expect((await setupFor(NEWSLETTER_WRITER)).ready).toBe(false);
    expect((await setupFor(BLOG_WRITER)).ready).toBe(false);
  });

  it("still demands the intake from an engine-routed client", async () => {
    hasLinkedInAgentIntakeMock.mockResolvedValue(false);
    hasNewsletterAgentIntakeMock.mockResolvedValue(false);
    hasBlogAgentIntakeMock.mockResolvedValue(false);
    expect((await setupFor(LINKEDIN_WRITER)).ready).toBe(false);
    expect((await setupFor(NEWSLETTER_WRITER)).ready).toBe(false);
    expect((await setupFor(BLOG_WRITER)).ready).toBe(false);
  });
});

describe("the intake pages", () => {
  /**
   * ASKED OF THE BUILDERS, not of the file's text. The two flips with the
   * largest client-visible consequence live here — the setup band's copy and
   * which seats the run dialog may offer — and a source-string assertion passes
   * whatever feeds them.
   *
   * Everything these builders read that is not about setup is seeded empty, so
   * the setup state is the only thing that varies.
   */
  beforeEach(() => {
    vi.mocked(data.listClientSeats).mockResolvedValue([]);
    vi.mocked(data.listAgentIntake).mockResolvedValue([]);
    vi.mocked(data.listCustomAgents).mockResolvedValue([]);
    vi.mocked(data.listXNewsUpdates).mockResolvedValue([]);
    vi.mocked(data.listLiDraftFeedback).mockResolvedValue([]);
    vi.mocked(data.listLiDirectionRequests).mockResolvedValue([]);
    vi.mocked(data.listNewsletterDraftFeedback).mockResolvedValue([]);
    vi.mocked(data.listJobs).mockResolvedValue([]);
    vi.mocked(data.getAgentIntake).mockResolvedValue(null);
    vi.mocked(data.getCustomAgentByKey).mockResolvedValue(null);
  });

  const linkedin = (agentKey?: string) =>
    buildLinkedInAgentIntakeView("c1", { isStaff: false, ...(agentKey ? { agentKey } : {}) });

  it("stops asking an engine-routed client for a stand-up nothing can produce", async () => {
    expect((await linkedin(LINKEDIN_WRITER)).isSetUp).toBe(true);
    expect((await buildNewsletterAgentIntakeView("c1", { isStaff: false })).isSetUp).toBe(true);
    expect((await buildBlogAgentIntakeView("c1", { isStaff: false })).isSetUp).toBe(true);
  });

  it("still asks a client whose runs do not reach the engine, exactly as before", async () => {
    vi.mocked(data.getClient).mockResolvedValue(client({ agentsRepoSlug: undefined }));
    expect((await linkedin(LINKEDIN_WRITER)).isSetUp).toBe(false);
    expect((await buildNewsletterAgentIntakeView("c1", { isStaff: false })).isSetUp).toBe(false);
    expect((await buildBlogAgentIntakeView("c1", { isStaff: false })).isSetUp).toBe(false);
  });

  it("asks of the LinkedIn agent the pane is about, not of a fixed key", async () => {
    // The family has four keys and only the two v2 ones route to the engine, so
    // a client whose only LinkedIn agent is an e10 instance must keep the
    // stand-up that is still the portal's to fire.
    expect((await linkedin("karos-linkedin-company-acme")).isSetUp).toBe(false);
    expect((await linkedin("karos-linkedin-agent")).isSetUp).toBe(false);
  });

  it("resolves the family page's question from the agents this client holds", async () => {
    // That page names no agent. With only the e10 instance granted there is
    // nothing engine-routed to carve out for...
    vi.mocked(data.listCustomAgents).mockResolvedValue([
      { id: "a1", key: "karos-linkedin-company-acme", enabled: true },
    ] as CustomAgent[]);
    vi.mocked(data.getClient).mockResolvedValue(client({ customAgentIds: ["a1"] }));
    expect((await linkedin()).isSetUp).toBe(false);
    // ...and with the v2 writer granted there is.
    vi.mocked(data.listCustomAgents).mockResolvedValue([
      { id: "a2", key: LINKEDIN_WRITER, enabled: true },
    ] as CustomAgent[]);
    vi.mocked(data.getClient).mockResolvedValue(client({ customAgentIds: ["a2"] }));
    expect((await linkedin()).isSetUp).toBe(true);
  });

  it("offers a seat the client set up on LinkedIn, and never one they did not", async () => {
    // Seats are SHARED across agents — one created for the X agent says nothing
    // about LinkedIn — and `voiceReady` is what `withLinkedInIdentityOptions`
    // filters the run dialog's "Post as" list by. Offering a seat with no
    // LinkedIn form would dispatch `requestedExecutiveName` for a person this
    // channel knows nothing about: a borrowed voice on a personal profile.
    vi.mocked(data.listClientSeats).mockResolvedValue([
      { id: "s1", clientId: "c1", name: "Albert Kattan", slug: "albert" },
      { id: "s2", clientId: "c1", name: "Lola Tamman", slug: "lola" },
    ] as Awaited<ReturnType<typeof data.listClientSeats>>);
    vi.mocked(data.listAgentIntake).mockResolvedValue([
      { id: "i1", clientId: "c1", agent: "linkedin", seatId: "s1", updatedAt: 1 },
    ] as Awaited<ReturnType<typeof data.listAgentIntake>>);

    const seats = (await linkedin(LINKEDIN_WRITER)).seats;
    expect(seats.find((s) => s.id === "s1")?.voiceReady).toBe(true);
    expect(seats.find((s) => s.id === "s2")?.voiceReady).toBe(false);
    // And neither of them has a voice profile, which is the OTHER question the
    // seat's status line speaks about.
    expect(seats.every((s) => s.voiceOnFile === false)).toBe(true);
  });

  it("keeps offering a seat whose voice was built on the old path", async () => {
    vi.mocked(data.getClient).mockResolvedValue(client({ agentsRepoSlug: undefined }));
    vi.mocked(data.listClientSeats).mockResolvedValue([
      { id: "s1", clientId: "c1", name: "Albert Kattan", slug: "albert" },
    ] as Awaited<ReturnType<typeof data.listClientSeats>>);
    listLinkedInReadySeatIdsMock.mockResolvedValue(["s1"]);
    const [seat] = (await linkedin(LINKEDIN_WRITER)).seats;
    expect(seat.voiceReady).toBe(true);
    expect(seat.voiceOnFile).toBe(true);
  });

  it("turns the LinkedIn stand-up TRIGGERS off with the demand, which is intended", async () => {
    // `isSetUp` is not only the band's copy. The company form fires the stand-up
    // on save while it is false, and the manual "Set it up" button exists only
    // in that branch — so an engine-routed client has neither. That is the
    // intent, not a side effect: `karos-linkedin-setup-v2` routes to
    // `linkedin-agent`, the DRAFTING agent, so a press there is a second charge
    // for a post nobody asked for. Pinned here so bringing the press back is a
    // deliberate edit rather than a quiet one.
    expect((await linkedin(LINKEDIN_WRITER)).isSetUp).toBe(true);
    const component = readFileSync(
      join(process.cwd(), "src/components/linkedin-agent-intake.tsx"),
      "utf8",
    );
    expect(component).toContain("if (isSetUp === false) {");
    expect(component).toContain("const firesSetup = isSetUp === false;");
    // The seat's own auto-fire is keyed the same way, so a seat with no
    // LinkedIn form still fires its build on the save that creates one.
    expect(component).toContain("if (!seat.voiceReady) {");
  });

  it("tells the band which kind of 'set up' it is looking at", async () => {
    // Both paths are "no press to make" and only one of them has already read
    // this company's material, so they cannot share a sentence.
    expect((await linkedin(LINKEDIN_WRITER)).setupInlinedInRuns).toBe(true);
    vi.mocked(data.getClient).mockResolvedValue(client({ agentsRepoSlug: undefined }));
    expect((await linkedin(LINKEDIN_WRITER)).setupInlinedInRuns).toBe(false);
  });
});

describe("the wiring that has to agree across modules", () => {
  const core = readFileSync(join(process.cwd(), "src/lib/jobs/submit-custom.ts"), "utf8");
  const gate = readFileSync(join(process.cwd(), "src/lib/jobs/schedule-gate.ts"), "utf8");
  const rows = readFileSync(join(process.cwd(), "src/lib/client-agent-rows.ts"), "utf8");
  const views = readFileSync(join(process.cwd(), "src/lib/agent-intake-views.ts"), "utf8");

  it("skips each stand-up rung on the engine path, and keeps every intake rung", () => {
    // The submit core already resolved the engine gate once as `engineProductId`
    // (the reputation branch's own shape), so the rungs carry that, not a second
    // resolution that could drift from it.
    expect(core).toContain("!engineProductId && !isLinkedInSetupV2(agent.key) && isLinkedInV2Agent(agent.key)");
    expect(core.replace(/\s+/g, " ")).toContain(
      "!engineProductId && !isNewsletterSetupV2(agent.key) && !(await hasNewsletterV2Setup(input.clientId))",
    );
    expect(core.replace(/\s+/g, " ")).toContain(
      "!engineProductId && !isBlogSetupV2(agent.key) && !(await hasBlogV2Setup(input.clientId))",
    );
    // The intake gates are portal-written and stay on BOTH paths.
    for (const call of [
      "hasLinkedInAgentIntake(input.clientId, agent.key)",
      "hasXAgentIntake(input.clientId)",
      "hasRedditAgentIntake(input.clientId)",
      "hasNewsletterAgentIntake(input.clientId)",
      "hasBlogAgentIntake(input.clientId)",
    ]) {
      expect(core, `the submit core stopped asking ${call}`).toContain(call);
    }
    // And the seat is still resolved to the name the engine matches on, which
    // sits ABOVE the skipped rungs and must not have been skipped with them.
    expect(core).toContain("engineBriefValues = { ...engineBriefValues, requestedExecutiveName: seat.name }");
  });

  it("asks the ONE shared helper on every surface that decides 'set up'", () => {
    // One definition, not five copies of the same three-part gate — including
    // reputation's own name for it, which now delegates here.
    expect(gate).toContain("engineOwnsSetup(agent.key, client.agentsRepoSlug)");
    expect(rows).toContain("engineOwnsSetupForClient(clientId, agent.key)");
    // LinkedIn asks through `engineOwnsLinkedInSetup`, which resolves WHICH of
    // the family's four keys to ask with; the pane's behaviour is pinned above.
    expect(views).toContain("engineOwnsSetupForClient(clientId, agentKey)");
    expect(views).toContain("engineOwnsSetupForClient(clientId, NEWSLETTER_WRITER_V2_KEY)");
    expect(views).toContain("engineOwnsSetupForClient(clientId, BLOG_WRITER_V2_KEY)");
    const reputation = readFileSync(
      join(process.cwd(), "src/lib/agent-service/reputation-agent-context.ts"),
      "utf8",
    );
    expect(reputation).toContain("return engineOwnsSetupForClient(clientId, agentKey);");
  });

});
