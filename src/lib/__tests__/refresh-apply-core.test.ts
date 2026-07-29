import { describe, expect, it } from "vitest";

import {
  buildWriteOps,
  docItemKey,
  planItems,
  validateProposal,
  validateSelection,
  PALETTE_ITEM_KEY,
  PROFILE_ITEM_KEY,
  type CurrentState,
  type Row,
} from "@/lib/refresh-apply-core";

/**
 * The refresh safety contract (CD-G7), now that it is shared by the CLI and the
 * admin Ops Import page.
 *
 * These are REFUSAL tests. The fences here are the only thing standing between
 * a hand-written JSON file and the live client portal, and each one exists
 * because the alternative is a specific, silent data loss: a shrunk document, a
 * blanked competitor list, an internal document published at tier "client", a
 * human's hand-written profile field overwritten by a machine. A test that only
 * checked the happy path would let any of those regress.
 */

/* ── Fixtures ────────────────────────────────────────────────────────── */

/** A body that clears the shape gates: frontmatter, >= 2 sections, >= 800 chars. */
function docBody(opts: { sections?: number; pad?: number; extra?: string } = {}): string {
  const sections = opts.sections ?? 4;
  const pad = opts.pad ?? 60;
  const body = Array.from(
    { length: sections },
    (_, i) => `## Section ${i + 1}\n\n${`Measured detail for section ${i + 1}. `.repeat(pad)}`,
  ).join("\n\n");
  // Trimmed: validation trims content, so an untrimmed fixture would never
  // compare equal to its own stored copy.
  return `---\ntitle: Test document\n---\n\n${body}${opts.extra ?? ""}`.trim();
}

function current(overrides: Partial<CurrentState> = {}): CurrentState {
  return {
    clientId: "client-1",
    clientName: "Acme Co",
    client: {},
    docs: new Map(),
    competitors: [],
    ...overrides,
  };
}

function proposal(overrides: Row = {}): Row {
  return { schemaVersion: 1, clientId: "client-1", clientName: "Acme Co", ...overrides };
}

/** The brandingGuidelines patch from the single `clients` op, or fail loudly. */
function brandingPatch(ops: ReturnType<typeof buildWriteOps>): Row {
  const op = ops.find((o) => o.collection === "clients");
  if (!op) throw new Error("expected a clients write op");
  return op.data.brandingGuidelines as Row;
}

/** Assert refusal and return the joined errors, so tests can match on the reason. */
function refuse(p: Row, c: CurrentState = current()): string {
  const res = validateProposal(p, c);
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  return res.errors.join("\n");
}

function accept(p: Row, c: CurrentState = current()) {
  const res = validateProposal(p, c);
  if (!res.ok) throw new Error(`expected acceptance, got:\n${res.errors.join("\n")}`);
  return res.plan;
}

/* ── Envelope ────────────────────────────────────────────────────────── */

describe("proposal envelope", () => {
  it("refuses an unknown top-level key rather than ignoring it", () => {
    expect(refuse(proposal({ assets: [] }))).toContain('unknown key "assets"');
  });

  it("refuses a schemaVersion it does not implement", () => {
    expect(refuse(proposal({ schemaVersion: 2 }))).toContain("schemaVersion: expected 1");
  });

  it("refuses to cross-apply a proposal aimed at another client", () => {
    expect(refuse(proposal({ clientId: "client-2" }))).toContain("clientId:");
  });

  // The cheapest guard against applying the right schema to the wrong client:
  // ids are opaque, names are not.
  it("refuses when the proposal's clientName disagrees with the stored name", () => {
    expect(refuse(proposal({ clientName: "Other Corp" }))).toContain("refusing to cross-apply");
  });

  it("reports every problem at once, so a reviewer fixes the file in one pass", () => {
    const res = validateProposal({ schemaVersion: 9, clientId: "nope", junk: 1 }, current());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.length).toBeGreaterThanOrEqual(3);
  });
});

/* ── Documents: the no-shrink and no-leak fences ─────────────────────── */

describe("document fences", () => {
  const stored = (content: string, id = "doc-1", version = 3): CurrentState =>
    current({ docs: new Map([["brand-voice@internal", { id, content, version, docType: "brand-voice", tier: "internal" }]]) });

  it("refuses a document that drops a section, even when it grew longer", () => {
    const before = docBody({ sections: 5, pad: 20 });
    const after = docBody({ sections: 4, pad: 200 });
    expect(after.length).toBeGreaterThan(before.length);
    const errors = refuse(
      proposal({ docs: [{ docType: "brand-voice", tier: "internal", content: after }] }),
      stored(before),
    );
    expect(errors).toContain("never removes a section");
  });

  it("refuses a document that shrinks below 90% of the stored one", () => {
    const before = docBody({ sections: 4, pad: 100 });
    const after = docBody({ sections: 4, pad: 40 });
    expect(refuse(
      proposal({ docs: [{ docType: "brand-voice", tier: "internal", content: after }] }),
      stored(before),
    )).toContain("floor 90%");
  });

  it("lets a written shrinkApproved reason relax the length floor to 50%", () => {
    const before = docBody({ sections: 4, pad: 100 });
    const after = docBody({ sections: 4, pad: 70 });
    const plan = accept(
      proposal({
        docs: [
          {
            docType: "brand-voice",
            tier: "internal",
            content: after,
            shrinkApproved: "Removed the duplicated competitor table that market-strategy already carries.",
          },
        ],
      }),
      stored(before),
    );
    expect(plan.docs[0].action).toBe("update");
  });

  it("never lets shrinkApproved relax the section floor", () => {
    const before = docBody({ sections: 5, pad: 100 });
    const after = docBody({ sections: 3, pad: 100 });
    expect(refuse(
      proposal({
        docs: [
          {
            docType: "brand-voice",
            tier: "internal",
            content: after,
            shrinkApproved: "Consolidated three thin sections into one, deliberately and with review.",
          },
        ],
      }),
      stored(before),
    )).toContain("never removes a section");
  });

  // THE no-leak boundary: these two docTypes are internal-only, and writing
  // either at tier "client" would publish them to the client portal.
  it.each(["client-guidelines", "action-plan"])(
    "refuses to publish %s at tier client",
    (docType) => {
      expect(refuse(proposal({ docs: [{ docType, tier: "client", content: docBody() }] }))).toContain(
        "no-leak boundary",
      );
    },
  );

  it("refuses a docType that is not a refresh target at all", () => {
    expect(refuse(proposal({ docs: [{ docType: "meeting-notes", tier: "internal", content: docBody() }] }))).toContain(
      "not a refreshable document type",
    );
  });

  it("refuses [VERIFY] markers at tier client but allows them internally", () => {
    const withMarker = docBody({ extra: "\n\nFounded in 2011 [VERIFY]." });
    expect(refuse(proposal({ docs: [{ docType: "brand-voice", tier: "client", content: withMarker }] }))).toContain(
      "must never reach the client portal",
    );
    const plan = accept(proposal({ docs: [{ docType: "brand-voice", tier: "internal", content: withMarker }] }));
    expect(plan.counts.verifyTotal).toBe(1);
  });

  it("refuses the placeholder phrases the pipeline bans", () => {
    expect(refuse(
      proposal({ docs: [{ docType: "brand-voice", tier: "internal", content: docBody({ extra: "\n\nRevenue: data unavailable." }) }] }),
    )).toContain("banned placeholder");
  });

  it("refuses a body with no frontmatter and one with too few sections", () => {
    expect(refuse(
      proposal({ docs: [{ docType: "brand-voice", tier: "internal", content: docBody().slice(4) }] }),
    )).toContain("YAML frontmatter");
    expect(refuse(
      proposal({ docs: [{ docType: "brand-voice", tier: "internal", content: docBody({ sections: 1, pad: 200 }) }] }),
    )).toContain("sections");
  });

  it("refuses two entries for the same docType and tier", () => {
    const c = docBody();
    expect(refuse(
      proposal({
        docs: [
          { docType: "brand-voice", tier: "internal", content: c },
          { docType: "brand-voice", tier: "internal", content: c },
        ],
      }),
    )).toContain("duplicate entry");
  });

  it("marks a byte-identical document unchanged instead of bumping its version", () => {
    const body = docBody();
    const plan = accept(
      proposal({ docs: [{ docType: "brand-voice", tier: "internal", content: body }] }),
      stored(body),
    );
    expect(plan.docs[0].action).toBe("unchanged");
    expect(plan.counts.totalWrites).toBe(0);
  });
});

/* ── Competitors ─────────────────────────────────────────────────────── */

describe("competitor fences", () => {
  const roster: Row[] = [
    { id: "c1", company: "Rival Inc", url: "rival.com", keyStrengths: ["scale", "brand"] },
  ];

  it("refuses an update aimed at an id this client does not own", () => {
    expect(refuse(
      proposal({ competitors: { update: [{ id: "someone-elses", company: "Rival Inc" }] } }),
      current({ competitors: roster }),
    )).toContain("is not a competitor of this client");
  });

  it("refuses to empty a list that currently holds entries", () => {
    expect(refuse(
      proposal({ competitors: { update: [{ id: "c1", keyStrengths: [] }] } }),
      current({ competitors: roster }),
    )).toContain("never blanks data");
  });

  it("refuses to blank a scalar field", () => {
    expect(refuse(
      proposal({ competitors: { update: [{ id: "c1", positioning: "   " }] } }),
      current({ competitors: roster }),
    )).toContain("never blanks a field");
  });

  /* A proposal is written against an export taken days earlier, so a "create"
     for a row that has since landed is a stale export — not an error. Refusing
     the whole bundle over it turned a routine refresh into a hand-editing job
     (Albert hit this on Geektime). These pin the reconciliation. */
  describe("reconciling a create onto a row that already exists", () => {
    it("folds a name match onto the existing row instead of refusing", () => {
      const plan = accept(
        proposal({ competitors: { create: [{ company: "Rival Inc", url: "elsewhere.com", positioning: "budget tier" }] } }),
        current({ competitors: roster }),
      );
      expect(plan.competitors[0]).toMatchObject({
        action: "update",
        id: "c1",
        reconciled: { matchedBy: "name", matchedCompany: "Rival Inc" },
      });
      // No new row: the roster count is unchanged.
      expect(plan.competitors.filter((c) => c.action === "create")).toHaveLength(0);
    });

    it("folds a domain match on too, even when the name differs", () => {
      const plan = accept(
        proposal({
          competitors: {
            create: [{ company: "Rival (rebranded)", url: "https://www.rival.com/about", scale: "200 staff" }],
          },
        }),
        current({ competitors: roster }),
      );
      expect(plan.competitors[0]).toMatchObject({ action: "update", id: "c1", reconciled: { matchedBy: "url" } });
      expect(plan.competitors[0].changes).toEqual([{ field: "scale", from: undefined, to: "200 staff" }]);
    });

    // Renaming a roster row on the strength of a URL match is not this pass's
    // call, and on a name match the company is what matched — either way it is
    // the join key, not a field to write.
    it("never writes company through a reconciled create", () => {
      const plan = accept(
        proposal({ competitors: { create: [{ company: "Rival (rebranded)", url: "rival.com" }] } }),
        current({ competitors: roster }),
      );
      expect(plan.competitors[0].data).not.toHaveProperty("company");
      expect(plan.competitors[0].changes.map((c) => c.field)).not.toContain("company");
    });

    it("still applies the never-blank-a-list rule once the row is known", () => {
      expect(refuse(
        proposal({ competitors: { create: [{ company: "Rival Inc", url: "rival.com", keyStrengths: [] }] } }),
        current({ competitors: roster }),
      )).toContain("never blanks data");
    });

    it("reports no change when the reconciled row already says the same thing", () => {
      const plan = accept(
        proposal({ competitors: { create: [{ company: "Rival Inc", url: "rival.com" }] } }),
        current({ competitors: roster }),
      );
      expect(plan.competitors[0].action).toBe("unchanged");
      expect(plan.counts.compWrites).toBe(0);
    });

    // Reconciliation is for the unambiguous case. Two candidates is a genuine
    // question about intent, and guessing would silently merge the wrong row.
    it("refuses when the create matches two different rows", () => {
      const twoWay: Row[] = [
        { id: "c1", company: "Rival Inc", url: "rival.com" },
        { id: "c2", company: "Other Co", url: "elsewhere.com" },
      ];
      expect(refuse(
        proposal({ competitors: { create: [{ company: "Rival Inc", url: "elsewhere.com" }] } }),
        current({ competitors: twoWay }),
      )).toContain("ambiguous");
    });

    it("refuses when the create resolves onto a row the same proposal updates", () => {
      expect(refuse(
        proposal({
          competitors: {
            update: [{ id: "c1", positioning: "one thing" }],
            create: [{ company: "Rival Inc", url: "rival.com", positioning: "another thing" }],
          },
        }),
        current({ competitors: roster }),
      )).toContain("already updates");
    });

    it("writes a reconciled create as a merge on the stored id, never as a new row", () => {
      const plan = accept(
        proposal({ competitors: { create: [{ company: "Rival Inc", url: "rival.com", scale: "200 staff" }] } }),
        current({ competitors: roster }),
      );
      const ops = buildWriteOps(plan, 42);
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ kind: "merge", collection: "clientCompetitors", id: "c1" });
    });
  });

  it("refuses a new row without a working domain", () => {
    expect(refuse(proposal({ competitors: { create: [{ company: "Ghost Co" }] } }))).toContain("required on a new competitor row");
    // Parses as a URL, but a bare label is not a reachable competitor domain.
    expect(refuse(proposal({ competitors: { create: [{ company: "Ghost Co", url: "localhost" }] } }))).toContain(
      "does not resolve to a real hostname",
    );
    expect(refuse(proposal({ competitors: { create: [{ company: "Ghost Co", url: "not a domain" }] } }))).toContain(
      "is not a parseable domain or URL",
    );
  });

  it("normalizes a create url to the bare host the app stores", () => {
    const plan = accept(proposal({ competitors: { create: [{ company: "New Co", url: "https://www.new-co.io/pricing?x=1" }] } }));
    expect(plan.competitors[0].data.url).toBe("new-co.io");
  });

  it("refuses values outside the closed enums", () => {
    expect(refuse(proposal({ competitors: { update: [{ id: "c1", threatLevel: "Critical" }] } }), current({ competitors: roster })))
      .toContain("HIGH | MEDIUM | LOW");
  });

  it("reports no change when an update restates what is stored", () => {
    const plan = accept(
      proposal({ competitors: { update: [{ id: "c1", company: "Rival Inc" }] } }),
      current({ competitors: roster }),
    );
    expect(plan.competitors[0].action).toBe("unchanged");
    expect(plan.counts.compWrites).toBe(0);
  });
});

/* ── Client profile: fill-only ───────────────────────────────────────── */

describe("client profile is fill-only", () => {
  it("fills an empty field but never overwrites one a human set", () => {
    const plan = accept(
      proposal({ client: { profile: { website: "https://acme.test", industry: "Fintech" } } }),
      current({ client: { industry: "Payments" } }),
    );
    expect(plan.client.profile).toEqual([{ field: "website", from: undefined, to: "https://acme.test" }]);
    expect(plan.client.skippedProfile[0]).toMatchObject({ field: "industry" });
  });

  it("merges social links without displacing the ones already set", () => {
    const plan = accept(
      proposal({ client: { profile: { socialLinks: { instagram: "new-ig", linkedin: "new-li" } } } }),
      current({ client: { socialLinks: { instagram: "human-set-ig" } } }),
    );
    expect(plan.client.profile[0].to).toEqual({ instagram: "human-set-ig", linkedin: "new-li" });
  });

  it("refuses an unknown profile field", () => {
    expect(refuse(proposal({ client: { profile: { revenue: "1M" } } }))).toContain('unknown key "revenue"');
  });
});

/* ── Palette (CD-E2) ─────────────────────────────────────────────────── */

describe("palette gates", () => {
  const colors = (over: Row[] = []) =>
    over.length
      ? over
      : [
          { hex: "#111111", dominanceRank: 1, usagePct: 50 },
          { hex: "#222222", dominanceRank: 2, usagePct: 30 },
          { hex: "#333333", dominanceRank: 3, usagePct: 20 },
        ];

  /** A branding doc that restates the palette, as the gate requires. */
  const brandingDoc = () => docBody({ extra: "\n\nPalette: #111111, #222222, #333333." });

  const withDoc = (dominantColors: Row[]) =>
    proposal({
      docs: [{ docType: "branding-guidelines", tier: "internal", content: brandingDoc() }],
      client: { brandingGuidelines: { dominantColors } },
    });

  it("accepts a well-formed palette shipped with its document", () => {
    const plan = accept(withDoc(colors()));
    expect(plan.client.colors?.to).toHaveLength(3);
    expect(plan.counts.clientTouched).toBe(true);
  });

  it("refuses a palette that is not 3-4 colors", () => {
    expect(refuse(withDoc([{ hex: "#111111", dominanceRank: 1, usagePct: 100 }]))).toContain("expected 3 or 4 colors");
  });

  it("refuses usagePct that does not sum to exactly 100", () => {
    expect(refuse(withDoc([
      { hex: "#111111", dominanceRank: 1, usagePct: 50 },
      { hex: "#222222", dominanceRank: 2, usagePct: 30 },
      { hex: "#333333", dominanceRank: 3, usagePct: 10 },
    ]))).toContain("sum to exactly 100");
  });

  it("refuses duplicate hexes and out-of-order dominance ranks", () => {
    expect(refuse(withDoc([
      { hex: "#111111", dominanceRank: 1, usagePct: 50 },
      { hex: "#111111", dominanceRank: 2, usagePct: 30 },
      { hex: "#333333", dominanceRank: 3, usagePct: 20 },
    ]))).toContain("duplicate color");
    expect(refuse(withDoc([
      { hex: "#111111", dominanceRank: 3, usagePct: 50 },
      { hex: "#222222", dominanceRank: 2, usagePct: 30 },
      { hex: "#333333", dominanceRank: 1, usagePct: 20 },
    ]))).toContain("array order IS dominance order");
  });

  // The app regenerates the branding document from the palette on save, so a
  // palette moved without its document leaves every agent reading stale hexes.
  it("refuses a palette change with no branding-guidelines document alongside it", () => {
    expect(refuse(proposal({ client: { brandingGuidelines: { dominantColors: colors() } } }))).toContain(
      "carries no branding-guidelines document",
    );
  });

  it("refuses when the supplied document does not mention the new hexes", () => {
    expect(refuse(
      proposal({
        docs: [{ docType: "branding-guidelines", tier: "internal", content: docBody() }],
        client: { brandingGuidelines: { dominantColors: colors() } },
      }),
    )).toContain("palette and document must agree");
  });

  it("does not trip the gate when the palette is unchanged", () => {
    const stored = colors().map((c) => ({ ...c }));
    const plan = accept(
      proposal({ client: { brandingGuidelines: { dominantColors: colors() } } }),
      current({ client: { brandingGuidelines: { dominantColors: stored } } }),
    );
    expect(plan.client.colors).toBeNull();
  });
});

/* ── Write ops ───────────────────────────────────────────────────────── */

describe("buildWriteOps", () => {
  it("emits no delete for any proposal — the op type cannot express one", () => {
    const plan = accept(
      proposal({
        docs: [{ docType: "brand-voice", tier: "internal", content: docBody() }],
        competitors: { create: [{ company: "New Co", url: "new-co.io" }] },
        client: { profile: { website: "https://acme.test" } },
      }),
    );
    const ops = buildWriteOps(plan, 1_700_000_000_000);
    expect(ops.every((o) => o.kind === "create" || o.kind === "merge")).toBe(true);
  });

  it("writes a new document at version 1 and invalidates the cached summary", () => {
    const plan = accept(proposal({ docs: [{ docType: "brand-voice", tier: "internal", content: docBody() }] }));
    const op = buildWriteOps(plan, 42)[0];
    expect(op).toMatchObject({
      kind: "create",
      collection: "clientContextDocs",
      data: { clientId: "client-1", docType: "brand-voice", tier: "internal", version: 1, summary: null, summaryVersion: null, createdAt: 42, updatedAt: 42 },
    });
  });

  it("bumps the stored version on an update and targets the stored id", () => {
    const body = docBody({ pad: 61 });
    const plan = accept(
      proposal({ docs: [{ docType: "brand-voice", tier: "internal", content: body }] }),
      current({
        docs: new Map([["brand-voice@internal", { id: "doc-9", content: docBody({ pad: 60 }), version: 7 }]]),
      }),
    );
    expect(buildWriteOps(plan, 42)[0]).toMatchObject({ kind: "merge", id: "doc-9", data: { version: 8 } });
  });

  it("mirrors the palette onto the legacy accent scalars branding.ts still reads", () => {
    const plan = accept(
      proposal({
        docs: [{ docType: "branding-guidelines", tier: "internal", content: docBody({ extra: "\n\n#111111 #222222 #333333" }) }],
        client: { brandingGuidelines: { dominantColors: [
          { hex: "#111111", dominanceRank: 1, usagePct: 50 },
          { hex: "#222222", dominanceRank: 2, usagePct: 30 },
          { hex: "#333333", dominanceRank: 3, usagePct: 20 },
        ] } },
      }),
    );
    expect(brandingPatch(buildWriteOps(plan, 42))).toMatchObject({
      primaryAccent: "#111111",
      secondaryAccent: "#222222",
      brandNeutralDark: "#333333",
      brandNeutralLight: null,
    });
  });

  it("preserves branding fields it is not filling", () => {
    const plan = accept(
      proposal({ client: { brandingGuidelines: { fontHeading: "Inter" } } }),
      current({ client: { brandingGuidelines: { visualStyle: "editorial, high contrast" } } }),
    );
    expect(brandingPatch(buildWriteOps(plan, 42))).toMatchObject({
      visualStyle: "editorial, high contrast",
      fontHeading: "Inter",
    });
  });

  it("produces nothing at all when the proposal matches what is stored", () => {
    const plan = accept(proposal({}));
    expect(buildWriteOps(plan, 42)).toEqual([]);
  });
});

/* ── Selective import ────────────────────────────────────────────────── */

describe("selective import", () => {
  /** A palette change always ships with its branding document (the validator insists). */
  const paletteProposal = () =>
    proposal({
      docs: [
        { docType: "branding-guidelines", tier: "internal", content: docBody({ extra: "\n\n#111111 #222222 #333333" }) },
        { docType: "brand-voice", tier: "internal", content: docBody() },
      ],
      competitors: { create: [{ company: "New Co", url: "new-co.io" }] },
      client: {
        profile: { website: "https://acme.test" },
        brandingGuidelines: {
          dominantColors: [
            { hex: "#111111", dominanceRank: 1, usagePct: 50 },
            { hex: "#222222", dominanceRank: 2, usagePct: 30 },
            { hex: "#333333", dominanceRank: 3, usagePct: 20 },
          ],
        },
      },
    });

  const BRANDING_DOC = docItemKey("branding-guidelines", "internal");
  const VOICE_DOC = docItemKey("brand-voice", "internal");

  it("lists one tickable item per write and nothing for unchanged rows", () => {
    const body = docBody();
    const plan = accept(
      proposal({
        docs: [
          { docType: "brand-voice", tier: "internal", content: body },
          { docType: "market-strategy", tier: "internal", content: docBody({ pad: 70 }) },
        ],
      }),
      current({ docs: new Map([["brand-voice@internal", { id: "d1", content: body, version: 2 }]]) }),
    );
    expect(planItems(plan).map((i) => i.key)).toEqual([docItemKey("market-strategy", "internal")]);
  });

  it("writes only the ticked subset", () => {
    const plan = accept(paletteProposal());
    const ops = buildWriteOps(plan, 42, new Set([VOICE_DOC]));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ collection: "clientContextDocs", data: { docType: "brand-voice" } });
  });

  it("omitting the selection writes everything, as the CLI always has", () => {
    const plan = accept(paletteProposal());
    expect(buildWriteOps(plan, 42, undefined)).toEqual(buildWriteOps(plan, 42));
  });

  it("drops an unticked competitor without touching the others", () => {
    const roster: Row[] = [{ id: "c1", company: "Rival Inc", url: "rival.com" }];
    const plan = accept(
      proposal({
        competitors: {
          update: [{ id: "c1", positioning: "budget tier" }],
          create: [{ company: "New Co", url: "new-co.io" }],
        },
      }),
      current({ competitors: roster }),
    );
    const ops = buildWriteOps(plan, 42, new Set(["comp:c1"]));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "merge", id: "c1" });
  });

  // Profile fills and the palette share one `clients` document but are two
  // independent ticks, so taking one must not drag the other along.
  it("keeps profile fills and the palette independent inside the shared client doc", () => {
    const plan = accept(paletteProposal());

    const paletteOnly = buildWriteOps(plan, 42, new Set([PALETTE_ITEM_KEY, BRANDING_DOC]))
      .find((o) => o.collection === "clients");
    expect(paletteOnly!.data).not.toHaveProperty("website");
    expect(brandingPatch([paletteOnly!])).toMatchObject({ primaryAccent: "#111111" });

    const profileOnly = buildWriteOps(plan, 42, new Set([PROFILE_ITEM_KEY]))
      .find((o) => o.collection === "clients");
    expect(profileOnly!.data).toMatchObject({ website: "https://acme.test" });
    expect(profileOnly!.data).not.toHaveProperty("brandingGuidelines");
  });

  it("writes no client document when neither client item is ticked", () => {
    const plan = accept(paletteProposal());
    expect(buildWriteOps(plan, 42, new Set([VOICE_DOC])).some((o) => o.collection === "clients")).toBe(false);
  });

  describe("the palette's dependency on its document", () => {
    it("declares it when the branding document is itself a write", () => {
      const item = planItems(accept(paletteProposal())).find((i) => i.key === PALETTE_ITEM_KEY);
      expect(item?.requires).toEqual([BRANDING_DOC]);
      expect(item?.requiresReason).toContain("stale hex");
    });

    it("refuses a selection that takes the palette without its document", () => {
      const plan = accept(paletteProposal());
      const errors = validateSelection(plan, new Set([PALETTE_ITEM_KEY]));
      expect(errors.join(" ")).toContain("Brand palette needs");
    });

    it("accepts the pair together", () => {
      const plan = accept(paletteProposal());
      expect(validateSelection(plan, new Set([PALETTE_ITEM_KEY, BRANDING_DOC]))).toEqual([]);
    });

    // No dependency when the stored document already states the palette: it is
    // "unchanged", so there is no document write to keep in step with.
    it("declares no dependency when the branding document needs no rewrite", () => {
      const brandingBody = docBody({ extra: "\n\n#111111 #222222 #333333" });
      const plan = accept(
        proposal({
          docs: [{ docType: "branding-guidelines", tier: "internal", content: brandingBody }],
          client: {
            brandingGuidelines: {
              dominantColors: [
                { hex: "#111111", dominanceRank: 1, usagePct: 50 },
                { hex: "#222222", dominanceRank: 2, usagePct: 30 },
                { hex: "#333333", dominanceRank: 3, usagePct: 20 },
              ],
            },
          },
        }),
        current({ docs: new Map([["branding-guidelines@internal", { id: "d1", content: brandingBody, version: 4 }]]) }),
      );
      expect(planItems(plan).find((i) => i.key === PALETTE_ITEM_KEY)?.requires).toEqual([]);
      expect(validateSelection(plan, new Set([PALETTE_ITEM_KEY]))).toEqual([]);
    });
  });

  it("refuses a key that is not in the plan at all", () => {
    const plan = accept(paletteProposal());
    expect(validateSelection(plan, new Set(["doc:client-guidelines@client"])).join(" ")).toContain("not something this plan can write");
  });
});
