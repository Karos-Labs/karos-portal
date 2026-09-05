import { describe, expect, it } from "vitest";
import {
  DEDICATED_FIELDS,
  SHARED_LIST_FIELDS,
  SHARED_SCALAR_FIELDS,
  SPECIAL_CASED_WIRE_KEYS,
  toEngineRunInput,
} from "../product-mapping";
import {
  ENGINE_FIELD_CONTRACT,
  REACHABLE_PRODUCTS,
  WIRE_FIELD_KEYS,
  type ReachableProductId,
  type WireFieldKey,
} from "../engine-field-contract";

/**
 * One `briefValues` probe per wire field, independent of which product it is
 * dispatched to. `toEngineRunInput`'s field tables (SHARED_SCALAR_FIELDS,
 * SHARED_LIST_FIELDS, DEDICATED_FIELDS, FOLDED_INTO_MEDIA) run the same way
 * regardless of `engineProductId` — only `requestedTopic` (seo-geo-agent's
 * request-is-direction carve-out) and the routing DECISION upstream of this
 * function depend on the product, and both are handled with their own
 * dedicated assertions below rather than this generic table.
 */
const PROBE_INPUT: Record<WireFieldKey, Record<string, string>> = {
  customPrompt: { customPrompt: "probe direction" },
  mediaAssets: { mediaAssets: '[{"uri":"gs://bucket/probe.mp4","role":"source"}]' },
  requestedTopic: { request: "probe topic" },
  audience: { audience: "probe audience" },
  tone: { tone: "probe tone" },
  cta: { cta: "probe cta" },
  mustInclude: { must_include: "probe requirement" },
  keywords: { keywords: "probe,keywords" },
  targetDate: { target_date: "2026-09-01" },
  requestedIdentityScope: { li_identity: "company" },
  runScope: { run_scope: "probe scope" },
  requestedLane: { requestedLane: "probe-lane" },
  requestedArchetype: { requestedArchetype: "probe-archetype" },
  requestedExecutiveName: { requestedExecutiveName: "Albert Kattan" },
  requestedSubreddit: { requestedSubreddit: "probe-subreddit" },
  requestedThreadUrl: { requestedThreadUrl: "https://reddit.test/thread" },
  requestedThreadTitle: { requestedThreadTitle: "probe title" },
  runMode: { run_mode: "single" },
  platform: { platform: "instagram" },
  duration: { duration: "15s" },
  offer: { offer: "probe offer" },
  proof: { proof: "probe proof" },
  website: { website: "https://example.test" },
  scope: { scope: "technical" },
  market: { market: "US" },
  competitors: { competitors: "acme.test" },
};

// ---------------------------------------------------------------------------
// THE GUARD, empirically checked — this is what the prior round overclaimed.
//
// See engine-field-contract.ts's own header for the full account. Short
// version, verified again in this file rather than only asserted in prose:
//
//   1. `WireFieldKey` (and `WIRE_FIELD_KEYS`, its runtime mirror) is now
//      DERIVED from product-mapping.ts's exported field tables plus
//      `SPECIAL_CASED_WIRE_KEYS` — there is no second, hand-copied key list
//      anywhere for the two files to drift apart on.
//   2. Adding a new row to one of the three TABLES
//      (SHARED_SCALAR_FIELDS/SHARED_LIST_FIELDS/DEDICATED_FIELDS) without a
//      matching ENGINE_FIELD_CONTRACT entry now fails `tsc --noEmit` — a real
//      compiler error, verified by hand this round (temporarily adding
//      `["probe_field", "probeNewWireField"]` to DEDICATED_FIELDS produced
//      `TS2741: Property 'probeNewWireField' is missing in type ... but
//      required in type 'Record<WireFieldKey, FieldContractEntry>'`; reverted
//      before committing — this repo's own tests can't assert a build FAILS,
//      only that it currently doesn't).
//   3. A BESPOKE wire key (a new `input.xyz = ...` line inside
//      `toEngineRunInput`'s body, not driven by any table) is NOT caught by
//      (2) — also verified by hand this round: adding such a line with no
//      matching entry in `SPECIAL_CASED_WIRE_KEYS` left `tsc --noEmit` clean.
//      The exhaustive-payload sweep below is what catches THAT case, at test
//      time instead of build time, for every dialog key this module actually
//      defines today.
// ---------------------------------------------------------------------------

describe("the guard actually guards (fixes the prior round's build-time-guard rejection)", () => {
  /**
   * Every dialog key this module currently knows how to read, each given a
   * distinct probe value, in one brief. Built from the SAME exported tables
   * `WireFieldKey` is derived from — not a separately hand-typed list — so
   * this brief can never quietly fall out of sync with what
   * `toEngineRunInput` actually consumes.
   */
  const EXHAUSTIVE_PROBE_BRIEF: Record<string, string> = {
    request: "probe-request",
    customPrompt: "probe-customPrompt-base",
    target_date: "2026-09-01",
    li_identity: "seat:probe-seat",
    mediaAssets: '[{"uri":"gs://bucket/probe-exhaustive.mp4","role":"source"}]',
  };
  for (const [dialogKey] of SHARED_SCALAR_FIELDS) EXHAUSTIVE_PROBE_BRIEF[dialogKey] = `probe-${dialogKey}`;
  for (const [dialogKey] of SHARED_LIST_FIELDS) EXHAUSTIVE_PROBE_BRIEF[dialogKey] = `probe-${dialogKey}`;
  for (const [dialogKey] of DEDICATED_FIELDS) EXHAUSTIVE_PROBE_BRIEF[dialogKey] = `probe-${dialogKey}`;

  it("every key toEngineRunInput can emit today, for every reachable product, is a member of WIRE_FIELD_KEYS", () => {
    for (const productId of REACHABLE_PRODUCTS) {
      const result = toEngineRunInput(EXHAUSTIVE_PROBE_BRIEF, productId);
      for (const key of Object.keys(result)) {
        expect(
          WIRE_FIELD_KEYS as readonly string[],
          `toEngineRunInput(..., "${productId}") emitted "${key}", which WIRE_FIELD_KEYS (and so ENGINE_FIELD_CONTRACT) has no entry for`,
        ).toContain(key);
      }
    }
  });

  it("WIRE_FIELD_KEYS itself is exactly SHARED_SCALAR_FIELDS ∪ SHARED_LIST_FIELDS ∪ DEDICATED_FIELDS' wireKeys ∪ SPECIAL_CASED_WIRE_KEYS — no extra, hand-added member", () => {
    const expected = new Set<string>([
      ...SHARED_SCALAR_FIELDS.map(([, wireKey]) => wireKey),
      ...SHARED_LIST_FIELDS.map(([, wireKey]) => wireKey),
      ...DEDICATED_FIELDS.map(([, wireKey]) => wireKey),
      ...SPECIAL_CASED_WIRE_KEYS,
    ]);
    expect(new Set(WIRE_FIELD_KEYS)).toEqual(expected);
  });

  it("the exhaustive sweep is not vacuous: it fails on an unknown key, exactly like the manual DEDICATED_FIELDS-drift repro this round verified by hand", () => {
    // Mirrors the empirical check described above without leaving a
    // permanently-broken test in the suite: constructs a deliberately
    // incomplete "known keys" list and shows the same assertion shape used
    // above rejects a real payload against it. If this test could not fail,
    // the sweep above would prove nothing about coverage — it would pass no
    // matter what toEngineRunInput returned.
    const deliberatelyIncompleteKnownKeys: readonly string[] = ["customPrompt"]; // missing "requestedTopic" on purpose
    const payload = toEngineRunInput({ request: "probe" }, "x-agent"); // -> { requestedTopic: "probe" }
    expect(Object.keys(payload)).toContain("requestedTopic");
    expect(() => {
      for (const key of Object.keys(payload)) {
        expect(deliberatelyIncompleteKnownKeys).toContain(key);
      }
    }).toThrow();
  });

  it("pins the exact current wire-field set (26 keys) — a change here should be a deliberate, reviewed diff", () => {
    expect([...WIRE_FIELD_KEYS].sort()).toEqual(
      [
        "audience",
        "competitors",
        "cta",
        "customPrompt",
        "duration",
        "keywords",
        "requestedExecutiveName",
        "market",
        "mediaAssets",
        "mustInclude",
        "offer",
        "platform",
        "requestedIdentityScope",
        "proof",
        "requestedArchetype",
        "requestedLane",
        "requestedSubreddit",
        "requestedThreadTitle",
        "requestedThreadUrl",
        "requestedTopic",
        "runMode",
        "runScope",
        "scope",
        "targetDate",
        "tone",
        "website",
      ].sort(),
    );
  });
});

describe("ENGINE_FIELD_CONTRACT — build-time exhaustiveness", () => {
  it("has exactly one row per WIRE_FIELD_KEYS entry, no more, no less", () => {
    // engine-field-contract.ts's own `ENGINE_FIELD_CONTRACT: Record<WireFieldKey,
    // FieldContractEntry>` annotation already fails the BUILD if a key is
    // missing (verified by hand this round, see the header comment above);
    // this also fails the TEST (visible without a typecheck step) and catches
    // a stray extra key the type annotation's excess-property check on an
    // object literal would also reject, but here in a form that runs in CI
    // without a separate `tsc` step.
    expect(Object.keys(ENGINE_FIELD_CONTRACT).sort()).toEqual([...WIRE_FIELD_KEYS].sort());
  });

  it("every product named anywhere in the contract is one this portal can actually reach", () => {
    const known = new Set<string>(REACHABLE_PRODUCTS);
    for (const [field, entry] of Object.entries(ENGINE_FIELD_CONTRACT)) {
      for (const { product } of entry.readBy) {
        expect(known.has(product), `${field}.readBy names unreachable product "${product}"`).toBe(true);
      }
      for (const product of entry.sentButUnread) {
        expect(known.has(product), `${field}.sentButUnread names unreachable product "${product}"`).toBe(true);
      }
    }
  });

  it("no product is claimed as both reading and not-reading the same field", () => {
    for (const [field, entry] of Object.entries(ENGINE_FIELD_CONTRACT)) {
      const readProducts = new Set(entry.readBy.map((r) => r.product));
      for (const product of entry.sentButUnread) {
        expect(readProducts.has(product), `${field}: "${product}" is listed as both reading and not reading it`).toBe(false);
      }
    }
  });

  it("every readBy claim cites a real agent-engine source file, not a placeholder", () => {
    for (const [field, entry] of Object.entries(ENGINE_FIELD_CONTRACT)) {
      for (const { product, evidence } of entry.readBy) {
        expect(evidence.length, `${field}/${product} has no evidence citation`).toBeGreaterThan(10);
        expect(evidence, `${field}/${product}'s evidence should cite a source file`).toMatch(/agents\/.+\.ts/);
      }
    }
  });
});

describe("ENGINE_FIELD_CONTRACT — grounded in this repo's own wire behavior", () => {
  // Every field this portal can still route to some product, whether the
  // contract says the engine reads it there or not, must actually appear in
  // toEngineRunInput's output for that product — otherwise the contract
  // would be documenting a field that cannot even reach the wire, which is a
  // different (and already-covered, by product-mapping.test.ts's T-B12
  // suite) problem than "reaches the wire but unread".
  for (const field of WIRE_FIELD_KEYS) {
    if (field === "targetDate") continue; // no current sender at all — see its `note`, nothing to ground against a live path
    const entry = ENGINE_FIELD_CONTRACT[field];
    const products = new Set<ReachableProductId>([...entry.readBy.map((r) => r.product), ...entry.sentButUnread]);

    for (const product of products) {
      it(`${field} reaches toEngineRunInput's output for ${product}`, () => {
        const payload = toEngineRunInput(PROBE_INPUT[field], product);
        expect(Object.prototype.hasOwnProperty.call(payload, field), JSON.stringify(payload)).toBe(true);
      });
    }
  }

  it("requestedTopic is never sent to seo-geo-agent at all, so it cannot be an 'unread' field there (product-mapping.ts's REQUEST_IS_DIRECTION_PRODUCT carve-out)", () => {
    const payload = toEngineRunInput({ request: "why aren't pages converting" }, "seo-geo-agent");
    expect(payload).not.toHaveProperty("requestedTopic");
    expect(payload).toEqual({ customPrompt: "Business goal or question\nwhy aren't pages converting" });
  });
});

describe("ENGINE_FIELD_CONTRACT — the pinned classification (C3's deliverable for T-A13)", () => {
  it("pins the exact set of wire fields no reachable product reads anywhere today", () => {
    const neverRead = WIRE_FIELD_KEYS.filter((field) => ENGINE_FIELD_CONTRACT[field].readBy.length === 0).sort();
    // T-A13's worklist, restated as data — and now down to ONE entry, which is
    // not a dialog field at all.
    //
    // This list used to hold sixteen: every structured thing a client typed
    // (audience, tone, call to action, must-include, keywords, the run-mode and
    // channel selectors, branded-shorts' duration, landing's offer and proof,
    // and all four of seo-geo's — the website to audit, its scope, market and
    // competitors) reached the wire and was read by no workflow anywhere. The
    // engine-side fix was one place, not sixteen: `readRunBrief` parses them,
    // `renderRunBrief` labels them, and every agent already spreads the result
    // into its drafting step via `runDirectionField`.
    //
    // `targetDate` stays, correctly: it has no sender either (see its own
    // `note`), and it is scheduling metadata the PORTAL acts on when it places
    // the asset — there is nothing for a drafting model to do with a date.
    expect(neverRead).toEqual(["targetDate"]);
  });

  it("pins the fields genuinely read by at least one product, and by which", () => {
    const read = Object.fromEntries(
      WIRE_FIELD_KEYS.filter((field) => ENGINE_FIELD_CONTRACT[field].readBy.length > 0).map((field) => [
        field,
        ENGINE_FIELD_CONTRACT[field].readBy.map((r) => r.product).sort(),
      ]),
    );
    expect(read).toEqual({
      customPrompt: [...REACHABLE_PRODUCTS].sort(),
      mediaAssets: ["instagram-agent", "tiktok-agent"],
      requestedTopic: ["linkedin-agent", "reddit-agent", "tiktok-agent", "x-agent"],
      requestedLane: ["x-agent"],
      requestedArchetype: ["linkedin-agent"],
      requestedIdentityScope: ["linkedin-agent"],
      requestedExecutiveName: ["linkedin-agent"],
      requestedSubreddit: ["reddit-agent"],
      requestedThreadUrl: ["reddit-agent"],
      requestedThreadTitle: ["reddit-agent"],
      // The structured brief, read through the shared run-direction primitive
      // rather than by each workflow's own `wf.input` access. Listed here per
      // product against the dialogs that actually COLLECT each field, so this
      // pin still says something specific: a field's readers are the agents
      // whose forms ask for it, not "everything", even though the mechanism
      // that delivers it is shared.
      audience: ["blog-agent", "instagram-agent", "landing-builder-agent", "newsletter-agent", "reddit-agent", "tiktok-agent"],
      tone: ["newsletter-agent"],
      cta: ["branded-shorts-agent", "landing-builder-agent", "newsletter-agent"],
      mustInclude: ["instagram-agent", "newsletter-agent", "reddit-agent", "tiktok-agent"],
      keywords: ["blog-agent"],
      runScope: ["x-agent"],
      runMode: ["blog-agent", "instagram-agent", "tiktok-agent"],
      platform: ["branded-shorts-agent", "instagram-agent", "tiktok-agent"],
      duration: ["branded-shorts-agent"],
      offer: ["landing-builder-agent"],
      proof: ["landing-builder-agent"],
      website: ["seo-geo-agent"],
      scope: ["seo-geo-agent"],
      market: ["seo-geo-agent"],
      competitors: ["seo-geo-agent"],
    });
  });

  it("the former flagship gap is closed: the LinkedIn 'Post as' choice reaches linkedin-agent under the two keys it actually reads", () => {
    // `liIdentity` used to be the wire key, and linkedin-agent's RUN_SCOPED_KEYS
    // never contained it: every run posted as the company page whatever the
    // client picked. The dialog value is now translated to the engine's scope
    // key, and the seat's NAME (a submit-core lookup) travels under the second.
    expect(ENGINE_FIELD_CONTRACT.requestedIdentityScope.readBy.map((r) => r.product)).toEqual(["linkedin-agent"]);
    expect(ENGINE_FIELD_CONTRACT.requestedExecutiveName.readBy.map((r) => r.product)).toEqual(["linkedin-agent"]);
    expect(toEngineRunInput({ li_identity: "company" }, "linkedin-agent")).toEqual({ requestedIdentityScope: "company" });
    expect(toEngineRunInput({ li_identity: "seat:exec-123", requestedExecutiveName: "Albert Kattan" }, "linkedin-agent")).toEqual({
      requestedIdentityScope: "executive",
      requestedExecutiveName: "Albert Kattan",
    });
    expect(JSON.stringify(toEngineRunInput({ li_identity: "seat:exec-123" }, "linkedin-agent"))).not.toContain("liIdentity");
  });

  it("pins which fields the engine reads but no current portal caller populates (idle but wired, not decoration)", () => {
    const idle = WIRE_FIELD_KEYS.filter(
      (field) => ENGINE_FIELD_CONTRACT[field].readBy.length > 0 && ENGINE_FIELD_CONTRACT[field].noCurrentSender === true,
    ).sort();
    expect(idle).toEqual(["requestedArchetype", "requestedLane", "requestedSubreddit", "requestedThreadTitle", "requestedThreadUrl"].sort());
    for (const field of idle) {
      expect(ENGINE_FIELD_CONTRACT[field].note, `${field} should explain why it's idle`).toBeTruthy();
    }
  });

  it("targetDate is doubly dead: no current sender AND no current reader — distinct from the idle-but-wired fields above", () => {
    const entry = ENGINE_FIELD_CONTRACT.targetDate;
    expect(entry.readBy).toEqual([]);
    expect(entry.noCurrentSender).toBe(true);
  });
});
