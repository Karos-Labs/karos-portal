import { describe, expect, it } from "vitest";

import {
  GEO_READINESS_CHECKS,
  REC_COPY,
  SEO_CHECKS,
  buildClientSuggestions,
  buildRecommendations,
  computeCheckGaps,
  computeVisibilityGaps,
  type SeoGeoCheck,
  type VisibilityGap,
} from "@/lib/seo-geo";

/**
 * "Things only you can do" (portal feedback round 4, 2026-09).
 *
 * The ruling this replaces: "This section is all false. All these 'what we're
 * fixing' items are not true. Check the root of where it comes from and make the
 * system not generate this anymore. Reduce it, and make it short suggestions of
 * things THEY can do that WE can't."
 *
 * So the rules below are the product, not an implementation detail: what gets in
 * (client-owned, measured, confirmed), what stays out (anything Karos executes,
 * anything unconfirmed, anything we cannot name), and how short the list is
 * allowed to be. Each test names the failure it prevents.
 */

const gap = (patch: Partial<VisibilityGap> = {}): VisibilityGap => ({
  id: "GEO-25",
  lever: "GEO",
  title: "t",
  severity: "high",
  evidence: "",
  confidence: "CONFIRMED",
  fixAction: "manual",
  target: "off-site",
  delivery: "advisory",
  benchmark: "",
  measured: "No public reference entry found.",
  scoreLift: 3,
  ...patch,
});

/** Every check in a registry, failing, so a producer emits its whole catalogue. */
const allFailing = (defs: typeof SEO_CHECKS, patch: Partial<SeoGeoCheck> = {}): SeoGeoCheck[] =>
  defs.map((d) => ({
    id: d.id,
    bucket: d.bucket,
    label: d.label,
    evidence: `observed on ${d.id}`,
    norm: 0,
    tier: "MEASURED",
    confidence: "CONFIRMED",
    ...patch,
  }));

/**
 * The list only. `buildClientSuggestions` returns `{ suggestions, emptyReason }`
 * since the review wave (2026-09) — the empty state has to say WHICH kind of
 * empty it is — and every rule below is about the list, so it is unwrapped once
 * here rather than at twenty call sites.
 */
const suggest = (...args: Parameters<typeof buildClientSuggestions>) =>
  buildClientSuggestions(...args).suggestions;

describe("buildClientSuggestions — only what the client owns", () => {
  it("keeps the advisory / off-site work and drops everything Karos executes", () => {
    const gaps = computeCheckGaps(
      GEO_READINESS_CHECKS,
      allFailing(GEO_READINESS_CHECKS),
      "GEO",
    );
    const ids = suggest(gaps, { limit: 99 }).map((s) => s.id);

    // Off-site entity + reputation: nothing in this product can ship these.
    expect(ids).toContain("GEO-25");
    expect(ids).toContain("GEO-04");
    // Karos-owned page work must never appear under this heading.
    expect(ids).not.toContain("GEO-02");
    expect(ids).not.toContain("GEO-17");
    // NOR the "connect" bucket, however client-shaped its owner line reads
    // ("You connect · we handle the rest"): the bucket is keyed on registry
    // position, and BOTH-09 sits in it while being a file Karos writes.
    expect(ids).not.toContain("BOTH-09");
    expect(ids).not.toContain("GEO-24");
  });

  it("agrees with the plan about who owns a row, from the other direction", () => {
    // The two functions read the same derivation, so nothing may be BOTH a Karos
    // plan row we execute and a thing only the client can do.
    const gaps = computeCheckGaps(GEO_READINESS_CHECKS, allFailing(GEO_READINESS_CHECKS), "GEO");
    const suggested = new Set(suggest(gaps, { limit: 99 }).map((s) => s.id));
    for (const rec of buildRecommendations(gaps, 999)) {
      if (suggested.has(rec.recId)) expect(rec.owner).toContain("Advisory");
    }
  });

  it("takes the competitor-visibility gaps, which are off-site by construction", () => {
    const gaps = computeVisibilityGaps([
      {
        engine: "chatgpt",
        source: "OpenAI",
        captureTier: "MEASURED",
        promptsMeasured: 12,
        mentionRate: 0,
        citationRate: 0,
        firstPositionRate: 0,
        shareOfVoice: 0,
        ghostCitationRate: 0,
        brandMentions: [],
        category: {
          promptsMeasured: 12,
          mentionRate: 0,
          citationRate: 0,
          firstPositionRate: 0,
          shareOfVoice: 0,
          ghostCitationRate: 0,
          brandMentions: [],
          topCompetitor: { name: "Rival", mentionRate: 1, shareOfVoice: 100 },
        },
      },
    ] as unknown as Parameters<typeof computeVisibilityGaps>[0]);
    const out = suggest(gaps, { limit: 99 });
    expect(out.map((s) => s.id.split(":")[0]).sort()).toEqual(["GEO-11", "GEO-27", "GEO-35"]);
  });
});

describe("buildClientSuggestions — the confidence cut", () => {
  it("asks the client for work only on a CONFIRMED finding", () => {
    // There is no Karos verification step between one of these rows and the
    // client acting on it, which is the whole reason the cut is here and not on
    // the plan's softer footnote.
    const out = suggest([
      gap({ id: "GEO-25", confidence: "CONFIRMED" }),
      gap({ id: "GEO-04", confidence: "LIKELY" }),
      gap({ id: "GEO-14", confidence: "HYPOTHESIS" }),
    ]);
    expect(out.map((s) => s.id)).toEqual(["GEO-25"]);
  });

  it("widens only when a caller names the wider threshold", () => {
    const out = suggest(
      [gap({ id: "GEO-04", confidence: "LIKELY" }), gap({ id: "GEO-14", confidence: "HYPOTHESIS" })],
      { minConfidence: "LIKELY" },
    );
    expect(out.map((s) => s.id)).toEqual(["GEO-04"]);
  });
});

describe("buildClientSuggestions — measured only", () => {
  it("drops a gap whose check was estimated rather than measured", () => {
    // Both producers already emit measured gaps exclusively; a snapshot written
    // by an older pipeline is not covered by that, so the caller's checks
    // re-assert it.
    const checks: SeoGeoCheck[] = [
      { id: "GEO-25", bucket: "offsiteEntity", label: "x", evidence: "e", norm: 0, tier: "ESTIMATED", confidence: "CONFIRMED" },
      { id: "GEO-04", bucket: "offsiteEntity", label: "y", evidence: "e", norm: 0, tier: "MEASURED", confidence: "CONFIRMED" },
    ];
    const out = suggest([gap({ id: "GEO-25" }), gap({ id: "GEO-04" })], { checks });
    expect(out.map((s) => s.id)).toEqual(["GEO-04"]);
  });
});

describe("buildClientSuggestions — length and shape", () => {
  it("caps the list at five, highest lift first", () => {
    const gaps = [
      gap({ id: "GEO-25", scoreLift: 1 }),
      gap({ id: "GEO-04", scoreLift: 9 }),
      gap({ id: "GEO-07", scoreLift: 5 }),
      gap({ id: "GEO-14", scoreLift: 7 }),
      gap({ id: "GEO-27:chatgpt", scoreLift: 8 }),
      gap({ id: "GEO-35:gemini", scoreLift: 6 }),
      gap({ id: "GEO-11:claude", scoreLift: 4 }),
    ];
    const out = suggest(gaps);
    expect(out).toHaveLength(5);
    expect(out.map((s) => s.id)).toEqual([
      "GEO-04",
      "GEO-27:chatgpt",
      "GEO-14",
      "GEO-35:gemini",
      "GEO-07",
    ]);
  });

  it("collapses the per-engine gaps that say the same sentence", () => {
    // Five engines produce five copies of one finding; the survivor is the
    // strongest measured instance, and its evidence names the engine it was
    // measured on.
    const out = suggest([
      gap({ id: "GEO-35:chatgpt", scoreLift: 4, measured: "Named in 1 of 12 ChatGPT category answers" }),
      gap({ id: "GEO-35:gemini", scoreLift: 9, measured: "Named in 0 of 12 Gemini category answers" }),
      gap({ id: "GEO-35:claude", scoreLift: 6, measured: "Named in 0 of 9 Claude category answers" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("GEO-35:gemini");
    expect(out[0].evidence).toBe("Named in 0 of 12 Gemini category answers");
  });

  it("carries what was found, never the benchmark or the registry label", () => {
    const [only] = suggest([
      gap({
        id: "GEO-14",
        title: "Review footprint: ≥3 platforms, ≥4.0 avg, ≥25 reviews each",
        benchmark: "Review footprint: ≥3 platforms, ≥4.0 avg, ≥25 reviews each",
        measured: "Found on 1 review platform.",
      }),
    ]);
    expect(only.evidence).toBe("Found on 1 review platform.");
    expect(only.title).not.toContain("≥");
    expect(only.why.length).toBeGreaterThan(10);
    // The suggestion shape carries none of the plan's commitment vocabulary.
    expect(only).not.toHaveProperty("owner");
    expect(only).not.toHaveProperty("actionKind");
    expect(only).not.toHaveProperty("impact");
    expect(Object.keys(only).sort()).toEqual(["evidence", "id", "title", "why"]);
  });

  it("drops an id it cannot name rather than printing the neutral fallback", () => {
    // "A technical finding your team is reviewing" is an honest thing to say
    // about a row Karos owns and a useless thing to hand a client as a task.
    const out = suggest([gap({ id: "GEO-999" }), gap({ id: "GEO-25" })]);
    expect(out.map((s) => s.id)).toEqual(["GEO-25"]);
  });

  it("says nothing at all when nothing is the client's to do", () => {
    const gaps = computeCheckGaps(SEO_CHECKS, allFailing(SEO_CHECKS), "SEO");
    expect(suggest(gaps)).toEqual([]);
  });
});

describe("an empty list says which kind of empty it is", () => {
  /**
   * Review wave, 2026-09. The section printed "everything this snapshot found
   * is work your Karos team owns" for all three cases, which is a claim that we
   * checked the client's side and cleared it — false in two of them.
   */
  it("calls it karosOwned only when every finding really is ours", () => {
    const gaps = computeCheckGaps(SEO_CHECKS, allFailing(SEO_CHECKS), "SEO");
    const out = buildClientSuggestions(gaps);
    expect(out.suggestions).toEqual([]);
    expect(out.emptyReason).toBe("karosOwned");
  });

  it("calls it lowConfidence when the client-owned findings were not confirmed", () => {
    const out = buildClientSuggestions([
      gap({ id: "GEO-04", confidence: "LIKELY" }),
      gap({ id: "GEO-14", confidence: "HYPOTHESIS" }),
    ]);
    expect(out.suggestions).toEqual([]);
    expect(out.emptyReason).toBe("lowConfidence");
  });

  it("calls it lowConfidence when a client-owned finding failed the measured cut", () => {
    const checks: SeoGeoCheck[] = [
      { id: "GEO-25", bucket: "offsiteEntity", label: "x", evidence: "e", norm: 0, tier: "ESTIMATED", confidence: "CONFIRMED" },
    ];
    const out = buildClientSuggestions([gap({ id: "GEO-25" })], { checks });
    expect(out.emptyReason).toBe("lowConfidence");
  });

  it("calls it none when the snapshot produced no gaps at all", () => {
    expect(buildClientSuggestions([]).emptyReason).toBe("none");
  });

  it("names no reason while there is something to show", () => {
    expect(buildClientSuggestions([gap({ id: "GEO-25" })]).emptyReason).toBeNull();
  });
});

describe("the evidence names the engine it was measured on", () => {
  /**
   * Rule 4 said so and the code did not (review wave, 2026-09): the survivor of
   * the per-engine dedupe stands for a finding measured on several engines, so
   * a line with no engine in it is a number with no measurement attached.
   */
  it("appends the engine when the producer's measured line does not carry it", () => {
    // GEO-27's own `measured` is a bare share-of-voice pair.
    const [only] = suggest([
      gap({
        id: "GEO-27:chatgpt",
        measured: "8% share of voice (vs Rival at 41%)",
        evidence: "Measured across 12 category questions answered by ChatGPT",
      }),
    ]);
    expect(only.evidence).toBe("8% share of voice (vs Rival at 41%), measured on ChatGPT");
  });

  it("leaves a line that already names its engine exactly as the producer wrote it", () => {
    const [only] = suggest([
      gap({ id: "GEO-35:gemini", measured: "Named in 0 of 12 Gemini category answers" }),
    ]);
    expect(only.evidence).toBe("Named in 0 of 12 Gemini category answers");
  });

  it("adds nothing to a finding that is not per engine", () => {
    const [only] = suggest([gap({ id: "GEO-25", measured: "No public reference entry found." })]);
    expect(only.evidence).toBe("No public reference entry found.");
  });
});

describe("GEO-27 says share of voice, because that is what it measures", () => {
  it("does not claim the rival was named more often", () => {
    // The gap fires on `shareOfVoice`, the rival's share of the brand mentions
    // in those answers. A brand named in fewer answers can still hold the
    // larger share, so "named more often than you" was a claim this report had
    // not made (review wave, 2026-09).
    const [only] = suggest([gap({ id: "GEO-27:chatgpt" })]);
    expect(only.why).toContain("share of the brand mentions");
    expect(`${only.title} ${only.why}`).not.toMatch(/named (more often|most often)/i);
  });
});

describe("the copy a client is asked to act on", () => {
  it("never quotes an internal registry label", () => {
    const labels = new Set([...SEO_CHECKS, ...GEO_READINESS_CHECKS].map((d) => d.label));
    const gaps = computeCheckGaps(GEO_READINESS_CHECKS, allFailing(GEO_READINESS_CHECKS), "GEO");
    for (const s of suggest(gaps, { limit: 99 })) {
      expect(labels.has(s.title)).toBe(false);
      expect(labels.has(s.why)).toBe(false);
    }
  });

  it("keeps the audited catalogue free of the claims a check cannot support", () => {
    // The ruling was that these items "are not true". A check measures the state
    // of a page or a public record; it does not observe an engine deciding
    // anything, so the copy may not report one as fact.
    const speculative =
      /\b(engines? (stop|start|will|would|repeat|favour|favor|prefer|treat|credit)|get(s)? passed over|far more readily|is what makes an engine|days rather than weeks|no other fix covers|stops confusing)\b/i;
    const offenders = Object.entries(REC_COPY)
      .filter(([id]) => ["GEO-25", "GEO-07", "GEO-04", "GEO-14", "GEO-27", "GEO-35", "GEO-11"].includes(id))
      .filter(([, c]) => speculative.test(c.description))
      .map(([id]) => id);
    expect(offenders).toEqual([]);
  });

  it("uses no dash punctuation, the client-copy rule (AF-8)", () => {
    const gaps = computeCheckGaps(GEO_READINESS_CHECKS, allFailing(GEO_READINESS_CHECKS), "GEO");
    for (const s of suggest(gaps, { limit: 99 })) {
      expect(s.title).not.toMatch(/ - |—/);
      expect(s.why).not.toMatch(/ - |—/);
    }
  });
});
