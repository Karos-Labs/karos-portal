# Routable recommendation — cross-repo contract (SCRUM-210 / C2)

Status: **portal side implemented.** Engine side (the 75-record mapping table,
recommend.ts enrichment) is **not built** — that is T-A4/SCRUM-257, a separate
agent-engine-repo ticket. This document is the spec both sides build against.

**Where this lives today: only here, in karos-portal.** T-A4 (SCRUM-257) and
T-A17 (SCRUM-261) — the two tickets that consume this contract — are both
`Repo: agent-engine` per Jira. Nothing in this document, or in
`src/lib/agent-engine/routable-recommendation.ts`, is committed to the
agent-engine repo, so an agent-engine engineer picking up T-A4 has no
in-repo pointer to it today. **This is a known gap, not an oversight** — see
"Cross-repo follow-up" at the bottom for exactly what closes it.

## Why this exists

agent-engine's `seo-geo-agent` fires recommendations off a catalog
(`packages/tools/karos-seo-geo/src/config/rec-catalog.data.ts`, agent-engine
repo — 72 records as read on 2026-08-29; the ticket text says 75, which is
either stale or counts a superset this reading didn't reproduce) that carries,
per record: `check` (the failing check, i.e. the evidence), `lever`
(SEO/GEO/BOTH), `product_ref` (`{id, folder, status}`) — and, once T-A4 ships,
which of three categories owns the fix and which engine product runs it when
we own it.

Today's wire shape (`packages/tools/karos-seo-geo/src/recommend.ts`'s
`FiredRecommendation`, agent-engine repo, verified by reading that file
directly on 2026-08-29) is exactly ten fields of scoring output:

```
recId, recommendation, fireState, worstNorm, scoreLift,
impact, effort, delivery, priorityScore, hardOverride
```

`recommend.ts`'s own `RecCatalogEntry` type (the shape it reads off each
catalog row) is narrower still — `{ recommendation, impact, effort, delivery,
source }` — so `check`/`lever`/`product_ref` never even reach that function's
local variables, let alone its output. None of the catalog's routable hints
leave the catalog. `materializeSeoGeoReport` in karos-portal
(`src/lib/agent-engine/materialize.ts`) used to read exactly that ten-field
shape and turn it into a recId plus a prose bullet; there was nothing else in
the payload TO keep.

## Vocabulary — canonical, not invented here

`FixAction` and `ActionKind` are **karos-portal's own unions**
(`src/lib/seo-geo.ts`), used today by the client-facing SaaS action plan.
This contract declares them canonical for both repos — agent-engine does not
get its own, differently-spelled versions of either.

```ts
// src/lib/seo-geo.ts (karos-portal) — canonical, do not fork
export type FixAction =
  | "meta_title"
  | "meta_description"
  | "schema"
  | "og_image"
  | "canonical"
  | "image_alt"
  | "sitemap"
  | "indexing"
  | "manual";

export type ActionKind = "one_click" | "review_approve" | "connect" | "guided_manual";
```

`RecOwner` is **new** — the three-way split the original requirement asked
for, defined in `src/lib/agent-engine/routable-recommendation.ts` (karos-portal
only; agent-engine's own copy is T-A4's job):

```ts
export type RecOwner =
  | "karos_agent"   // our agent runs the fix automatically
  | "karos_tool"    // a tool or connector does it, not a full agent
  | "client_manual"; // we recommend the client do it themselves
```

**`client_manual` is the fail-safe default.** An unmapped, malformed, or
not-yet-classified record is `client_manual` — never silently promoted to
something the platform runs on its own.

## The canonical shape

`RoutableRecommendation` **extends** `FiredRecommendation` — it does not
replace it. Every existing scoring field stays exactly as-is; what's added is
what the catalog already holds and the old wire shape discarded, plus the new
routing:

| Field | Type | Notes |
|---|---|---|
| `recId` … `hardOverride` | *(ten `FiredRecommendation` fields, unchanged)* | |
| `check` | `string` | The failing check / the evidence (catalog `check`). Empty string if absent on the wire. |
| `lever` | `"SEO" \| "GEO" \| "BOTH"` | Defaults to `"BOTH"` if absent/unrecognized. |
| `productRef` | `{id, folder, status} \| null` | `folder` is a **lab folder name**, never an engine `productId` — see Rule 1. |
| `fixAction` | `FixAction` | Defaults to `"manual"` if absent/unrecognized. |
| `actionKind` | `ActionKind` | Defaults to `"guided_manual"` if absent/unrecognized. |
| `owner` | `RecOwner` | Defaults to `"client_manual"` if absent/unrecognized. |
| `targetPlatform?` | `string` | Optional, no default. |
| `engineProductId?` | `string` | **Only present, and only trusted, when `owner === "karos_agent"`.** See Rule 3. |

## The three rules (from the ticket, verbatim)

1. **`product_ref.folder` is a lab folder name, NOT an engine `productId`.**
   The mapping from a catalog record to an `engineProductId` is manual and
   reviewed — never derived automatically from a folder name string.
2. **`engineProductId` must come from `KNOWN_PRODUCT_IDS`** (agent-engine's
   `apps/agent-server/src/wiring/workflows.ts`; karos-portal's mirror is
   `KNOWN_ENGINE_PRODUCT_IDS` in `src/lib/agent-engine/product-mapping.ts`),
   enforced by a test on whichever side does the mapping.
3. **`owner === "karos_agent"` without a valid `engineProductId` is a build
   error** on the side that owns the 75-row mapping table (agent-engine, once
   T-A4 lands). karos-portal cannot enforce a build error against a value
   arriving over the wire at runtime, so its parser
   (`toRoutableRecommendation` in `routable-recommendation.ts`) fails safe
   instead: a `karos_agent` record whose `engineProductId` is missing or not a
   `KNOWN_ENGINE_PRODUCT_IDS` member is downgraded to `client_manual` and the
   invalid id is dropped, rather than ever being routed to a product nobody
   validated.

## Where the mapping table itself lives

**Not here.** The 75-ish-row `rec_id -> {fixAction, actionKind, owner,
engineProductId?}` table is, per the ticket, agent-engine's own artifact:
*"The mapping lives in the engine beside the catalog (the same commit updates
both); the portal consumes it through the output and keeps no copy."*
karos-portal's `routable-recommendation.ts` only defines the **shape** and a
**fail-safe parser** for whatever the engine sends — it holds no per-recId
mapping data and never will.

## Portal-side implementation (this repo)

- `src/lib/agent-engine/routable-recommendation.ts` — `RoutableRecommendation`,
  `RecOwner`, the fail-safe parser `toRoutableRecommendation`, the sprayer
  `groupRecommendationsByOwner`, and `hasClassifiedOwner` (distinguishes "the
  wire actually sent an owner" from "the parser defaulted one").
- `src/lib/agent-engine/materialize.ts`'s `materializeSeoGeoReport` calls the
  parser over the reported `firedRecommendations` and exposes the typed result
  as `meta.routableRecommendations` on the materialized asset — always
  populated (fail-safe data is still real data), so a future consumer never
  has to guess whether a given run predates this contract. A human-readable
  "Owner mix" summary line is added to the asset's rendered content **only
  when at least one record in the run actually carried a real `owner` field**
  (`hasClassifiedOwner`) — see "A note on shipping ahead of the data," below.
- `src/lib/agent-engine/__tests__/routable-recommendation.test.ts` pins
  `KNOWN_FIX_ACTIONS`/`KNOWN_ACTION_KINDS` against `seo-geo.ts`'s live
  `FixAction`/`ActionKind` declarations by parsing that file's AST directly
  (not a second hand-copied list), so either union gaining or losing a member
  fails this suite. `src/lib/agent-engine/__tests__/materialize.test.ts`
  exercises the same parser and sprayer **through the real
  `materializeAgentEngineDeliverable` pipeline**, so a regression in the
  wiring itself — not just in the isolated parser — fails a test.

## A note on shipping ahead of the data

As of 2026-08-29, agent-engine's `seo-geo-agent` workflow
(`create-seo-geo-agent-workflow.ts`) writes `firedRecommendations:
recommendations` where `recommendations` is a bare `FiredRecommendation[]` —
**zero** records carry `owner`, `fixAction`, or `engineProductId` on the wire
today. Every real report currently parses to `owner: "client_manual"` for
every recommendation, by the fail-safe default, not because anyone has
actually triaged them. karos-portal's materializer treats that distinction as
load-bearing: it withholds the "Owner mix" prose line until at least one
record on the wire carries a real, recognized `owner` value, so a report never
shows what looks like a genuine automatic/manual triage when nothing has
actually been classified yet. The moment T-A4 ships real `owner` data, the
line starts rendering — accurately, because by then it will be.

## Cross-repo follow-up (not done by this ticket — needs its own agent-engine PR)

This document, and the type/parser it describes, currently exist **only in
karos-portal**. For T-A4 (SCRUM-257) and T-A17 (SCRUM-261) — both
`Repo: agent-engine` — to have an actual in-repo pointer to this contract,
someone with agent-engine write access needs to:

1. **Commit an equivalent contract doc into agent-engine**, e.g.
   `packages/tools/karos-seo-geo/CONTRACT-routable-recommendation.md` (beside
   `rec-catalog.data.ts` and `recommend.ts`, the two files this contract is
   about) — this file's content is a reasonable starting point; it needs
   nothing added except an agent-engine-side "where the mapping table lives"
   section once T-A4 picks a file name for it.
2. **T-A4/SCRUM-257** then does the real work this contract exists to enable:
   enrich `FiredRecommendation` in `recommend.ts` with `check`/`lever`/
   `productRef`, and build the reviewed `rec_id -> {fixAction, actionKind,
   owner, engineProductId?}` mapping table for all ~72–75 catalog records,
   landing beside `rec-catalog.data.ts`. `engineProductId` values must be
   validated against agent-engine's own `KNOWN_PRODUCT_IDS`
   (`apps/agent-server/src/wiring/workflows.ts`) — a test failing on an
   invalid or missing id for a `karos_agent`-owned record is Rule 3's actual
   enforcement point (karos-portal can only fail safe at runtime; agent-engine
   is where "build error" is real).
3. **T-A17/SCRUM-261** (the SEO fix actuator) is blocked on T-A4, per Jira, and
   is out of scope for both this ticket and this document.

This session could not commit to agent-engine (git access is portal-only,
confirmed by the workflow constraints this round operates under), so item 1
above is reported here rather than done.
