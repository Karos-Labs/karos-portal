# Portal-finalisation review — Albert's directives (CD-L, 2026-08-03)

Source of truth for auditing `fix/portal-finalisation` (Daniel's 49-commit
round): two meeting transcripts (weekly-goals call + platform-review call,
distilled to product feedback only) plus Albert's written recap while walking
the branch on localhost.

## THE KEEP-RULE (AF-0)

A change on this branch survives only if it is one of:
1. **SOURCED-ALBERT** — traces to a feedback item below (cite the AF number);
2. **INVISIBLE-CORRECTNESS** — a security / billing / correctness / data-integrity
   fix a user cannot see (fences, metering, scheduler dedupe, leak closures);
   these keep regardless of source, listed for Albert's awareness.

Everything else — any **visible UI/UX change with no AF source** — is a STRIP
CANDIDATE: inventoried with what changed vs the merge-base (`0ee7420`), and
stripped only after Albert rules on the list. "I don't want to have all the BS
changes that it created because Claude found those changes… I want only things
that are from pure real feedback."

## Explicit rulings from the recap (strip/fix NOW, no further approval needed)

- **AF-1 Meetings placement.** The Meetings tab does NOT belong in the client
  sidebar (the branch added it there citing its own doc's #134). Keep the
  meetings feature ("let's keep it, it doesn't hurt" — call 2) but reach it
  from Settings, not the rail.
- **AF-2 Account settings.** Profile information + account security live as
  TABS inside the normal Settings page. No separate "account settings" page
  behind a button hop. "It's just supposed to be seamless."
- **AF-3 One look for both views.** "View as Client" (staff) and the real
  client view must look the same: same favicon, same layout, same palette.
  The orange-accent scheme is rejected — "some of the buttons are orange in
  the view as a client, which is supposed to be not like that. I prefer the
  client version" on colors; the view-as-client layout is preferred and stays.
  If the orange re-theme was introduced on this branch without an AF source,
  restore the prior (dark + neon) theme.
- **AF-4 Company info panel polish.** Social accounts render as the PLATFORM'S
  LOGO + `@username` (shorten any stored full link to the username), and each
  row is clickable, opening that profile. Same pattern as the clickable
  brand-color swatches. Applies wherever the handles show (company panel,
  profile card).

## Feedback items from the calls (the audit's trace targets)

- **AF-5 Live means live.** If content items exist on the client's calendar
  (we produce posts internally and import them), the agent shows **LIVE** even
  though its own schedule/cron is paused. "It should still show that it's live
  even though we're creating it internally… if there's items on the calendar
  like Instagram or TikTok items, it should show us live." Staff surfaces keep
  the operational truth alongside.
- **AF-6 Templates on the agent page.** Clicking the Instagram agent shows the
  different templates we produce for that client and an example of each.
- **AF-7 Agent details on the page.** "Your X details — this is a button here,
  but realistically it should show on this page." The client's own intake
  answers render inline on the agent page (through the client-safe views),
  with the edit still living on the intake surface.
- **AF-8 No em dashes in client copy.** "Why is there an M dash? We don't use
  those."
- **AF-9 Post-run navigation.** After "run the agent" the flow should not dump
  the user back somewhere confusing; improve UX without losing features.
- **AF-10 Credits exhausted is a message, not a spinner.** When credits run
  out, surfaces say something honest ("please contact your Karos team"), never
  load forever.
- **AF-11 SEO/GEO approve flow.** No duplicate rows after approval; where an
  approved item goes must be visible/understandable.
- **AF-12 About text clamped.** The client "about" must not render as a huge
  block in the rail (branch commit 6547959 traces here — SOURCED).
- **AF-13 Rail is not scrollable** (standing CD-E3 contract — keep).
- **AF-14 Clients never see failed runs** (verified live in the call — keep
  the guards).
- **AF-15 Video download button** on video assets (Tomer added — keep).
- **AF-16 Copilot actions vs chat.** "Refresh task map" pops a different thing
  than a chat answer — differentiate in UI or relocate (noted; Ben's item).
- **AF-17 Favicon/spacing consistency** between staff and client views (part
  of AF-3's parity).
- **AF-18 Saved agent stages / input rollback** for client-driven agent edits
  (future item — note only, Tomer/infra).

## Process

Audit every one of the 49 commits against this list → per-change ledger
(SOURCED-ALBERT n / INVISIBLE-CORRECTNESS / STRIP-CANDIDATE / CONFLICTS-AF-n)
→ Albert rules on strip candidates → strips land as surgical restore commits
(never history rewrites) → gates (tsc/build/vitest/lint) after every merge.
Nothing pushes without Albert.

## Resolution status (2026-08-03, head 97a6f8e)

Audit: docs/portal-finalisation-review/audit-ledger.md (d40b54c). Both build
waves merged (builder B 2c1bbb9, builder A bca907b), gates green at every
step: tsc clean · 3433 tests · build exit 0 · lint 0 errors.

- AF-1 RESOLVED — Meetings out of the client rail and sheet; the pre-existing
  Settings Meetings tab is the one entry point. The "#134" the rail entry
  cited does not exist in the QA doc (audit-verified fabrication).
- AF-2 RESOLVED — Profile Information + Account Security are real tabs of the
  client settings page; /settings redirects clients (staff keep it).
- AF-3 RESOLVED-REFRAMED — the orange is Albert's OWN Ember brand system
  (7d53506, on main, pre-branch; Daniel touched no stylesheet). No revert.
  Parity work done instead: nav tables asserted EQUAL, one favicon source,
  wordmark identical at all mounts, staff Company sheet unclamped (97a6f8e).
  CLAUDE.md's stale "dark + neon-green" line corrected to Ember.
- AF-4 RESOLVED — social rows are platform mark + @handle (shortened on save,
  idempotent), clickable, via the existing SocialPlatformMark set.
- AF-5 RESOLVED — upcoming calendar content ⇒ LIVE (Set-of-ids boundary, no
  counts); refusal still outranks; staff get the operational note. The
  failed-run rung is staff-only now (was flipping a client's badge —
  CONFLICTS-AF-14, resolved per the directive).
- AF-6 RESOLVED — each format row carries its newest delivered post as the
  example (archive-filtered).
- AF-7 RESOLVED — intake answers render inline via the same client-safe views
  the intake pages use; edits stay on the owning form.
- AF-8 RESOLVED — both guards inverted (house rule: no em dashes in client
  copy), 282 literals across 74 files swept, copilot prompt told the same.
  Known residual: strings already PERSISTED in Firestore keep their dash
  until rewritten (data script needs Albert's sign-off).
- AF-9 RESOLVED — staff "Run now" stays on the agent page with an in-flight
  banner; a run the viewer started keeps its In-progress card (cron ticks
  stay invisible, A3/A4).
- AF-10 RESOLVED — schedule dialog paints the shared credit refusal; paused
  format no longer masks "out of credits"; task-plan errors surface.
- AF-11 RESOLVED — Daniel's same-recId dedupe verified + the healed-copy twin
  class closed; post-approve copy names the hand-off.
- AF-12/13/14/15 — sourced keeps, verified by audit.
- AF-16 (copilot task-map placement) and AF-18 (input rollback) — NOT BUILT,
  deferred with Albert's list.
- STRIP CANDIDATES held for Albert's ruling (kept in place meanwhile):
  task-board delete-confirm + client run-price confirm (ff5c9ef/fb4f132),
  "Remove this seat" (f1e8ecf), "AI Agents"→"AI agents" casing (6fad72d
  rider). Everything else classified keep (sourced or invisible-correctness);
  staff-only additions (ops links, library picker, bulk-upload, not-billed
  badges) recommended keep.
- Deploy note from the branch itself: run scripts/audit-schedule-billing-flags.ts
  READ-ONLY before this branch deploys.
