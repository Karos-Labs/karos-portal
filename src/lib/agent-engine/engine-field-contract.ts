/**
 * C3 (SCRUM-211) — which brief fields agent-engine workflows actually READ,
 * versus which ones this portal sends (or could send) that no workflow
 * consumes today.
 *
 * `toEngineRunInput` (`./product-mapping.ts`) answers "what does the wire
 * payload contain" — T-B12 (SCRUM-266) made that side honest: every field a
 * dialog shows now reaches the payload. It does NOT answer "what does the
 * agent DO with it once the payload lands" — nothing in this repo can answer
 * that from `toEngineRunInput`'s own code, because the answer lives in a
 * different repository's workflow implementations
 * (`agent-engine/agents/<product>-agent/src/workflow/create-*-workflow.ts`).
 *
 * This file is that missing half, read out of agent-engine's actual source
 * (commit `8156679`, 2026-08-29 — see each entry's citation) rather than
 * assumed from the field's name or its dialog label. It exists so T-A13
 * (SCRUM-269) has a real, evidenced list of "still-decoration" fields to
 * build engine-side readers against, instead of re-deriving this audit from
 * scratch or guessing from field names (a field named `tone` looks read; it
 * is not, anywhere, today).
 *
 * ## Method
 *
 * For every key `toEngineRunInput` can put on the wire, agent-engine's
 * `agents/*` and `apps/agent-server` trees were grepped for a real read of
 * that key off `WorkflowContext.input` (`wf.input.<key>`, `wf.input[key]`, or
 * a destructure of the same) inside each of the 11 products this portal can
 * currently reach (`REACHABLE_PRODUCTS` below — `campaign-orchestrator` and
 * `intel-report-agent` are excluded because neither `resolveAgentEngineProductId`
 * nor `resolveAgentEngineProductIdForCustomAgent` in `./product-mapping.ts`
 * can ever route a run to them; auditing what they read would document
 * something this portal cannot exercise).
 *
 * A read of the SAME field name off `client.getConfig`/`client.getProfile` (a
 * tenant's STANDING configuration, fetched by its own tool call) does not
 * count as reading the wire field, and is called out explicitly wherever it
 * could be mistaken for one (blog-agent and newsletter-agent both have a
 * `requestedTopic` on their intake-config type, and instagram-agent has a
 * `requestedLane` — all three are populated from `client.getConfig`, never
 * from this run's own `wf.input`, so a run's brief cannot reach them this
 * way no matter what the portal sends).
 *
 * `customPrompt`/`mediaAssets` are read through the shared
 * `readRichRunInput`/`readRunDirection` primitives
 * (`packages/core/src/types/run-input.ts`,
 * `packages/workflow/src/primitives/run-direction.ts`); every other field
 * here is read (or not) by each product's own workflow directly.
 *
 * ## Why `WireFieldKey` is DERIVED, not a hand-copied list (fixes the prior
 * round's rejection)
 *
 * A prior version of this file declared `WIRE_FIELD_KEYS` as its own 25-key
 * string-literal array and claimed the `Record<WireFieldKey, FieldContractEntry>`
 * annotation below was a build-time guard against a new wire field shipping
 * without a contract row. That claim was false for the exact drift scenario
 * the guard exists to prevent: `WIRE_FIELD_KEYS` was a standalone list,
 * disconnected from `product-mapping.ts`'s actual (then-unexported)
 * `SHARED_SCALAR_FIELDS`/`SHARED_LIST_FIELDS`/`DEDICATED_FIELDS` tables.
 * Verified empirically before this round's fix: adding a new tuple directly to
 * `DEDICATED_FIELDS` (say `["new_field", "newWireKey"]`) and NOT touching this
 * file left `tsc --noEmit` clean and the whole agent-engine-facing suite
 * green — the two files simply never talked to each other at the type level.
 *
 * The fix: `product-mapping.ts` now EXPORTS those three tables (each
 * `as const satisfies ReadonlyArray<...>`, so the `wireKey` slot keeps its
 * literal type instead of widening to `string`) plus `SPECIAL_CASED_WIRE_KEYS`
 * (the handful of keys `toEngineRunInput` sets by bespoke logic rather than by
 * walking a table — `customPrompt`, `mediaAssets`, `requestedTopic`,
 * `targetDate`, `postCount`). `WireFieldKey` below is a type built ENTIRELY
 * out of those exports — there is no second, independently-typed key list
 * anywhere in this codebase for the compiler to lose sync with. Re-run the
 * same empirical check after this fix (see `engine-field-contract.test.ts`'s
 * "the guard actually guards" section for the exact repro) and adding a row to
 * any of the three tables without a matching `ENGINE_FIELD_CONTRACT` entry
 * now fails `tsc --noEmit` with "Property '<newWireKey>' is missing in type
 * ... but required in type 'Record<WireFieldKey, FieldContractEntry>'".
 *
 * This closes the table-driven half of the drift (`DEDICATED_FIELDS`, the
 * exact table the prior round's rejection named, plus the other two). It does
 * NOT — and this file does not claim it does — close the bespoke half: a
 * brand-new `input.xyz = ...` line added straight into `toEngineRunInput`'s
 * body, with no row added to `SPECIAL_CASED_WIRE_KEYS`, has no table for
 * TypeScript to widen a type from, so it cannot fail the BUILD. That case is
 * instead caught at TEST time by `engine-field-contract.test.ts`'s exhaustive
 * sweep, which drives `toEngineRunInput` with every dialog key this repo
 * defines and asserts every key the function actually returns is a member of
 * `WIRE_FIELD_KEYS` — so an un-catalogued bespoke field fails `npm test`, not
 * `tsc --noEmit`. Two mechanisms, two different failure modes, stated
 * separately rather than folded into one overclaimed "build-time guard"
 * sentence.
 */

import {
  DEDICATED_FIELDS,
  SHARED_LIST_FIELDS,
  SHARED_SCALAR_FIELDS,
  SPECIAL_CASED_WIRE_KEYS,
} from "./product-mapping";

/** The agent-engine `productId`s this portal can actually dispatch a run to today (`./product-mapping.ts`'s two resolvers, exhaustively). `campaign-orchestrator` and `intel-report-agent` exist in agent-engine but neither resolver can ever name them. */
export const REACHABLE_PRODUCTS = [
  "x-agent",
  "instagram-agent",
  "linkedin-agent",
  "reddit-agent",
  "blog-agent",
  "newsletter-agent",
  "landing-builder-agent",
  "branded-shorts-agent",
  "tiktok-agent",
  "reputation-agent",
  "seo-geo-agent",
] as const;
export type ReachableProductId = (typeof REACHABLE_PRODUCTS)[number];

/**
 * Pulls the literal `wireKey` slot (index 1) out of one of `product-mapping.ts`'s
 * `as const satisfies` tables. `T[number]` is the union of that table's row
 * types; indexing `[1]` off a union distributes over it, so this really is
 * "every wireKey any row in this table names," not just the first row's.
 */
type WireKeyOf<T extends ReadonlyArray<readonly [string, string, ...unknown[]]>> = T[number][1];

/**
 * THE derived union — every wire key `toEngineRunInput` can emit, built
 * entirely from `product-mapping.ts`'s own exports (see this file's header).
 * Add a row to any of the three tables, or a key to `SPECIAL_CASED_WIRE_KEYS`,
 * and this union widens on its own; there is nothing here to keep in sync by
 * hand.
 */
export type WireFieldKey =
  | WireKeyOf<typeof SHARED_SCALAR_FIELDS>
  | WireKeyOf<typeof SHARED_LIST_FIELDS>
  | WireKeyOf<typeof DEDICATED_FIELDS>
  | (typeof SPECIAL_CASED_WIRE_KEYS)[number];

/**
 * The same union, as a runtime array — for tests that need to iterate "every
 * wire key" rather than just name the type. Deduplicated because `mustInclude`
 * appears twice in `SHARED_LIST_FIELDS` (`must_include` and `success_criteria`
 * both fold into it).
 */
export const WIRE_FIELD_KEYS: readonly WireFieldKey[] = Array.from(
  new Set<WireFieldKey>([
    ...SHARED_SCALAR_FIELDS.map(([, wireKey]) => wireKey),
    ...SHARED_LIST_FIELDS.map(([, wireKey]) => wireKey),
    ...DEDICATED_FIELDS.map(([, wireKey]) => wireKey),
    ...SPECIAL_CASED_WIRE_KEYS,
  ]),
);

export interface FieldContractEntry {
  /**
   * Products whose engine workflow genuinely reads this key off its OWN
   * run's `WorkflowContext.input` today. Each citation is a real file:line
   * in agent-engine, not an inference from the field's name.
   */
  readBy: ReadonlyArray<{ product: ReachableProductId; evidence: string }>;
  /**
   * Products that can carry this key on the wire today (per a dialog this
   * portal renders, or `toEngineRunInput`'s own folding rules — e.g. a
   * `references`/`sources` box folding into `mediaAssets`) whose workflow
   * never reads it. This is T-A13's worklist for this field: give the field
   * a reader, or the portal should stop collecting it — C3's own principle,
   * restated in `product-mapping.test.ts`'s T-B12 section header, is that a
   * dialog field must do one or the other.
   */
  sentButUnread: readonly ReachableProductId[];
  /** One-line note for a field with no current sender at all (neither a dialog nor a non-dialog caller sets it), so an empty `sentButUnread` isn't misread as "nothing to fix here". */
  note?: string;
  /**
   * True when NOTHING in this repo currently sets this key in `briefValues`
   * (no dialog field, no server action) — distinct from an empty
   * `sentButUnread`, which `customPrompt` also has, for the opposite reason
   * (everything that sends it is read). Grepped this repo for the literal
   * key outside test files; explicit rather than inferred so a field that is
   * merely read-by-everyone can never be mistaken for one nobody sends.
   */
  noCurrentSender?: true;
}

/**
 * THE CONTRACT. Typed as `Record<WireFieldKey, FieldContractEntry>` — with
 * `WireFieldKey` now DERIVED from `product-mapping.ts`'s own exported tables
 * (see this file's header) — is the real build-time guard: add a row to
 * `DEDICATED_FIELDS`/`SHARED_SCALAR_FIELDS`/`SHARED_LIST_FIELDS`, which
 * happens the moment `toEngineRunInput` grows a new TABLE-DRIVEN wire field,
 * without adding a row here, and `tsc --noEmit` fails on this object literal
 * with a missing-property error. The explicit annotation also keeps every
 * entry's type uniform (so an entry that happens to have no `note` today
 * doesn't statically forget that `note` and `noCurrentSender` exist). That is
 * deliberately the same shape as `ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY` (C5):
 * the guard cannot be satisfied by a filter over keys nobody named, only by a
 * row someone actually wrote after checking the engine source.
 *
 * A bespoke (non-table) wire field — one added via a new line inside
 * `toEngineRunInput`'s body plus a matching entry in
 * `SPECIAL_CASED_WIRE_KEYS` — ALSO fails to compile here the moment it's
 * added to `SPECIAL_CASED_WIRE_KEYS`, for the same structural reason. What is
 * NOT caught by `tsc` is a bespoke field added to `toEngineRunInput`'s body
 * and never added to `SPECIAL_CASED_WIRE_KEYS` at all — there is no exported
 * table for the compiler to widen a type from in that case.
 * `engine-field-contract.test.ts`'s exhaustive-payload sweep exists
 * specifically to catch that remaining case at test time.
 */
export const ENGINE_FIELD_CONTRACT: Record<WireFieldKey, FieldContractEntry> = {
  // ── Read almost everywhere: the two shared, agent-agnostic fields ──

  customPrompt: {
    // Every reachable product resolves `readRunDirection(wf.input)` and then
    // consumes `.direction`/`.topicOverride`, or spreads
    // `runDirectionField(runDirection)` into a drafting step's input.
    readBy: [
      { product: "x-agent", evidence: "agents/x-agent/src/workflow/create-x-agent-workflow.ts:71,208-209" },
      { product: "instagram-agent", evidence: "agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts:387,656-657" },
      { product: "linkedin-agent", evidence: "agents/linkedin-agent/src/workflow/create-linkedin-agent-workflow.ts:183,398-399" },
      { product: "reddit-agent", evidence: "agents/reddit-agent/src/workflow/create-reddit-agent-workflow.ts:89,251-252" },
      { product: "blog-agent", evidence: "agents/blog-agent/src/workflow/create-blog-agent-workflow.ts:80,201-202" },
      { product: "newsletter-agent", evidence: "agents/newsletter-agent/src/workflow/create-newsletter-agent-workflow.ts:102,217-220" },
      { product: "landing-builder-agent", evidence: "agents/landing-builder-agent/src/workflow/create-landing-builder-agent-workflow.ts:109,149,161,219 (runDirectionField spread into three steps)" },
      { product: "branded-shorts-agent", evidence: "agents/branded-shorts-agent/src/workflow/create-branded-shorts-agent-workflow.ts:78-86 (own comment: reaches the two editorial steps, not the cut planner)" },
      { product: "tiktok-agent", evidence: "agents/tiktok-agent/src/workflow/create-tiktok-agent-workflow.ts:201-205 (readRichRunInput; rich.customPrompt wins over requestedTopic for the topic claim)" },
      { product: "reputation-agent", evidence: "agents/reputation-agent/src/workflow/create-reputation-pulse-workflow.ts:168,481" },
      { product: "seo-geo-agent", evidence: "agents/seo-geo-agent/src/workflow/create-seo-geo-agent-workflow.ts:148 (+ runDirectionField downstream)" },
      // NOT listed, deliberately: `intel-report-agent`. It reads `customPrompt`
      // (workflow lines 112/147/276 — the direction narrows the research query
      // before the draft step ever sees it), and since the Phase A cutover this
      // portal really does send it one, from the Regenerate modal via
      // `dispatch-research-agents.ts`. But that dispatch does not go through
      // `toEngineRunInput`, and this file's whole method — including the
      // grounding check in its test, which drives `toEngineRunInput` per listed
      // product — is scoped to the run-dialog wire path and its eleven
      // `REACHABLE_PRODUCTS`. Adding a row here would assert something this
      // file has no evidence path for. The evidence for that dispatch lives at
      // the send site instead.
    ],
    sentButUnread: [],
  },

  mediaAssets: {
    // Only two products ever look at `.mediaAssets`. Every other reachable
    // product calls `readRunDirection`/`readRichRunInput` too (so a malformed
    // attachment is parsed and silently dropped exactly as designed) but
    // never reads the parsed array back out.
    readBy: [
      { product: "instagram-agent", evidence: "agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts:806 (filters role === source|reference)" },
      { product: "tiktok-agent", evidence: "agents/tiktok-agent/src/workflow/create-tiktok-agent-workflow.ts:237 (firstAsset(rich.mediaAssets, \"source\"))" },
    ],
    // branded-shorts: dialog shows both a raw `mediaAssets` field AND
    // `source_url` (which product-mapping.ts also folds into mediaAssets) —
    // its own workflow comment says outright "mediaAssets is unread here".
    // landing-builder: `references` folds into mediaAssets; blog: `sources`
    // does the same. Neither workflow ever touches `.mediaAssets`.
    sentButUnread: ["branded-shorts-agent", "landing-builder-agent", "blog-agent"],
  },

  // ── requestedTopic: read by 4 of the 6 products whose dialog can send it ──

  requestedTopic: {
    readBy: [
      { product: "x-agent", evidence: "agents/x-agent/src/workflow/create-x-agent-workflow.ts:93-95 (RUN_SCOPED_KEYS, wf.input[key])" },
      { product: "reddit-agent", evidence: "agents/reddit-agent/src/workflow/create-reddit-agent-workflow.ts:125-127 (same pattern)" },
      { product: "linkedin-agent", evidence: "agents/linkedin-agent/src/workflow/create-linkedin-agent-workflow.ts:71-79,226-227,254 (RUN_SCOPED_KEYS via withRunInput(config, wf.input))" },
      { product: "tiktok-agent", evidence: "agents/tiktok-agent/src/workflow/create-tiktok-agent-workflow.ts:203-205 (runInput.requestedTopic, only when customPrompt is absent)" },
    ],
    // instagram-agent and blog-agent/newsletter-agent each have a same-named
    // `requestedTopic`/`requestedSubject` on an intake-config TYPE, which
    // reads misleadingly like this field — all three are populated from
    // `client.getConfig()` (the tenant's standing config store), never from
    // `wf.input`. A run's own brief cannot reach them:
    //   - instagram-agent: create-instagram-agent-workflow.ts:449-452 reads
    //     `requestedSubject` (a DIFFERENT key) off `client.getConfig`'s
    //     result, not `requestedTopic` off `wf.input` at all.
    //   - blog-agent: create-blog-agent-workflow.ts:92-110 reads
    //     `config.requestedTopic` off `configOutcome.result`
    //     (`client.getConfig`) — confirmed directly: `config.requestedTopic`
    //     comes from `configOutcome = tools["client.getConfig"].execute(...)`,
    //     never off `wf.input`.
    //   - newsletter-agent: create-newsletter-agent-workflow.ts:110,127, same
    //     client-config-only pattern.
    // landing-builder-agent, branded-shorts-agent and reputation-agent's
    // dialogs also show `request` -> `requestedTopic`, and none of the three
    // reads `requestedTopic` anywhere (grepped, zero hits beyond the type/
    // comment level) — they only ever consume the run through `customPrompt`.
    // seo-geo-agent's `request` box never becomes `requestedTopic` in the
    // first place (product-mapping.ts's `REQUEST_IS_DIRECTION_PRODUCT`
    // routes it into `customPrompt` instead), so it is not "unread" here —
    // it is simply never sent.
    sentButUnread: [
      "instagram-agent",
      "blog-agent",
      "newsletter-agent",
      "landing-builder-agent",
      "branded-shorts-agent",
      "reputation-agent",
    ],
  },

  // ── SHARED_SCALAR_FIELDS (audience/tone/cta) — read by NOTHING, anywhere ──

  audience: {
    readBy: [],
    // reddit-agent: only via the GENERIC profile (karos-reddit-setup).
    sentButUnread: ["reddit-agent", "instagram-agent", "tiktok-agent", "landing-builder-agent", "blog-agent", "newsletter-agent"],
  },

  tone: {
    readBy: [],
    sentButUnread: ["newsletter-agent"],
  },

  cta: {
    readBy: [],
    sentButUnread: ["branded-shorts-agent", "landing-builder-agent", "newsletter-agent"],
  },

  // ── SHARED_LIST_FIELDS — also read by nothing ──

  mustInclude: {
    readBy: [],
    // reddit-agent's `success_criteria` alias (the GENERIC profile's own
    // constraints box) folds into this exact same list — equally unread.
    sentButUnread: ["reddit-agent", "instagram-agent", "tiktok-agent", "newsletter-agent"],
  },

  keywords: {
    readBy: [],
    // blog-agent reads its OWN `targetKeywords` off `client.getConfig`
    // (create-blog-agent-workflow.ts:92-99) — a real, load-bearing read, but
    // of the client's standing config, never of this run's `keywords`.
    sentButUnread: ["blog-agent"],
  },

  // ── Fields no current dialog renders at all ──

  targetDate: {
    readBy: [],
    sentButUnread: [],
    noCurrentSender: true,
    note: "No dialog in this portal shows target_date/targetDate (checked every ENGINE_ROUTED_DIALOGS row in product-mapping.test.ts), and no server action sets it either — grepped this repo for the literal key, zero non-test hits. Doubly dead today: nothing sends it, and no agent-engine workflow reads it (grepped agent-engine's agents/ tree for a wf.input read, zero hits). Kept in toEngineRunInput's allow-list for when a scheduling surface needs it, per that function's own doc comment.",
  },

  postCount: {
    readBy: [],
    sentButUnread: ["instagram-agent", "tiktok-agent"],
  },

  // ── DEDICATED_FIELDS ──

  runScope: {
    readBy: [],
    // The one dedicated field whose own dialog (X draft's "run_scope") sends
    // it and whose product (x-agent) still never reads it — x-agent's
    // RUN_SCOPED_KEYS is only ["requestedTopic", "requestedLane"].
    sentButUnread: ["x-agent"],
  },

  requestedLane: {
    // Genuinely read by x-agent off `wf.input` directly. instagram-agent has
    // its OWN `requestedLane`, but sourced from `client.getConfig()`
    // (create-instagram-agent-workflow.ts:417-420,452) — the client's
    // standing lane assignment, not this run's brief — so it does not count
    // as reading the wire field this portal would send.
    readBy: [{ product: "x-agent", evidence: "agents/x-agent/src/workflow/create-x-agent-workflow.ts:93-95,232 (RUN_SCOPED_KEYS; selectLane(intake.requestedLane, ...))" }],
    sentButUnread: [],
    noCurrentSender: true,
    note: "No dialog field renders this key (product-mapping.ts's own doc comment: one of the five requested* keys with no dialog field at all) and no server action in this repo sets it either — so today the one product that reads it never receives it from any live caller.",
  },

  requestedArchetype: {
    readBy: [{ product: "linkedin-agent", evidence: "agents/linkedin-agent/src/workflow/create-linkedin-agent-workflow.ts:71-96,226-227,254 (RUN_SCOPED_KEYS; parseArchetype(record.requestedArchetype))" }],
    sentButUnread: [],
    noCurrentSender: true,
    note: "No dialog field renders this key and no server action sets it — same idle-but-wired state as requestedLane.",
  },

  liIdentity: {
    // THE flagship finding of this audit. linkedin-agent's own RUN_SCOPED_KEYS
    // is ["requestedTopic", "requestedArchetype", "requestedIdentityScope",
    // "requestedExecutiveName"] (verified directly at
    // create-linkedin-agent-workflow.ts:71) — "liIdentity" appears in NONE of
    // them, and was grepped across the whole agent-engine tree with zero hits
    // outside this portal's own doc comments. Both live senders hit the same
    // wall:
    //   - the LinkedIn writer/setup dialog's "Choose my seat" /
    //     "Set up" field (custom-agent-launch.ts's LINKEDIN_IDENTITY_FIELD_KEY)
    //   - runLinkedInSetupAction (src/lib/actions/linkedin-agent-actions.ts:
    //     598-601), which sets briefValues.li_identity to "company" or
    //     `seat:<seatId>` directly, bypassing the dialog entirely.
    // Both become `liIdentity` on the wire via product-mapping.ts's
    // DEDICATED_FIELDS row and are then silently ignored: linkedin-agent
    // always falls back to `options.identityScope ?? "company"`
    // (create-linkedin-agent-workflow.ts:228,257), so every run posts as the
    // company regardless of which seat a client picked. This is a live user-
    // facing defect this audit surfaced as a side effect, not a hypothetical.
    readBy: [],
    sentButUnread: ["linkedin-agent"],
    note: "The engine's actual identity fields are requestedIdentityScope (\"company\"|\"executive\") and requestedExecutiveName (an executive's NAME, matched case-insensitively — see selectExecutive, create-linkedin-agent-workflow.ts:102-104), not a single combined liIdentity/seat-id string. Translating li_identity's \"company\"|\"seat:<id>\" shape into those two keys (the id -> executive NAME lookup agent-engine expects) is real per-run logic this portal does not have today, not a one-line rename — see the cross-repo follow-up note below.",
  },

  requestedSubreddit: {
    readBy: [{ product: "reddit-agent", evidence: "agents/reddit-agent/src/workflow/create-reddit-agent-workflow.ts:125-127" }],
    sentButUnread: [],
    noCurrentSender: true,
    note: "No dialog field renders this key and no server action sets it.",
  },

  requestedThreadUrl: {
    readBy: [{ product: "reddit-agent", evidence: "agents/reddit-agent/src/workflow/create-reddit-agent-workflow.ts:125-127" }],
    sentButUnread: [],
    noCurrentSender: true,
    note: "No dialog field renders this key and no server action sets it.",
  },

  requestedThreadTitle: {
    readBy: [{ product: "reddit-agent", evidence: "agents/reddit-agent/src/workflow/create-reddit-agent-workflow.ts:125-127" }],
    sentButUnread: [],
    noCurrentSender: true,
    note: "No dialog field renders this key and no server action sets it.",
  },

  runMode: {
    readBy: [],
    sentButUnread: ["instagram-agent", "tiktok-agent", "blog-agent"],
  },

  platform: {
    // Read by the PORTAL (resolveAgentEngineProductId's instagram/tiktok
    // routing decision, made before dispatch) but by no engine WORKFLOW —
    // once a run lands inside instagram-agent/tiktok-agent/branded-shorts-
    // agent, nothing reads wf.input.platform back out. The gate calls in
    // several agents' self-critique steps (e.g. `gateArgs: { platform: "x" }`)
    // are fixed string literals the agent supplies itself, never a value read
    // off this run's input — a different "platform" entirely.
    readBy: [],
    sentButUnread: ["instagram-agent", "tiktok-agent", "branded-shorts-agent"],
  },

  duration: {
    readBy: [],
    sentButUnread: ["branded-shorts-agent"],
  },

  offer: {
    readBy: [],
    sentButUnread: ["landing-builder-agent"],
  },

  proof: {
    readBy: [],
    // landing-builder-agent's own make.ts has an unrelated static site-build
    // constant literally named "proof" (the ProofStrip component's prop
    // name) — a coincidence of naming, not a read of this run's input.
    sentButUnread: ["landing-builder-agent"],
  },

  website: {
    readBy: [],
    // seo-geo-agent reads its OWN "website" off `client.getProfile()`
    // (create-seo-geo-agent-workflow.ts:63), never off `wf.input` — same
    // client-config-not-run-input shape as requestedTopic above.
    sentButUnread: ["seo-geo-agent"],
  },

  scope: {
    readBy: [],
    sentButUnread: ["seo-geo-agent"],
  },

  market: {
    readBy: [],
    sentButUnread: ["seo-geo-agent"],
  },

  competitors: {
    readBy: [],
    // seo-geo-agent's own `clientContext.competitors` comes from a
    // `client.*` tool read (create-seo-geo-agent-workflow.ts:170-176,203),
    // never off `wf.input`.
    sentButUnread: ["seo-geo-agent"],
  },
};
