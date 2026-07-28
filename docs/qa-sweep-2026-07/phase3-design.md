# Phase 3 design — launch-vs-runs architecture (F148 umbrella)

Status: DESIGN COMPLETE — ready for Albert sign-off + Opus build. No src/ edits in
this phase; this document is the buildable spec.

Author: Phase-3 architect (Fable), 2026-07-28, against integration HEAD `5015a10`
(wave-1 + CALENDAR merged). Inputs: call-directives §A1–A5, F147/F148/F149/F130
specs, rescopes.md rulings, and the live code surfaces cited inline.

Changelog:
- **v2.1 (2026-07-28, orchestrator)** — §3 copy rule clarified: the "team is
  reviewing it" sentence is for run-FINISHED surfaces; run-STARTED surfaces say
  "Your Karos team reviews it when it lands — finished posts appear in your
  Workspace once approved" (landed in custom-agents.tsx with a call-site
  comment). F149's merged Phase-2 interim (non-draft/non-future/30-day view) is
  the named starting state for WP-5's migration to posted-only.
- **v2 (2026-07-28, same day)** — Albert answered Q1/Q2/Q6/Q9 (relayed by the
  orchestrator). Amended: launch is **client-billed and client-triggerable**
  (§2, §6, §7.1, WP-1); launch pricing is **measured-ratio per agent** with a
  gated-until-priced default (§6.1–6.3, new ops step); Q6 confirmed per-agent
  flat run pricing (no design change); the **X agent adopts a daily 3-option
  slot** with pick/edit/post telemetry feeding generation (§1.2 slot `kind`,
  new §4.5, seam T7, WP-9 added — additive package, WP-0..8 unchanged in
  order). §12 restructured into answered rulings vs still-open defaults.
- v1 — initial design.

Covers: data model · state machines · calendar slots + notes · two-level feedback ·
posted/archive · credit split · UI states with churn-rule audit · agent-service
contract (today vs Tomer) · migration · ordered build plan.

---

## 0. The one-paragraph model

Every content platform a client buys becomes ONE **client agent** ("Instagram
Agent for Geektime"): a per-client umbrella doc that binds the lab agent
(`customAgents`) to the client and owns everything the call asked for — a
**launch** state machine (setup run → template set → live), a registry of
**child template streams**, a **slot plan** the calendar renders (template +
date + optional client note, never content), **two-level feedback** (whole
agent / one template), and a **launch-vs-run cost ledger**. Existing machinery
is reused, not replaced: `PlannedScheduledRun` stays the firing engine, the
chain (`post-chain.ts`) becomes slot-aware, `Asset.templateKey` is already the
template join key, `markAssetPostedAction` is already the posted transition,
and the agent service is driven entirely through the metadata/context-file
channels it supports today.

Glossary (use these words everywhere; credits vocabulary rules apply — never
"token" for credits):

| Term | Meaning |
|---|---|
| client agent | The per-client umbrella (parent). Collection `clientAgents`. |
| template | A child stream ("By The Numbers"). Lives in the parent's `templates` array; joined to posts via `Asset.templateKey`. |
| launch / setup run | The one-time heavy run that researches the client and produces the template set. Client- or staff-fired (Q2); client-billed at the measured per-agent price (Q1, §6.3). `runType: "launch"`. |
| recurring run | A scheduled fire of the parent agent that fills slots. `runType: "scheduled"`. |
| manual template run | Client-triggered "run this template now", 25 credits (per-agent flat price, Q6). `runType: "manual_template"`. |
| slot | A calendar-day intent: template + date (+ optional note). What clients see on the calendar. Collection `agentSlots`. |
| options slot | The X daily variant (Q9, §4.5): one day, three post options, the client picks/edits/posts one; pick telemetry feeds the learning loop. |
| posted | Asset status `published` reached via Mark-as-posted (or a real platform push). The only state the client archive shows. |

---

## 1. Data model

All timestamps epoch millis. All writes via server actions (CLAUDE.md). New
collections are flat, keyed by clientId per repo convention. Deterministic doc
ids where noted (idempotent upserts, race-safe backfill).

### 1.1 `clientAgents` (new collection) — the parent umbrella

Doc id: `${clientId}__${agentKeySlug}` (agentKey lowercased, `/`→`-`).

```ts
/** Launch lifecycle of a client agent. See §2 for the state machine. */
export type ClientAgentLaunchState =
  | "not_launched"   // bound, nothing run yet
  | "launching"      // setup job in flight (launchJobId set)
  | "curating"       // setup deliverables arrived; staff confirming templates
  | "live"           // launch complete — recurring model active
  | "launch_failed"; // setup job failed/cancelled; error retained

/** One child template stream. Small set (1–8) ⇒ array on the parent doc. */
export interface ClientAgentTemplate {
  /** Slug — THE join key; must equal Asset.templateKey for this stream. */
  key: string;
  /** Display name ("By The Numbers"). */
  name: string;
  /** The launch run's rationale — "these are your templates because…". */
  rationale?: string;
  status: "active" | "paused" | "retired";
  /** Rotation order (0-based). Drives slot generation, editable by the client. */
  position: number;
  /** "launch" | "backfill" | "manual" — provenance. */
  source: "launch" | "backfill" | "manual";
  addedAt: number;
}

export interface ClientAgent {
  id: string;
  clientId: string;
  /** customAgents.key of the bound lab agent (stable across re-imports). */
  agentKey: string;
  /** customAgents doc id at bind time (display metadata lookup). */
  customAgentId: string;
  /** Client-facing name, e.g. "Instagram Agent". Defaults from the custom agent. */
  displayName: string;
  /** Platform identity for icons/labels ("instagram" | "tiktok" | "x" | "linkedin" | …).
   *  Derived at bind time via socialPlatformsFor() (agent-identity.tsx); stored so
   *  renaming the lab agent can't silently re-platform the umbrella. */
  platform: string;
  /** Which chain family this umbrella's slots own ("social" | "email" | "article").
   *  While a clientAgent is live, the slot planner (§4) owns this family for this
   *  client and plain reflowClientChain must not re-date its assets.
   *  OPTIONAL: an options-mode umbrella (X, §4.5) owns no chain family — its
   *  slots present picks from batch assets (type "note", chainFamilyFor = null)
   *  and never re-date chain assets. */
  chainFamily?: "social" | "email" | "article";

  launchState: ClientAgentLaunchState;
  /** Platform job doc id of the setup run (jobs collection). */
  launchJobId?: string | null;
  launchStartedAt?: number | null;
  launchCompletedAt?: number | null;
  /** Client-safe refusal/error for launch_failed (clientSafeRefusal() applied
   *  at the page boundary exactly like toScheduleRows does for lastError). */
  launchError?: string | null;

  templates: ClientAgentTemplate[];
  /** Default weekly template rotation: templateKeys in firing order. The slot
   *  generator cycles this; individual slots may be overridden. */
  rotation: string[];

  /** The always-on weekly schedule row that fires this umbrella
   *  (plannedScheduledRuns id). Null until a schedule exists. */
  scheduleRunId?: string | null;

  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
```

Deliberately NOT on this doc: cadence/hour/zone (owned by the linked
`PlannedScheduledRun`, which is already F108-compliant — no second clock),
credit balances (owned by `clientCredits`), and feedback (own collection, §5 —
it grows unboundedly).

### 1.2 `agentSlots` (new collection) — the calendar plan

Doc id: `${clientAgentId}__${dateKey}` — **one slot per day per umbrella**,
matching the chain's one-post-per-day-per-family invariant. (Multi-slot days
are out of scope for v1; the id scheme leaves room for a `#2` suffix later.)

```ts
export interface AgentSlotNote {
  text: string;               // ≤ 500 chars, plain text (server-clamped)
  authorUid: string;
  authorRole: "client" | "staff";
  createdAt: number;
  /** Stamped when a generation/revision run actually received this note. */
  consumedAt?: number | null;
  consumedByJobId?: string | null;
}

/** Recorded when the client picks one of an options slot's choices (§4.5). The
 *  learning-log source of truth stays XDraftFeedback; this is the slot-level
 *  render state. */
export interface AgentSlotOptionPick {
  /** Which option was chosen — its ref within the linked asset's parsed batch
   *  (interim mode) or its option key (day-of mode). */
  optionRef: string;
  pickedAt: number;
  pickedBy: string;
  /** True when the client edited the text before confirming. */
  edited: boolean;
}

export interface AgentSlot {
  id: string;
  clientId: string;
  clientAgentId: string;
  /** Calendar-day identity, "YYYY-MM-DD" in the schedule's zone. This is the
   *  F108 "intent" side (wall calendar day + the parent schedule's IANA zone);
   *  derived instants are computed via run-cadence helpers. NOT a timestamp —
   *  the epoch-millis rule applies to instants, and a slot is a day. */
  dateKey: string;
  /** "single" = one template, one post (default). "options" = the daily
   *  3-option pick model (§4.5, X agent) — the client chooses between
   *  optionRefs on the day. Absent ⇒ "single". */
  kind?: "single" | "options";
  /** single: the stream this day produces. options: a fixed key ("daily-post")
   *  so calendar chips still render a stable label. */
  templateKey: string;
  status:
    | "planned"     // future intent — nothing client-visible exists
    | "generated"   // content exists and the day has arrived (client can act)
    | "posted"      // its asset reached status published
    | "skipped";    // client/staff removed the day (kept for history)
  /** The fulfilling asset once one is matched/created. For an options slot:
   *  before the pick, the (staff-side) batch asset the options are drawn from;
   *  after the pick, the materialized per-day asset (§4.5). */
  assetId?: string | null;
  /** The generation job for day-of runs. */
  jobId?: string | null;
  /** options slots only: the 3 candidate refs assigned to this day (draft refs
   *  within the batch asset, or option keys once day-of generation lands). */
  optionRefs?: string[];
  /** options slots only: set once the client picks. */
  optionPick?: AgentSlotOptionPick | null;
  note?: AgentSlotNote | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
```

`status` reconciliation rule: `posted` and `generated` are DERIVED from the
linked asset (asset.status === "published" ⇒ posted; unlocked+exists ⇒
generated) and re-stamped by the actions/readers that observe it — the asset
remains the source of truth for content state; the slot is the source of truth
for *intent* (template + day + note). Nothing ever reads slot.status to decide
asset visibility.

### 1.3 `clientAgentFeedback` (new collection) — two-level feedback (CD-A2)

```ts
export interface ClientAgentFeedback {
  id: string;
  clientId: string;
  clientAgentId: string;
  /** "agent" = global, shapes every template; "template" = one stream. */
  scope: "agent" | "template";
  /** Required when scope === "template"; must match a registry key. */
  templateKey?: string | null;
  /** ≤ 500 chars, plain text (server-clamped — DOCS risk ruling: bounded). */
  text: string;
  /** active = injected into every future run; resolved = kept, not injected. */
  status: "active" | "resolved";
  createdBy: string;
  creatorRole: "client" | "staff";
  createdAt: number;
  updatedAt: number;
}
```

Why not reuse the existing `Feedback` collection (types.ts:854): that one is
the doc-correction log (docType / single_doc / global semantics) consumed by
the context-doc pipeline; overloading it with template scopes would leak
template feedback into doc-correction consumers. The per-draft learning logs
(`XDraftFeedback` / `LiDraftFeedback`) are untouched — they stay the third,
item-level tier.

Injection caps (hard, server-side): newest 50 `active` rows per umbrella, 500
chars each — the F77 risk ruling (unbounded accumulating client text inflating
every run) applies here and is closed by design, not by convention.

### 1.4 Existing types — additive field changes only

`Job` (types.ts:343) gains:

```ts
/** How this run was initiated within the launch-vs-runs model. Absent on
 *  legacy jobs (analytics buckets them as "untyped"). */
runType?: "launch" | "scheduled" | "manual_template" | "manual";
/** The umbrella this run belongs to, when one exists. */
clientAgentId?: string | null;
/** For manual_template + slot-fulfilling runs: the stream produced. */
templateKey?: string | null;
```

`CustomAgent` (types.ts:221) gains:

```ts
/** Credits a client-fired LAUNCH costs (Q1 ruling: client-billed, priced from
 *  the MEASURED setup-vs-run USD ratio — see §6.3). Admin-set per agent after
 *  measurement, like creditCost (F130). null ⇒ price not yet calibrated: the
 *  client's self-serve Launch is gated with a visible reason; staff launches
 *  (free, and the measurement source) remain available. Must price above the
 *  agent's per-run creditCost — the setter action validates that. */
launchCreditCost?: number | null;
```

(`creditCost` per-run already exists and satisfies F130's per-agent price;
AGENTS cluster owns rendering it.)

`CreditOperation` (types.ts:1300) gains one member:

```ts
| "agent_launch"   // client-billed setup run of a client agent
```

`CreditLedgerEntry` needs NO new fields — `operation` + `agentId` + `jobId`
already carry enough to split launch vs run vs manual (jobs carry `runType`).

`PlannedScheduledRun` gains:

```ts
/** Umbrella linkage; when set, the cron fires slot-aware (§4.3). */
clientAgentId?: string | null;
```

No fields are removed anywhere. `firestore.rules` stays deny-all (new
collections are Admin-SDK-only like everything else).

---

## 2. Launch state machine

```
                 staff "Launch agent"
 not_launched ───────────────────────▶ launching ──(webhook: done)──▶ curating
      ▲                                   │                              │
      │        staff "Reset"              │ (webhook: failed/cancelled)  │ staff "Go live"
      └────────────── launch_failed ◀─────┘                              ▼
                                                                       live
```

- **not_launched** — umbrella exists (bound by staff, §7.2). **Q2 ruling: the
  launch is triggerable by BOTH the client and staff.** The client card shows a
  primary "Launch <name>" CTA ("I want to launch my Instagram agent" → press →
  visible process). The CTA is enabled only when every gate below passes; when
  a gate blocks, the button is disabled with the reason as a visible line, F25
  pattern — never an enabled button the server will refuse (F131 rule).
- **launching** — `submitClientAgentLaunchAction` submitted the setup job
  through `submitCustomAgentJob` with `runType: "launch"` metadata (§8.1).
  Authorization: `requireClientAccess` (client on own workspace, or staff).
  Server-side gates, in order, each with a client-readable refusal:
  1. agent granted + umbrella `not_launched`/`launch_failed` (one launch in
     flight per umbrella);
  2. intake-gated agents (X/LinkedIn): the existing hard gate — the launch
     modal surfaces the same `AgentSetupState` setup block first;
  3. **pricing gate (client-fired only)**: `launchCreditCost` set for this
     agent, else refuse "Launch pricing for this agent is being finalized —
     ask your Karos team" (§6.3 justification);
  4. **charge (client-fired only)**: `isBillableClientActor` ⇒
     `chargeClientCredits` with operation `agent_launch` at `launchCreditCost`,
     jobId-paired exactly like run charges (submit-custom.ts:179-196 pattern)
     so webhook/reconcile refunds work unchanged. Staff- and impersonation-
     fired launches never charge (existing rule).
  `launchJobId` + `launchStartedAt` set on success.
- **curating** — the launch job delivered. Its deliverables land as
  staff-only assets (§8.2). Staff confirm the template registry on the
  curation pane (§7.2): auto-seeded from a structured `templates.json`
  artifact when present (Tomer seam T1), else parsed suggestions + manual add.
  Client still sees guided progress ("Designing your templates").
- **live** — staff pressed "Go live": templates array non-empty, rotation
  seeded, `launchCompletedAt` stamped; the card flips to the live-agent view.
  Going live also (optionally, one checkbox) creates/updates the weekly
  `PlannedScheduledRun` via the existing `configureClientAgentScheduleAction`
  path and stamps `scheduleRunId`.
- **launch_failed** — webhook reported failed/dead_letter/cancelled (note:
  AGENTS cluster's F30 adds a distinct "cancelled" JobStatus — the launch
  branch must treat cancelled as launch_failed with neutral copy, not red).
  A client-billed launch charge is auto-refunded by the existing webhook
  refund path (route.ts:195-205 — jobId pairing makes this free), and the
  client-facing failure copy states it: "Setup needs another pass — your
  credits were returned." Staff "Reset" returns to not_launched; a client may
  simply press Launch again (new charge, new job).

Client-visible presentation collapses the five internal states to three
phases (A1's script): **"Researching your brand"** (launching, first half),
**"Designing your templates"** (launching second half + curating),
**"Live"**. Until the service emits progress events (Tomer seam T2), the
launching split is a two-stage narrative keyed off job lifecycle
(queued/running = stage 1 copy with the estimate; the stage copy never claims
completed work it can't see). `AutoRefresh` (already in the repo) mounts while
launching so the page moves on its own (same F31 medicine).

Guard rails:
- One launch in flight per umbrella (`launchState === "launching"` blocks a
  second submit server-side).
- `runCustomAgentAction` / schedule configuration for an umbrella-bound agent
  key are refused for CLIENT_USER while `launchState !== "live"` — this
  *extends* F131's rule (never an enabled Run beside a blocked state) to the
  umbrella level; card UI mirrors it with a disabled control + visible reason
  (F25 pattern: visible line, not tooltip).

---

## 3. Posted state + archive (A4 / F149 / F149-interplay)

The asset lifecycle is already right; Phase 3 changes *visibility*, not the
machine:

- draft → (staff approve) → approved/scheduled → **published**. The ONLY
  client transition remains `markAssetPostedAction` (asset-actions.ts:222) —
  Phase 3 adds call sites, never a second mechanism (rescopes building block).
- **Archive = posted only, ~30-day window**: the client archive
  (`archive-view.tsx` via /tasks archive tab) filters to
  `status === "published"` AND `(publishedAt ?? updatedAt) >= now − 30d`.
  Ageing out is a *view filter* — assets are never deleted; staff surfaces
  keep full history. Group headers gain template chips (F148's "rendered
  nowhere as a group").
- **Mark-as-posted on the calendar day card** (F149's spec): the slot card in
  the day detail renders `MarkPostedRow` for a `generated` slot's asset — the
  exact component from asset-detail-modal.tsx:460 extracted to a shared
  module, not a copy. Composes with staff-only `PublishNowRow` per the F107
  ruling (staff push vs client attestation; neither preempts the other).
- Slot.status flips to `posted` when the linked asset publishes (derived, §1.2).

**Ownership note (Wave-B WORKSPACE interplay):** F149 sits in the WORKSPACE
cluster (Phase 2, wave B) in the ledger. The archive filter + day-card
MarkPostedRow above IS F149's fix and belongs to whichever lands first:
- If WORKSPACE wave B ships F149 before WP-5 starts → WP-5 *consumes* it and
  adds only the template grouping + churn copy pass.
- If not → WP-5 implements this section and F149's ledger row resolves with
  Phase 3 (orchestrator flips the cluster tag).
Either way the spec is THIS section; the two must not diverge. Related
residuals that dissolve here (log against F149 in the ledger when WP-5 lands):
F97's attention-row draft inflation, F109's client-review gap, F66's
draft-seeded deep link, and F47's "lands in your archive as soon as the run
finishes" copy (reword: "your Karos team is reviewing it — finished posts
appear on your calendar").

---

## 4. Calendar slots, reorder, notes (A3 / CD-A3)

### 4.1 What a client sees (the churn rule, made structural)

The client calendar renders **slots**, never content, for anything in the
future: chip label = template name + platform mark. Two producers, one
projection — the client cannot distinguish them (that indistinguishability IS
the A3 churn guard):

| Underlying truth | Client sees |
|---|---|
| Pre-generated asset, future-dated by the chain (today's reality) | Slot chip "By The Numbers", day detail: template + note editor. Nothing else. |
| No asset yet — day-of generation will fire (target reality) | Identical. |

Building blocks already in place: `redactLockedAsset`
(asset-visibility.ts:37) already strips content/meta/image and swaps the title
for the template name before the RSC boundary. Gaps to close (each is a WP-4/5
acceptance criterion):

1. **Copy**: locked modal says "This deliverable unlocks on …. You'll be able
   to view and download it then" (asset-detail-modal.tsx:157-181) — "unlocks"
   admits the thing exists. Reword everywhere to creation language: "This
   post is created on <day>. It'll appear here that morning." Grep-level
   sweep for "unlock" in client-reachable strings.
2. **Chips**: `CalendarPost` chips for future-dated client assets must render
   the template name (they already do post-redaction, since title is swapped —
   verify no path feeds unredacted assets to the calendar; calendar-body.tsx:143
   passes through `getClientLibraryAssets({forClient:true})` ✓).
3. **Run history**: a batch run row "Instagram Agent · 2 hours ago · 7 assets"
   on the client agents page is a pre-generation tell. For umbrella-bound
   agents, client run rows hide `assetCount` and show slot-language ("preparing
   your upcoming posts") — or are hidden entirely below the umbrella card
   (default; Q8). Staff rows unchanged.
4. **Ready pills**: the "N ready" pill (custom-agents.tsx:395) counts review
   runs — for live umbrellas the client-facing pill must count only
   *unlocked-day* items awaiting action, not the whole batch.
5. **Day detail for a future day**: never renders PastRunCard/PostCard bodies
   for locked items — slot card only.

### 4.2 The slot plan + reordering

New pure module `src/lib/slot-plan.ts` (client-safe, unit-tested — the
post-chain.ts discipline):

- `generateSlotHorizon(parent, schedule, existingSlots, now)` — extends the
  slot plan to a rolling ~28-day horizon: firing days come from the linked
  schedule's weekdays/zone (run-cadence helpers, F108 contract), templates
  cycle `rotation` (skipping `paused`/`retired` templates), existing slot docs
  are never overwritten. Runs opportunistically from the pages/actions that
  touch the plan (no new cron needed).
- `matchAssetsToSlots(assets, slots)` — slot-aware chain assignment: for each
  family-owned future slot in date order, take the earliest unassigned
  chain-candidate asset **of that slot's template** (deriveOrderKey order,
  same candidacy rules as `planClientChain` — reuse its predicates) and emit
  `ChainAssignment`s re-dating assets to their slot's day (persisted via the
  existing `applyChainAssignments`, which re-checks the draft invariant).
  Leftover candidate assets with no slot keep chain behavior (append after the
  horizon); slots with no matching asset stay `planned` (day-of generation
  fills them, or the day passes and the slot is marked missed on the staff
  side only).
- **Reorder/swap** = editing slot.templateKey on specific days (or moving a
  template between two days), then re-running `matchAssetsToSlots`. Client
  action `reorderAgentSlotsAction` (requireClientAccess): validates all
  touched slots are future, templates active, one per day. Frequency changes
  keep flowing through `configureClientAgentScheduleAction` (existing action;
  AGENTS cluster is relabeling its UI per F40) followed by horizon regen.

**Ownership handoff (critical):** while a clientAgent is `live`, its
`chainFamily` for that client is planned by the slot planner; the plain
`reflowClientChain` (chain.ts:22, called from the webhook and lab import) must
detect a live umbrella for the family and delegate to the slot-aware path so
the two planners never fight over dates. Non-migrated clients keep today's
behavior byte-for-byte.

### 4.3 Per-slot notes, consumed on run day (CD-A3)

- `setAgentSlotNoteAction(slotId, text)` — requireClientAccess; clamps 500
  chars; future slots only (past = read-only history). One note per slot
  (edit replaces; author + time kept).
- **Consumption — three fulfillment paths, declining order of fidelity:**
  1. *Day-of generation exists (target state, Tomer seam T3):* the
     run-scheduled cron, when firing a slot-linked run, attaches
     `slot-note.md` as a context file + `karos_slot_id` metadata; webhook
     stamps `consumedAt/consumedByJobId`. Portal side is fully buildable now.
  2. *Content pre-generated + note arrives (today's reality):* the note
     triggers a **revision pass** — a normal `submitCustomAgentJob` run with
     prompt "Revise this draft for its posting day using the client's note",
     the draft content + note as context, `runType: "manual"` and the slot id
     in metadata; the webhook branch replaces the slot's asset content (same
     asset doc, content patch) instead of creating a new asset. This is
     buildable today but costs a real run — default OFF pending Q4.
  3. *Fallback (ships first):* the note is stored + surfaced to staff (a
     notification-bell alert "Client left a note for Thursday's post" + shown
     on the staff asset card) so a human applies it. Never silently dropped:
     the slot card shows the note back to the client with "Noted — your Karos
     team factors this in".
- The note editor copy never promises regeneration it can't do ("We'll take
  this into account for that day's post") — honest under all three paths.

### 4.4 Paused schedules

CALENDAR cluster logged the product gap (paused schedules vanish from the
calendar). Under the slot model: pausing the parent schedule freezes horizon
extension; existing future slots render greyed "paused" on staff calendar; the
client parent card carries the paused state (existing behavior). Slots are NOT
deleted (resume keeps the plan). Folded into Q7 for Albert.

### 4.5 Options slots — the X agent's daily 3-option pick (Q9 ruling)

Q9 ruling: X keeps its batch generation model AND syncs to the calendar as a
**daily 3-option slot**: each day the client gets three post options (three
slightly different directions), picks a favorite, may edit it, posts it by
hand, and the system records pick + edits + posted so future generation
converges on demonstrated preferences ("it improves and improves").

**(a) The slot type.** `AgentSlot.kind: "options"` (§1.2): `templateKey`
fixed to `"daily-post"` (stable chip label), `optionRefs` = the day's three
candidate refs. Calendar chip: "Daily post · pick of 3". One options slot per
day per the existing id scheme. The X umbrella has no `chainFamily` — options
slots never re-date chain assets; they present choices.

**(b) Where the options come from — churn-honest in both modes.**
- *Interim (today's engine, weekly batch):* the recurring X run keeps
  producing its batch asset (DRAFTS.md → `parseXDrafts`, unchanged webhook
  path). A deterministic selector in `slot-plan.ts`
  (`assignOptionRefs(batch, slots)`) walks the parsed batch and assigns three
  not-yet-assigned drafts per future slot, diversifying by avenue/account
  (three different directions, per the ruling). Assignment is stored on the
  slot (`optionRefs` + `assetId` = batch asset) — but the OPTION TEXTS cross
  the RSC boundary only for slots whose day has arrived. The batch asset
  itself is staff-side (drafts are already client-invisible on the calendar
  path; the archive hole closes per §8.2/WP-5). The orchestrator's churn rule
  is satisfied by **presentation day-of**: the client sees "pick of 3" chips
  for future days and gets the three texts only on the day.
- *Target (Tomer seam T7):* the X engine gains a daily mode — "produce
  exactly 3 option drafts, distinct directions, for <date>, consuming the
  pick history" — fired by the run-scheduled cron per slot with
  `karos_slot_id`. The portal surfaces are identical; only the producer
  changes. Until T7, generation cadence (weekly) ≠ presentation cadence
  (daily), invisibly to the client.

**(c) The pick flow + telemetry.** Reuses existing machinery; one new action.
1. Day arrives → the day card / Today surface renders the **option picker**
   (new component, sibling of x-drafts-review): three cards, each with text +
   direction label, an inline edit affordance, and "Use this one".
2. `pickAgentSlotOptionAction(slotId, optionRef, finalText?)`
   (requireClientAccess):
   - **materializes the chosen option as its own asset** — `createAsset` with
     content = finalText ?? original, type per platform hint, `templateKey:
     "daily-post"`, `status: "approved"`, `publishMode: "manual"`,
     `scheduledAt` = the slot's day. The slot's `assetId` re-points to it.
     Materialization is what makes the rest of the system work unchanged:
     `MarkPostedRow` (per-asset), the posted archive (shows the text the
     client actually used), and analytics all operate on the per-day asset.
     The batch asset stays staff-side history.
   - stamps `slot.optionPick` ({ optionRef, edited: finalText != null … }).
   - **writes the negative signals immediately**: for each unchosen ref, an
     `XDraftFeedback` row `{ account, draftRef, action: "not_posted", reason:
     "Not picked — client chose <ref>" }` via the existing feedback actions
     (x-agent-actions) — final at pick time, no client effort.
3. Client posts by hand → **Mark as posted** on the materialized asset (the
   §3 flow, unchanged) → the action wrapper also writes the chosen option's
   `XDraftFeedback` row: `action: "posted"` or `"posted_with_edits"` +
   `finalText` (edit detection = materialized content ≠ original; the
   original stays recoverable from the batch asset, so no schema change to
   XDraftFeedback). Slot → `posted`.
4. A pick never followed by Mark-as-posted keeps its `optionPick` (render
   state) — the learning log simply never gets the posted row, which is
   itself signal.

**(d) The learning loop closes with zero new plumbing.**
`buildXAgentContextFiles` (x-agent-context.ts) already serializes
`XDraftFeedback` into per-account Learning Logs attached to every X run — the
pick/skip/edit/posted rows land there automatically. T7 additionally teaches
the engine to *optimize for* pick-rate patterns (directions the client keeps
choosing, edits they keep making); the portal's only job is honest recording,
which is complete at steps 2–3.

**(e) Migration from the weekly pick-a-batch contract** (details §9): the X
umbrella backfills as `live` (runs exist); the staff-facing x-drafts-review
batch pane REMAINS (staff QA + history); the client's daily entry point
becomes the option picker. The existing weekly schedule row keeps firing
(generation); the slot horizon generates daily options slots forward-only —
no retroactive slots, no existing asset touched. The intake Feedback card
copy (F28's surfaces) updates to name the daily pick as the fastest signal —
which becomes TRUE, closing F28's overpromise class for X.

---

## 5. Two-level feedback (A2 / CD-A2)

Surfaces:
- **Global**: "Give feedback on this agent" on the live parent card → modal
  (textarea + recent feedback list with status). Copy anchors scope: "Shapes
  everything this agent makes."
- **Template-level**: per template row "Feedback" → same modal pre-scoped
  ("Shapes only <name> posts"). Also reachable from a generated slot's day
  card ("About this format").
- Both lists visible to client + staff; author + relative time; client may
  edit/delete own rows; staff may mark `resolved` (kept, no longer injected).

Consumption (portal-side today, no service change): a new builder
`buildClientAgentFeedbackFile(clientAgentId)` mirroring
`buildXAgentContextFiles` — serializes active feedback as `agent-feedback.md`
(global section first, then per-template sections) and is attached in
`submitCustomAgentJob` for EVERY run whose agent resolves to a live umbrella
(launch runs excluded — nothing to shape yet). The instructions preamble the
file with the same authority framing the lab contract already uses for
learning logs. Caps per §1.3.

Actions: `addClientAgentFeedbackAction`, `updateClientAgentFeedbackAction`
(own rows / staff any), `setClientAgentFeedbackStatusAction` (staff) — all
requireClientAccess/requireStaff per the verb, all validating templateKey
against the registry.

Relationship to per-draft feedback: untouched (XDraftFeedback stays the
fastest per-item signal). The intake Feedback cards (F28's surfaces) gain one
line linking up to the umbrella feedback modal — no new promises.

---

## 6. Credits: launch-vs-run split (A5, extends F130)

### 6.1 Charging (Q1 ruling: launch is client-billed, priced above a run)

| Run | Charged? | Price | Ledger operation |
|---|---|---|---|
| Launch, client-fired | yes (`isBillableClientActor`) | `CustomAgent.launchCreditCost` — admin-set from the measured ratio (§6.3); unset ⇒ client launch gated | `agent_launch` |
| Launch, staff-fired | No (staff never charge — existing rule); these ARE the measurement runs | — (job cost tracked in USD) | — |
| Scheduled recurring fire | per existing `billClientCredits` on the schedule | `creditCost` × outputs | `custom_agent_run` |
| Manual template run | yes (client) | `creditCost` (per-agent flat price — **Q6 ruling confirmed**: templates inherit the agent price, no per-template overrides) | `custom_agent_run` |
| Options-slot pick / Mark-as-posted (§4.5) | free — picking is feedback, not generation | — | — |
| Revision pass (note, path 2) | policy per Q4 | `creditCost` | `custom_agent_run` |

No changes to `assessCharge`/`applyCredit`/caps — pricing stays pure in
credits.ts; the only credits.ts diff is the `agent_launch` operation label map
where ledgers render. Refund paths already cover every non-done outcome
(webhook refundJobCharge) including launches.

### 6.2 Reporting

Two audiences, two sources, both already captured:

- **Client-facing (credits)**: the settings Credits panel gains a per-agent
  breakdown — group `creditLedger` rows by `agentId` × operation into
  "Setup" (`agent_launch`) / "Scheduled runs" / "Manual runs" (`jobId` →
  job.runType splits custom_agent_run into scheduled vs manual; rows whose
  job is gone bucket as "runs"). Pure presentation over `listCreditLedger`.
- **Staff economics (USD)**: per-umbrella card (staff agents page / client
  settings): launch cost = Σ `jobs[runType=launch].external.totalCostUsd`;
  recurring = Σ scheduled+manual; per-template where useful (jobs.templateKey).
  This is the "493 onboarding runs at ~$8.5" visibility Albert asked for,
  scoped per client agent. Legacy untyped jobs render as their own bucket,
  honestly labeled "before run-type tracking".

### 6.3 Launch-price calibration from measured cost (Q1 ruling)

Albert's intent: template runs ≈ 25 credits; the launch price must reflect the
**actual measured ratio** of what a setup run costs vs a template run — not a
guessed multiplier. Mechanics:

- **Measurement surface** (part of the staff economics card, per lab agent
  across clients): avg `totalCostUsd` of `runType="launch"` jobs vs avg of
  `runType∈{scheduled,manual_template}` jobs for the same `agentKey`, the
  resulting ratio, sample sizes, and a **suggested launch price** =
  `round(ratio × creditCost)`, displayed next to the current
  `launchCreditCost`. Data source is entirely `jobs.external.totalCostUsd` —
  already captured by the webhook, no service change.
- **Setting the price** is an admin action on the agent editor
  (`updateCustomAgentAction` already exists; add the field), validated
  `launchCreditCost > creditCost` (priced ABOVE a template run, per the
  ruling).
- **Safe default while unmeasured — GATED, not provisional** (chosen and
  justified): while `launchCreditCost` is null, the client's self-serve
  Launch button is disabled with the visible reason "Launch pricing is being
  finalized"; staff launches remain available (free) and are precisely the
  runs that produce the measurement. Justification: the first launches are
  staff-fired onboarding work anyway, and billing a client an invented
  provisional number that later changes is the F130 placeholder-pricing
  failure re-created at the most expensive SKU — never charge a price nobody
  consciously set. Flagged as Q10 for Albert to veto if he prefers a
  provisional price.
- **Ops step** (LEDGER discipline, like F127/C2): after a few measured
  launches per agent, Albert/admin sets `launchCreditCost` from the surfaced
  suggestion — until then the row stays "code merged, pricing ops pending".

F130 ledger note: the flat "25 credits per output" card line is AGENTS-cluster
work (per-agent `creditCost` display); Phase 3's live view repeats the same
per-agent number on the template rows ("Run now · 25 credits") — **Q6 ruling
confirmed: one flat price per agent, templates inherit it, no per-template
pricing.**

---

## 7. UI states

New components live in `src/components/client-agents/` (new directory) — NOT
inside custom-agents.tsx, which the AGENTS cluster is actively editing
(F129/F25/F128/F132/F44). custom-agents.tsx keeps serving non-umbrella agents
and shrinks by delegation; the page decides which card renders per agent.

### 7.1 Client `/clients/[id]/agents` — **rev 2026-07-28 per CD-G1**

**This section was rewritten after Albert reviewed the built surface on
localhost.** The original design put every state, every control and the whole
template set on ONE card per agent, in a grid. His ruling: "they can just click
on it, and then it opens… over the whole page. That whole page should be like
the Instagram Agent." The card states below are still the states — they moved
to a different surface. Where this section and CD-G1 disagree, CD-G1 wins.

**The split.**

- **Roster** — `/clients/[id]/agents`. One card per granted agent (umbrella-bound
  or not): platform mark, name, a one-line client blurb (§CD-G2, never the lab
  manifest's `description`), and ONE status word. Live / Setting up / Not set up
  yet / Setup needs attention / Ready to start, resolved by `rosterStatus()`
  with the F24/F129 precedence intact — a refusal on the linked schedule
  outranks Live. **No Run button anywhere on the roster**: a client's run
  gesture lives only inside a detail page, beside the context that explains what
  it costs and produces. The whole card is a `next/link` to the detail route
  (never a modal — a modal cannot be middle-clicked, deep-linked or navigated
  back from) with a lift + border + chevron hover affordance.
- **Detail** — `/clients/[id]/agents/[agentId]`, where `[agentId]` is the
  CustomAgent id (stable for umbrella-bound and non-umbrella agents alike).
  Both viewer roles; client redaction at the RSC boundary via the shared
  `client-agent-rows.ts` projection, so roster and detail cannot answer "what
  may this viewer see" differently. Sections: hero (launch states 1–3 for a
  non-live umbrella, the working agent once live) · **"Create new post"** as the
  primary run gesture, priced, disabled-with-visible-reason per F25/F131,
  resolving to the first format whose gate allows · the template set (the WP-2
  rows: per-template run with cost, feedback, pause, reorder) · week strip ·
  two-level feedback (agent + per-template, WP-3) · what it has made for you
  (assets attributed through the §7.3 identity helper) · what it knows about you
  (intake links — X / LinkedIn setup) · connected accounts (read-only chips) ·
  Adjust pace (moved here from the card).

Card states 1–5 below therefore describe **the detail page's hero**, not roster
cards. The roster shows only the status word for each.

1. **Umbrella, not_launched** — platform card with the primary **"Launch
   <name>" CTA** (Q2 ruling: client self-serve). Shows what launching does
   ("We research your brand, then design your posting templates"), the launch
   price ("<launchCreditCost> credits, one time"), and the estimate. Gated
   states render the button disabled with a visible reason line (F25/F131
   pattern): intake missing → the setup block (§2 gate 2); price uncalibrated
   → "Launch pricing is being finalized — ask your Karos team" (§6.3);
   credits short → the standard denial wording. TikTok additionally shows the
   connector chip "Pending TikTok verification" (CD-D2 state; connector state
   is orthogonal to launch state and both render — a TikTok agent can be
   launched and producing manual-post content while the connector waits).
2. **Umbrella, launching/curating** — `LaunchProgressCard`: 3-phase guided
   progress (§2), estimate, AutoRefresh. Never a Run button.
3. **Umbrella, launch_failed** — neutral "Setup needs another pass — your
   credits were returned" for client-fired launches / "your Karos team is on
   it" (clientSafeRefusal on the stored error; internal text staff-only, F127
   discipline). Client may relaunch (§2).
4. **Umbrella, live** — `ClientAgentCard`:
   - Header: platform mark, name, Live badge (AGENTS F24/F129 precedence
     rules inherited: refusal on the linked schedule outranks Live).
   - **Template rows** (the F148 core): name, 1-line rationale, per-row
     "Run now · <cost> credits" (disabled with visible reason when credits
     short / template paused — F25 pattern), "Feedback", pause toggle, drag
     or up/down reorder writing `position`/`rotation`.
   - Week strip: next 7 days of slots (template names only).
   - Footer: "Give feedback on this agent" + "Adjust pace" (existing schedule
     modal) + credits line.
5. **Umbrella, live, options mode (X)** — `ClientAgentCard` variant: instead
   of template rows, a **"Today's pick"** row (opens the option picker when
   today's slot is `generated`, else "Today's options arrive each morning"),
   the week strip shows "Daily post · pick of 3" chips, and the footer keeps
   agent-level feedback + pace. No per-template Run buttons (options are the
   daily product; manual extra runs stay possible via the generic run dialog
   for staff).
6. **Non-umbrella custom agents** — today's card, untouched (AGENTS cluster
   owns its fixes).

Client calendar: §4.1 (+ §4.5 picker on the day card). Client archive: §3.

### 7.2 Staff

- **Client agents admin** (staff branch of the same page): bind/create
  umbrella (pick lab agent → creates clientAgents doc), Launch button (with
  intake gate surfaced), curation pane in `curating` (launch deliverables
  listed staff-only; template editor seeded per §8.2; "Go live"), Reset on
  launch_failed, per-umbrella economics card (§6.2) incl. the setup-vs-run
  USD ratio + suggested launch price (§6.3).
- **Staff calendar**: full truth — slots + real asset states + jobs, exactly
  as today plus slot cards. Staff day detail shows the client note
  prominently (path-3 consumption).
- **Jobs / run history**: rows labeled through the identity helper (§7.3)
  with runType chips (Launch / Scheduled / Manual).
- The retired managed-products UI (F39/F45) stays retired — the umbrella IS
  the sanctioned return path for managed-product-shaped runs (rescopes: "never
  as the old four cards").

### 7.3 Identity unification (F147)

New client-safe helper (extends post-chain.ts's label logic, single module,
e.g. `src/lib/agent-identity-map.ts`):

```ts
resolveContentIdentity(input: { job?: …; asset?: …; scheduledRun?: … },
  clientAgents: Pick<ClientAgent, "id"|"agentKey"|"displayName"|"platform"|"chainFamily">[])
  → { clientAgentId?: string; label: string; platform?: string }
```

Rules, in order: job.clientAgentId / slot linkage → direct; job.customAgentId
→ umbrella by agentKey; asset `meta.taskType === "social_post"` or family
"social" for a client with a live social umbrella → that umbrella's
displayName (this kills the "Instagram Agent" vs "Social posts (IG/TikTok)"
double identity, including the "TikTok Agent twice from two systems" case);
otherwise today's `agentLabelForAsset` fallback. Call sites: calendar-body
(both run + post mapping), archive grouping, jobs page rows, run history,
analytics labels. One helper, imported everywhere — no per-surface maps
(JOB_STATUS_META precedent).

---

## 8. Agent-service contract — build-against-today vs Tomer

### 8.1 What the portal builds against TODAY (no service change)

All of these ride on mechanisms verified in current code:

| Mechanism | Where it exists today | Phase-3 use |
|---|---|---|
| `metadata` round-trip (submit → webhook echo) | submit-custom.ts:220-224 → webhook route.ts:108,164 (`platform_job_id` fallback proves the echo) | `karos_run_type`, `karos_client_agent_id`, `karos_template_key`, `karos_slot_id` — all `string` values (schema is `z.record(z.string(), z.string())`) |
| `context_files` | submit-custom.ts:106-156 (X/LinkedIn intake files) | `agent-feedback.md` (§5), `slot-note.md` (§4.3), launch brief |
| `metadata.asset_type` hint honored by webhook | webhook route.ts:313-317 | extend the same whitelist pattern to `template_key`/`template_name` stamping |
| Free-text `brief.prompt` | submit-custom.ts:209-217 | template-pinned prompts ("Produce exactly 1 post using the <name> template …") |
| Webhook refunds on non-done | route.ts:195-205 | launch failure refunds, free |
| Cron fires via the shared submit core | run-scheduled/route.ts | slot-aware prompt + note attachment |

### 8.2 Portal-side webhook changes (our file, our contract)

`/api/agent-service/webhook/route.ts` branches on `metadata.karos_run_type`:

- `"launch"`: deliverables land as **staff-only** assets — created with
  `status: "draft"`, `meta: { launchDeliverable: true, clientAgentId }`,
  **no chain reflow**. Client-side exclusion is NOT free today: the calendar
  path filters drafts for clients (calendar-body.tsx:142) but the archive path
  does not (tasks-body.tsx:64 passes drafts through — that IS F149's
  complaint). So the `launchDeliverable` flag must be excluded explicitly in
  `getClientLibraryAssets({forClient:true})` (one filter, all three client
  surfaces inherit it), independent of WP-5's published-only archive filter
  which closes the same hole later and stays as the second belt. The
  umbrella flips `launching → curating` (or → launch_failed). If a
  client-facing `templates.json` artifact is present (Tomer seam T1), parse
  → seed `templates` (status active, source "launch") for the curation pane.
- slot-linked runs (`karos_slot_id`): created asset gets
  `templateKey/templateName` from metadata (whitelisted against the umbrella
  registry), the slot gets `assetId`/`jobId`, reflow is skipped in favor of
  pinning `scheduledAt` to the slot's day.
- revision passes (`karos_revises_asset_id`): patch the existing asset's
  content instead of creating a new one (§4.3 path 2).
- Everything else: byte-identical behavior to today.

### 8.3 DEFER-TO-TOMER seams (precise)

| # | Seam | File/contract on our side (stub ready) | What Tomer wires |
|---|---|---|---|
| T1 | **Structured launch output**: setup runs emit client-facing artifact `templates.json` — `[{ key, name, rationale }]`, keys kebab-case matching the lab item-folder convention (templateFromItemKey-compatible) | webhook launch branch parses when present; curation pane works without it | lab setup skills emit the file; agent-service passes it through as a normal artifact (may already — it's just an artifact) |
| T2 | **Launch progress events**: `event: "job.progress"` webhook variant (`{ job_id, stage: string, detail?: string }`) | webhook accepts + appends JobRunEvent, LaunchProgressCard upgrades from 2-stage to real stages; schema addition is additive | service emits progress callbacks at research/template checkpoints |
| T3 | **Day-of single-output generation** for the Instagram/TikTok engine: task accepts `template_key` + `count: 1` and produces exactly one on-template post | cron already sends the pinned prompt + metadata; slot flow completes when a single-post run lands (webhook slot branch built) | lab engine honors single-slot mode (today it batches); confirm per-product |
| T4 | **Note revision as a first-class light run** (cheaper than a full run) | portal fallback = full custom run (§4.3 path 2, behind a flag) | dedicated revise skill / task param |
| T5 | **Video deliverables (F150/CD-D1)**: `Asset.kind`-style `mimeType: video/*` + storage URL field | portal renders `<video controls>` in the detail modal off `meta.artifacts` video entries (WP-5 stretch; the liMedia filter already recognizes video/*; extract the shared helper per rescopes F150 note) | GCP block storage + upload path; service fetches from storage |
| T6 | **TikTok connector** | CD-D2 "Pending TikTok verification" chip state (integration status), decoupled from launch | TikTok app verification + connector |
| T7 | **X daily 3-option generation** (§4.5): X engine mode "produce exactly 3 option drafts, distinct directions, for <date>", consuming the pick/edit/posted learning log to converge on the client's demonstrated preferences | cron fires per options slot with `karos_slot_id`; picker, telemetry, and learning-log serialization (x-agent-context.ts) all live and already feeding every X run — the interim batch-slicing selector simply retires | lab X skill gains the daily-options mode + pick-history optimization contract |

Nothing in Phase 3 *waits* on T1–T7: every feature has a working degraded mode
(staff curation, 2-stage narrative, pre-generated slot matching, staff-applied
notes, no inline video, pending chip, batch-sliced daily options).

---

## 9. Migration / backfill (script spec only — `scripts/backfill-client-agents.ts`)

Follows the scripts/import-lab-client.ts conventions: `--dry-run` default,
`--apply` to write, `--client <id>` to scope, idempotent via deterministic ids,
prints a per-client plan table. Steps per client:

1. **Umbrella creation**: for each enabled customAgent granted to the client
   (customAgentIds ∪ activated-by-successful-run, the same union the agents
   page computes) whose identity maps to a content platform
   (socialPlatformsFor(key+name) non-empty): upsert `clientAgents` doc.
   `launchState`: any successful job (review/approved/delivered) for that
   agent OR any assets attributable to its family ⇒ `"live"` (grandfathered;
   launchJobId null); else `"not_launched"`. Never overwrite an existing doc's
   launchState (idempotency).
2. **Template seeding**: distinct `templateForAsset()` results across the
   client's assets in the umbrella's family (knownKeys collapse applied,
   reference-doc slugs excluded) → `templates` entries (source "backfill",
   active, position = first-seen chain order). Rotation = template keys in
   recent-usage order.
3. **Schedule linkage**: existing weekly `PlannedScheduledRun` for the
   agent → stamp `clientAgentId` on the run and `scheduleRunId` on the
   umbrella. No cadence/zone changes (F108 legacy behavior preserved).
4. **Slot derivation — zero movement**: every FUTURE-dated asset in the family
   → `agentSlots` doc with that asset's existing day (dateKey computed in the
   schedule's zone, else runtime zone exactly as the asset was bucketed),
   templateKey from the asset, status "planned", assetId linked. **The
   backfill never re-dates an asset** — the slot plan is fitted to current
   dates; the slot planner only moves things on subsequent explicit edits.
   Days beyond existing assets are NOT pre-filled (horizon generation runs
   lazily after go-live).
5. **X umbrella (options mode, §4.5)**: created like step 1 but with
   `chainFamily` unset and no template seeding (registry stays empty — the
   options model has no template streams; `rotation` empty). `launchState`
   "live" when X runs exist (the weekly batch contract predates launches).
   NO retroactive options slots and no touching of existing batch assets or
   XDraftFeedback rows: daily options slots generate forward-only from the
   first horizon run after --apply, drawing on the most recent batch asset.
   The existing weekly schedule row is linked per step 3 and keeps firing.
6. **Jobs**: legacy jobs get NO runType (heuristic launch-detection is
   unreliable); analytics buckets them as "before run-type tracking". Optional
   `--stamp-jobs` pass stamps `clientAgentId` only (by customAgentId →
   umbrella), which is safe and useful for grouping.
7. Report: umbrellas created, templates seeded, slots derived, schedules
   linked, anomalies (assets with unknown templates → listed for staff
   review, left untouched).

Rollback: umbrella/slot collections are additive; `--delete --client <id>`
removes the new docs and clears the two linkage fields. No existing doc is
mutated beyond those two nullable fields.

Ops note (LEDGER discipline): like F127's blurb backfill, this is
code-merged + ops-pending until Albert runs it per client.

---

## 10. Build plan — Opus work packages

Sizing: one Opus builder per WP in its own worktree; file-disjoint except where
flagged; serial merges. Every WP: `npx tsc --noEmit` + `npm run build` +
unit tests for pure modules + the three-lens gate.

**Merge-conflict strategy:** WP-1..WP-6 and WP-9 build new files under
`src/components/client-agents/`, `src/lib/slot-plan.ts`,
`src/lib/actions/client-agent-actions.ts`, `src/lib/agent-identity-map.ts`.
The only shared-file touches are enumerated per WP below — those files are the
serialization points with in-flight Phase-2 clusters (custom-agents.tsx,
submit-custom.ts, webhook route, run-calendar.tsx, archive-view.tsx,
credits-panel.tsx). **WP-0 and anything touching custom-agents.tsx or
job-status maps must rebase on the AGENTS-cluster merge** (F30 "cancelled",
F129 status strip, F25 blockReason, planned-run-actions call-site arg).

| WP | Scope | Files (new / shared-touch) | Blocked on | Acceptance criteria (condensed) |
|---|---|---|---|---|
| **WP-0 Foundations** | Types (§1.4 additions + 4 new interfaces incl. slot `kind`/option fields), data.ts CRUD (clientAgents, agentSlots, clientAgentFeedback: get/list/upsert/patch, deterministic ids), `slot-plan.ts` pure module + tests (horizon gen, asset↔slot matching, reorder, `assignOptionRefs` batch-slicing selector §4.5b), agent-identity-map helper + tests | new: slot-plan.ts, agent-identity-map.ts; shared: types.ts, data.ts | **AGENTS merge** (types.ts JobStatus "cancelled" conflict) | tsc/build green; tests cover: horizon respects zone + paused templates; matching preserves deriveOrderKey order per template; no asset ever moved to a past day; identity helper resolves the F147 double-identity fixture; option selector is deterministic, never reuses a draft across slots, and diversifies directions |
| **WP-1 Launch engine** | client-agent-actions.ts (bind, **client self-serve + staff launch submit** with the §2 gate ladder incl. `agent_launch` charge + pricing gate, reset, curate templates, go-live), submit path metadata plumb (add `extraMetadata`/`runType` inputs to `SubmitCustomAgentInput`), webhook launch branch, `launchDeliverable` exclusion in getClientLibraryAssets, client Launch CTA card + LaunchProgressCard + staff curation pane, agents-page wiring | new: actions + components; shared: submit-custom.ts (metadata arg), webhook route, asset-visibility.ts, agents page.tsx | WP-0 | Client-fired launch charges `launchCreditCost` exactly once (ledger op `agent_launch`, jobId-paired) and refunds on failure with "credits returned" copy; unpriced/intake-blocked/credits-short states each show a disabled CTA with its visible reason (F25/F131 — mock-client lens walks all three); staff launch never charges; launch deliverables never client-visible through the whole cycle; state transitions server-enforced (no second launch while one is in flight) |
| **WP-2 Live view** | ClientAgentCard, template rows (per-template run w/ credit gate, pause, reorder, rationale), week strip, page card-selection logic | new: components; shared: agents page.tsx, custom-agents.tsx (render delegation only — one conditional, rebased after AGENTS) | WP-0, WP-1; **rebase after AGENTS** | Per-template run submits pinned prompt + template metadata and charges per-agent price exactly once; disabled states show visible reasons (F25 pattern); reorder persists rotation and regenerates horizon; run history for umbrella agents leaks no batch tells (churn checklist §4.1 items 3–4) |
| **WP-3 Feedback** | Feedback collection actions + modal UI (both scopes), feedback context-file builder, submit-core attachment | new: actions/components/builder; shared: submit-custom.ts (one attachment block — coordinate with WP-1's touch: WP-1 lands first, WP-3 rebases) | WP-0 | Caps enforced server-side (50 × 500); feedback file attaches on every live-umbrella run and never on launch runs; template scope validated against registry; client sees own history; staff resolve works |
| **WP-4 Slots + calendar** | Slot actions (note, reorder, skip), calendar client projection (slot chips + day-card slot view + note editor), staff slot surfaces, run-scheduled slot-aware firing, reflow delegation guard | new: slot components; shared: run-calendar.tsx, calendar-body.tsx, run-scheduled route, chain.ts, planned-run-actions.ts | WP-0; CALENDAR already merged (safe); **coordinate with WORKSPACE on notification-bell** (note alert — separate small file preferred) | Client calendar shows template-name slots for ALL future content (mock-client lens must fail to distinguish pre-generated from not-generated); notes clamp + surface to staff within one refresh; reorder re-dates matching assets correctly (test via slot-plan fixtures); paused schedule freezes horizon; no client payload carries locked content (RSC payload inspection) |
| **WP-5 Posted/archive + churn copy** | Archive = published-only + 30d window + template grouping; MarkPostedRow extraction + day-card mount; locked-copy rewrite sweep; F47 run-started copy; (stretch) video render off artifacts | shared: archive-view.tsx, asset-detail-modal.tsx, tasks-body/progress-view seeding, run modal copy in custom-agents.tsx | **Wave-B WORKSPACE (F149/F66/F107-part-1)** — consume if landed, implement if not (§3) | Client archive shows only posted ≤30d; nothing "draft"-badged ever client-visible; Mark-as-posted reachable from day card and archive modal, one action; "unlock"/"already exists" language gone from client strings; F97 attention count no longer inflated by future drafts |
| **WP-6 Credit split + analytics** | `agent_launch` operation, ledger label map, credits-panel per-agent breakdown, staff umbrella economics card incl. **setup-vs-run USD ratio + suggested launch price (§6.3)**, `launchCreditCost` field on the agent editor (validated > creditCost) | shared: types.ts (enum — WP-0 can pre-land it), credits-panel.tsx, custom-agents.tsx editor modal (rebase after AGENTS), agents page staff branch | WP-0; **rebase after CREDITS cluster** (credits-panel edits) | Ledger renders launch vs scheduled vs manual buckets that sum to the existing totals; staff card splits USD by runType with an honest legacy bucket AND shows the ratio + suggested price with sample sizes; editor rejects launchCreditCost ≤ creditCost; no charge-path behavior change (risk lens: charge/refund diffs zero) |
| **WP-7 Identity unification (F147)** | Wire agent-identity-map into calendar-body, archive grouping, jobs page, run rows, analytics labels | shared: calendar-body.tsx, archive-view.tsx, jobs page, custom-agents.tsx run rows | WP-0 (helper), WP-4 (calendar file overlap — same builder or after) | The F147 screenshot scenario (27 Jul stacked "Instagram Agent" + "Social posts (IG/TikTok)") renders one identity; TikTok single identity; zero label maps duplicated |
| **WP-8 Backfill script + handover** | §9 script incl. the X options-mode umbrella (step 5), TOMER-HANDOVER Phase-3 section (T1–T7 with file pointers), ledger flips | new: script; shared: docs | WP-0..WP-4 + WP-9 shapes final | Dry-run on Geektime + Karos Labs fixtures produces a zero-asset-movement plan; --apply idempotent (second run = no-op); X umbrella gets no retroactive slots and touches no XDraftFeedback rows; handover lists every seam with expected payload |
| **WP-9 X daily options + telemetry (§4.5)** | Option picker component (three cards, inline edit, "Use this one"), `pickAgentSlotOptionAction` (materialize chosen asset, stamp optionPick, auto-write skipped `not_posted` rows), Mark-as-posted wrapper writing the chosen `posted`/`posted_with_edits` row, options-slot rendering on calendar/day card/Today, options-mode ClientAgentCard variant | new: picker + card variant components; shared: x-agent-actions.ts (feedback writes), asset-actions.ts or a thin wrapper (posted hook), day-card file from WP-4 | WP-0 (types + selector), WP-4 (slot surfaces); **coordinate x-drafts-review adjacency with WORKSPACE (F70 owner)** — build the picker as a new component, don't edit x-drafts-review | Future days show only "pick of 3" chips (mock-client lens: option texts unreachable in the RSC payload before the day); pick materializes exactly one approved asset + N−1 not_posted rows, idempotent per slot; edited pick → posted_with_edits + finalText on Mark-as-posted; picks are free (no charge path touched); learning log serialization verified to include the new rows (existing x-agent-context path) |

Startable immediately (after AGENTS merge lands, which is imminent): WP-0 →
then WP-1, WP-3, WP-6 in parallel (disjoint after WP-0), WP-4 parallel to
WP-1/2 except the shared submit/cron file order (WP-1 → WP-3 → WP-4 on
submit-custom.ts / run-scheduled). WP-5 waits on Wave-B WORKSPACE or absorbs
F149. WP-2 after WP-1. WP-9 after WP-4 (and after WORKSPACE's F70/F28 merges
touch the X reader surfaces). WP-7 next-to-last. WP-8 last.

**DEFER-TO-TOMER list** (= §8.3 T1–T7 verbatim, into TOMER-HANDOVER.md), plus
the three ops items: run the backfill script (§9), set per-agent
`launchCreditCost` from the measured ratio once staff launches accumulate
(§6.3), and the existing F127 blurb backfill before client-facing demo.

---

## 11. Constraints honored (checklist for the drift lens)

- No removed system reintroduced: no builder agents / lib-agents engine /
  content-engine / newsletter e11 / in-app launcher; managed-product UI stays
  retired, umbrella is the sanctioned successor (F39/F45 ruling).
- All Firestore via data.ts; all writes via server actions with
  requireClientAccess / requireStaff / requireAdmin as tabled; epoch millis
  everywhere except the justified `dateKey` day-identity (§1.2).
- F108 timezone contract: slots and horizons derive from the schedule's stored
  IANA zone via run-cadence helpers; no second clock implementation.
- JOB_STATUS_META consumed, never re-invented; "cancelled" treated as terminal
  (AGENTS F30) including in the launch branch.
- Churn rule A3 is enforced structurally (server-side redaction + slot
  projection), with the five named residual tells closed in WP-2/WP-4/WP-5;
  §4.5's options texts additionally cross the RSC boundary only on their day
  (generated day-of or presented day-of, per the Q9 ruling).
- Credits vocabulary: "credits" client-facing; "token" reserved for PATs/LLM
  counts; no flat-price copy reintroduced (F130).
- Reddit surfaces: none designed (struck per rescopes); TikTok = CD-D2
  pending-verification state, decoupled from launch.
- B5 guard: AI Insights untouched by every WP.

---

## 12. Albert rulings + remaining open questions

### 12.1 Answered (2026-07-28, via orchestrator) — now binding spec

| # | Ruling | Where it landed |
|---|---|---|
| Q1 | **Launch is client-billed, priced above a template run**, with the credit price set per agent from the MEASURED setup-vs-run USD ratio (jobs.external.totalCostUsd). Staff analytics must surface that ratio to inform pricing. | §6.1, §6.3 (calibration + ops step), §1.4 `launchCreditCost`, WP-1/WP-6 |
| Q2 | **Launch triggerable by BOTH client (self-serve button with guided progress) and staff.** | §2 (gate ladder), §7.1 card 1, WP-1 |
| Q6 | **Per-agent flat run price** (today's `creditCost` model); templates inherit it, no per-template overrides. | §6.1 (no design change — default confirmed) |
| Q9 | **X keeps batch generation AND syncs to the calendar as a daily 3-option slot** with pick/edit/posted telemetry feeding a learning loop; options generated or presented day-of (churn-honest). | §4.5, §1.2 slot `kind`/options fields, seam T7, WP-9, §9 step 5 |

### 12.2 Still open — defaults chosen so building can start

| # | Question | Default until answered |
|---|---|---|
| Q3 | Must **staff confirm the template set** before the client sees it (the `curating` gate), or does the agent's output go straight to live once T1 exists? | Staff confirm (curating stays even after T1; it becomes one click). |
| Q4 | A client note lands on a day whose post is **already generated**: auto-run a paid revision pass (whose credits?), route to staff as a task, or best-effort? | Path 3 (staff notification + note surfaced); revision pass built but flag-off. |
| Q5 | Archive **30-day window**: confirm hide-after-30d (data retained, staff see all). Any client-facing "request older content" affordance needed? | Hide at 30d, no affordance, contact-us path suffices. |
| Q7 | **Paused umbrellas on the calendar**: hide future slots (client) + greyed (staff), per §4.4 — confirm. (Extends the CALENDAR cluster's logged paused-schedule gap.) | As stated. |
| Q8 | Churn: for live umbrellas, **hide raw batch-run rows** from the client's "Recent agent runs" entirely (staff keep them)? A visible "ran yesterday · 7 assets" row contradicts day-of slots. | Hide for umbrella agents, keep for non-umbrella. |
| Q10 | Q1 follow-up: while an agent's launch price is **uncalibrated**, the client Launch button is GATED ("pricing being finalized") rather than charging a provisional number — §6.3's justification (never bill a price nobody set; F130's placeholder-pricing failure at the most expensive SKU). Veto if you prefer a provisional price. | Gated until admin sets `launchCreditCost`; staff launches (free) proceed and produce the measurements. |
