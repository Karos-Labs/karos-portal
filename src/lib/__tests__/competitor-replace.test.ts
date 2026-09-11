import { describe, expect, it } from "vitest";
import { planReportCompetitorReplacement, type CompetitorReplacementPlan, type StoredCompetitor } from "../competitor-replace";
import { competitorBrandKeys, looksLikeUrlInput } from "../competitor-input";
import type { ClientCompetitor } from "../types";

type Row = Omit<ClientCompetitor, "id">;

const NOW = 1_800_000_000_000;
const CLIENT_ID = "c1";

function row(company: string, extra: Partial<Row> = {}): Row {
  return {
    clientId: CLIENT_ID,
    company,
    marketTier: "Challenger",
    overlap: "Medium",
    deepDive: false,
    keyStrengths: [],
    keyWeaknesses: [],
    source: "report",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function stored(id: string, company: string, extra: Partial<Row> = {}): StoredCompetitor {
  return { id, data: row(company, extra) };
}

/**
 * `replaceReportCompetitors` as it was before the rules moved into
 * `planReportCompetitorReplacement`, transcribed line for line from data.ts
 * with the Firestore batch swapped for a list of operations. It is the oracle
 * for "a client with no lab rows is treated exactly as before": the planner
 * must produce these operations, in this order, for any pool of report and
 * manual rows.
 */
function planAsBefore(existing: readonly StoredCompetitor[], rows: readonly Row[], now: number): CompetitorReplacementPlan {
  const reportDocs = existing.filter((d) => d.data.source === "report");
  const manualDocs = existing.filter((d) => d.data.source === "manual");

  const oldRows = reportDocs.map((d) => d.data);
  const oldByKey = new Map<string, Row>();
  for (const r of oldRows) {
    for (const k of competitorBrandKeys(r.company, r.url)) if (!oldByKey.has(k)) oldByKey.set(k, r);
  }
  const manualByKey = new Map<string, StoredCompetitor>();
  for (const d of manualDocs) {
    const m = d.data;
    for (const k of competitorBrandKeys(m.company, m.url)) if (!manualByKey.has(k)) manualByKey.set(k, d);
  }
  const manualKeyOf = (name: string, url?: string) =>
    competitorBrandKeys(name, url).map((k) => manualByKey.get(k)).find(Boolean);

  const updates: CompetitorReplacementPlan["updates"] = [];
  const carriedOld = new Set<Row>();
  const merged: Row[] = [];
  for (const r of rows) {
    const manualDoc = manualKeyOf(r.company, r.url);
    if (manualDoc) {
      const m = manualDoc.data;
      updates.push({
        id: manualDoc.id,
        patch: {
          company: looksLikeUrlInput(m.company) && r.company ? r.company : m.company,
          ...(m.url || !r.url ? {} : { url: r.url }),
          ...(r.positioning ? { positioning: r.positioning } : {}),
          ...(r.keyStrengths?.length ? { keyStrengths: r.keyStrengths } : {}),
          ...(r.keyWeaknesses?.length ? { keyWeaknesses: r.keyWeaknesses } : {}),
          ...(r.threatLevel ? { threatLevel: r.threatLevel } : {}),
          marketTier: r.marketTier,
          overlap: r.overlap,
          updatedAt: now,
        },
      });
      continue;
    }
    const old = competitorBrandKeys(r.company, r.url)
      .map((k) => oldByKey.get(k))
      .find(Boolean);
    if (!old) {
      merged.push(r);
      continue;
    }
    carriedOld.add(old);
    merged.push({
      ...r,
      ...(!r.url && old.url ? { url: old.url } : {}),
      ...(old.llmMentions !== undefined
        ? { llmMentions: old.llmMentions, ...(old.llmMentionsAt !== undefined ? { llmMentionsAt: old.llmMentionsAt } : {}) }
        : {}),
    });
  }
  const survivors = oldRows.filter(
    (r) => !carriedOld.has(r) && (r.llmMentions ?? 0) > 0 && !manualKeyOf(r.company, r.url),
  );
  return { updates, deletes: reportDocs.map((d) => d.id), creates: [...merged, ...survivors] };
}

/** Pools and analyses with no lab row in them — the only thing every client had before. */
const WITHOUT_LAB: Array<{ name: string; existing: StoredCompetitor[]; rows: Row[] }> = [
  { name: "an empty pool", existing: [], rows: [row("Northwind", { url: "northwind.com" }), row("Initech")] },
  {
    name: "report rows replaced, a measured one carried and a dropped measured one kept",
    existing: [
      stored("r1", "Northwind", { url: "northwind.com", llmMentions: 4, llmMentionsAt: 9 }),
      stored("r2", "Globex", { llmMentions: 2, llmMentionsAt: 9 }),
      stored("r3", "Hooli"),
    ],
    rows: [row("Northwind"), row("Initech", { url: "initech.com" })],
  },
  {
    name: "a pasted-URL manual row absorbing its resolved twin",
    existing: [
      stored("m1", "https://speedrun.a16z.com", { source: "manual" }),
      stored("r1", "Techstars", { llmMentions: 1 }),
    ],
    rows: [
      row("Speedrun by a16z", { url: "speedrun.a16z.com", positioning: "Accelerator", keyStrengths: ["Capital"], threatLevel: "HIGH", marketTier: "Leader", overlap: "High" }),
      row("Y Combinator", { url: "ycombinator.com" }),
    ],
  },
  {
    name: "two analysis rows landing on one manual row, and a measured survivor a manual row now covers",
    existing: [
      stored("m1", "Whop", { source: "manual", url: "whop.com" }),
      stored("r1", "whop.com", { llmMentions: 7 }),
    ],
    rows: [row("Whop", { positioning: "Creator storefronts" }), row("Whop", { url: "whop.com", keyWeaknesses: ["Fees"] })],
  },
];

describe("planReportCompetitorReplacement — a client with no lab rows, exactly as before", () => {
  for (const scenario of WITHOUT_LAB) {
    it(scenario.name, () => {
      expect(planReportCompetitorReplacement(scenario.existing, scenario.rows, NOW)).toEqual(
        planAsBefore(scenario.existing, scenario.rows, NOW),
      );
    });
  }

  it("deletes every report row and nothing else", () => {
    const plan = planReportCompetitorReplacement(
      [stored("r1", "A"), stored("m1", "B", { source: "manual" }), stored("r2", "C")],
      [],
      NOW,
    );
    expect(plan.deletes).toEqual(["r1", "r2"]);
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
  });
});

describe("planReportCompetitorReplacement — lab rows (profile/competitor-tracking.json)", () => {
  // N°3's four, as scripts/import-lab-client.ts writes them.
  const lab = (id: string, company: string, extra: Partial<Row> = {}) =>
    stored(id, company, { source: "lab", marketTier: "Leader", overlap: "High", threatLevel: "HIGH", ...extra });
  const LAB_POOL = [
    lab("l1", "Le Mascara (Cimalpes)"),
    lab("l2", "Atmosphère"),
    lab("l3", "Le Strato"),
    lab("l4", "Les Grandes Alpes"),
  ];

  it("never deletes a lab row", () => {
    const plan = planReportCompetitorReplacement(LAB_POOL, [row("Six Senses Residences")], NOW);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates.map((r) => r.company)).toEqual(["Six Senses Residences"]);
  });

  it("absorbs its analysis twin: no report row beside it, curated name and tier kept", () => {
    const twin = row("Le Strato", {
      url: "lestrato.com",
      positioning: "Ski-in hotel residences",
      keyStrengths: ["Slope access"],
      keyWeaknesses: ["Hotel service model"],
      marketTier: "Niche",
      overlap: "Low",
      threatLevel: "LOW",
    });
    const plan = planReportCompetitorReplacement(LAB_POOL, [twin], NOW);

    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([
      {
        id: "l3",
        patch: {
          url: "lestrato.com",
          positioning: "Ski-in hotel residences",
          keyStrengths: ["Slope access"],
          keyWeaknesses: ["Hotel service model"],
          updatedAt: NOW,
        },
      },
    ]);
    // What the lab decided is not in the patch at all, so a merge-set cannot move it.
    const patch = plan.updates[0]!.patch;
    for (const curated of ["company", "marketTier", "overlap", "threatLevel", "source", "createdAt", "deepDive"]) {
      expect(patch, curated).not.toHaveProperty(curated);
    }
  });

  it("keeps a url the lab already has", () => {
    const plan = planReportCompetitorReplacement(
      [lab("l1", "Le Strato", { url: "le-strato.com" })],
      [row("Le Strato", { url: "lestrato.fr" })],
      NOW,
    );
    expect(plan.updates[0]!.patch).not.toHaveProperty("url");
  });

  it("does not re-create a measured report twin the lab row now covers", () => {
    const plan = planReportCompetitorReplacement(
      [...LAB_POOL, stored("r1", "Le Strato", { llmMentions: 3, llmMentionsAt: 9 })],
      [],
      NOW,
    );
    expect(plan.deletes).toEqual(["r1"]);
    expect(plan.creates).toEqual([]);
  });

  it("lets a manual row keep precedence over a lab row for the same brand", () => {
    const plan = planReportCompetitorReplacement(
      [stored("m1", "Le Strato", { source: "manual" }), lab("l3", "Le Strato")],
      [row("Le Strato", { positioning: "Hotel residences" })],
      NOW,
    );
    expect(plan.updates.map((u) => u.id)).toEqual(["m1"]);
  });
});
