import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSlot,
  Asset,
  ClientAgent,
  ClientAgentFeedback,
  ClientAgentLaunchState,
  ClientAgentTemplate,
  CustomAgent,
  Job,
  JobRunType,
  JobStatus,
  PlannedRunCadence,
  PlannedScheduledRun,
} from "@/lib/types";

vi.mock("server-only", () => ({}));

const { getAssetMock, upcomingSlotsMock, listFeedbackMock, listClientSeatsMock } = vi.hoisted(() => ({
  getAssetMock: vi.fn(),
  upcomingSlotsMock: vi.fn(),
  listFeedbackMock: vi.fn(),
  listClientSeatsMock: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getAsset: getAssetMock,
  listPlannedScheduledRuns: vi.fn(),
  listClientSeats: listClientSeatsMock,
}));
vi.mock("@/lib/data-client-agents", () => ({ listClientAgentFeedback: listFeedbackMock }));
vi.mock("@/lib/client-agent-slots", () => ({ upcomingSlots: upcomingSlotsMock }));
vi.mock("@/lib/agent-service/x-agent-context", () => ({ hasXAgentIntake: vi.fn() }));
vi.mock("@/lib/agent-service/linkedin-agent-context", () => ({ hasLinkedInAgentIntake: vi.fn() }));
vi.mock("@/lib/agent-service/reddit-agent-context", () => ({ hasRedditAgentIntake: vi.fn() }));

const { scheduleZonesByAgent, toClientAgentRows, toRunRows, toScheduleRows, toSummary } =
  await import("@/lib/client-agent-rows");

/**
 * The strip's horizon, as a literal. `WEEK_STRIP_DAYS` is deliberately NOT
 * imported and compared against itself: an assertion that reads the constant
 * back passes whatever the constant is, which is decoration. Seven is the whole
 * definition of "a week strip", so it is spelled out here once.
 */
const A_WEEK = 7;

/**
 * The keyed fallback line for `karos-x-agent-v2`, spelled out for the same reason
 * as the horizon above: imported and compared against itself it would pass
 * whatever the table says, including the manifest. This is the SECOND rung of
 * the CD-G2 chain, and the assertions below need to name it to be able to say
 * the third rung is absent.
 */
const X_AGENT_KEYED_BLURB =
  "Grow your following on X with a post a day, written in your voice from what your industry is talking about right now.";

/**
 * The RSC-boundary projections in `client-agent-rows.ts`, tested for what a
 * CLIENT's browser receives — not for what a component paints.
 *
 * Every assertion here is about the returned object, because that object is
 * serialized into the RSC payload: a field the page never renders is still
 * readable in view-source. So the questions are closed ones — "is this key
 * absent from the object?", "is this sentinel absent from the whole payload?",
 * "does this call happen at all?" — never "is this string missing from some
 * rendered output".
 *
 * SCOPE. This file covers `toRunRows`, `toScheduleRows`, `scheduleZonesByAgent`,
 * `toSummary` and `toClientAgentRows`. It says nothing about `buildAgentSetup`,
 * and nothing about the callers: in particular the §4.1 rule that a client's
 * generic run list drops the rows of umbrella-owned agents ("ran 2 hours ago ·
 * 7 drafts") lives in the agents page's `runnableNames` filter, NOT in
 * `toRunRows`, and is therefore not pinned here.
 */

/* ───────────────────────────── sentinels ───────────────────────────── */

/**
 * Distinctive values, so `JSON.stringify(payload)` can be asked whether any of
 * them crossed the boundary. Asserting on the WHOLE payload rather than on the
 * one field that is supposed to carry them is deliberate: a second field that
 * starts carrying the same value fails the same assertion.
 */
const S = {
  /** Operator free text on a job's request. */
  operatorPrompt: "SENTINEL_operator_freetext_teh_brief",
  /** A raw submit-core failure: service host, env var names. */
  internalError: "SENTINEL_AGENT_SERVICE_URL_unreachable_10_1_2_3_8080",
  /** The standing instruction pinned to a weekly schedule. */
  standingInstruction: "SENTINEL_staff_authored_standing_instruction",
  /** The lab manifest's own line about an agent. */
  manifestDescription: "SENTINEL_manifest_master_content_social_skill",
  /** The stored system prompt of a lab agent. */
  agentInstructions: "SENTINEL_agent_system_instructions",
  /** A staff member's internal uid. */
  staffUid: "SENTINEL_uid_staff_albert",
  /** An unconfirmed, AI-written template rationale on a curating umbrella. */
  templateRationale: "SENTINEL_unconfirmed_ai_rationale",
  /** Draft text for a day that is NOT today. */
  futureDraft: "SENTINEL_draft_for_a_day_that_is_not_today",
  /** Draft text for today. */
  todayDraft: "SENTINEL_draft_for_today",
  /** Ids of jobs that must not surface. */
  hiddenJobId: "SENTINEL_job_id_that_must_not_surface",
  /** A schedule's last-fire bookkeeping. */
  lastJobId: "SENTINEL_last_fire_job_id",
} as const;

/* ─────────────────────── the projected key sets ─────────────────────── */

/**
 * What each projection is allowed to put on the wire, written ONCE.
 *
 * Asserted as an exact set rather than a subset: a field added to any of these
 * rows then fails this file until a human decides it is client-safe, which is
 * the tripwire — the leaks this campaign chased were all fields nobody
 * consciously admitted.
 *
 * Nested collections are asserted PER ELEMENT (`week[]`, `week[].note`,
 * `feedback[]`, `today`, `today.options[]`), because a wrapper's own key set is
 * unchanged by a field added to every item inside it — which is exactly how a
 * batch `assetId` and a fulfilment `status` could be added to every option and
 * stay green.
 */
const RUN_ROW_CLIENT_KEYS = ["id", "agentName", "label", "status", "createdAt", "assetCount"];
const RUN_ROW_STAFF_ONLY_KEYS = ["prompt", "href", "error", "runType"];
const SCHEDULE_ROW_CLIENT_KEYS = [
  "id",
  "agentId",
  "status",
  "postsPerWeek",
  "outputsPerRun",
  "nextRunAt",
  "hour",
  "minute",
  "lastError",
  "lastErrorAt",
];
const SCHEDULE_ROW_STAFF_ONLY_KEYS = ["prompt"];
// `enabled` crossed into the summary with main's coming-soon roster: the run
// dialog refuses a disabled agent client-side with the same word the card uses.
const SUMMARY_KEYS = ["id", "key", "name", "clientBlurb", "icon", "color", "creditCost", "enabled"];
/** One day of the "Coming up" strip. */
const WEEK_ENTRY_KEYS = ["dateKey", "label", "slotId", "note", "canNote"];
const WEEK_NOTE_KEYS = ["text", "authorName", "createdAt", "applied"];
/** The wrapper around today's pick. */
const TODAY_KEYS = ["slotId", "options", "pickedDirection"];
/**
 * One option inside that wrapper — the element type, asserted per element.
 *
 * Declared because `today.options[]` was the one client-facing collection with
 * no key-set guard: adding the batch's `assetId`, or the slot's fulfilment
 * `status`, to every option was silently green while the wrapper's own key set
 * was pinned.
 *
 * SCOPE: this is a key-set tripwire and nothing more. It does NOT assert that
 * every field on an option reads like client copy — `ref` demonstrably carries
 * the lab's own avenue vocabulary today ("Acme · Avenue 1 · Playbook"), and the
 * churn tests below are written knowing that.
 */
const OPTION_KEYS = ["ref", "account", "direction", "posts"];
const FEEDBACK_ROW_KEYS = [
  "id",
  "scope",
  "templateKey",
  "text",
  "category",
  "status",
  "authorName",
  "creatorRole",
  "createdAt",
  "editable",
];
/** A card row for a client viewer with an intake surface and a credit balance. */
const CARD_ROW_KEYS = [
  "id",
  "clientId",
  "customAgentId",
  "identity",
  "icon",
  "displayName",
  "blurb",
  "launchState",
  "launchStartedAt",
  "launchError",
  "launchRefunded",
  "launchCost",
  "gate",
  "setupHref",
  "setupLabel",
  "templates",
  "optionsMode",
  "runCost",
  "templateGates",
  "week",
  "today",
  "feedback",
  "activeRun",
  "runnable",
  "schedule",
  "availableCredits",
];

const keysOf = (value: object) => Object.keys(value).sort();
const sorted = (keys: string[]) => [...keys].sort();

/* ───────────────────────────── fixtures ───────────────────────────── */

const NOW = Date.UTC(2026, 6, 28, 23, 30, 0); // 2026-07-28T23:30:00Z
const LA = "America/Los_Angeles"; // UTC-7 → still 2026-07-28
const NZ = "Pacific/Auckland"; // UTC+12 → already 2026-07-29
const TODAY_LA = "2026-07-28";
const TOMORROW_LA = "2026-07-29";
const DAY_AFTER_LA = "2026-07-30";

const VIEWER_UID = "uid_the_viewer";

function agent(patch: Partial<CustomAgent> = {}): CustomAgent {
  return {
    id: "ca_x",
    key: "karos-x-agent-v2",
    name: "Karos X Agent",
    description: S.manifestDescription,
    icon: "AtSign",
    color: "#0f0",
    entrySkillDir: "skills/x",
    skillRoots: ["skills"],
    includeClientSkills: true,
    instructions: S.agentInstructions,
    enabled: true,
    createdBy: S.staffUid,
    createdAt: 1,
    clientBlurb: "One post a day for your X account, in your voice.",
    creditCost: 25,
    launchCreditCost: 500,
    ...patch,
  } as CustomAgent;
}

function template(patch: Partial<ClientAgentTemplate> = {}): ClientAgentTemplate {
  return {
    key: "playbook",
    name: "Playbook",
    rationale: S.templateRationale,
    status: "active",
    position: 0,
    source: "launch",
    addedAt: 1,
    ...patch,
  };
}

function umbrella(patch: Partial<ClientAgent> = {}): ClientAgent {
  return {
    id: "clientAgent_1",
    clientId: "c1",
    agentKey: "karos-x-agent-v2",
    customAgentId: "ca_x",
    displayName: "Your X agent",
    platform: "x",
    slotMode: "options",
    launchState: "live",
    templates: [template()],
    rotation: ["playbook"],
    createdBy: S.staffUid,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function job(patch: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    clientId: "c1",
    agentId: "agent-service",
    agentName: "Karos X Agent",
    title: "Custom run",
    status: "delivered",
    input: { prompt: S.operatorPrompt },
    assetIds: ["a1", "a2"],
    events: [],
    error: S.internalError,
    external: { serviceJobId: "svc_1", taskType: "custom" },
    createdBy: S.staffUid,
    createdAt: NOW - 1000,
    updatedAt: NOW,
    runType: "scheduled",
    ...patch,
  };
}

function scheduled(patch: Partial<PlannedScheduledRun> = {}): PlannedScheduledRun {
  return {
    id: "sched_1",
    clientId: "c1",
    customAgentId: "ca_x",
    clientAgentId: "clientAgent_1",
    agentName: "Karos X Agent",
    agentIcon: "AtSign",
    agentColor: "#0f0",
    prompt: S.standingInstruction,
    cadence: "weekly",
    hour: 9,
    minute: 30,
    weekdays: [1, 3, 5],
    timeZone: LA,
    outputsPerRun: 3,
    billClientCredits: true,
    nextRunAt: NOW + 86_400_000,
    status: "active",
    lastRunAt: NOW - 86_400_000,
    lastJobId: S.lastJobId,
    lastError: S.internalError,
    lastErrorAt: NOW - 3600_000,
    createdBy: S.staffUid,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

function slot(patch: Partial<AgentSlot> = {}): AgentSlot {
  return {
    id: `slot_${patch.dateKey ?? TODAY_LA}`,
    clientId: "c1",
    clientAgentId: "clientAgent_1",
    dateKey: TODAY_LA,
    kind: "options",
    templateKey: "daily-post",
    status: "planned",
    ...patch,
  } as AgentSlot;
}

function feedback(patch: Partial<ClientAgentFeedback> = {}): ClientAgentFeedback {
  return {
    id: "fb_1",
    clientId: "c1",
    clientAgentId: "clientAgent_1",
    scope: "agent",
    text: "More numbers, fewer adjectives.",
    status: "active",
    createdBy: S.staffUid,
    createdByName: "Albert",
    creatorRole: "staff",
    createdAt: NOW - 5000,
    updatedAt: NOW - 5000,
    ...patch,
  };
}

/**
 * A batch asset in the lab's own markdown: four drafts for one account, of
 * which three are assigned to today. The fourth exists in the same file and is
 * the whole point — it is a day the client must not be able to see coming.
 */
const BATCH_MARKDOWN = [
  "# Account 1 · Acme",
  "## Avenue 1 · Playbook",
  `> ${S.todayDraft} one`,
  "## Avenue 2 · News-reaction (live)",
  `> ${S.todayDraft} two`,
  "## Avenue 3 · POV thread",
  `> ${S.todayDraft} three`,
  "## Avenue 4 · Explainer",
  `> ${S.futureDraft}`,
].join("\n");

const TODAY_REFS = [
  "Acme · Avenue 1 · Playbook",
  "Acme · Avenue 2 · News-reaction (live)",
  "Acme · Avenue 3 · POV thread",
];
const FUTURE_REF = "Acme · Avenue 4 · Explainer";

function batchAsset(): Asset {
  return {
    id: "asset_batch",
    clientId: "c1",
    type: "social_post",
    title: "X batch",
    content: BATCH_MARKDOWN,
    status: "draft",
    createdBy: S.staffUid,
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
    agentSetup: {
      ca_x: {
        ready: true,
        standUpDone: true,
        href: "/clients/c1/x-agent",
        label: "X agent data",
        clientLabel: "Your X details",
      },
    },
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

beforeEach(() => {
  vi.clearAllMocks();
  upcomingSlotsMock.mockResolvedValue([]);
  listFeedbackMock.mockResolvedValue([]);
  getAssetMock.mockResolvedValue(null);
  listClientSeatsMock.mockResolvedValue([]);
});

/* ─────────────────────── the viewer-split helper ─────────────────────── */

/**
 * The closed question for a viewer split, asked once instead of field by field:
 * for every id present in BOTH projections, is the client's object a field-wise
 * subset of staff's?
 *
 * - every client key must exist on the staff row, and
 * - every shared key must hold the SAME value, except the keys listed in
 *   `viewerDependent`, which are skipped here and pinned in a test of their own
 *   (each caller names them).
 *
 * SCOPE: matched ids only. It says nothing about rows one viewer has and the
 * other does not — those are asserted separately, because the two projections
 * legitimately differ in row SET as well as in fields.
 */
function expectClientFieldsSubsetOfStaff<T extends { id: string }>(
  clientRows: T[],
  staffRows: T[],
  viewerDependent: string[] = [],
): number {
  const bag = (row: T) => row as unknown as Record<string, unknown>;
  const staffById = new Map(staffRows.map((row) => [row.id, row]));
  let matched = 0;
  for (const clientRow of clientRows) {
    const staffRow = staffById.get(clientRow.id);
    if (!staffRow) continue;
    matched += 1;
    for (const key of Object.keys(bag(clientRow))) {
      expect(Object.keys(bag(staffRow))).toContain(key);
      if (viewerDependent.includes(key)) continue;
      expect(bag(clientRow)[key]).toEqual(bag(staffRow)[key]);
    }
  }
  return matched;
}

/* ═══════════════════════════════ toRunRows ═══════════════════════════ */

describe("toRunRows — the run-history projection", () => {
  it("gives a client exactly the declared client-safe keys, and staff those plus the staff-only ones", () => {
    const [clientRow] = toRunRows([job()], false, []);
    expect(keysOf(clientRow)).toEqual(sorted(RUN_ROW_CLIENT_KEYS));

    const [staffRow] = toRunRows([job()], true, []);
    expect(keysOf(staffRow)).toEqual(sorted([...RUN_ROW_CLIENT_KEYS, ...RUN_ROW_STAFF_ONLY_KEYS]));
  });

  it("keeps the operator's free text and the raw failure out of a client's payload", () => {
    const clientPayload = JSON.stringify(toRunRows([job()], false, []));
    expect(clientPayload).not.toContain(S.operatorPrompt);
    expect(clientPayload).not.toContain(S.internalError);
    // The staff half: an over-broad drop that redacted for everyone must also
    // go red here. /jobs is the run's real history and needs both.
    const staffPayload = JSON.stringify(toRunRows([job()], true, []));
    expect(staffPayload).toContain(S.operatorPrompt);
    expect(staffPayload).toContain(S.internalError);
  });

  it("does not smuggle the staff-only fields through as nulls", () => {
    const [clientRow] = toRunRows([job()], false, []);
    for (const key of RUN_ROW_STAFF_ONLY_KEYS) {
      expect(key in clientRow).toBe(false);
    }
  });

  /**
   * Driven from an exhaustive Record so a new JobRunType cannot land without a
   * decision here: adding a member to the union makes this object fail tsc.
   */
  const RUN_TYPE_REACHES_A_CLIENT: Record<JobRunType, boolean> = {
    launch: false,
    test: false,
    scheduled: true,
    manual_template: true,
    manual: true,
  };

  it.each(Object.keys(RUN_TYPE_REACHES_A_CLIENT) as JobRunType[])(
    "runType %s: the client sees the row only when the product says it may",
    (runType) => {
      const expected = RUN_TYPE_REACHES_A_CLIENT[runType];
      const only = [job({ id: S.hiddenJobId, runType })];

      const clientRows = toRunRows(only, false, []);
      expect(clientRows.map((r) => r.id)).toEqual(expected ? [S.hiddenJobId] : []);
      // The id itself, anywhere in the payload — not just the row it would be
      // the id of.
      expect(JSON.stringify(clientRows).includes(S.hiddenJobId)).toBe(expected);

      // Staff keep every run: the launch/test drop is a client rule, not a
      // global one.
      expect(toRunRows(only, true, []).map((r) => r.id)).toEqual([S.hiddenJobId]);
    },
  );

  it("legacy jobs with no runType still reach a client", () => {
    const legacy = job({ id: "job_legacy" });
    delete legacy.runType;
    expect(toRunRows([legacy], false, []).map((r) => r.id)).toEqual(["job_legacy"]);
  });

  /** Exhaustive over JobStatus: a new status cannot leave this sweep stale. */
  const ALL_JOB_STATUSES: Record<JobStatus, true> = {
    queued: true,
    running: true,
    review: true,
    approved: true,
    delivered: true,
    failed: true,
    cancelled: true,
    held: true,
  };

  it("for every JobStatus, a client's row is a field-wise subset of staff's", () => {
    const statuses = Object.keys(ALL_JOB_STATUSES) as JobStatus[];
    const jobs = statuses.map((status, i) =>
      job({ id: `job_${status}`, status, createdAt: NOW - i * 1000 }),
    );
    expect(jobs.length).toBeLessThanOrEqual(8); // below the cap, so ids match up

    const clientRows = toRunRows(jobs, false, []);
    const staffRows = toRunRows(jobs, true, []);
    expect(expectClientFieldsSubsetOfStaff(clientRows, staffRows)).toBe(statuses.length);
    // …and the status itself still crosses, so a client can be told what
    // happened to their own run.
    expect(clientRows.map((r) => r.status).sort()).toEqual([...statuses].sort());
  });

  it("drops jobs that are not agent-service custom runs, for both viewers", () => {
    const foreign = [
      job({ id: S.hiddenJobId, agentId: "some-other-agent" }),
      job({
        id: `${S.hiddenJobId}_managed`,
        external: { serviceJobId: "svc", taskType: "social_post" },
      }),
      job({ id: `${S.hiddenJobId}_nolink`, external: undefined }),
    ];
    for (const staff of [false, true]) {
      expect(JSON.stringify(toRunRows(foreign, staff, []))).not.toContain(S.hiddenJobId);
    }
  });

  it("caps the history at eight, newest first, and the older runs are absent", () => {
    const jobs = Array.from({ length: 11 }, (_, i) =>
      job({ id: i < 8 ? `job_recent_${i}` : `${S.hiddenJobId}_${i}`, createdAt: NOW - i * 1000 }),
    );
    const rows = toRunRows(jobs, false, []);
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.createdAt)).toEqual([...rows.map((r) => r.createdAt)].sort((a, b) => b - a));
    expect(JSON.stringify(rows)).not.toContain(S.hiddenJobId);
  });

  it("prints the umbrella's name (F147) while still joining on the stored one", () => {
    const rows = toRunRows(
      [job({ clientAgentId: "clientAgent_1" })],
      false,
      [
        {
          id: "clientAgent_1",
          agentKey: "karos-x-agent-v2",
          customAgentId: "ca_x",
          displayName: "Your X agent",
          platform: "x",
          launchState: "live",
        },
      ],
    );
    expect(rows[0].label).toBe("Your X agent");
    expect(rows[0].agentName).toBe("Karos X Agent");
  });
});

/* ═════════════════════════════ toSummary ═════════════════════════════ */

describe("toSummary — the client-safe agent summary", () => {
  it("carries exactly the declared fields, and neither the manifest line nor the prompt", () => {
    const summary = toSummary(agent());
    expect(keysOf(summary)).toEqual(sorted(SUMMARY_KEYS));
    const payload = JSON.stringify(summary);
    expect(payload).not.toContain(S.manifestDescription);
    expect(payload).not.toContain(S.agentInstructions);
    expect(payload).not.toContain("skills/x");
  });

  it("sends no blurb at all for an agent nobody has curated a line for", () => {
    // The falsifying half of the assertion above, which on `agent()` alone
    // cannot fail: that fixture always carries a curated clientBlurb, and a
    // curated line wins outright, so the manifest stays out of the payload
    // whether or not `description` sits behind it as a fallback. With nothing
    // curated there is nothing for the manifest to lose to, and F127 becomes a
    // question this file can actually answer.
    const bare = agent();
    delete bare.clientBlurb;
    const summary = toSummary(bare);
    expect(summary.clientBlurb).toBeNull();
    expect(keysOf(summary)).toEqual(sorted(SUMMARY_KEYS));
    expect(JSON.stringify(summary)).not.toContain(S.manifestDescription);
  });
});

/* ═══════════════════════════ toScheduleRows ══════════════════════════ */

describe("toScheduleRows — the weekly-pace projection", () => {
  it("gives a client exactly the declared keys and staff the standing instruction on top", () => {
    const [clientRow] = toScheduleRows([scheduled()], true);
    expect(keysOf(clientRow)).toEqual(sorted(SCHEDULE_ROW_CLIENT_KEYS));

    const [staffRow] = toScheduleRows([scheduled()], false);
    expect(keysOf(staffRow)).toEqual(
      sorted([...SCHEDULE_ROW_CLIENT_KEYS, ...SCHEDULE_ROW_STAFF_ONLY_KEYS]),
    );
  });

  it("withholds the standing instruction from a client and keeps it for staff", () => {
    const clientRows = toScheduleRows([scheduled()], true);
    expect("prompt" in clientRows[0]).toBe(false);
    expect(JSON.stringify(clientRows)).not.toContain(S.standingInstruction);
    expect(JSON.stringify(toScheduleRows([scheduled()], false))).toContain(S.standingInstruction);
  });

  it("collapses a raw scheduler refusal for a client and leaves it raw for staff", () => {
    const clientRows = toScheduleRows([scheduled()], true);
    expect(JSON.stringify(clientRows)).not.toContain(S.internalError);
    expect(clientRows[0].lastError).toBe(
      "This agent could not start on its last scheduled run. Your Karos team can unblock it.",
    );
    expect(toScheduleRows([scheduled()], false)[0].lastError).toBe(S.internalError);
  });

  it("still passes a refusal that was written for the client to read", () => {
    // The over-broad-redaction half: a blanket rewrite would swallow the one
    // line the client can act on, and the card would stop linking the intake.
    const setupRefusal = "Set up the Reddit agent data before this agent can run.";
    expect(toScheduleRows([scheduled({ lastError: setupRefusal })], true)[0].lastError).toBe(
      setupRefusal,
    );
  });

  it("keeps the last fire's job id, instant and author off both viewers' rows", () => {
    // The fire timestamps and the last job id are the batch's own trail. They
    // are absent from the row for BOTH viewers — a structural property of the
    // projection, not a viewer split.
    for (const viewerIsClient of [true, false]) {
      const payload = JSON.stringify(toScheduleRows([scheduled()], viewerIsClient));
      expect(payload).not.toContain(S.lastJobId);
      expect(payload).not.toContain(String(scheduled().lastRunAt));
      expect(payload).not.toContain(S.staffUid);
    }
  });

  /**
   * Exhaustive over PlannedRunCadence — the card is a POSTS-PER-WEEK surface.
   *
   * `daily: false` was this table's answer, and it was the defect written down
   * as a specification: the calendar modal offers Daily, `createPlannedRunAction`
   * stores it, the cron fires and bills it, and the client's card showed no
   * pace, no next run, no Pause and a "Start posting" button. A daily row is
   * seven posting days a week, which `postsPerWeek` states exactly.
   *
   * `once` and `monthly` stay out for a reason the row can carry: neither has a
   * posts-per-week figure, and `ClientAgentScheduleRow` has no cadence field to
   * say so in — quoting a monthly schedule as one-a-week would overstate its
   * cost more than fourfold in the pace dialog. Stated as a residual on
   * `weeklyFireDays`, not as a design.
   */
  const CADENCE_REACHES_THE_CARD: Record<PlannedRunCadence, boolean> = {
    once: false,
    daily: true,
    weekly: true,
    monthly: false,
  };

  it.each(Object.keys(CADENCE_REACHES_THE_CARD) as PlannedRunCadence[])(
    "cadence %s reaches the card only when the projection says so",
    (cadence) => {
      const expected = CADENCE_REACHES_THE_CARD[cadence];
      const runs = [scheduled({ id: S.hiddenJobId, cadence })];
      for (const viewerIsClient of [true, false]) {
        expect(JSON.stringify(toScheduleRows(runs, viewerIsClient)).includes(S.hiddenJobId)).toBe(
          expected,
        );
      }
    },
  );

  /** Exhaustive over the stored status union, including the mapped output. */
  const STATUS_PROJECTION: Record<PlannedScheduledRun["status"], "active" | "paused" | null> = {
    active: "active",
    paused: "paused",
    completed: null, // filtered out entirely
  };

  it.each(Object.keys(STATUS_PROJECTION) as Array<PlannedScheduledRun["status"]>)(
    "status %s maps to the card's own two-state word (or to no row at all)",
    (status) => {
      const expected = STATUS_PROJECTION[status];
      const rows = toScheduleRows([scheduled({ status })], true);
      expect(rows.map((r) => r.status)).toEqual(expected ? [expected] : []);
    },
  );

  it("counts the client's own pace, and keeps the multiplier the dialog quotes", () => {
    const [row] = toScheduleRows([scheduled({ weekdays: [1, 3, 5], outputsPerRun: 3 })], true);
    expect(row.postsPerWeek).toBe(3);
    expect(row.outputsPerRun).toBe(3);
    const bare = scheduled();
    delete bare.weekdays;
    delete bare.outputsPerRun;
    expect(toScheduleRows([bare], true)[0]).toMatchObject({ postsPerWeek: 1, outputsPerRun: 1 });
  });

  it("a client's rows are a field-wise subset of staff's for every named class", () => {
    // Classes covered — named rather than claimed to be the whole input space:
    // an active weekly row with a raw refusal, a paused one with no refusal, a
    // single-fire-per-week row, a row written before weekdays existed, and a
    // daily row.
    //
    // ONE AGENT EACH, deliberately. The projection now returns one governing
    // row per agent (selectAgentSchedules), so five rows sharing a
    // customAgentId would be one row out and this would be asserting the
    // subset property over a single shape. The de-duplication itself is pinned
    // in agent-schedule-selection.test.ts.
    const bare = scheduled({ id: "sched_legacy", customAgentId: "ca_legacy" });
    delete bare.weekdays;
    const runs = [
      scheduled({ id: "sched_active_refused", customAgentId: "ca_refused" }),
      scheduled({
        id: "sched_paused",
        customAgentId: "ca_paused",
        status: "paused",
        lastError: null,
        lastErrorAt: null,
      }),
      scheduled({ id: "sched_one_day", customAgentId: "ca_one_day", weekdays: [2] }),
      bare,
      scheduled({ id: "sched_daily", customAgentId: "ca_daily", cadence: "daily" }),
    ];
    const clientRows = toScheduleRows(runs, true);
    const staffRows = toScheduleRows(runs, false);
    // `lastError` is rewritten in place for a client — skipped here and pinned
    // by "collapses a raw scheduler refusal…" above.
    expect(expectClientFieldsSubsetOfStaff(clientRows, staffRows, ["lastError"])).toBe(runs.length);
  });
});

/* ══════════════════════ scheduleZonesByAgent (F108) ═════════════════ */

describe("scheduleZonesByAgent", () => {
  it("indexes the firing zone of every recurring schedule that has not completed", () => {
    const zones = scheduleZonesByAgent([
      scheduled({ id: "s1", customAgentId: "ca_x", timeZone: NZ }),
      // Paused is NOT excluded, and the name above says so: a paused schedule's
      // strip is still read, and it fires again the moment someone resumes it,
      // so reading its days in the container's zone would shift them by a day.
      scheduled({ id: "s2", customAgentId: "ca_paused", status: "paused", timeZone: NZ }),
      scheduled({ id: "s3", customAgentId: "ca_done", status: "completed", timeZone: NZ }),
      // A DAILY row's zone was dropped, so the one agent posting every day drew
      // its week strip in the CONTAINER's zone (UTC in production) while every
      // weekly agent used its own — the F108 shift, on the only agent whose
      // strip changes every day.
      scheduled({ id: "s4", customAgentId: "ca_daily", cadence: "daily", timeZone: NZ }),
      // Monthly keeps a zone even though it has no posts-per-week figure: the
      // strip still has to be drawn in some zone, and this is the agent's own.
      scheduled({ id: "s5", customAgentId: "ca_monthly", cadence: "monthly", timeZone: NZ }),
      // One-off runs are bookings, not a pace, and hold no strip.
      scheduled({ id: "s6", customAgentId: "ca_once", cadence: "once", timeZone: NZ }),
    ]);
    expect([...zones.entries()]).toEqual([
      ["ca_x", NZ],
      ["ca_paused", NZ],
      ["ca_daily", NZ],
      ["ca_monthly", NZ],
    ]);
  });

  it("records nothing for a schedule written before the zone field existed", () => {
    const legacy = scheduled();
    delete legacy.timeZone;
    expect(scheduleZonesByAgent([legacy]).has("ca_x")).toBe(false);
  });
});

/* ═════════════════════════ toClientAgentRows ════════════════════════ */

describe("toClientAgentRows — the card projection", () => {
  it("gives a client viewer exactly the declared key set", async () => {
    upcomingSlotsMock.mockResolvedValue([slot()]);
    const rows = await toClientAgentRows(cardArgs());
    expect(rows).toHaveLength(1);
    expect(keysOf(rows[0])).toEqual(sorted(CARD_ROW_KEYS));
  });

  it("renders nothing for an umbrella whose bound agent is gone or disabled", async () => {
    const gone = await toClientAgentRows(
      cardArgs({ umbrellas: [umbrella({ displayName: S.hiddenJobId })], agentsById: new Map() }),
    );
    expect(gone).toEqual([]);

    const disabled = await toClientAgentRows(
      cardArgs({
        umbrellas: [umbrella({ displayName: S.hiddenJobId })],
        agentsById: new Map([["ca_x", agent({ enabled: false })]]),
      }),
    );
    expect(disabled).toEqual([]);
    expect(JSON.stringify(disabled)).not.toContain(S.hiddenJobId);
  });

  /* ───────────────── the A3 churn guard ───────────────── */

  it("only TODAY's option texts cross the boundary, not the rest of the batch", async () => {
    upcomingSlotsMock.mockResolvedValue([
      slot({ dateKey: TODAY_LA, status: "generated", assetId: "asset_batch", optionRefs: TODAY_REFS }),
      slot({
        dateKey: TOMORROW_LA,
        status: "generated",
        assetId: "asset_batch",
        optionRefs: [FUTURE_REF],
      }),
    ]);
    getAssetMock.mockResolvedValue(batchAsset());

    const rows = await toClientAgentRows(cardArgs());
    const payload = JSON.stringify(rows);

    // Today's three arrive…
    expect(rows[0].today?.options).toHaveLength(3);
    expect(keysOf(rows[0].today!)).toEqual(sorted(TODAY_KEYS));
    // …each carrying the declared option fields and nothing else. Asserted per
    // ELEMENT, not on the wrapper: the wrapper's key set is unchanged by a
    // field added to every option inside it.
    for (const option of rows[0].today!.options) {
      expect(keysOf(option)).toEqual(sorted(OPTION_KEYS));
    }
    expect(payload).toContain(S.todayDraft);
    // …and the draft sitting in the SAME batch file for another day does not.
    expect(payload).not.toContain(S.futureDraft);
    // The closed question behind it: is tomorrow's batch even read?
    expect(getAssetMock).toHaveBeenCalledTimes(1);
    expect(getAssetMock).toHaveBeenCalledWith("asset_batch");
  });

  /* ───────────────── personal-seat filtering ───────────────── */

  describe("today's options — filtered by the viewer's own seat", () => {
    const MULTI_SEAT_BATCH = [
      "# Account 1 · Company page @getkaros",
      "## Avenue 1 · Playbook",
      "> The company's own draft.",
      "# Account 2 · Albert Kattan",
      "## Avenue 1 · Playbook",
      "> Albert's personal draft.",
    ].join("\n");
    const REFS = ["Company page @getkaros · Avenue 1 · Playbook", "Albert Kattan · Avenue 1 · Playbook"];
    const SEATS = [
      { id: "seat-albert", clientId: "c1", name: "Albert Kattan", slug: "albert-kattan", createdBy: "u1", createdAt: 0, updatedAt: 0 },
    ];

    beforeEach(() => {
      upcomingSlotsMock.mockResolvedValue([
        slot({ status: "generated", assetId: "asset_batch", optionRefs: REFS }),
      ]);
      getAssetMock.mockResolvedValue({ ...batchAsset(), content: MULTI_SEAT_BATCH });
      listClientSeatsMock.mockResolvedValue(SEATS);
    });

    it("gives a plain team login only its own seat's option plus the company's", async () => {
      const [row] = await toClientAgentRows(cardArgs({ viewerSeatId: "seat-albert" }));
      expect(row.today?.options).toHaveLength(2);
    });

    it("gives a shared/company login (no seat) only the company's option", async () => {
      const [row] = await toClientAgentRows(cardArgs({ viewerSeatId: undefined }));
      expect(row.today?.options).toHaveLength(1);
      expect(JSON.stringify(row.today)).not.toContain("Albert");
    });

    it("never drops another seat's option for staff", async () => {
      const [row] = await toClientAgentRows(cardArgs({ viewerIsStaff: true }));
      expect(row.today?.options).toHaveLength(2);
    });

    it("never drops another seat's option for a client's own group admin", async () => {
      const [row] = await toClientAgentRows(cardArgs({ viewerSeatId: undefined, viewerIsGroupAdmin: true }));
      expect(row.today?.options).toHaveLength(2);
    });
  });

  it("a future day that already has content projects identically to an empty one", async () => {
    // The churn rule as a single comparison: two days ahead, one fully
    // generated with an asset, a job and three assigned candidates, one bare
    // intent. If a client can tell them apart, the batch is visible.
    upcomingSlotsMock.mockResolvedValue([
      slot({ dateKey: TOMORROW_LA, status: "planned" }),
      slot({
        dateKey: DAY_AFTER_LA,
        status: "generated",
        assetId: "asset_batch",
        jobId: S.hiddenJobId,
        optionRefs: TODAY_REFS,
      }),
    ]);
    getAssetMock.mockResolvedValue(batchAsset());

    const [row] = await toClientAgentRows(cardArgs());
    const [bare, generated] = row.week;
    expect({ ...bare, dateKey: "", slotId: "" }).toEqual({ ...generated, dateKey: "", slotId: "" });

    const payload = JSON.stringify(row);
    expect(payload).not.toContain(S.hiddenJobId);
    expect(payload).not.toContain("asset_batch");
    expect(payload).not.toContain(FUTURE_REF);
    // Neither day is today, so no options were read at all.
    expect(getAssetMock).not.toHaveBeenCalled();
  });

  it("reads and offers nothing for today when the agent's next generated day is later", async () => {
    // The day comparison, asked where it can actually fail. Every other options
    // fixture happens to list TODAY's slot first, so a projection that took
    // `slots[0]` instead of finding today's dateKey would still look right on
    // all of them. Here the agent does not fire today — the ordinary shape for
    // a three-times-a-week schedule — and the only generated day is two out,
    // so taking the first slot would hand the client a future day's batch.
    upcomingSlotsMock.mockResolvedValue([
      slot({
        dateKey: DAY_AFTER_LA,
        status: "generated",
        assetId: "asset_batch",
        optionRefs: [FUTURE_REF],
      }),
    ]);
    getAssetMock.mockResolvedValue(batchAsset());

    const [row] = await toClientAgentRows(cardArgs());
    expect(row.week.map((d) => d.dateKey)).toEqual([DAY_AFTER_LA]);
    expect(row.today).toBeNull();
    // The closed question behind it: is that day's batch even read?
    expect(getAssetMock).not.toHaveBeenCalled();

    const payload = JSON.stringify(row);
    expect(payload).not.toContain(S.futureDraft);
    expect(payload).not.toContain(FUTURE_REF);
    expect(payload).not.toContain("asset_batch");
  });

  /** Exhaustive over AgentSlot["status"]: a new one cannot slip past the strip. */
  const ALL_SLOT_STATUSES: Record<AgentSlot["status"], true> = {
    planned: true,
    generated: true,
    posted: true,
    skipped: true,
  };

  it.each(Object.keys(ALL_SLOT_STATUSES) as Array<AgentSlot["status"]>)(
    "a %s day projects to exactly the declared day fields, and never its status",
    async (status) => {
      upcomingSlotsMock.mockResolvedValue([
        slot({ dateKey: TOMORROW_LA, status, assetId: "asset_batch", jobId: S.hiddenJobId }),
      ]);
      const [row] = await toClientAgentRows(cardArgs());
      expect(keysOf(row.week[0])).toEqual(sorted(WEEK_ENTRY_KEYS));
      expect(row.week[0].label).toBe("Daily post");
      const payload = JSON.stringify(row.week);
      expect(payload).not.toContain(status);
      expect(payload).not.toContain(S.hiddenJobId);
      expect(payload).not.toContain("asset_batch");
    },
  );

  it("labels every options-mode day with the same constant, batch shape or not", async () => {
    upcomingSlotsMock.mockResolvedValue([
      slot({ dateKey: TODAY_LA, optionRefs: TODAY_REFS, status: "generated" }),
      slot({ dateKey: TOMORROW_LA }),
      slot({ dateKey: DAY_AFTER_LA, optionRefs: [FUTURE_REF] }),
    ]);
    const [row] = await toClientAgentRows(cardArgs());
    expect(row.week.map((d) => d.label)).toEqual(["Daily post", "Daily post", "Daily post"]);
    // "pick of 3" would state the batch shape and promise a picker.
    expect(JSON.stringify(row.week)).not.toContain("pick of");
  });

  it("a single-mode day prints its template's name and reads no batch", async () => {
    // TODAY carries an asset and three assigned candidates, so the options
    // branch would have everything it needs — the only thing stopping it is
    // that this umbrella does not sell a daily pick.
    upcomingSlotsMock.mockResolvedValue([
      slot({
        dateKey: TODAY_LA,
        kind: "single",
        templateKey: "playbook",
        status: "generated",
        assetId: "asset_batch",
        optionRefs: TODAY_REFS,
      }),
      slot({ dateKey: TOMORROW_LA, kind: "single", templateKey: "playbook" }),
    ]);
    getAssetMock.mockResolvedValue(batchAsset());
    const [row] = await toClientAgentRows(
      cardArgs({ umbrellas: [umbrella({ slotMode: "single" })] }),
    );
    expect(row.week.map((d) => d.label)).toEqual(["Playbook", "Playbook"]);
    expect(row.today).toBeNull();
    expect(getAssetMock).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).not.toContain(S.todayDraft);
  });

  it("humanises the picked direction rather than shipping the lab's lane name", async () => {
    upcomingSlotsMock.mockResolvedValue([
      slot({
        dateKey: TODAY_LA,
        status: "generated",
        optionRefs: TODAY_REFS,
        optionPick: {
          optionRef: "Acme · Avenue 2 · News-reaction (live)",
          pickedAt: NOW,
          pickedBy: VIEWER_UID,
          edited: false,
        },
      }),
    ]);
    const [row] = await toClientAgentRows(cardArgs());
    expect(row.today).toEqual({
      slotId: `slot_${TODAY_LA}`,
      options: [],
      pickedDirection: "Reacting to the news · live",
    });
    // The pick branch resolves nothing, so no raw lane vocabulary is on the wire.
    const payload = JSON.stringify(row);
    expect(payload).not.toContain("Avenue");
    expect(payload).not.toContain("News-reaction");
  });

  // The scheduled half of this rule is the run-type table below, not this test.
  it("does not announce a staff-fired run on a client's card", async () => {
    upcomingSlotsMock.mockResolvedValue([slot()]);
    const staffPress = job({
      id: S.hiddenJobId,
      clientAgentId: "clientAgent_1",
      runType: "manual_template",
      status: "running",
      createdBy: "uid_someone_at_karos",
      templateKey: "playbook",
    });
    const clientRows = await toClientAgentRows(cardArgs({ jobs: [staffPress] }));
    expect(clientRows[0].activeRun).toBeNull();
    expect(JSON.stringify(clientRows)).not.toContain(S.hiddenJobId);

    // Staff reading the same page do see it — an over-broad scoping that hid it
    // from everyone must go red here.
    const staffRows = await toClientAgentRows(
      cardArgs({ jobs: [staffPress], viewerIsClient: false, viewerIsStaff: true }),
    );
    expect(staffRows[0].activeRun).toEqual({
      id: S.hiddenJobId,
      status: "running",
      templateName: "Playbook",
    });
  });

  /** Exhaustive over JobRunType: only a press counts, never a fire. */
  const ACTIVE_RUN_RUN_TYPES: Record<JobRunType, boolean> = {
    manual_template: true,
    scheduled: false,
    launch: false,
    manual: false,
    test: false,
  };

  it.each(Object.keys(ACTIVE_RUN_RUN_TYPES) as JobRunType[])(
    "an in-flight %s run is acknowledged only when the card owns it",
    async (runType) => {
      upcomingSlotsMock.mockResolvedValue([slot()]);
      const rows = await toClientAgentRows(
        cardArgs({
          jobs: [
            job({
              id: S.hiddenJobId,
              clientAgentId: "clientAgent_1",
              runType,
              status: "running",
              createdBy: VIEWER_UID,
            }),
          ],
        }),
      );
      const expected = ACTIVE_RUN_RUN_TYPES[runType];
      expect(rows[0].activeRun !== null).toBe(expected);
      expect(JSON.stringify(rows).includes(S.hiddenJobId)).toBe(expected);
    },
  );

  /** Exhaustive over JobStatus: only a run that has not landed is in flight. */
  const ACTIVE_RUN_STATUSES: Record<JobStatus, boolean> = {
    queued: true,
    running: true,
    review: false,
    approved: false,
    delivered: false,
    failed: false,
    cancelled: false,
    // Terminal: the run finished, it just produced nothing. Not in flight.
    held: false,
  };

  it.each(Object.keys(ACTIVE_RUN_STATUSES) as JobStatus[])(
    "a %s template run counts as in flight only while it has not landed",
    async (status) => {
      upcomingSlotsMock.mockResolvedValue([slot()]);
      const rows = await toClientAgentRows(
        cardArgs({
          jobs: [
            job({
              id: S.hiddenJobId,
              clientAgentId: "clientAgent_1",
              runType: "manual_template",
              status,
              createdBy: VIEWER_UID,
            }),
          ],
        }),
      );
      expect(JSON.stringify(rows).includes(S.hiddenJobId)).toBe(ACTIVE_RUN_STATUSES[status]);
    },
  );

  /* ───────────────── RSC redaction ───────────────── */

  it("collapses a raw launch failure for a client and keeps it raw for staff", async () => {
    const failed = [umbrella({ launchState: "launch_failed", launchError: S.internalError })];
    const clientRows = await toClientAgentRows(cardArgs({ umbrellas: failed }));
    expect(JSON.stringify(clientRows)).not.toContain(S.internalError);
    expect(clientRows[0].launchError).toBe(
      "This agent could not start on its last scheduled run. Your Karos team can unblock it.",
    );

    const staffRows = await toClientAgentRows(
      cardArgs({ umbrellas: failed, viewerIsClient: false, viewerIsStaff: true }),
    );
    expect(staffRows[0].launchError).toBe(S.internalError);
  });

  it("prints the curated line, and keeps the agent's prompt out of the payload, either viewer", async () => {
    upcomingSlotsMock.mockResolvedValue([slot()]);
    for (const viewerIsClient of [true, false]) {
      const rows = await toClientAgentRows(cardArgs({ viewerIsClient }));
      const payload = JSON.stringify(rows);
      expect(payload).not.toContain(S.manifestDescription);
      expect(payload).not.toContain(S.agentInstructions);
      expect(rows[0].blurb).toBe("One post a day for your X account, in your voice.");
    }
  });

  it("falls back to the keyed line, never to the lab manifest, when nothing is curated", async () => {
    // THE CD-G2 RULE, which the assertion above cannot see. That one runs on
    // `agent()`, which always carries a curated clientBlurb, and the curated
    // line wins outright — so the manifest is absent from its payload whether
    // or not a third rung back to `description` exists. Re-adding that rung
    // leaves it green.
    //
    // The rule is "curated first, then the keyed fallback, and no third rung
    // back to the manifest". Only an agent with nothing curated reaches the
    // rung being forbidden, so that is the case asserted here: the second rung
    // must answer, and the manifest must still be absent from the whole
    // payload — this agent's `description` is the sentinel, so a rung that
    // preferred it over the keyed line would put it on the wire.
    const bare = agent();
    delete bare.clientBlurb;
    upcomingSlotsMock.mockResolvedValue([slot()]);

    for (const viewerIsClient of [true, false]) {
      const rows = await toClientAgentRows(
        cardArgs({ viewerIsClient, agentsById: new Map([["ca_x", bare]]) }),
      );
      expect(rows[0].blurb).toBe(X_AGENT_KEYED_BLURB);
      const payload = JSON.stringify(rows);
      expect(payload).not.toContain(S.manifestDescription);
      expect(payload).not.toContain(S.agentInstructions);
    }
  });

  /**
   * Exhaustive over ClientAgentLaunchState: a new state must decide whether the
   * registry crosses to a client.
   */
  const TEMPLATES_CROSS_TO_A_CLIENT: Record<ClientAgentLaunchState, boolean> = {
    not_launched: false,
    launching: false,
    curating: false,
    launch_failed: false,
    live: true,
  };

  it.each(Object.keys(TEMPLATES_CROSS_TO_A_CLIENT) as ClientAgentLaunchState[])(
    "an unconfirmed registry stays server-side while the umbrella is %s",
    async (launchState) => {
      upcomingSlotsMock.mockResolvedValue([slot()]);
      const umbrellas = [umbrella({ launchState })];
      const expected = TEMPLATES_CROSS_TO_A_CLIENT[launchState];

      const clientRows = await toClientAgentRows(cardArgs({ umbrellas }));
      expect(clientRows[0].templates).toHaveLength(expected ? 1 : 0);
      expect(JSON.stringify(clientRows).includes(S.templateRationale)).toBe(expected);

      // Staff are confirming that registry — they must always receive it.
      const staffRows = await toClientAgentRows(
        cardArgs({ umbrellas, viewerIsClient: false, viewerIsStaff: true }),
      );
      expect(staffRows[0].templates).toHaveLength(1);
      expect(JSON.stringify(staffRows)).toContain(S.templateRationale);
    },
  );

  it("names note and feedback authors without their uids, for either viewer", async () => {
    upcomingSlotsMock.mockResolvedValue([
      slot({
        dateKey: TOMORROW_LA,
        note: {
          text: "Mention the new pricing page.",
          authorUid: S.staffUid,
          authorName: "Albert",
          authorRole: "staff",
          createdAt: NOW - 1000,
          consumedAt: NOW,
        },
      }),
    ]);
    listFeedbackMock.mockResolvedValue([feedback()]);

    for (const viewerIsClient of [true, false]) {
      const [row] = await toClientAgentRows(cardArgs({ viewerIsClient, viewerIsStaff: !viewerIsClient }));
      expect(keysOf(row.week[0].note!)).toEqual(sorted(WEEK_NOTE_KEYS));
      expect(keysOf(row.feedback[0])).toEqual(sorted(FEEDBACK_ROW_KEYS));
      expect(row.week[0].note!.authorName).toBe("Albert");
      expect(row.feedback[0].authorName).toBe("Albert");
      expect(JSON.stringify(row)).not.toContain(S.staffUid);
    }
  });

  it("falls back to a side, never to a uid, for rows written before names were stored", async () => {
    const legacyNote = {
      text: "Mention the new pricing page.",
      authorUid: S.staffUid,
      authorRole: "staff" as const,
      createdAt: NOW - 1000,
    };
    upcomingSlotsMock.mockResolvedValue([slot({ dateKey: TOMORROW_LA, note: legacyNote })]);
    const legacyStaff = feedback({ id: "fb_legacy_staff" });
    delete legacyStaff.createdByName;
    const legacyClient = feedback({
      id: "fb_legacy_client",
      creatorRole: "client",
      createdBy: "uid_a_client_person",
    });
    delete legacyClient.createdByName;
    listFeedbackMock.mockResolvedValue([legacyStaff, legacyClient]);

    const [row] = await toClientAgentRows(cardArgs());
    expect(row.week[0].note!.authorName).toBe("Karos");
    expect(row.feedback.map((f) => f.authorName)).toEqual(["Karos", "Your team"]);
    const payload = JSON.stringify(row);
    expect(payload).not.toContain(S.staffUid);
    expect(payload).not.toContain("uid_a_client_person");
  });

  it("labels a note by viewer, not by role (B5)", async () => {
    upcomingSlotsMock.mockResolvedValue([
      slot({
        dateKey: TOMORROW_LA,
        note: {
          text: "Mention the new pricing page.",
          authorUid: VIEWER_UID,
          authorName: "Albert",
          authorRole: "staff",
          createdAt: NOW - 1000,
        },
      }),
    ]);
    const [mine] = await toClientAgentRows(cardArgs());
    expect(mine.week[0].note!.authorName).toBe("You");
    const [theirs] = await toClientAgentRows(cardArgs({ viewerUid: "uid_someone_else" }));
    expect(theirs.week[0].note!.authorName).toBe("Albert");
  });

  /* ───────── projected VALUES, not just their keys ───────── */

  /**
   * Three fields the key-set tripwire above covers and nothing checked the
   * VALUE of, so an inversion of any of them would ship green while telling a
   * client something untrue. A key set answers "is this field allowed on the
   * wire"; it cannot answer "is what it says right".
   */

  it("says a failed launch was refunded only when the umbrella records that it was", async () => {
    // Coerced with `=== true`, and the coercion is the point: `launchRefunded`
    // is optional AND nullable, and either loose reading of it ("not false",
    // "not null") tells a client their launch credits came back when the charge
    // still stands.
    const cases: Array<[boolean | null | undefined, boolean]> = [
      [undefined, false], // never written — no refund happened
      [null, false], // written, then cleared
      [false, false],
      [true, true],
    ];
    for (const [stored, expected] of cases) {
      const failed = umbrella({ launchState: "launch_failed" });
      if (stored !== undefined) failed.launchRefunded = stored;
      const [row] = await toClientAgentRows(cardArgs({ umbrellas: [failed] }));
      expect(row.launchRefunded).toBe(expected);
    }
  });

  it("marks a day's note applied only once a run has consumed it", async () => {
    // Derived from `consumedAt`, which is optional and nullable like the flag
    // above. Inverted, the card tells whoever wrote the note that the agent
    // already acted on it — the one thing that would stop them re-sending it.
    const note = (consumedAt: number | null | undefined) => ({
      text: "Mention the new pricing page.",
      authorUid: S.staffUid,
      authorName: "Albert",
      authorRole: "staff" as const,
      createdAt: NOW - 1000,
      ...(consumedAt === undefined ? {} : { consumedAt }),
    });
    const cases: Array<[number | null | undefined, boolean]> = [
      [undefined, false],
      [null, false],
      [NOW, true],
    ];
    for (const [consumedAt, expected] of cases) {
      upcomingSlotsMock.mockResolvedValue([slot({ dateKey: TOMORROW_LA, note: note(consumedAt) })]);
      const [row] = await toClientAgentRows(cardArgs());
      expect(row.week[0].note!.applied).toBe(expected);
    }
  });

  it("hands a card the pace row of its own agent, and null when there is none", async () => {
    // Joined by customAgentId. A miss projects `null` silently, and the pace
    // dialog then opens on an agent that has a weekly schedule with no schedule
    // to show — so the null and the hit both need asserting.
    const paceRow = toScheduleRows([scheduled()], true)[0];
    expect(paceRow.agentId).toBe("ca_x"); // the join key, from the fixture

    const [withPace] = await toClientAgentRows(cardArgs({ scheduleRows: [paceRow] }));
    expect(withPace.schedule).toEqual(paceRow);

    const [otherAgent] = await toClientAgentRows(
      cardArgs({ scheduleRows: [{ ...paceRow, agentId: "ca_someone_else" }] }),
    );
    expect(otherAgent.schedule).toBeNull();

    const [none] = await toClientAgentRows(cardArgs({ scheduleRows: [] }));
    expect(none.schedule).toBeNull();
  });

  it("lets staff edit any feedback row and a client only their own", async () => {
    listFeedbackMock.mockResolvedValue([
      feedback({ id: "fb_theirs", createdBy: S.staffUid }),
      feedback({ id: "fb_mine", createdBy: VIEWER_UID, createdByName: "Dana", creatorRole: "client" }),
    ]);
    upcomingSlotsMock.mockResolvedValue([slot()]);

    const [asClient] = await toClientAgentRows(cardArgs());
    expect(asClient.feedback.map((f) => f.editable)).toEqual([false, true]);

    const [asStaff] = await toClientAgentRows(
      cardArgs({ viewerIsClient: false, viewerIsStaff: true }),
    );
    expect(asStaff.feedback.map((f) => f.editable)).toEqual([true, true]);
  });

  /* ───────────────── the viewer split, asked once ───────────────── */

  it("a client's row is a field-wise subset of staff's for every named class", async () => {
    // Classes covered — named, not claimed to be the whole input space: a live
    // options umbrella with a note and an in-flight staff press, a live
    // single-mode umbrella with templates, a curating umbrella carrying
    // unconfirmed rationales, a failed launch with a raw internal error, and an
    // unlaunched umbrella. `viewerIsClient` is the ONLY input that varies; the
    // uid, the staff flag and the balance are held fixed so the answer is about
    // the viewer split and nothing else.
    upcomingSlotsMock.mockResolvedValue([
      slot({
        dateKey: TOMORROW_LA,
        note: {
          text: "Mention the new pricing page.",
          authorUid: S.staffUid,
          authorName: "Albert",
          authorRole: "staff",
          createdAt: NOW - 1000,
        },
      }),
    ]);
    listFeedbackMock.mockResolvedValue([feedback()]);

    const umbrellas: ClientAgent[] = [
      umbrella({ id: "u_live_options" }),
      umbrella({ id: "u_live_single", slotMode: "single", customAgentId: "ca_single" }),
      umbrella({ id: "u_curating", launchState: "curating", customAgentId: "ca_curating" }),
      umbrella({
        id: "u_failed",
        launchState: "launch_failed",
        launchError: S.internalError,
        customAgentId: "ca_failed",
      }),
      umbrella({ id: "u_fresh", launchState: "not_launched", customAgentId: "ca_fresh" }),
    ];
    const agentsById = new Map(
      umbrellas.map((u) => [u.customAgentId, agent({ id: u.customAgentId })]),
    );
    const base = {
      umbrellas,
      agentsById,
      grantedAgentIds: new Set(agentsById.keys()),
      agentSetup: {},
      jobs: [
        job({
          id: "job_inflight",
          clientAgentId: "u_live_single",
          runType: "manual_template",
          status: "queued",
          createdBy: "uid_someone_at_karos",
          templateKey: "playbook",
        }),
      ],
      viewerUid: VIEWER_UID,
      viewerIsStaff: false,
      spendable: 5000,
      scheduleZones: new Map(),
    };

    const clientRows = await toClientAgentRows(cardArgs({ ...base, viewerIsClient: true }));
    const staffRows = await toClientAgentRows(cardArgs({ ...base, viewerIsClient: false }));

    // Each skipped key is pinned by a test of its own above: launchError by
    // "collapses a raw launch failure…", templates by "an unconfirmed registry
    // stays server-side…", activeRun by "does not announce a staff-fired run…".
    const matched = expectClientFieldsSubsetOfStaff(clientRows, staffRows, [
      "launchError",
      "templates",
      "activeRun",
    ]);
    expect(matched).toBe(umbrellas.length);
  });

  /* ───────────────── A5: the cost split ───────────────── */

  it("quotes no price to a viewer who never pays, and no balance either", async () => {
    const fresh = [umbrella({ launchState: "not_launched" })];
    const staffArgs = cardArgs({ umbrellas: fresh, viewerIsClient: false, viewerIsStaff: true });
    delete staffArgs.spendable;

    const [staffRow] = await toClientAgentRows(staffArgs);
    expect(staffRow.launchCost).toBeNull();
    expect(staffRow.runCost).toBeNull();
    expect("availableCredits" in staffRow).toBe(false);
    // …and no price can block them.
    expect(staffRow.gate.allowed).toBe(true);

    // A billable client gets the real numbers, and the gate that goes with them.
    const [clientRow] = await toClientAgentRows(
      cardArgs({ umbrellas: fresh, spendable: 10, creditBlockReasons: {} }),
    );
    expect(clientRow.launchCost).toBe(500);
    expect(clientRow.runCost).toBe(25);
    expect(clientRow.availableCredits).toBe(10);
    expect(clientRow.gate).toMatchObject({ allowed: false, code: "credits_short" });
  });

  it("falls back to the run baseline when the agent has no per-run price", async () => {
    const priceless = agent();
    delete priceless.creditCost;
    const [row] = await toClientAgentRows(
      cardArgs({ agentsById: new Map([["ca_x", priceless]]) }),
    );
    expect(row.runCost).toBe(25); // CREDIT_COSTS.customAgentRun
  });

  /* ───────────────── F25: a blocked press explains itself ───────────────── */

  it("a blocked launch gate arrives with the line that explains it, an open one with nothing", async () => {
    const blocked = await toClientAgentRows(
      cardArgs({
        umbrellas: [umbrella({ launchState: "not_launched" })],
        spendable: 10,
        creditBlockReasons: { ca_x: "Not enough credits — ask your Karos team for a top-up." },
      }),
    );
    expect(blocked[0].gate).toStrictEqual({
      allowed: false,
      code: "credits_short",
      reason: "Not enough credits — ask your Karos team for a top-up.",
    });

    // An allowed gate carries nothing to explain. Asserted on the KEY SET: a
    // `code: undefined` riding along satisfies toEqual and would put a raw
    // block enum in the payload the moment something started filling it in.
    upcomingSlotsMock.mockResolvedValue([]);
    const open = await toClientAgentRows(
      cardArgs({ umbrellas: [umbrella({ launchState: "not_launched" })] }),
    );
    expect(keysOf(open[0].gate)).toEqual(["allowed"]);
    expect(open[0].gate.allowed).toBe(true);
  });

  it("blocks a live umbrella's template run on the same intake, in the client's words", async () => {
    upcomingSlotsMock.mockResolvedValue([]);
    const rows = await toClientAgentRows(
      cardArgs({
        umbrellas: [umbrella({ slotMode: "single" })],
        agentSetup: {
          ca_x: {
            ready: false,
            standUpDone: true,
            href: "/clients/c1/x-agent",
            label: "X agent data",
            clientLabel: "Your X details",
          },
        },
      }),
    );
    expect(rows[0].templateGates.playbook).toStrictEqual({
      allowed: false,
      code: "setup_missing",
      reason: "Your X details are missing. This agent needs them before it can make a post.",
    });
    expect(rows[0].setupLabel).toBe("Your X details");
    // The operator's name for that page stays server-side.
    expect(JSON.stringify(rows)).not.toContain("X agent data");
  });

  it("opens a live template's gate with nothing to explain when it is runnable", async () => {
    upcomingSlotsMock.mockResolvedValue([]);
    const rows = await toClientAgentRows(cardArgs({ umbrellas: [umbrella({ slotMode: "single" })] }));
    expect(Object.keys(rows[0].templateGates)).toEqual(["playbook"]);
    expect(keysOf(rows[0].templateGates.playbook)).toEqual(["allowed"]);
    expect(rows[0].templateGates.playbook.allowed).toBe(true);
  });

  /* ───────────────── the week strip's day boundary (F108) ───────────────── */

  it("reads a week of the strip from the SCHEDULE's zone, not the container's", async () => {
    upcomingSlotsMock.mockResolvedValue([]);
    await toClientAgentRows(cardArgs({ scheduleZones: new Map([["ca_x", LA]]) }));
    expect(upcomingSlotsMock).toHaveBeenLastCalledWith("clientAgent_1", TODAY_LA, A_WEEK);

    // Same instant, a zone twelve hours further on: tomorrow there.
    await toClientAgentRows(cardArgs({ scheduleZones: new Map([["ca_x", NZ]]) }));
    expect(upcomingSlotsMock).toHaveBeenLastCalledWith("clientAgent_1", TOMORROW_LA, A_WEEK);
  });

  it("closes a day for notes once it has passed in the schedule's zone", async () => {
    upcomingSlotsMock.mockResolvedValue([slot({ dateKey: TODAY_LA })]);
    const [stillToday] = await toClientAgentRows(
      cardArgs({ scheduleZones: new Map([["ca_x", LA]]) }),
    );
    expect(stillToday.week[0].canNote).toBe(true);

    const [alreadyTomorrow] = await toClientAgentRows(
      cardArgs({ scheduleZones: new Map([["ca_x", NZ]]) }),
    );
    expect(alreadyTomorrow.week[0].canNote).toBe(false);
  });

  it("reads no plan and no feedback for an umbrella that is not live", async () => {
    const rows = await toClientAgentRows(
      cardArgs({ umbrellas: [umbrella({ launchState: "curating" })] }),
    );
    expect(upcomingSlotsMock).not.toHaveBeenCalled();
    expect(listFeedbackMock).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ week: [], feedback: [], today: null, runnable: null });
    expect(rows[0].templateGates).toEqual({});
  });
});
