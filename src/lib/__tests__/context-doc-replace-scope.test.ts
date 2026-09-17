import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE REPLACE DELETES WHAT ONBOARDING OWNS, AND NOTHING ELSE (2026-09-11).
 *
 * `replaceClientContextDocs` used to delete EVERY clientContextDocs row with
 * the client's id before writing the onboarding set. It runs on every intel
 * pipeline run — onboarding, Regenerate, onboarding completion, the schedule
 * cron — and that set has no `x-agent-profile` (the X agent's handle, off-limits
 * and how the client wants to come across; upsertAgentProfileScope) and no
 * `meeting-notes` (transcript ingest). Nothing writes either back, so one
 * Regenerate lost them for good. When this was fixed, production held
 * x-agent-profile rows for Sitti and Pitch by Deel and a meeting-notes row for
 * XO Digital.
 *
 * Driven against a fake Firestore rather than a mocked data layer: the
 * behaviour under test is the batch `replaceClientContextDocs` builds, so the
 * real function has to be what runs. The fake applies a batch only when it is
 * committed and counts every query, batch and unbatched write, so "one atomic
 * batch" is asserted here rather than assumed.
 */

type Row = Record<string, unknown>;
type Ref = { collection: string; id: string };

const fake = vi.hoisted(() => ({
  /** The clientContextDocs collection, by document id. */
  rows: new Map<string, Record<string, unknown>>(),
  nextId: 0,
  queries: 0,
  batches: [] as Array<{ deletes: number; sets: number; commits: number }>,
  /** Writes that bypassed a batch. The replace must make none. */
  unbatchedWrites: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/firebase/admin", () => {
  const onlyContextDocs = (ref: Ref) => {
    if (ref.collection !== "clientContextDocs") throw new Error(`unexpected write to ${ref.collection}`);
  };
  const query = (collection: string, filters: Array<[string, unknown]>) => ({
    where: (field: string, op: string, value: unknown) => {
      if (op !== "==") throw new Error(`unsupported op ${op}`);
      return query(collection, [...filters, [field, value]]);
    },
    get: async () => {
      fake.queries += 1;
      const docs =
        collection === "clientContextDocs"
          ? [...fake.rows]
              .filter(([, row]) => filters.every(([field, value]) => row[field] === value))
              .map(([id, row]) => ({ id, ref: { collection, id }, data: () => structuredClone(row) }))
          : [];
      return { docs, empty: docs.length === 0 };
    },
  });
  const db = {
    collection: (name: string) => ({
      ...query(name, []),
      doc: (id?: string): Ref => ({ collection: name, id: id ?? `new-${++fake.nextId}` }),
      add: async () => {
        fake.unbatchedWrites += 1;
      },
    }),
    batch: () => {
      const stats = { deletes: 0, sets: 0, commits: 0 };
      fake.batches.push(stats);
      const ops: Array<() => void> = [];
      return {
        delete(ref: Ref) {
          onlyContextDocs(ref);
          stats.deletes += 1;
          ops.push(() => void fake.rows.delete(ref.id));
        },
        set(ref: Ref, data: Row) {
          onlyContextDocs(ref);
          stats.sets += 1;
          ops.push(() => void fake.rows.set(ref.id, structuredClone(data)));
        },
        async commit() {
          stats.commits += 1;
          for (const op of ops) op();
        },
      };
    },
  };
  return { adminDb: () => db };
});
// `agentOnboardingDeps` loads these beside data.ts. The write half calls only
// `condenseDocs` (the model call, stubbed); the rest fail loudly if reached.
vi.mock("@/lib/agent-engine/dispatch-research-agents", () => ({
  dispatchOnboardingResearchAgents: () => {
    throw new Error("the write half dispatches nothing");
  },
}));
vi.mock("@/lib/agent-engine/client", () => ({
  getAgentEngineDeliverable: () => {
    throw new Error("the write half fetches no deliverable");
  },
}));
vi.mock("@/lib/intel/condense", () => ({
  condenseDocs: async (_client: unknown, docTypes: string[]) =>
    docTypes.map((docType) => ({ docType, content: `condensed ${docType}` })),
}));
vi.mock("@/lib/intel/brain", () => ({ RESEARCH_ENGINE_RULES: "", METRICS_RULES: "" }));

import { replaceClientContextDocs } from "@/lib/data";
import {
  CONTEXT_DOC_SET_CONTRACT,
  agentOnboardingDeps,
  writeContextDocsFromResearch,
} from "@/lib/intel/agent-onboarding";

const CLIENT_ID = "acme";
const OTHER_CLIENT_ID = "initech";
const EARLIER = 1_690_000_000_000;
const NOW = 1_700_000_000_000;

const pairOf = (row: { docType?: unknown; tier?: unknown }) => `${String(row.docType)}::${String(row.tier)}`;
const CONTRACT_PAIRS = CONTEXT_DOC_SET_CONTRACT.map(pairOf);

function stored(clientId: string, docType: string, tier: string, content: string): Row {
  return { clientId, docType, tier, content, version: 4, createdAt: EARLIER, updatedAt: EARLIER };
}

/** The X agent's identity narrative, as upsertAgentProfileScope renders it. */
const X_PROFILE: Row = stored(
  CLIENT_ID,
  "x-agent-profile",
  "internal-only",
  '<!-- STRUCTURED:{"company":{"handle":"@acme","offLimits":"Never discuss pricing","comeAcross":"Plain-spoken"},"seats":{}} -->\n\n' +
    "# x agent — onboarding profile\n\n## Company page\n- Handle: @acme\n- How they want to come across: Plain-spoken\n- Off-limits: Never discuss pricing\n",
);

/** Transcript ingest's running log, with a cached summary on it. */
const MEETING_NOTES: Row = {
  ...stored(
    CLIENT_ID,
    "meeting-notes",
    "internal-only",
    "# Meeting Notes & Signals\n\n_Auto-generated from transcripts. Read by the AI pipeline on regeneration._\n\n---\n\n" +
      "## Meeting Signal - 2026-09-02\n**Title:** Q4 planning\n",
  ),
  summary: ["Q4 planning call"],
  summaryVersion: 4,
};

/** What one pipeline run writes: a fresh row at every contract pair. */
function freshSet(): Row[] {
  return CONTEXT_DOC_SET_CONTRACT.map(({ docType, tier }) => ({
    clientId: CLIENT_ID,
    docType,
    tier,
    content: `fresh ${docType} (${tier})`,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }));
}

const replace = (docs: Row[]) => replaceClientContextDocs(CLIENT_ID, docs as never, CONTEXT_DOC_SET_CONTRACT);

const rowsOf = (clientId: string) => [...fake.rows].filter(([, row]) => row.clientId === clientId);
const oldRowIds = () => [...fake.rows.keys()].filter((id) => id.startsWith("old-"));

beforeEach(() => {
  fake.rows.clear();
  fake.nextId = 0;
  fake.queries = 0;
  fake.batches.length = 0;
  fake.unbatchedWrites = 0;

  // The previous run's set, one row per contract pair...
  for (const { docType, tier } of CONTEXT_DOC_SET_CONTRACT) {
    fake.rows.set(`old-${docType}-${tier}`, stored(CLIENT_ID, docType, tier, `old ${docType} (${tier})`));
  }
  // ...the two rows other writers own...
  fake.rows.set("x-profile", structuredClone(X_PROFILE));
  fake.rows.set("meeting-notes", structuredClone(MEETING_NOTES));
  // ...and another client, at a contract pair and outside one.
  fake.rows.set("other-brand-voice", stored(OTHER_CLIENT_ID, "brand-voice", "internal", "initech voice"));
  fake.rows.set("other-x-profile", stored(OTHER_CLIENT_ID, "x-agent-profile", "internal-only", "initech x profile"));
});

describe("replaceClientContextDocs — deletes only the pairs the producer owns", () => {
  it("keeps an x-agent-profile row and a meeting-notes row, byte for byte", async () => {
    await replace(freshSet());

    expect(fake.rows.get("x-profile")).toEqual(X_PROFILE);
    expect(fake.rows.get("meeting-notes")).toEqual(MEETING_NOTES);
  });

  it("replaces every row of the onboarding set, a duplicate included", async () => {
    // The old delete-everything cleaned up duplicates as a side effect. Scoping
    // it by pair must not lose that: every row at an owned pair goes.
    fake.rows.set("old-brand-voice-internal-twin", stored(CLIENT_ID, "brand-voice", "internal", "stale twin"));

    await replace(freshSet());

    expect(oldRowIds()).toEqual([]);
    const ownedRows = rowsOf(CLIENT_ID)
      .map(([, row]) => row)
      .filter((row) => CONTRACT_PAIRS.includes(pairOf(row)));
    expect(ownedRows.map(pairOf).sort()).toEqual([...CONTRACT_PAIRS].sort());
    for (const row of ownedRows) expect(row.content).toBe(`fresh ${row.docType} (${row.tier})`);
  });

  it("deletes an owned row the run did not write — the scope is the contract, not the incoming set", async () => {
    // writeContextDocsFromResearch drops a condensation that came back empty.
    // The previous condensation goes all the same, as it always has: it was
    // condensed from an internal document this run just replaced.
    await replace(freshSet().filter((row) => pairOf(row) !== "brand-voice::client"));

    expect(rowsOf(CLIENT_ID).map(([, row]) => pairOf(row))).not.toContain("brand-voice::client");
  });

  it("keeps a row of an onboarding docType at a tier outside the contract", async () => {
    // The lab import writes client-guidelines at tier internal (N°3 has one in
    // production); onboarding writes it at internal-only. The pipeline owns
    // pairs, not docTypes.
    const labGuidelines = stored(CLIENT_ID, "client-guidelines", "internal", "lab-curated guidelines");
    fake.rows.set("lab-guidelines", structuredClone(labGuidelines));

    await replace(freshSet());

    expect(fake.rows.get("lab-guidelines")).toEqual(labGuidelines);
  });

  it("touches no other client's rows", async () => {
    const before = structuredClone(rowsOf(OTHER_CLIENT_ID));

    await replace(freshSet());

    expect(rowsOf(OTHER_CLIENT_ID)).toEqual(before);
  });

  it("is one atomic batch: one read, every delete and every write in one batch, one commit", async () => {
    await replace(freshSet());

    expect(fake.queries).toBe(1);
    expect(fake.batches).toEqual([
      { deletes: CONTEXT_DOC_SET_CONTRACT.length, sets: CONTEXT_DOC_SET_CONTRACT.length, commits: 1 },
    ]);
    expect(fake.unbatchedWrites).toBe(0);
  });

  it("refuses a row the next replace would not delete, before reading or writing anything", async () => {
    // Written anyway, either row would gain a duplicate on every run.
    const before = structuredClone([...fake.rows]);

    await expect(replace([...freshSet(), { ...X_PROFILE, version: 5 }])).rejects.toThrow(
      /refused rows it would never delete: x-agent-profile::internal-only of client acme/,
    );
    await expect(replace([...freshSet(), { ...freshSet()[0], clientId: OTHER_CLIENT_ID }])).rejects.toThrow(
      /refused rows it would never delete: brand-voice::internal of client initech/,
    );

    expect([...fake.rows]).toEqual(before);
    expect(fake.queries).toBe(0);
    expect(fake.batches).toEqual([]);
  });
});

describe("the pipeline's write goes through that scope", () => {
  it("a real write half on the production wiring keeps the x-agent-profile and meeting-notes rows", async () => {
    // compose → condense → shape gate → `agentOnboardingDeps().replaceDocs`: the
    // call runIntelReportPipeline makes, with only the model call stubbed. The
    // workspace projection is left out; it is best-effort and reads no row
    // this test is about.
    const deps = await agentOnboardingDeps();
    const intelReport = {
      overallScore: 70,
      brandAnalysis: "One voice in the docs, another on the site.",
      positioningAnalysis: "Positioned against spreadsheets.",
      competitors: [{ company: "Northwind" }],
      targetAudience: { summary: "Operations leads at mid-market logistics firms." },
      recommendations: [{ title: "Ship five comparison pages" }],
    };

    const result = await writeContextDocsFromResearch(
      { client: { id: CLIENT_ID, name: "Acme" } as never, intelReport, seoGeo: {} },
      { condense: deps.condense, replaceDocs: deps.replaceDocs, now: () => NOW },
    );

    expect(result.docsWritten).toBe(CONTEXT_DOC_SET_CONTRACT.length);
    expect(fake.rows.get("x-profile")).toEqual(X_PROFILE);
    expect(fake.rows.get("meeting-notes")).toEqual(MEETING_NOTES);
    expect(oldRowIds()).toEqual([]);
    expect(fake.batches).toHaveLength(1);
  });
});
