/**
 * D11: every output states its point — goal, who it is for, why now.
 *
 * The engine has emitted that line since x-craft@6 and linkedin-craft@6, and
 * the portal dropped it on the floor: `metaFields` never listed the three
 * fields, so they never reached the asset and no card could have shown them.
 * A client saw a lane label on X, "why this thread" on Reddit, and nothing at
 * all on LinkedIn.
 *
 * The other half of the same rule is what must NOT travel. `formattingNotes`
 * is instruction to whoever formats the post, it reached a client once through
 * this exact list, and nothing in the repo reads it back.
 *
 * SCRUM-483 added the visual half. Instagram and the three TikTok agents emit
 * the same three fields, and their materializers build `meta` as a literal
 * rather than through a `metaFields` list — so the source scan below could
 * never have caught them, and did not. Those assertions run the real
 * materialization instead; see the second half of this file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAssetMock,
  attachAssetToJobMock,
  getJobMock,
  updateJobMock,
  getClientMock,
  listClientCompetitorsMock,
  upsertClientSeoGeoMock,
  uploadBytesMock,
  reflowMock,
  generateTitleMock,
  getDeliverableMock,
  readAgentEngineRunMock,
} = vi.hoisted(() => ({
  createAssetMock: vi.fn(),
  attachAssetToJobMock: vi.fn(),
  getJobMock: vi.fn(),
  updateJobMock: vi.fn(),
  getClientMock: vi.fn(),
  listClientCompetitorsMock: vi.fn(),
  upsertClientSeoGeoMock: vi.fn(),
  uploadBytesMock: vi.fn(),
  reflowMock: vi.fn(),
  generateTitleMock: vi.fn(),
  getDeliverableMock: vi.fn(),
  readAgentEngineRunMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
// The same seam materialize.test.ts uses, for the same reason: this module's
// whole job is the payload it hands `createAsset`, so that call is the only
// honest place to read what a client would see.
vi.mock("@/lib/data", () => ({
  createAsset: createAssetMock,
  attachAssetToJob: attachAssetToJobMock,
  getJob: getJobMock,
  updateJob: updateJobMock,
  getClient: getClientMock,
  listClientCompetitors: listClientCompetitorsMock,
  upsertClientSeoGeo: upsertClientSeoGeoMock,
}));
vi.mock("@/lib/storage", () => ({ uploadBytes: uploadBytesMock }));
vi.mock("@/lib/chain", () => ({ reflowClientChain: reflowMock }));
vi.mock("@/lib/asset-titles", () => ({ generateAssetTitle: generateTitleMock }));
vi.mock("../read-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../read-run")>()),
  readAgentEngineRun: readAgentEngineRunMock,
}));
vi.mock("../client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client")>()),
  getAgentEngineDeliverable: getDeliverableMock,
}));

import { materializeAgentEngineDeliverable, PRODUCT_DELIVERABLE_KINDS } from "../materialize";
import type { Asset, Job } from "@/lib/types";
import { readFileSync } from "node:fs";
import path from "node:path";

const SOURCE = readFileSync(path.join(process.cwd(), "src/lib/agent-engine/materialize.ts"), "utf8");

/** The `metaFields: [...]` array declared by one materializer, as written. */
function metaFieldsNear(marker: string): string[] {
  const at = SOURCE.indexOf(marker);
  expect(at, `could not find ${marker} in materialize.ts`).toBeGreaterThan(-1);
  const rest = SOURCE.slice(at);
  const m = /metaFields:\s*\[([^\]]*)\]/.exec(rest);
  expect(m, `no metaFields after ${marker}`).not.toBeNull();
  return m![1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

describe("the goal line reaches the asset (D11)", () => {
  it("X carries goal, audience and whyNow", () => {
    const fields = metaFieldsNear('titleWhenAbsent: "X post"');
    for (const k of ["goal", "audience", "whyNow"]) expect(fields, k).toContain(k);
  });

  it("LinkedIn carries goal, audience and whyNow", () => {
    const fields = metaFieldsNear('titleWhenAbsent: "LinkedIn post"');
    for (const k of ["goal", "audience", "whyNow"]) expect(fields, k).toContain(k);
  });

  it("Reddit carries whyThread — a reply has no funnel stage, but it must say why this thread", () => {
    const fields = metaFieldsNear('titleWhenAbsent: "Reddit reply"');
    expect(fields).toContain("whyThread");
  });
});

describe("internal working text stays off the client's card", () => {
  it("formattingNotes is in no materializer's metaFields", () => {
    // Every `metaFields: [...]` in the file, not just LinkedIn's: the point is
    // that it reaches NO asset, whichever product grows a meta list next. The
    // prose comment explaining WHY it was removed is deliberately not what this
    // reads — an assertion over the whole file would fail on its own rationale.
    const lists = [...SOURCE.matchAll(/metaFields:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
    expect(lists.length, "no metaFields lists found — the scan is vacuous").toBeGreaterThanOrEqual(3);
    for (const list of lists) expect(list).not.toContain("formattingNotes");
  });
});

describe("the products are all still mapped", () => {
  it("did not lose a product while editing the meta lists", () => {
    expect(Object.keys(PRODUCT_DELIVERABLE_KINDS)).toHaveLength(16);
  });
});

/* ─────────────────── the visual agents (SCRUM-483) ───────────────────
 *
 * A scan of `metaFields` is the wrong instrument here — these four products
 * have no such list. Their deliverable is a rendered PNG or mp4 and each
 * materializer writes its `meta` literally, which is precisely how they were
 * missed: the three fields arrived from the engine, nothing put them on the
 * asset, and the client's card had nowhere to read them from.
 *
 * So these go through the real materialization and read the payload that
 * reaches `createAsset` — the only thing a card can render. The renderer
 * itself needed no change: the modal's block is a sibling of the content
 * branch, not inside it, so a carousel and a video reach it exactly as a
 * drafts batch does.
 */

/** The goal line as the engine sends it: the funnel's own word, plus two sentences. */
const GOAL_LINE = {
  goal: "expertise",
  audience: "Heads of growth at Series-B fintechs",
  whyNow: "The EU ad rules landed this week and nobody has explained them plainly.",
} as const;

/**
 * One deliverable per visual materializer, in the shape that materializer
 * actually reads — not one payload reused three times. Instagram wants
 * slides, branded-shorts wants a duration and nothing else, and the clip
 * wants the caption that IS its post text.
 */
const VISUAL_DELIVERABLES: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  [
    "instagram-agent",
    "materializeInstagramCarousel",
    {
      topic: "What the EU ad rules changed",
      caption: "Three things changed this week. Here is what each one costs you.",
      slides: [{ n: 1, fields: { headline: "What the EU ad rules changed" } }],
      rendered: [{ n: 1, path: "https://signed.example/slide-1.png", gcsUri: "gs://b/1.png" }],
    },
  ],
  [
    "branded-shorts-agent",
    "materializeBrandedShortsVideo",
    { durationSeconds: 30, gcsUri: "gs://media/shorts/final.mp4" },
  ],
  [
    "tiktok-agent",
    "materializeTiktokClip",
    {
      topic: "The margin call moment",
      caption: "Our read: the number is right, the conclusion is wrong.",
      sourceCredit: "Jane Doe on The Show ep. 12",
      durationSeconds: 40,
    },
  ],
];

function job(productId: string): Job {
  return {
    id: "job_1",
    clientId: "client_1",
    agentId: "agent-engine",
    agentName: "Instagram Content Specialist",
    title: "Test job",
    status: "review",
    input: {},
    assetIds: [],
    events: [],
    createdBy: "user_1",
    createdAt: 1000,
    updatedAt: 1000,
    agentEngineRunId: "pubsub-1",
    agentEngineProductId: productId,
  } as Job;
}

async function materialize(productId: string, deliverable: unknown): Promise<Omit<Asset, "id">> {
  getDeliverableMock.mockResolvedValue(deliverable);
  await materializeAgentEngineDeliverable(job(productId));
  expect(createAssetMock).toHaveBeenCalledTimes(1);
  return createAssetMock.mock.calls[0]![0] as Omit<Asset, "id">;
}

beforeEach(() => {
  createAssetMock.mockReset().mockImplementation(async (_data: unknown, id: string) => ({ id, created: true }));
  attachAssetToJobMock.mockReset();
  getJobMock.mockReset().mockResolvedValue(null); // no fresh information — the snapshot stands
  updateJobMock.mockReset().mockResolvedValue(undefined);
  getDeliverableMock.mockReset();
  // Null by default, so every assertion reads the deterministic field-derived
  // title rather than a live Haiku call.
  generateTitleMock.mockReset().mockResolvedValue(null);
  reflowMock.mockReset().mockResolvedValue(undefined);
  uploadBytesMock.mockReset().mockResolvedValue({ url: "https://karos.example/rehosted.png" });
  getClientMock.mockReset().mockResolvedValue({ id: "client_1", name: "Acme Fintech" });
  listClientCompetitorsMock.mockReset().mockResolvedValue([]);
  upsertClientSeoGeoMock.mockReset().mockResolvedValue(undefined);
  readAgentEngineRunMock.mockReset().mockResolvedValue(null);
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as typeof fetch;
});

describe("the goal line reaches the visual agents' cards (D11, SCRUM-483)", () => {
  it("instagram-carousel carries goal, audience and whyNow onto the asset", async () => {
    const [, , deliverable] = VISUAL_DELIVERABLES[0]!;
    const asset = await materialize("instagram-agent", { ...deliverable, ...GOAL_LINE });
    expect(asset.meta).toMatchObject(GOAL_LINE);
    // Still the carousel it was: the line rides alongside the gallery, it does
    // not stand in for it.
    expect((asset.meta?.slides as unknown[]).length).toBe(1);
  });

  it("branded-shorts-video carries them — and this asset has no caption at all, so they are the only words on the card", async () => {
    const [, , deliverable] = VISUAL_DELIVERABLES[1]!;
    const asset = await materialize("branded-shorts-agent", { ...deliverable, ...GOAL_LINE });
    expect(asset.content).toBe("");
    expect(asset.meta).toMatchObject(GOAL_LINE);
  });

  it("tiktok-clip carries them alongside its own commentary fields", async () => {
    const [, , deliverable] = VISUAL_DELIVERABLES[2]!;
    const asset = await materialize("tiktok-agent", { ...deliverable, ...GOAL_LINE });
    expect(asset.meta).toMatchObject({ ...GOAL_LINE, sourceCredit: "Jane Doe on The Show ep. 12", durationSeconds: 40 });
  });

  // D08's three TikTok cards are three product ids over two deliverable shapes:
  // clipping and content design both run the tiktok workflow and materialize as
  // a clip, editing runs the branded-shorts one. Content design has NO
  // materializer of its own, so it inherits this line only because
  // `materializeTiktokClip` carries it — which is the thing worth pinning.
  it.each([
    ["tiktok-clipping-agent", VISUAL_DELIVERABLES[2]![2]],
    ["tiktok-content-design-agent", VISUAL_DELIVERABLES[2]![2]],
    ["tiktok-editing-agent", VISUAL_DELIVERABLES[1]![2]],
  ])("%s lands the line through the materializer it shares", async (productId, deliverable) => {
    const asset = await materialize(productId, { ...deliverable, ...GOAL_LINE });
    expect(asset.meta).toMatchObject(GOAL_LINE);
  });
});

describe("nothing is invented when the run did not send it", () => {
  // A run from an older prompt version, or one that resumed mid-flight,
  // legitimately carries none of these. The modal renders only the rows that
  // are there, so an absent field must stay ABSENT rather than land as an
  // empty labelled row under "The point of this post".
  it.each(VISUAL_DELIVERABLES)("%s (%s) leaves the three keys off the meta entirely", async (productId, _fn, deliverable) => {
    const asset = await materialize(productId, deliverable);
    for (const key of ["goal", "audience", "whyNow"]) {
      expect(asset.meta, key).not.toHaveProperty(key);
    }
  });

  it("a partial line travels as far as it goes, and no further", async () => {
    // Half a goal line is not a broken one — the engine legitimately sends
    // `whyNow` on a product that has no funnel stage to state.
    const [, , deliverable] = VISUAL_DELIVERABLES[2]!;
    const asset = await materialize("tiktok-agent", { ...deliverable, whyNow: GOAL_LINE.whyNow });
    expect(asset.meta).toMatchObject({ whyNow: GOAL_LINE.whyNow });
    expect(asset.meta).not.toHaveProperty("goal");
    expect(asset.meta).not.toHaveProperty("audience");
  });
});

/**
 * SCRUM-474 — the DRAFTING agents, which is the half SCRUM-483 did not cover.
 *
 * These three do not carry the line as deliverable fields and the C7 §3
 * contract does not promise that they will: the engine resolves it once and
 * writes it into the drafts string, which is the same string the asset stores
 * as its `content` and the card already parses. Reading the deliverable's own
 * optional fields meant the modal's block was populated by luck on X and
 * LinkedIn and never on Reddit, while the card beside it was right.
 */
describe("the goal line reaches the drafting agents' cards (D11, SCRUM-474)", () => {
  const X_DRAFTS = [
    "## Post 1",
    "- **Goal:** show expertise",
    "- **For:** ops leads whose intake breaks in month two",
    "- **Why now:** a benchmark report landed on Monday",
    "",
    "Most marketing calendars fail in the second month.",
  ].join("\n");

  it("X takes it from the drafts markdown, storing the funnel word the modal renders", async () => {
    const asset = await materialize("x-agent", { draftsMarkdown: X_DRAFTS, hook: "Most calendars fail in month two" });
    expect(asset.meta).toMatchObject({
      goal: "expertise",
      audience: "ops leads whose intake breaks in month two",
      whyNow: "a benchmark report landed on Monday",
    });
    // The drafts string is untouched — the card parses the same bullets.
    expect(asset.content).toBe(X_DRAFTS);
  });

  it("LinkedIn takes it from its own drafts markdown", async () => {
    const asset = await materialize("linkedin-agent", { draftsMarkdown: X_DRAFTS, headline: "Month two" });
    expect(asset.meta).toMatchObject({ goal: "expertise", whyNow: "a benchmark report landed on Monday" });
  });

  it("Reddit takes whyThread from the v2 envelope, which its deliverable calls something else entirely", async () => {
    // The deliverable field is `whyThisThread`; `metaFields` asks for
    // `whyThread`; nothing in this repo reads the former. The envelope has the
    // name the portal uses, so that is where it comes from.
    const envelope = JSON.stringify({
      version: 2,
      threads: [{ targetThreadUrl: "https://reddit.com/r/ops/1", whyThread: "the thread is asking our exact question" }],
    });
    const asset = await materialize("reddit-agent", { draftsEnvelope: envelope, whyThisThread: "ignored by everything" });
    expect(asset.meta).toMatchObject({ whyThread: "the thread is asking our exact question" });
  });

  it("a deliverable that DID state its own line keeps it — this is a fallback, not an override", async () => {
    // A model that stated its goal said something the resolver would only have
    // defaulted. The bullet is the backstop for the fields it left empty.
    const asset = await materialize("x-agent", { draftsMarkdown: X_DRAFTS, goal: "attention", hook: "h" });
    expect(asset.meta).toMatchObject({ goal: "attention", whyNow: "a benchmark report landed on Monday" });
  });

  it("a drafts string with no line leaves the keys off entirely", async () => {
    const asset = await materialize("x-agent", { draftsMarkdown: "## Post 1\n\nJust the post text.\n", hook: "h" });
    for (const key of ["goal", "audience", "whyNow"]) expect(asset.meta, key).not.toHaveProperty(key);
  });
});
