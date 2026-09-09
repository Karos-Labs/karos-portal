# Task review queue — proposal

**Status:** proposal, nothing built. Written 2026-09-02 in response to the
product owner's request to "spec out a new dedicated screen/view for these
tasks that solves this UX gap naturally and gives them a clear review
destination."

**Placement: DECIDED 2026-09-02 — option (a),** its own route and rail item
(§6). Recorded there.

**Still open:** §4 (the surface), and it needs revising before it is built —
see §0.

---

## 0. The prerequisite measurement came back, and it changes §4

§8 named one measurement as a prerequisite: how many `review_pending` tasks
production actually has. Answer, read from the `(default)` database on
2026-09-02:

| | |
|---|---|
| `clientTasks` total, all 7 clients | **15** |
| `pending` | **12** (Karos Labs 7, XO Digital 5) |
| `completed` | 2 |
| `in_progress` | 1 |
| **`review_pending`** | **0** |

**Nothing is in `review_pending`, for any client.** So the half of §4 built
around "Ready for your review" — the grouped header, the ordering rule, the
`Review` button, the whole reason the surface was called a *review* queue — has
no data behind it today, and shipping it would mean shipping an empty first
section to every client.

The other half is real. **12 `pending` tasks across two live clients**, and
"N pending tasks" is a dead-ended count on both their dashboards right now.

So §8's own escape clause half-fires. It said that if `review_pending` is empty
the honest fix is to delete the two dashboard counts instead; that is right for
one of the two counts and wrong for the other. The revision:

- **The surface's subject is open items, not review.** Name it for `pending` —
  what clients have — and let `review_pending` be a state it supports and
  promotes to the top *when tasks start landing there*, rather than the
  section the page is organised around. `TaskTicketModal` still handles it; no
  code is wasted.
- **Do not build the review-specific affordances yet** (§4.1's grouped
  ordering, the artifact preview line). Those are for a state with no rows.
- **Re-run the measurement before that second phase.** Whether
  `review_pending` ever fills is a question about the execution engine, not
  about this screen.

Everything below is the proposal as originally written. §4 should be read
against §0.

## 1. The gap, stated precisely

Home's "Needs your attention" card counts `ClientTask` rows in two states and
sends the reader nowhere:

| Row | Count | Destination today |
|---|---|---|
| "N tasks ready for review" | `status: "review_pending"` | none |
| "N pending tasks" | `status: "pending"` | none |

Both are real, live signals. Neither is a link, and that is deliberate rather
than an oversight — the rule is F97 × F149, "a link is only honest if the
screen behind it holds the rows the number counted." The screen those rows used
to open was the Workspace board, removed 2026-08 under the locked decision *"The
Board is replaced by the action list on Home."* Nothing replaced its review
function.

The same absence shows up twice more, which is what makes this a gap rather
than a missing link:

- `notification-bell.tsx`'s `TaskAlertRow` carries the identical ruling in its
  own docstring ("A task alert is a STATUS LINE, not a destination") for the
  same rows.
- **`TaskTicketModal` has no live mount anywhere in the product.** Its only
  importer in `src/` is a test (`task-no-deliverable-card.test.ts`). It lost its
  mount with the board.

## 2. What already exists (and is why this is cheap)

This is the finding that shapes the proposal. The review *machinery* is built,
authorized and tested; only the way in is missing.

| Piece | Where | State |
|---|---|---|
| The review UI: deliverable preview (text / image / video / library file), approve, adjust-and-resubmit, comments, AI execution guide, per-status CTA | `src/components/task-ticket-modal.tsx` (~1100 lines) | **Complete, unmounted** |
| Approve → materialize the artifact into an Asset, promote existing draft assets, apply schedule fields | `approveTaskArtifactAction` (`lib/actions/execution-actions.ts`) | Live, client-reachable via `requireTaskAccess`, atomic (`claimTaskCompletion`) |
| Status moves, with the client/staff rules already enforced server-side | `updateTaskStatusAction` (`lib/actions/task-actions.ts`) | Live |
| Comments | `getTaskCommentsAction` / `addTaskCommentAction` | Live |
| The query | `listClientTasks({ clientId, status: [...], limit })` | Live; already called by both the dashboard and the app shell |
| Refusal copy for a lost race / not-in-review | `TASK_LEFT_REVIEW_MESSAGE`, `TASK_NOT_IN_REVIEW_MESSAGE` (`lib/actions/_shared.ts`) | Live, pinned by `client-copy-boundary.test.ts` |

**So the work is a list and a route, not a review surface.** That is the main
argument for doing it at all: the estimate is small and the alternative
(leaving two permanently dead counts on the dashboard) is a standing lie on the
client's first screen.

## 3. What this must NOT be

Three constraints, each from a decision already on the record. A proposal that
breaks one of them should be rejected on that basis alone.

1. **Not a board.** "The Board is replaced by the action list on Home" is
   locked. No columns, no drag-and-drop, no owner tabs. The board was removed
   because it presented a workflow the client does not run; re-adding it under
   a new name would re-add the same problem.
2. **Not a second copy of the Home action list.** `lib/action-list.ts` is a
   **preset onboarding checklist** — 20 hand-typed rows, "PRESET AND DEFINED,
   NEVER GENERATED," whose "done" is computed from signals. It is not a task
   queue and does not read `ClientTask` at all. The two do not overlap, and
   merging them would put live work items inside a fixed checklist.
3. **Not a new authority.** Every action is an existing server action with its
   existing gate. Nothing here lets a client approve something they could not
   approve before; it gives them a screen for what `requireTaskAccess` already
   permits.

## 4. Proposed surface: a review queue, not a board

**One route, one list, one modal.**

```
/clients/[id]/tasks          staff, scoped to that client
/tasks                       a CLIENT_USER's own (resolved from user.clientId,
                             same shape as the flat /calendar route)
```

`/tasks` is free: the page route was deleted with the board and only the
`/api/tasks/*` handlers still use the name. Reusing it is deliberate — it is
the address the product had for this, and `client-rail.tsx` still tells the
next reader it exists (see §6.1).

### 4.1 Shape

A single vertical list, newest-first, grouped by one header per state — the
same arrangement `AssetsView` already uses for the staff library, deliberately,
so this is a familiar list rather than a new interaction model:

```
Ready for your review        3          ← review_pending, first, always
  ┌───────────────────────────────────────────────────┐
  │ [icon] Approve the Q4 content plan                │
  │        LinkedIn agent · high · 2 days ago         │
  │        "Here is the drafted plan…"      [Review]  │
  └───────────────────────────────────────────────────┘
  … 2 more

In progress                  2          ← pending / in_progress
  [icon] Send brand assets · Karos team is working through these
  …
```

- **`review_pending` rows come first and are the only ones with a button.**
  They are the only rows that ask the reader for a decision. The rest report.
- A row shows: title, the agent that produced it (`metadata.agentName`, through
  the §7.3 identity helper — never a per-surface name map), priority,
  `relativeTime(updatedAt)`, and a one-line artifact preview when there is one.
- **`Review` opens `TaskTicketModal`.** Not a detail page. The modal is built,
  it handles all four deliverable shapes, and it is what the board opened.

### 4.2 Filters

Status and agent, seeded from `?status=`, matching the `AssetsView` /
`ArchiveView` pattern that was just re-established for the content deep links.
**Only offer states the reader's own data can hold** — ask
`lib/client-state-domain.ts` rather than typing a list. That module exists
precisely because three surfaces once offered a filter that could only ever
empty the page.

### 4.3 Empty state

"Nothing waiting on you." Plus the count of tasks in progress, so an empty
review queue does not read as an empty account.

### 4.4 What a CLIENT may see

`review_pending` on a `karos_managed` task only. `updateTaskStatusAction`
already refuses to move a `client_managed` task into `review_pending` ("Tasks
you own go straight to Done"), so that state is Karos drafts by construction.
Two fields must not cross: `metadata.executionError` (a raw engine diagnostic,
staff-only per `task-disable-copy.ts`) and any stored status enum rendered
verbatim — the registers in `lib/task-status-copy.ts` are what a client reads.

## 5. What this closes

| Today | After |
|---|---|
| "3 tasks ready for review" — inert text | links to the queue, filtered to those three |
| "2 pending tasks" — inert text | links to the queue |
| Notification bell task rows — inert | link to the queue (their docstring's stated blocker removed) |
| `TaskTicketModal` — 1100 lines, no mount | mounted |
| Home's attention card cannot offer a Review action on its most urgent item when that item is a task | it can |

## 6. Placement — the open question

Three candidates. **The recommendation is (a).**

- **(a) Its own route + rail item. ← DECIDED 2026-09-02.** A client's rail is Home, the AI-agents
  roster (rendered inline, not a row), Calendar, and Account Center — three
  destinations. "Review" becomes a fourth, with a count badge when non-zero.
  Best discoverability, and the count is then ambient, which is the argument
  `notification-bell` makes for keeping the bell out of the account menu ("a
  badge behind a dropdown is not a badge"). Cost: a rail item, and the portal
  revamp spent effort reducing that list.
- **(b) A tab in Account Center.** Cheapest — the tab strip exists and takes a
  `?tab=` deep link already. But Account Center is explicitly *"everything that
  is not daily use,"* and a review queue is daily use. Wrong home by its own
  charter.
- **(c) Expand the Home card in place.** No new surface at all: "Needs your
  attention" grows an expandable list. Rejected — it puts a filterable,
  paginated queue inside a summary widget, which is how that card became the
  five-equal-rows problem the 2026-09 pass just fixed.

### 6.1 One stale comment to fix on the way past

`client-rail.tsx` still says, of the removed Workspace entry: *"The /tasks
route and its data are untouched by this change: only the sidebar's entry point
is removed."* The data is untouched; **the route is not** — there is no
`src/app/(app)/tasks/` any more (only the `/api/tasks/*` handlers). Whoever
builds this should either take `/tasks` back for the queue and make that
sentence true again, or correct it. It is the kind of comment that sends the
next person looking for a page that does not exist.

## 7. Estimate and sequencing

Small, because §2. Roughly:

1. `lib/task-review-queue.ts` — pure grouping/ordering/filter-offer logic, no
   Firestore. Testable directly, same shape as `lib/action-list.ts`.
2. `components/task-review-list.tsx` — the list, mounting `TaskTicketModal`.
   Takes `viewerIsClient` **required, no default** (the standing convention: a
   defaulted viewer flag is how a client surface acquires staff vocabulary).
3. The two routes, both reading `listClientTasks` with an explicit `limit` and
   passing a `hitLimit` flag — a windowed count printed as a total is the
   defect `tasksHitLimit` exists for on the dashboard.
4. Re-point the producers: the dashboard's two attention items, and
   `notification-bell`'s `TaskAlertRow`.
5. Tests: the grouping/ordering rules; that a client is never offered a filter
   their data cannot hold; that `executionError` never renders for a client;
   and — the one that would have caught the calendar bug — **that the
   dashboard's counts and this list's contents are derived from the same
   predicate.**

## 8. Risks

- **The counts and the list must agree.** This is exactly the defect just fixed
  on Home's Calendar widget: it filtered on `status === "scheduled"` while the
  calendar page filtered on `postKind`, and a production client saw an empty
  widget beside a full calendar. One shared predicate, in
  `lib/task-review-queue.ts`, asked by both.
- **~~`review_pending` may be near-empty in practice.~~ MEASURED: it is empty.**
  Zero rows, all seven clients, 2026-09-02. See §0 for what that changes. The
  risk is now the opposite one: building the review half against no data.
- **A fifth nav item costs something.** See §6(a).
