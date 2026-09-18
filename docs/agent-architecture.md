# What the portal owes an agent

**Status:** the standard · owner Shlomi · companion to `agent-engine/docs/AGENT-ARCHITECTURE.md`
and `agent-middleware/docs/AGENT-ARCHITECTURE.md`
**Rests on:** C7 (run context), D11 (the goal line), D15 (cadence is the client's), D23 (owners)

The portal is the only one of the three repos a client ever sees. That gives it two jobs
nobody else can do: hand a run everything the platform has learned before it starts, and
show the client what came back — without showing them how the sausage was made.

Read the engine's `AGENT-ARCHITECTURE.md` first; it defines the run. This file is what the
portal must hold up at either end of it.

---

## 1. Before the run: give it the live context

A run gets its context as **files in its workspace**, not as form fields. `toEngineRunInput`
carries what the client typed; everything the platform *learned* travels the projection
path — the same mechanism `context-doc-projection` already uses for C1's documents, but on
every run rather than only at onboarding.

Two writers project, and they do not overlap:

| Projected by | Files |
|---|---|
| **agent-middleware**, at dispatch | `context/learning/<platform>/{platform-state,subject-window,feedback,what-works,strategy-map,craft}.json` and `context/learning/preferences.json` |
| **the portal** | C1's `context/<docType>.json` and `client/competitors.json` |

**Live at run time, never a snapshot.** A context assembled at submit and carried through a
queue is stale by the time the run reads it, and the staleness is invisible.

### 1.1 `slotStage` — the one field sequencing owns

A calendar run carries `slotStage` (`attention` | `expertise` | `decide`) on its run input.
A manual run does not, and the engine derives a stage from the account's recent history
against the D32 mix. Cadence is the client's choice in the calendar, not a per-agent setting
(D15); sequencing decides which post goes in each slot.

Do not send `slotStage` on a manual run to "be helpful". The absence is information.

---

## 2. After the run: collect, then render

`src/app/api/agent-engine/reconcile` materialises what a run produced. For an agent on the
loop it must also call the middleware's `POST /runs/{run_id}/collect`, which is what folds
the run's state files into the stores. A reconcile that materialises assets but never calls
`collect` gives you an agent that produces and never learns — and it looks completely healthy
from the outside.

That call lives in `src/lib/agent-engine/learning-collect.ts` and is made from
`syncAgentEngineJobStatusFromView`, asked the way materialization is asked — *"did this
happen?"*, not *"is this the transition where it should happen"*. Gating it on the terminal
transition would strand every run delivered before the call existed, because their transition
was already recorded. `job.learningCollectedAt` is the bookmark that stops the sweep
re-asking; `learningCollectReason` carries the middleware's answer when it collected nothing,
so "this agent learned nothing" is a fact on the job rather than a line in a log.

Only a **completed** run is collected. `failed` and `degraded` are refunded — the client
received nothing — and a subject the client never used must not enter the anti-repeat window.

### 2.1 The two run ids

They are not the same id, and confusing them is what kept the loop open:

- **agent-engine's** is `pubsub-<messageId>`, derived from Pub/Sub's own message id. It keys
  `agentEngineRuns`, every path the run writes (`state/runs/<runId>.json` included), and
  `asset.meta.agentEngineRunId`. **It is the only one this repo holds.**
- **the middleware's** is its own, minted at dispatch. `dispatchViaMiddleware` returns it and
  this repo drops it.

So reconcile can only ever send the engine's, and the middleware resolves either spelling
(`LearningService._resolve_run`). Send the engine's; it is what the state files, the
deliverables and the portal all agree on.

## 2.2 Review actions

Feedback posts to `POST /clients/{slug}/learning/feedback`; "add this to never-topics" posts
to `PUT /clients/{slug}/learning/preferences` (a full replacement — read, add, write back).
Both live in `src/lib/agent-engine/learning-feedback.ts`. Feedback that only lands in a
Firestore field is feedback that never becomes a rule.

Two callers, deliberately:

| Where | What it sends |
|---|---|
| `markAssetPostedAction` | `posted`, or `posted_with_edits` when `updateAssetAction` stashed the agent's own text on the first edit (`meta.engineOriginalContent`) |
| `addXDraftFeedbackAction`, `addLiDraftFeedbackAction`, `addRedditDraftFeedbackAction` | the client's own words: `posted`, `posted_with_edits`, `not_posted` → `skipped`, `edit_request` → `change_requested`, `note` |

The per-agent surfaces keep their Firestore rows — the portal's own history views read those
and nothing else does. This is a **second write**, not a move.

**The edit pair is the point.** "What the client changed" is a direct statement about voice
that no amount of drafting infers, and the projection puts the last few in front of the next
draft. Both halves are required; the middleware rejects half an edit, and the portal
downgrades to a bare `posted` rather than sending one. Capturing the original at post time is
too late — by then the edit has already overwritten it.

---

## 3. The goal line, and the meta that must never reach a client

Every output states its point: **goal, who it is for, why now** (D11). The engine emits it;
the portal renders it.

**There is no `goalLine` field.** An earlier version of this section described one, and
nothing has ever emitted or read it — the name appears in this repo only as an unrelated
SEO/GEO gap line and as the local variable that renders the block below. The real shape is
**three separate top-level fields on the deliverable**, and Reddit's own fourth:

| Field | Sent by | Meaning |
|---|---|---|
| `goal` | x, linkedin, instagram, the three TikTok agents | the funnel stage, in the engine's own word — `attention` / `expertise` / `decide`. The client reads the sentence, not the word |
| `audience` | the same | who this one is for |
| `whyNow` | the same | why this week |
| `whyThread` | reddit | its shape of the same line. A reply has no funnel stage to state, but it must say why THIS thread was worth answering. `goal`/`audience` ride along in Reddit's list for the agents that do emit them |

They reach the client through **one path, for every product**:

1. `src/lib/agent-engine/materialize.ts` projects them onto `asset.meta`. A product whose
   deliverable is a bag of fields lists them in its `materializeDraftBatch` `metaFields`
   (x, linkedin, reddit); a product whose deliverable is a typed shape spreads
   `goalLineMeta(deliverable)` into its `meta` literal (instagram, the three TikTok
   agents). Same rule, two spellings, because those materializers have no `metaFields`
   list to add to.
2. `src/components/asset-detail-modal.tsx` renders them as the "The point of this post"
   block. It is a sibling of the content branch, not inside it, so a carousel and a video
   reach it exactly as a drafts batch does — **there is no per-product renderer to write.**

Read leniently at both ends: a field the run did not send stays off the asset, and the
block renders only the rows that are there. A run from an older prompt version, or one that
resumed mid-flight, legitimately carries none of it, and an empty labelled row is worse
than no block.

The three drafting agents have a **second** surface on top of that one. Their deliverable
is a drafts batch — several drafts in one asset — and the asset-level meta above can only
describe one thing, so each draft carries its own copy in the markdown or the envelope:

| Shape | Agents | Read by |
|---|---|---|
| `- **Label:** value` bullets in the drafts markdown | x, linkedin | `src/lib/x-drafts.ts`, `src/lib/li-drafts.ts` — every such bullet is pushed onto that draft, and `x-drafts-review.tsx` / `li-drafts-review.tsx` render them per draft |
| a named slot in a JSON envelope | reddit (`whyThread`) | `envelopeToBatch` in `src/lib/reddit-drafts.ts`, rendered as "Why this thread" by `reddit-drafts-review.tsx` |

`classifyXMetaBullet` weighs a bullet's URL against a reply/quote phrase to find a draft's
reply target. The engine therefore strips URLs from the why-now bullet. If you add a meta
bullet that legitimately carries a link, give it its own label — do not widen the classifier.

**Internal meta never reaches the card.** Account-manager fields, revision counts and
reviewer notes belong on the gate payload and the run report. `materialize`'s `metaFields`
is the surface that leaks them; `formattingNotes` reached a client through it once. Client
copy never mentions review or approval.

---

## 4. The catalog

Three bands (D09), and an agent's band is a product decision, not a code detail:

- **up and running** — X, LinkedIn, Reddit
- **beta** — Instagram, and the three TikTok agents
- **coming soon** — Rebrand, Newsletter/Blog, Landing page, Micro-influencers, Motion design, PR

SEO/GEO and Reputation are **reporting, not agents** (D07). Campaign is **not an agent** — it
is a button that runs the other agents around one launch, and it is never listed in the
catalog (D40).

TikTok is three cards with three different forms (D08): clipping takes a long video or "find
podcasts in my niche"; editing takes the client's own video plus what to communicate, length,
CTA and edit constraints, and is on demand, outside sequencing (D19); content design takes
nothing, or a note about the topic, and ships as beta (D20).

Adding a product id to the catalog without its form is how a client gets refused on every
press.

---

## 5. Autopilot and publishing — what the UI may offer

Per D35 and D38, and these are product rules, not defaults to tune:

| Platform | Publishing |
|---|---|
| LinkedIn | draft-only; the person posts in one click. Karos staff are never a client's page admin |
| Reddit | draft-only by hard product rule; no posting code path exists or may be added (D25) |
| X | autopilot only behind the consent screen X requires; text only — no images sourced or created, and a client's own picture is attached and written to if they give one (D24). The run dialog offers no "where do the visuals come from" choice here, because there is only one answer |
| Instagram | autopilot offered; format and visuals chosen per post by performance, never by a fixed rotation (D17) |
| TikTok | autopilot only after the Content Posting audit |
| Google Business Profile, Pinterest | never |

Every new client is manual.

---

## 6. When you add an agent

1. A catalog card in the right band, with its form.
2. The product id in the portal's product mapping, and the platform key it belongs to — a
   TikTok agent is `tiktok`, whatever the product is called.
3. Projection: nothing, if the platform already has it. The stores are keyed on the
   platform, not the product, because a client has one account per platform and one subject
   history on it.
4. Reconcile: call `collect` for it.
5. The goal line: carry `goal`/`audience`/`whyNow` onto the asset in `materialize.ts`, by
   whichever of the two spellings in §3 that product's materializer uses. Nothing to
   render — the modal's block already reads them.
6. A portal doc under `docs/<agent>-portal.md`, like the ones already there.

If a step in that list feels like it does not apply, say why in the PR. Every one of them has
been skipped once, and each time the symptom was the same: an agent that looked fine and
quietly learned nothing.
