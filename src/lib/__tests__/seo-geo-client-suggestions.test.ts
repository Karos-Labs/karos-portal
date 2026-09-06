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
  // round 6: the whole GEO registry now yields exactly three ids, because
  // ownership is an explicit allow-list rather than a derivation off the
  // scoring bucket. "Only structural things the client is doing wrong AND our
  // agents cannot fix (accounts, records, relationships they own)."
  it("takes the three accounts and records, and nothing else in the registry", () => {
    const gaps = computeCheckGaps(
      GEO_READINESS_CHECKS,
      allFailing(GEO_READINESS_CHECKS),
      "GEO",
    );
    const ids = suggest(gaps, { limit: 99 }).map((s) => s.id);

    // A record, the account that owns it, and listings opened in the business's
    // name: nothing in this product can create, verify or ask for these.
    expect(ids.sort()).toEqual(["GEO-07", "GEO-14", "GEO-25"]);
    // round 6: GEO-04 is OUT. "≥10 authoritative domains mentioning the brand"
    // is coverage, which the LinkedIn and Reddit agents partly move, and its
    // ask ("get named on sites you don't own") is the general advice the ruling
    // rejected outright.
    expect(ids).not.toContain("GEO-04");
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

  // round 6: INVERTED. These three are OUTCOMES our agents exist to move
  // (share of voice, named-mention rate, never cited as a source), and they
  // were the three lines Albert quoted back as wrong. They now appear on
  // Reporting under "What we are doing to improve your SEO and GEO", as the
  // lever each agent moves, rather than as homework for the reader.
  it("never takes a competitor-visibility gap, whatever its delivery says", () => {
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
    // The producer still emits them (the plan catalogue is the cross-repo
    // contract), and every one of them is hardcoded `delivery: "advisory"` —
    // which is exactly why a derivation off delivery could not express the
    // ruling and an explicit set can.
    expect(gaps.length).toBeGreaterThan(0);
    expect(suggest(gaps, { limit: 99 })).toEqual([]);
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
    // round 6: re-fixtured onto GEO-07 — GEO-04 is no longer a client-owned id,
    // so the confidence rule could not be observed through it.
    const out = suggest(
      [gap({ id: "GEO-07", confidence: "LIKELY" }), gap({ id: "GEO-14", confidence: "HYPOTHESIS" })],
      { minConfidence: "LIKELY" },
    );
    expect(out.map((s) => s.id)).toEqual(["GEO-07"]);
  });
});

describe("buildClientSuggestions — measured only", () => {
  it("drops a gap whose check was estimated rather than measured", () => {
    // Both producers already emit measured gaps exclusively; a snapshot written
    // by an older pipeline is not covered by that, so the caller's checks
    // re-assert it.
    // round 6: re-fixtured onto GEO-07 for the same reason as the confidence
    // cut above.
    const checks: SeoGeoCheck[] = [
      { id: "GEO-25", bucket: "offsiteEntity", label: "x", evidence: "e", norm: 0, tier: "ESTIMATED", confidence: "CONFIRMED" },
      { id: "GEO-07", bucket: "offsiteEntity", label: "y", evidence: "e", norm: 0, tier: "MEASURED", confidence: "CONFIRMED" },
    ];
    const out = suggest([gap({ id: "GEO-25" }), gap({ id: "GEO-07" })], { checks });
    expect(out.map((s) => s.id)).toEqual(["GEO-07"]);
  });
});

describe("buildClientSuggestions — length and shape", () => {
  it("orders by lift, highest first", () => {
    // round 6: with three ids the cap of five cannot bite, so what is worth
    // pinning is the ORDER — and the cap is asked of `limit` directly below,
    // because it is still the contract this list is built on ("reduce it" was
    // half the ruling).
    const out = suggest([
      gap({ id: "GEO-25", scoreLift: 1 }),
      gap({ id: "GEO-07", scoreLift: 5 }),
      gap({ id: "GEO-14", scoreLift: 7 }),
    ]);
    expect(out.map((s) => s.id)).toEqual(["GEO-14", "GEO-07", "GEO-25"]);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("honours the cap a caller names", () => {
    const out = suggest(
      [
        gap({ id: "GEO-25", scoreLift: 1 }),
        gap({ id: "GEO-07", scoreLift: 5 }),
        gap({ id: "GEO-14", scoreLift: 7 }),
      ],
      { limit: 2 },
    );
    expect(out.map((s) => s.id)).toEqual(["GEO-14", "GEO-07"]);
  });

  it("collapses two instances of one finding, keeping the strongest", () => {
    // Rule 4, deduped BY COPY: one sentence, one row, whatever produced it.
    // round 6: re-fixtured off the per-engine gaps, which are no longer
    // client-owned, onto two instances of one client-owned id.
    const out = suggest([
      gap({ id: "GEO-14", scoreLift: 4, measured: "Found on 2 review platforms." }),
      gap({ id: "GEO-14", scoreLift: 9, measured: "Found on 1 review platform." }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toBe("Found on 1 review platform.");
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

  it("drops an id with no client copy even when the plan catalogue has some", () => {
    // round 6: the REC_COPY fallback is gone. GEO-04 keeps its catalogue entry
    // for the cross-repo plan contract, so before this an advisory id with no
    // client copy rendered with the voice of a row that has an Approve button
    // and a Karos owner behind it. Rule 6 always claimed the drop; now the code
    // does it. Asked at the widest threshold, so only the copy rule can be what
    // removes the row.
    expect(REC_COPY["GEO-04"]).toBeDefined();
    expect(
      suggest([gap({ id: "GEO-04", confidence: "CONFIRMED" })], { minConfidence: "HYPOTHESIS" }),
    ).toEqual([]);
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
    // round 6: GEO-04 is not client-owned any more, so the fixture says
    // lowConfidence with two ids that are.
    const out = buildClientSuggestions([
      gap({ id: "GEO-07", confidence: "LIKELY" }),
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
  // round 6: re-fixtured onto a client-owned id carrying an engine suffix. None
  // of the three ids is per-engine TODAY, and the rule is kept anyway because
  // the allow-list is deliberately keyed on the id before the `:` — so a future
  // per-engine instance of one of them is client-owned and must still say which
  // engine it was measured on.
  it("appends the engine when the producer's measured line does not carry it", () => {
    const [only] = suggest([
      gap({
        id: "GEO-14:chatgpt",
        measured: "Found on 1 review platform",
        evidence: "Measured across 12 category questions answered by ChatGPT",
      }),
    ]);
    expect(only.evidence).toBe("Found on 1 review platform, measured on ChatGPT");
  });

  it("leaves a line that already names its engine exactly as the producer wrote it", () => {
    const [only] = suggest([
      gap({ id: "GEO-14:gemini", measured: "Named on 0 of 12 Gemini review platforms" }),
    ]);
    expect(only.evidence).toBe("Named on 0 of 12 Gemini review platforms");
  });

  it("adds nothing to a finding that is not per engine", () => {
    const [only] = suggest([gap({ id: "GEO-25", measured: "No public reference entry found." })]);
    expect(only.evidence).toBe("No public reference entry found.");
  });
});

// round 6: GEO-27's wording moved to seo-geo.test.ts. It is no longer a client
// suggestion at all (it is an outcome our agents move), but `REC_COPY["GEO-27"]`
// still exists for the cross-repo plan contract and still must not claim the
// rival was "named more often" — so the assertion follows the copy rather than
// being deleted with the row.

describe("the copy a client is asked to act on", () => {
  it("never quotes an internal registry label", () => {
    const labels = new Set([...SEO_CHECKS, ...GEO_READINESS_CHECKS].map((d) => d.label));
    const gaps = computeCheckGaps(GEO_READINESS_CHECKS, allFailing(GEO_READINESS_CHECKS), "GEO");
    for (const s of suggest(gaps, { limit: 99 })) {
      expect(labels.has(s.title)).toBe(false);
      expect(labels.has(s.why)).toBe(false);
    }
  });

  it("keeps the audited copy free of the claims a check cannot support", () => {
    // The ruling was that these items "are not true". A check measures the state
    // of a page or a public record; it does not observe an engine deciding
    // anything, so the copy may not report one as fact.
    //
    // round 6: the same regex, now applied to the three ids this section can
    // actually render AND to the strings it renders for them, rather than to
    // seven REC_COPY descriptions the section no longer reads.
    const speculative =
      /\b(engines? (stop|start|will|would|repeat|favour|favor|prefer|treat|credit)|get(s)? passed over|far more readily|is what makes an engine|days rather than weeks|no other fix covers|stops confusing)\b/i;
    const gaps = computeCheckGaps(GEO_READINESS_CHECKS, allFailing(GEO_READINESS_CHECKS), "GEO");
    const rendered = suggest(gaps, { limit: 99 });
    expect(rendered).toHaveLength(3);
    for (const s of rendered) {
      expect(speculative.test(`${s.title} ${s.why}`), `${s.id}: ${s.why}`).toBe(false);
      // Nor a percentage, nor a promise: this section describes an ASK, and the
      // scores are the only thing on the tab that reports an effect.
      expect(s.why).not.toMatch(/\d+\s*%/);
      expect(`${s.title} ${s.why}`).not.toMatch(/\b(guarantee|boost|will rank)\b/i);
    }
    const offenders = Object.entries(REC_COPY)
      .filter(([id]) => ["GEO-25", "GEO-07", "GEO-14"].includes(id))
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
