import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCompetitorRows,
  competitorHref,
  oneLineSummary,
  type CompetitorAiVisibility,
} from "@/lib/competitor-rows";
import type { ClientCompetitor } from "@/lib/types";

/**
 * Portal feedback round 4 (2026-09). "Since it's only competitors now we can
 * show all of them right off the bat, and make it more interactive if we have
 * data on these competitors that we collected anyway."
 *
 * The row mapping is the whole of that ruling in code, and two of its rules are
 * invisible to a type check: the ORDER (a person's own picks, then whoever the
 * engines actually name) and the NO-RESEARCH boundary (every field comes off a
 * stored row or off a snapshot the page already read). Both are asked here.
 */

let seq = 0;
function competitor(over: Partial<ClientCompetitor> = {}): ClientCompetitor {
  seq += 1;
  return {
    id: `c${seq}`,
    clientId: "client-1",
    company: `Company ${seq}`,
    marketTier: "Challenger",
    overlap: "Medium",
    deepDive: false,
    keyStrengths: [],
    keyWeaknesses: [],
    source: "report",
    createdAt: 1_000 + seq,
    updatedAt: 1_000 + seq,
    ...over,
  };
}

const CAPTURED_AT = 1_700_000_000_000;
const AI: CompetitorAiVisibility = {
  clientMentions: 4,
  answersMeasured: 12,
  capturedAt: CAPTURED_AT,
};

/** A row measured by the capture `AI` describes. */
const measured = (over: Partial<ClientCompetitor> & { llmMentions: number }): ClientCompetitor =>
  competitor({ llmMentionsAt: CAPTURED_AT, ...over });

describe("buildCompetitorRows ordering", () => {
  it("puts the rows a person tracked themselves first, whatever the engines say", () => {
    const rows = buildCompetitorRows([
      competitor({ company: "Loud Auto", source: "report", llmMentions: 40 }),
      competitor({ company: "My Pick", source: "manual", llmMentions: 0 }),
    ]);
    expect(rows.map((r) => r.company)).toEqual(["My Pick", "Loud Auto"]);
    expect(rows[0].tracked).toBe(true);
    expect(rows[1].tracked).toBe(false);
  });

  it("ranks the rest by measured AI-answer presence, then by name", () => {
    const rows = buildCompetitorRows([
      competitor({ company: "Beta", llmMentions: 2 }),
      competitor({ company: "Alpha", llmMentions: 9 }),
      competitor({ company: "Delta", llmMentions: 2 }),
    ]);
    expect(rows.map((r) => r.company)).toEqual(["Alpha", "Beta", "Delta"]);
  });

  it("sinks a never-measured rival below one measured at zero", () => {
    // "We have not asked yet" is not "the engines did not name them", and the
    // two used to collapse into the same number the moment `llmMentions ?? 0`
    // was the sort key.
    const rows = buildCompetitorRows([
      competitor({ company: "Unmeasured" }),
      competitor({ company: "Measured Zero", llmMentions: 0 }),
    ]);
    expect(rows.map((r) => r.company)).toEqual(["Measured Zero", "Unmeasured"]);
    expect(rows[0].mentions).toBe(0);
    expect(rows[1].mentions).toBeNull();
  });

  it("does not mutate the array it was handed", () => {
    const input = [competitor({ company: "Zed" }), competitor({ company: "Ada" })];
    const before = input.map((c) => c.company);
    buildCompetitorRows(input);
    expect(input.map((c) => c.company)).toEqual(before);
  });
});

describe("buildCompetitorRows row data", () => {
  it("reads what they do, how close they are and what they are like off the stored row", () => {
    const [row] = buildCompetitorRows([
      competitor({
        company: "Rival Co",
        url: "rival.example",
        positioning: "Enterprise payroll for mid-market teams. Expanding into Europe this year.",
        overlap: "High",
        marketTier: "Leader",
        founded: "2016",
        scale: "300 staff",
        threatLevel: "HIGH",
        keyStrengths: ["Named on every comparison page"],
        keyWeaknesses: ["Thin support coverage"],
      }),
    ]);
    // One line of "what they do": the first sentence, no trailing period.
    expect(row.summary).toBe("Enterprise payroll for mid-market teams");
    expect(row.chips).toEqual(["High overlap", "Market leader"]);
    expect(row.facts).toEqual([
      { label: "Founded", value: "2016" },
      { label: "Scale", value: "300 staff" },
      { label: "Threat", value: "High" },
    ]);
    expect(row.strengths).toEqual(["Named on every comparison page"]);
    expect(row.weaknesses).toEqual(["Thin support coverage"]);
    expect(row.href).toBe("https://rival.example");
    expect(row.hasDetail).toBe(true);
  });

  it('drops the "Other" tier chip, which is the import saying it did not know', () => {
    const [row] = buildCompetitorRows([competitor({ marketTier: "Other", overlap: "Low" })]);
    expect(row.chips).toEqual(["Low overlap"]);
  });

  it("leaves a row with nothing behind it closed rather than opening an empty box", () => {
    const [row] = buildCompetitorRows([competitor({ company: "Bare Name" })]);
    expect(row.summary).toBeNull();
    expect(row.href).toBeNull();
    expect(row.facts).toEqual([]);
    expect(row.hasDetail).toBe(false);
  });
});

describe("buildCompetitorRows share of conversation", () => {
  it("scales the bar against the larger of the rival's count and the client's", () => {
    const rows = buildCompetitorRows(
      [
        measured({ company: "Ahead", llmMentions: 8 }),
        measured({ company: "Level", llmMentions: 4 }),
        measured({ company: "Behind", llmMentions: 1 }),
      ],
      AI,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.company, r]));
    // A full bar means "ahead of you", never "100% of something".
    expect(byName["Ahead"].barPct).toBe(100);
    expect(byName["Level"].barPct).toBe(100);
    expect(byName["Behind"].barPct).toBe(25);
    for (const row of rows) {
      expect(row.clientMentions).toBe(4);
      expect(row.answersMeasured).toBe(12);
    }
  });

  it("renders no meter at all when there is no snapshot to compare against", () => {
    const [row] = buildCompetitorRows([competitor({ llmMentions: 3 })]);
    expect(row.mentions).toBe(3);
    expect(row.barPct).toBeNull();
    expect(row.clientMentions).toBeNull();
    expect(row.answersMeasured).toBeNull();
  });

  it("gives a never-measured rival no bar even when the client has a count", () => {
    const [row] = buildCompetitorRows([competitor()], AI);
    expect(row.mentions).toBeNull();
    expect(row.barPct).toBeNull();
  });

  it("survives a snapshot in which nobody was named", () => {
    const [row] = buildCompetitorRows([measured({ llmMentions: 0 })], {
      clientMentions: 0,
      answersMeasured: 9,
      capturedAt: CAPTURED_AT,
    });
    expect(row.barPct).toBe(0);
  });
});

/**
 * Review wave, 2026-09. Two ways this meter could compare things that are not
 * comparable, both of them silent: a count from an OLDER capture standing next
 * to this run's client figure, and a client figure computed off a snapshot with
 * no category split, where the branded questions name the client by
 * construction. The second is the page's to prevent (see the settings page's
 * `competitorAiVisibility`); this is the first.
 */
describe("buildCompetitorRows only shows what THIS run measured", () => {
  it("withholds the count and the bar when the row was measured on another capture", () => {
    const [row] = buildCompetitorRows(
      [competitor({ company: "Stale", llmMentions: 9, llmMentionsAt: CAPTURED_AT - 86_400_000 })],
      AI,
    );
    expect(row.mentions).toBeNull();
    expect(row.barPct).toBeNull();
    // …and says so, rather than leaving a row that looks unmeasurable.
    expect(row.notMeasuredThisRun).toBe(true);
  });

  it("treats a row with no stamp at all as not measured this run", () => {
    // Rows past the measurement roster never get one: they hold whatever some
    // earlier run wrote, or nothing.
    const [row] = buildCompetitorRows([competitor({ company: "Unstamped", llmMentions: 5 })], AI);
    expect(row.mentions).toBeNull();
    expect(row.notMeasuredThisRun).toBe(true);
  });

  it("keeps a matching stamp, with the run's own denominator beside it", () => {
    const [row] = buildCompetitorRows([measured({ company: "Fresh", llmMentions: 6 })], AI);
    expect(row.mentions).toBe(6);
    expect(row.answersMeasured).toBe(12);
    expect(row.clientMentions).toBe(4);
    expect(row.notMeasuredThisRun).toBe(false);
  });

  it("sinks a stale row below a fresh zero rather than ranking it on an old number", () => {
    const rows = buildCompetitorRows(
      [
        competitor({ company: "Stale Big", llmMentions: 40, llmMentionsAt: CAPTURED_AT - 1 }),
        measured({ company: "Fresh Zero", llmMentions: 0 }),
      ],
      AI,
    );
    expect(rows.map((r) => r.company)).toEqual(["Fresh Zero", "Stale Big"]);
  });

  it("passes a stored count through untouched when there is no capture to check it against", () => {
    // No snapshot means no run for the stamp to disagree with, so the row reads
    // exactly as it did before: a bare count, no bar, no "not measured" note.
    const [row] = buildCompetitorRows([
      competitor({ llmMentions: 3, llmMentionsAt: CAPTURED_AT - 999 }),
    ]);
    expect(row.mentions).toBe(3);
    expect(row.barPct).toBeNull();
    expect(row.notMeasuredThisRun).toBe(false);
  });
});

describe("oneLineSummary", () => {
  it("is null for nothing stored, so the row simply has no second line", () => {
    expect(oneLineSummary(undefined)).toBeNull();
    expect(oneLineSummary("   ")).toBeNull();
  });

  it("collapses newlines rather than letting analyst prose reflow the row", () => {
    expect(oneLineSummary("A payroll\n  platform")).toBe("A payroll platform");
  });

  it("clamps a one-sentence essay at a word boundary", () => {
    const long = `${"word ".repeat(60)}end`;
    const out = oneLineSummary(long)!;
    expect(out.length).toBeLessThanOrEqual(141);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("wor…");
  });
});

describe("competitorHref", () => {
  it("prefers the stored website and absolutizes a bare domain", () => {
    expect(competitorHref({ company: "Rival", url: "rival.com" })).toBe("https://rival.com");
    expect(competitorHref({ company: "Rival", url: "https://rival.com/x" })).toBe(
      "https://rival.com/x",
    );
  });

  it("falls back to a name that is itself a domain, and to nothing otherwise", () => {
    // CD-H3: the favicon beside the row already resolves through this same
    // fallback, so a row that shows a brand's real icon must be openable too.
    expect(competitorHref({ company: "Okara.ai" })).toBe("https://okara.ai");
    expect(competitorHref({ company: "Some Big Company" })).toBeNull();
  });
});

/**
 * The OTHER half of the same guarantee, and it cannot live in this module: the
 * client's own count is summed on the server, in the Account Center page, from
 * the snapshot it already read. `categoryMetrics` silently falls back to an
 * engine row's FULL-PROMPT figures when the row predates the `category` field,
 * and those include the brand and navigational questions, which name the client
 * by construction. Summed into `clientMentions` they inflate it, every rival's
 * bar is drawn shorter than it should be, and nothing on the page says so.
 *
 * Source-level because the page is a server component that reads Firestore on
 * import; what is asserted is the one line that makes the fallback unreachable
 * from here (review wave, 2026-09).
 */
describe("the client's side of the meter is never taken from a legacy snapshot", () => {
  it("refuses a capture whose engine rows have no category split", () => {
    const page = readFileSync(
      join(__dirname, "..", "..", "app", "(app)", "clients", "[id]", "settings", "page.tsx"),
      "utf8",
    );
    const at = page.indexOf("const competitorAiVisibility");
    expect(at, "competitorAiVisibility is gone — the meter's client side moved").toBeGreaterThan(-1);
    const block = page.slice(at, page.indexOf("const competitorsSection", at));
    expect(block.replace(/\s+/g, " ")).toContain(
      "if (perEngine.some((engine) => !engine.category)) return null;",
    );
    // And the capture's own stamp travels with the counts, so every row can
    // check that its stored number belongs to this run.
    expect(block).toContain("capturedAt: seoGeo.capturedAt");
  });
});
