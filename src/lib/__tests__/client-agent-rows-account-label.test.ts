import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSlot, Asset, ClientAgent, CustomAgent } from "@/lib/types";
import type { ClientAgentCardRow } from "@/components/client-agents/types";

vi.mock("server-only", () => ({}));

const { getAssetMock, upcomingSlotsMock, listFeedbackMock } = vi.hoisted(() => ({
  getAssetMock: vi.fn(),
  upcomingSlotsMock: vi.fn(),
  listFeedbackMock: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getAsset: getAssetMock,
  listPlannedScheduledRuns: vi.fn(),
}));
vi.mock("@/lib/data-client-agents", () => ({ listClientAgentFeedback: listFeedbackMock }));
vi.mock("@/lib/client-agent-slots", () => ({ upcomingSlots: upcomingSlotsMock }));
vi.mock("@/lib/agent-service/x-agent-context", () => ({ hasXAgentIntake: vi.fn() }));
vi.mock("@/lib/agent-service/linkedin-agent-context", () => ({ hasLinkedInAgentIntake: vi.fn() }));
vi.mock("@/lib/agent-service/reddit-agent-context", () => ({ hasRedditAgentIntake: vi.fn() }));

const { toClientAgentRows } = await import("@/lib/client-agent-rows");

/**
 * The ACCOUNT heading on today's options, asked at the server boundary.
 *
 * `today.options[].account` is the batch markdown's own "# Account N · …"
 * heading, and the contract's example for it is "Albert Kattan (seat 1, handle
 * pending)" — lab seat bookkeeping, on a paying client's option picker. The
 * question here is about the PAYLOAD, not the render: these objects are
 * serialized into the RSC payload, so a heading a component declines to paint is
 * still readable in view-source.
 *
 * SCOPE, and it is a real one. The bookkeeping is still readable inside each
 * option's `ref`, which is the batch join key: the pick action resolves it
 * against `slot.optionRefs` and the learning log records it as `draftRef`
 * byte-identical (pinned in x-options.test.ts, and the reason is x-options.ts's
 * own header). So every assertion below asks the question with the refs blanked,
 * and narrowing that last field needs an opaque option handle plus a new key on
 * the option shape — a human's decision, not a rename.
 *
 * This file adds nothing about the projected KEY SET: that is
 * client-agent-rows.test.ts's tripwire and belongs in exactly one place.
 */

/* ───────────────────────────── sentinels ───────────────────────────── */

/** The lab's seat bookkeeping, the part of a heading no client may read. */
const BOOKKEEPING = "(seat 1, handle pending)";
/** The person the heading names — the client's own exec, which they DO read. */
const PERSON = "Albert Kattan";
const SEAT_HEADING = `${PERSON} ${BOOKKEEPING}`;
/** The company section's heading, which the contract writes as client copy. */
const COMPANY_HEADING = "Company page @getkaros";
/** Today's draft text, so a fixture that never reached the code cannot pass. */
const TODAY_DRAFT = "SENTINEL_draft_for_today";

const NOW = Date.UTC(2026, 6, 28, 23, 30, 0);
const LA = "America/Los_Angeles";
const TODAY_LA = "2026-07-28";
const VIEWER_UID = "uid_the_viewer";

const SEAT_REF = `${SEAT_HEADING} · Avenue 1 · Playbook`;
const COMPANY_REF = `${COMPANY_HEADING} · Avenue 2 · News-reaction (live)`;
/** A ref whose tail names no lane at all — the #155 fallback case. */
const NO_LANE_REF = `${SEAT_HEADING} · Avenue 9 · `;

const BATCH_MARKDOWN = [
  `# Account 1 · ${SEAT_HEADING}`,
  "## Avenue 1 · Playbook",
  `> ${TODAY_DRAFT} one`,
  `# Account 2 · ${COMPANY_HEADING}`,
  "## Avenue 2 · News-reaction (live)",
  `> ${TODAY_DRAFT} two`,
].join("\n");

/* ───────────────────────────── fixtures ───────────────────────────── */

function agent(): CustomAgent {
  return {
    id: "ca_x",
    key: "karos-x-agent",
    name: "Karos X Agent",
    icon: "AtSign",
    color: "#0f0",
    entrySkillDir: "skills/x",
    skillRoots: ["skills"],
    includeClientSkills: true,
    enabled: true,
    createdBy: "uid_staff",
    createdAt: 1,
    clientBlurb: "One post a day for your X account, in your voice.",
    creditCost: 25,
  } as CustomAgent;
}

function umbrella(): ClientAgent {
  return {
    id: "clientAgent_1",
    clientId: "c1",
    agentKey: "karos-x-agent",
    customAgentId: "ca_x",
    displayName: "Your X agent",
    platform: "x",
    slotMode: "options",
    launchState: "live",
    templates: [],
    rotation: [],
    createdBy: "uid_staff",
    createdAt: 1,
    updatedAt: 1,
  };
}

function slot(patch: Partial<AgentSlot> = {}): AgentSlot {
  return {
    id: `slot_${TODAY_LA}`,
    clientId: "c1",
    clientAgentId: "clientAgent_1",
    dateKey: TODAY_LA,
    kind: "options",
    templateKey: "daily-post",
    status: "generated",
    ...patch,
  } as AgentSlot;
}

function batchAsset(): Asset {
  return {
    id: "asset_batch",
    clientId: "c1",
    type: "social_post",
    title: "X batch",
    content: BATCH_MARKDOWN,
    status: "draft",
    createdBy: "uid_staff",
    createdAt: 1,
    updatedAt: 1,
  } as Asset;
}

type CardArgs = Parameters<typeof toClientAgentRows>[0];

function cardArgs(patch: Partial<CardArgs> = {}): CardArgs {
  return {
    umbrellas: [umbrella()],
    agentsById: new Map([["ca_x", agent()]]),
    viewerIsClient: true,
    grantedAgentIds: new Set(["ca_x"]),
    agentSetup: {},
    spendable: 5000,
    creditBlockReasons: {},
    scheduleRows: [],
    scheduleZones: new Map([["ca_x", LA]]),
    jobs: [],
    viewerUid: VIEWER_UID,
    viewerIsStaff: false,
    now: NOW,
    ...patch,
  };
}

/**
 * The payload as a client receives it, with the one field that must stay raw
 * replaced. Asked on the WHOLE payload rather than on `account` alone: a second
 * field that starts carrying the heading fails the same assertion.
 */
function payloadWithoutJoinKeys(rows: ClientAgentCardRow[]): string {
  return JSON.stringify(rows, (key, value) => (key === "ref" ? "<join-key>" : value));
}

beforeEach(() => {
  vi.clearAllMocks();
  upcomingSlotsMock.mockResolvedValue([]);
  listFeedbackMock.mockResolvedValue([]);
  getAssetMock.mockResolvedValue(batchAsset());
});

describe("today's options — the account heading at the RSC boundary", () => {
  it("keeps the lab's seat bookkeeping out of the payload, and keeps the person in", async () => {
    upcomingSlotsMock.mockResolvedValue([slot({ assetId: "asset_batch", optionRefs: [SEAT_REF] })]);

    const rows = await toClientAgentRows(cardArgs());
    const options = rows[0].today?.options ?? [];
    // Non-vacuity first: the fixture reached the options branch at all.
    expect(options).toHaveLength(1);
    expect(options[0].account).toBe(PERSON);

    const payload = payloadWithoutJoinKeys(rows);
    expect(payload).not.toContain(BOOKKEEPING);
    expect(payload).not.toContain("seat 1");
    expect(payload).not.toContain("handle pending");
    // …and the payload the question was asked of is a real one: the person and
    // their draft are both still in it, so a replacer that blanked everything
    // could not have produced this pass.
    expect(payload).toContain(PERSON);
    expect(payload).toContain(TODAY_DRAFT);
  });

  it("leaves a heading the contract wrote as client copy exactly as it is", async () => {
    // The neighbouring case, and the reason it matters: the account label is on
    // the card so a client knows WHICH account a draft is for. A humaniser that
    // dropped or mangled a good heading would break the thing it protects.
    upcomingSlotsMock.mockResolvedValue([
      slot({ assetId: "asset_batch", optionRefs: [COMPANY_REF] }),
    ]);
    const rows = await toClientAgentRows(cardArgs());
    expect(rows[0].today?.options.map((o) => o.account)).toEqual([COMPANY_HEADING]);
  });

  it("humanises every option on a day that mixes accounts, not just the first", async () => {
    upcomingSlotsMock.mockResolvedValue([
      slot({ assetId: "asset_batch", optionRefs: [SEAT_REF, COMPANY_REF] }),
    ]);
    const rows = await toClientAgentRows(cardArgs());
    expect(rows[0].today?.options.map((o) => o.account)).toEqual([PERSON, COMPANY_HEADING]);
    expect(payloadWithoutJoinKeys(rows)).not.toContain(BOOKKEEPING);
    // The angle is humanised too — the same rule, the other heading kind.
    expect(rows[0].today?.options.map((o) => o.direction)).toEqual([
      "Playbook",
      "Reacting to the news · live",
    ]);
  });
});

describe("the receipt for a day already chosen", () => {
  it("names the direction without the lab's lane vocabulary", async () => {
    upcomingSlotsMock.mockResolvedValue([
      slot({
        optionRefs: [COMPANY_REF],
        optionPick: {
          optionRef: COMPANY_REF,
          pickedAt: NOW,
          pickedBy: VIEWER_UID,
          edited: false,
        },
      }),
    ]);
    const rows = await toClientAgentRows(cardArgs());
    expect(rows[0].today?.pickedDirection).toBe("Reacting to the news · live");
    const payload = payloadWithoutJoinKeys(rows);
    expect(payload).not.toContain("Avenue");
    expect(payload).not.toContain("News-reaction");
  });

  it("says nothing rather than 'Draft' when the stored ref names no lane", async () => {
    // #155: this value is read inside a sentence ("You chose …"), so the lane
    // helper's card-heading fallback would put an internal status word into a
    // client's confirmation. Null, and the receipt simply omits the label.
    upcomingSlotsMock.mockResolvedValue([
      slot({
        optionRefs: [NO_LANE_REF],
        optionPick: {
          optionRef: NO_LANE_REF,
          pickedAt: NOW,
          pickedBy: VIEWER_UID,
          edited: false,
        },
      }),
    ]);
    const rows = await toClientAgentRows(cardArgs());
    expect(rows[0].today?.pickedDirection).toBeNull();
    expect(payloadWithoutJoinKeys(rows)).not.toContain("Draft");
  });

  it("prefers the direction stored at pick time, which is already client copy", async () => {
    // Non-vacuity for the null above: the field IS populated in the ordinary
    // case, so a projection that always returned null would fail here.
    upcomingSlotsMock.mockResolvedValue([
      slot({
        optionRefs: [SEAT_REF],
        optionPick: {
          optionRef: SEAT_REF,
          direction: "Playbook",
          pickedAt: NOW,
          pickedBy: VIEWER_UID,
          edited: false,
        },
      }),
    ]);
    const rows = await toClientAgentRows(cardArgs());
    expect(rows[0].today?.pickedDirection).toBe("Playbook");
  });
});
