import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * WHAT THE ADMIN OPS-IMPORT CONFIRM PROMISES, asked of the RENDER.
 *
 * Two claims, both about a dialog that authorizes a write to a live client
 * record, and both invisible to a source scan:
 *
 *  · #106 — the reassurance ("fields a human already filled are skipped, never
 *    overwritten") is true of documents, competitors and the profile fills and
 *    FALSE of the brand palette, which `buildWriteOps` replaces wholesale. Worse
 *    in the bulk confirm, which renders the manifest with `compact` and used to
 *    drop the caveat altogether while still listing — and writing — the palette.
 *    `toContain("brand palette")` over the file passes on the doc comment
 *    alone, and passes whether the warning is conditional or unconditional; only
 *    rendering the manifest with and without the palette ticked separates them.
 *
 *  · #110 — the surface writes to another client's brand data and had no render
 *    path from `clientId` to a link. A scan for `href` cannot tell a link that
 *    is painted from one that is spelled in a component nothing mounts.
 *
 * The components under test are exported for this file (see their doc comments);
 * from `OpsImport` the confirm is a server action and two clicks away, which
 * `renderToStaticMarkup` cannot drive.
 */

vi.mock("server-only", () => ({}));
// The module graph reaches the server-action barrel; nothing here needs it.
vi.mock("@/lib/actions", () => ({
  applyOpsBundleAction: vi.fn(),
  planOpsBundleAction: vi.fn(),
  scanLabForUpdatesAction: vi.fn(),
}));
vi.mock("@/lib/actions/lab-import-actions", () => ({ importLabRunAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import type { PlanSummary } from "@/lib/actions/ops-import-actions";
import { OpsImport, OutcomePanel, WriteManifest } from "@/components/ops-import";

/**
 * The reassurance, SCOPED TO PROFILE FIELDS — which is the only thing it is true
 * of. It read "Fields a human already filled are skipped, never overwritten",
 * which generalises over documents, competitors and the SEO/GEO snapshot; the
 * apply core's own header says documents "may be updated or created" and that
 * only "every other client profile field is FILL-ONLY".
 */
const BLANKET_PROMISE = /Profile fields a human already filled are skipped/;

/**
 * The palette's own row, keyed to the two facts that make it worth a warning:
 * it names the outgoing and incoming values, and it says nothing restores them.
 *
 * NOT keyed to "unlike everything above it". The first version of this fix said
 * that, and it is FALSE — three of the five line kinds above the palette also
 * overwrite stored content. A caveat written because the dialog over-promised
 * must not become a second false statement on the dialog that authorizes the
 * write, which is a worse outcome than the blanket promise it replaced.
 */
const PALETTE_WARNING = /Nothing on this page puts it back/i;

/** The clause that must NOT come back: it exonerates writes that do overwrite. */
const FALSE_CONTRAST = /unlike everything above/i;

const DOC_KEY = "doc:brand-voice@internal";
const PALETTE_KEY = "client:palette";

function planWith(palette: boolean): PlanSummary {
  return {
    origin: "inbox",
    ref: "acme.json",
    label: "acme.json",
    clientId: "client-acme",
    clientName: "Acme",
    docs: [
      {
        key: DOC_KEY,
        label: "brand-voice · internal",
        action: "update",
        detail: "1,000 → 1,200 chars",
        verifyTokens: 0,
      },
    ],
    competitors: [],
    profileFills: [],
    skippedProfile: [],
    brandingFills: [],
    colors: palette ? { from: ["#111111"], to: ["#222222", "#333333", "#444444"] } : null,
    items: [
      { key: DOC_KEY, kind: "doc", label: "brand-voice", requires: [], requiresReason: null },
      ...(palette
        ? [
            {
              key: PALETTE_KEY,
              kind: "palette" as const,
              label: "Brand palette",
              requires: [],
              requiresReason: null,
            },
          ]
        : []),
    ],
    warnings: [],
    counts: { docWrites: 1, compWrites: 0, clientTouched: palette, verifyTotal: 0, totalWrites: 2 },
    seoGeo: null,
    lockedReason: null,
    fingerprint: "fp",
    priorImport: null,
  };
}

/** The manifest as the confirm paints it, for a given tick state and face. */
function manifest(opts: { palette: boolean; ticked: boolean; compact: boolean }): string {
  const plan = planWith(opts.palette);
  const selectedKeys = opts.palette && opts.ticked ? [DOC_KEY, PALETTE_KEY] : [DOC_KEY];
  return renderToStaticMarkup(
    <WriteManifest pick={{ plan, selectedKeys, includeSeoGeo: false }} compact={opts.compact} />,
  );
}

/** Markup text with the tags and React's numeric entities taken back out. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** How many times a phrase appears — `String.match` with a non-global regex
 *  answers 1 for "twice", which is the difference one test below measures. */
function occurrences(text: string, phrase: string): number {
  return text.split(phrase).length - 1;
}

/** One parseable inbox bundle, so the page has a card rather than a void. */
const ACME_BUNDLE = {
  file: "acme.json",
  clientId: "client-acme",
  clientName: "Acme",
  error: null,
  counts: { docs: 1, competitorUpdates: 0, competitorCreates: 0 },
  hasSeoGeo: false,
  priorImport: null,
};

describe("#106 the confirm's promise matches what it is about to write", () => {
  it("keeps the blanket promise when no palette is being written", () => {
    const text = textOf(manifest({ palette: false, ticked: false, compact: false }));
    expect(text).toMatch(BLANKET_PROMISE);
    expect(text).not.toMatch(PALETTE_WARNING);
  });

  it("keeps it when a palette is in the plan but the operator unticked it", () => {
    // The tick is the whole point of the manifest: an item nobody selected is
    // not written, so warning about it would be its own false statement.
    const text = textOf(manifest({ palette: true, ticked: false, compact: false }));
    expect(text).toMatch(BLANKET_PROMISE);
    expect(text).not.toMatch(PALETTE_WARNING);
  });

  it("drops the blanket promise and warns, once the palette is ticked", () => {
    const text = textOf(manifest({ palette: true, ticked: true, compact: false }));
    expect(text).not.toMatch(BLANKET_PROMISE);
    expect(text).toMatch(PALETTE_WARNING);
  });

  it("warns in the BULK confirm too, which renders compact", () => {
    // The worse half of #106: "Import all reviewed" passes `compact`, the caveat
    // was gated on `!compact`, and the multi-client dialog therefore listed
    // palette replacements with no caveat at all and wrote every one of them.
    const text = textOf(manifest({ palette: true, ticked: true, compact: true }));
    expect(text).toMatch(PALETTE_WARNING);
  });

  it("names the colors going out and the colors coming in", () => {
    // A warning that does not say what is being replaced is a shrug. Both
    // directions, because the stored ones are what the operator loses.
    const text = textOf(manifest({ palette: true, ticked: true, compact: true }));
    expect(text).toContain("#111111");
    expect(text).toContain("#222222, #333333, #444444");
  });

  it("still lists the ordinary writes beside it", () => {
    for (const compact of [true, false]) {
      const text = textOf(manifest({ palette: true, ticked: true, compact }));
      expect(text, `compact=${compact}`).toContain("Update document brand-voice · internal");
    }
  });
});

describe("#108 the empty state carries the step it names", () => {
  it("offers the scan from inside the empty state, not only from the strip", () => {
    // Counted, because the strip above the list always carries one. Two means
    // the empty state grew its own `action`; one means it is back to a sentence
    // pointing at a control somewhere else on the page.
    const empty = textOf(renderToStaticMarkup(<OpsImport bundles={[]} />));
    const populated = textOf(renderToStaticMarkup(<OpsImport bundles={[ACME_BUNDLE]} />));
    expect(occurrences(populated, "Check for updates")).toBe(1);
    expect(occurrences(empty, "Check for updates")).toBe(2);
  });

  it("stops telling the reader to go and click something", () => {
    const empty = textOf(renderToStaticMarkup(<OpsImport bundles={[]} />));
    expect(empty).not.toContain("Click Check for updates");
  });
});

describe("#110 the page offers a way to go and look at the client's record", () => {
  it("paints a link to the client on a bundle card that names one", () => {
    const markup = renderToStaticMarkup(<OpsImport bundles={[ACME_BUNDLE]} />);
    expect(markup).toContain('href="/clients/client-acme"');
  });

  it("paints no client link when the source could not name a client", () => {
    // The fail-closed direction: a bundle whose clientId never parsed must not
    // produce `/clients/null`. Same render, one field different.
    const markup = renderToStaticMarkup(
      <OpsImport
        bundles={[
          {
            file: "broken.json",
            clientId: null,
            clientName: null,
            error: "Could not parse this bundle.",
            counts: null,
            hasSeoGeo: false,
            priorImport: null,
          },
        ]}
      />,
    );
    // KEYED TO THE ELEMENT, not to a URL prefix. `not.toContain('href="/clients/')`
    // is dodged by the natural loosening — replacing the `{row.clientId && …}`
    // guard with `clientId={row.clientId ?? ""}` — because next/link normalises
    // `/clients/` to `href="/clients"`, no trailing slash. That renders a LIVE
    // link to the clients INDEX for a bundle whose id never parsed, which is
    // worse than the `/clients/null` the comment names, and it read green.
    expect(markup, "a card with no parsed client id still offers a record link").not.toMatch(
      /href="\/clients(\/|")/,
    );
    expect(markup, "the link's own label appeared without a client to point at").not.toMatch(
      /Open the client record/i,
    );
  });

  it("offers the record to check the moment the write comes back", () => {
    // The id on ApplyOutcome is the plan's VALIDATED one, so this lands on the
    // record that was written rather than the one the file was filed under.
    const markup = renderToStaticMarkup(
      <OutcomePanel
        outcome={{
          origin: "inbox",
          ref: "acme.json",
          clientId: "client-acme",
          clientName: "Acme",
          refresh: { applied: true, docs: 1, competitors: 0, client: 1, error: null },
          seoGeo: { applied: false, skippedReason: null, error: null },
        }}
      />,
    );
    expect(markup).toContain('href="/clients/client-acme"');
    expect(textOf(markup)).toContain("Check Acme's record");
  });
});


describe("the caveat does not exonerate the writes it contrasts itself with", () => {
  /**
   * The palette IS the only wholesale replacement of a field a human picks, but
   * it is NOT the only line that overwrites: `Update document X` merges a whole
   * new body over the stored doc, `Update competitor Y` replaces typed fields,
   * and the SEO/GEO line replaces the stored snapshot when the incoming capture
   * is newer. Telling an operator otherwise, on the dialog that authorizes the
   * write, is the same class of defect as the blanket promise this fix removed —
   * one direction over-promises safety, the other over-promises danger elsewhere
   * being absent. Both leave the operator with a false model of the write.
   */
  it("never claims the palette is the only line that overwrites", () => {
    for (const compact of [false, true]) {
      const markup = textOf(manifest({ palette: true, ticked: true, compact }));
      expect(markup, `compact=${compact}`).not.toMatch(FALSE_CONTRAST);
    }
  });

  it("says what IS true of the other lines, so the operator is not left guessing", () => {
    // Scoped, not silent: the reassurance names profile fields and says the rest
    // are updated in place, rather than implying they are untouched.
    const markup = textOf(manifest({ palette: true, ticked: true, compact: false }));
    expect(markup).toMatch(/updated in place/i);
  });
});
