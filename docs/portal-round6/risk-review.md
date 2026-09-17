# Round 6 risk review: the three thinking docs against the brief

Worktree at `855f8146` (= `origin/main 532bf1b6` + docs). Line numbers are this worktree's; drift from the docs' commits was three lines at most. Verdicts: **CUT**, **KEEP AS DECISION** (goes on list E), **KEEP**.

---

## A. Derailments

No em dash and no spaced hyphen appears in any of the three docs (grep over all three), so no client-copy dash offences. Everything below is about scope and settled rulings.

### think-home

| § | Proposal (quoted) | Problem | Verdict |
|---|---|---|---|
| 2.10 | "the freed slot takes 'More ways to get value' (B12 ...) reusing `HomeTaskRow`" | Brings the round-4 Next-actions list back onto Home. Not content ideas, and `portal-audit-status.md` lists it as Open, so not a settled ruling; still unasked. | KEEP AS DECISION (recommend: not this round) |
| 3.3 | "Four row kinds ... Feed: a bounded read in the layout" | Albert asked that existing rows lead somewhere, not for a new feed. §3.2 alone delivers the ask. Needs `notificationsSeenAt` (new field) and new reads. | KEEP AS DECISION, unasked, phase 2 |
| 3.2 | Removes the R10 client summary rows | See B5: legitimate revision. | KEEP |
| 2.3 | "Profile complete = category, description, website" | Widens a definition; harmless, sensible. | KEEP AS DECISION |
| 2.4 | "'Looks right' ... and 'Something is off' (opens Support with the document named)" | Brushes the open brand-voice question. As written it does not assume an answer (Support, not an editor). Doc already flags it. | KEEP, Support only |
| 2.7 | `asset` added to `CALENDAR_QUERY_KEYS`; action 05 becomes an event write | Data-shape change, but needed for "land on the exact thing". | KEEP AS DECISION (small) |

Everything else in think-home (the `--focus` token, SEO cells as links, the ladder landings) is either asked for or needed to deliver an ask. Nothing re-opens a ruling; §1.5's button label is settled in B4.

### think-agents

| § | Proposal (quoted) | Problem | Verdict |
|---|---|---|---|
| 1 | "six client states ... Paused, Needs your input, Being set up" | Relabels words Albert did not complain about; 23 pins in `client-agents.test.ts`; think-reporting D5 argues the opposite. His complaint was the badge and the logic. | CUT the renames. KEEP the precedence, the predicate fix, the reason line, the `Internal` failed-run marker |
| 1 / D4 | "'Coming Soon' ... becomes 'Paused by your Karos team'" | An agent the client never had is not "paused" (`client-agents.ts:872`). | CUT |
| 1 | Header chip goes; strip becomes one plain status line | Direct answer to "is the badge necessary" and "doesn't look that good". | KEEP AS DECISION (his question; recommend yes) |
| 2 / D2 | "allow it (S: route + `canUpload`) so 'Add files' exists for clients" | New capability; the 403 at `context/route.ts:70` is deliberate. He asked for the dashed box to go. | CUT: render nothing for clients, staff keep the picker |
| 2 | Run type "Set up the content system / Refresh strategy" under More options | Staff operations offered to a client. | KEEP, staff-only inside the existing `StaffOnlySection` idiom |
| 2 / D3 | Default post count 1, price follows `post_count` | Product default change. | KEEP AS DECISION; the multiplier fix is required either way |
| 4 / D5 | Cards become full-width rows | An audit was asked; a rebuild is a choice. | KEEP AS DECISION |
| 5 | "five `accent` CTAs that become paper `primary`" incl. `agent-detail-panel.tsx:210-227` | Contradicts think-home §1.6 and Ember §7. | Partly CUT, see B2 |

### think-reporting

| § | Proposal (quoted) | Problem | Verdict |
|---|---|---|---|
| 2C / D3 | "decision D3 if Albert wants 'Ask about it' on the button itself" | R7 settled one word per support trigger. | CUT "Ask about it" |
| 2C / D2 | "Not on your plan" rows, "Open {name}" for granted, Support otherwise | See C row 21: a client cannot open an ungranted agent page, so "Open" never renders there. | KEEP AS DECISION (recommend yes, Support only) |
| 2C | Status badge and "Quoted N times" line per row | Unasked; harmless; the status forces the roster extraction B3 wants anyway. | KEEP (unasked, optional: drop the quoted line if short on time) |
| 3.1 | `MeasurementStamp` moves under the tiles | Unasked, small. | KEEP (unasked, optional) |
| D6 | Per-client "site access" flag | New data field, unasked. | CUT this round |
| D1 / D4 | GEO-04 as a "relationships" row; dynamic agents in the section | Implementation details. | Decided: OUT / not v1 |
| 2E | Eyebrow "What we are doing for your SEO and GEO" | He said "actively doing to improve"; think-home differs again. | Ruled in B6a |

---

## B. Contradictions, each with one ruling

**B1. Status vocabulary.** think-agents §1 wants six new words; think-reporting §2C/D5 wants the current roster words plus "Not on your plan".
*Ruling:* keep the current words (Live, Setting up, Setup needs attention, Needs attention, Runs on request, Not set up yet, Coming Soon), rendered everywhere by one exported `RosterStatusBadge`; "Not on your plan" exists only on Reporting; think-agents' reasons ("Your X details are missing. Add them") become the sentence under the badge, never a new badge word.

**B2. The agent page's orange.** think-home §1.6 keeps one accent (the run panel); think-agents §5 demotes all five, dialog CTA included. Ember §7 per `ui.tsx:6-8`: "accent = the one orange CTA (rationed)". Zero is not the rule; one is.
*Ruling:* `agent-setup-hero.tsx:65`, `launch-card.tsx:147-156`, `legacy-agent-panel.tsx:201-208` and `agent-detail-panel.tsx:210-227` keep `accent` (mutually exclusive states, one renders per page); `task-kickoff-strip.tsx:117-124` and the dialog confirm (`custom-agents.tsx:2655-2657`, "Create post") become `Button primary`; the Pin button and selected chips lose orange as think-agents proposes.

**B3. The "Live" predicate.** Three spellings in the docs; one function in code. `rosterStatus` (`client-agents.ts:868-878`) takes `hasUpcomingContent` from `agentsWithUpcomingContent` (`agent-detail-archetypes.ts:439`) on both the roster (`agents/page.tsx:358`) and the detail page (`[agentId]/page.tsx:505`). The bug is inside `isUpcomingCalendarItem` (`:396-402`); the ladder (`clients/[id]/page.tsx:460`) bypasses the function.
*Ruling:* Live = `rosterStatus(...).tone === "live"`, where `hasUpcomingContent` = any non-launch, non-test asset attributed to the agent with `scheduledAt` in (now, now + 14 days] and `postKind` in {scheduled, placeholder, draft} (`isUpcomingPost`, `calendar-kind.ts:131`, plus the ceiling); umbrella `live` and schedule `active` also qualify; refusal and pause outrank. Readers: ladder step 3 (replace `page.tsx:460`), both agent pages (wired), Reporting via the extracted `buildClientRosterEntries`.

**B4. The per-agent control on Reporting.** think-home: `Button outline` "Open the {Reddit} agent"; think-reporting: text link "Open {name}" + chevron, `hover:text-neon`. Albert: "a button that links DIRECTLY".
*Ruling:* `Button outline` (a Link styled as one), label "Open {stored agent name}" (R7: one name per agent, so "Open Reddit Agent"), no chevron (think-home rule 2: no glyph after a button label); `hover:text-neon` is not a rule anywhere in `globals.css`, so think-home rule 2 (quiet links hover muted to foreground with underline) wins for text links portal-wide.

**B5. Removing R10's client summary rows.** R10's own comment (`notification-rows.ts:143-170`) says the rows are inert because Home's counts are also destination-less. Albert's round-6 ruling ("every notification row must be clickable and lead somewhere") supersedes that compromise.
*Ruling:* legitimate revision, not a derailment: drop `ReviewSummaryRow` and `TaskSummaryRow` for clients, the count drops to the meeting items, the badge stays honest; the fact lives on Home's attention card as an indicator.

**B6. Others.**
- a. Section heading: use Albert's words, "What we are doing to improve your SEO and GEO" (both docs' variants retire).
- b. "Support" vs "Ask about it": Support (R7).
- c. Ladder step 3 verbs ("Add your LinkedIn agent details" / "Set up the LinkedIn agent") vs roster verbs ("Set up" / "Launch" / "Request setup"): the ladder button is the long form of the roster verb; "Request setup" never appears on the ladder (a waiting row carries no button).
- d. Run dialog default: think-home §2.6 is singular, think-agents D3 says 1, code says 3 (`custom-agent-launch.ts:296`). Ruling: default 1, footer price = `post_count` × per-post estimate, "about N credits".
- e. Dialog labels: the page trigger keeps R15's format-naming label (`agent-detail-panel.tsx:226`); dialog title and CTA say "Create post" (noun-aware: clip, reply).
- f. Empty states: bell "Nothing needs you right now." + "Open your calendar"; "Things only you can do" keeps its heading with "Nothing on your side is holding you back right now."

---

## C. Code spot-checks

| # | Claim (doc) | File:line here | Verdict |
|---|---|---|---|
| 1 | Imports written as drafts | `lib/actions/lab-output-actions.ts:299` `status: "draft"` | HOLDS |
| 2 | Reflow moves only drafts | `lib/post-chain.ts:220-237`; `:236` `if (mode === "reflow" && a.status !== "draft") return false` | HOLDS |
| 3 | `isUpcomingCalendarItem` rejects drafts | `lib/agent-detail-archetypes.ts:396-402`, reason at `:380-387` | HOLDS. Note `isClientCalendarStatus` (`:398`) now always returns true, so the draft exclusion lives only in the `postKind` test at `:401` |
| 4 | `isUpcomingPost` counts drafts; comment on clients seeing drafts | `lib/calendar-kind.ts:92-96` (UPCOMING_KINDS has `draft`), `:131-135`, comment `:188-208` "NO LONGER DRAFT-EXCLUDING" | HOLDS |
| 5 | rosterStatus idle branch; staff-only "Needs attention" | `lib/client-agents.ts:930-932`; `:902-910` (`viewerIsStaff` gate); AF-5 rung `:872-877` | HOLDS |
| 6 | Card hover, Button lift, focus ring, inputs `outline-none` | `components/ui.tsx:71`; `:19,21`; `:39` `ring-foreground/25`; `:99,113,127`; §7 comment `:6-8`; `Badge tone="neon"` = success `:155` | HOLDS |
| 7 | Static SEO cells in the KPI shell | `components/home-standing.tsx:33-56` (`div`, same shell); "See the breakdown" + chevron `:143-149`; empty tile `:180-192`; orange takeaway `:205-209` | HOLDS. Its hover is already muted to foreground with underline; only chevron and label are wrong |
| 8 | `start` only to `next`; no row link; "Let's do this" | `home-get-set-up.tsx:188-195`; `home-task-row.tsx:277-288`; orange Link `:317-322`, label `:319` | HOLDS |
| 9 | Profile signal; step-4 signal; 7-day hide; ladder live | `clients/[id]/page.tsx:348`; `:346-351`; `:528-533`; `:460` `launchState === "live"` only | HOLDS |
| 10 | `isClientOwnedGap`; seven copy entries; REC_COPY fallback | `lib/seo-geo.ts:1556-1558`; `:1574-1609`; fallback `:1674-1687` (`known?.title ?? catalog!.title`) | HOLDS WITH DRIFT (fallback) |
| 11 | Seats card; ClientSuggestions second; reputation bubble | `settings/page.tsx:405-437`; `:646-649`; `:540-571` (`Badge tone="neon"` at `:554`) | HOLDS |
| 12 | Always-visible stars, pinned orange | `components/client-rail-agents-nav.tsx:78-100`; `:96` `text-neon`; `pr-7` at `:61` | HOLDS |
| 13 | `canUpload={!viewerIsClient}`; 403 for clients | `components/custom-agents.tsx:2881`; `app/api/clients/[id]/context/route.ts:70` | HOLDS |
| 14 | `post_count` default 3 vs `batch_size` multiplier | `lib/custom-agent-launch.ts:77` `BATCH_SIZE_FIELD_KEY`; `:296` `defaultValue: "3"` | HOLDS |
| 15 | Five accent CTAs on agent surfaces; arrow as a character | `agent-detail-panel.tsx:210-227` (`→` at `:241`); `task-kickoff-strip.tsx:117-124` (doc said :121); `agent-setup-hero.tsx:65`; `launch-card.tsx:147-156`; `legacy-agent-panel.tsx:201-208`, "No schedule yet" `:284-288` | HOLDS (strip WITH DRIFT) |
| 16 | Client summary rows; "N unread" chip; "All caught up!" | `lib/notification-rows.ts:138`, `:180-186`; `notification-bell.tsx:312-318`, `:323-330` | HOLDS |
| 17 | Header stacks tile + badge + Pin; EmptyState copy; `StatusBadge` copy; roster card lift/orange/ring | `[agentId]/page.tsx:1044-1064`, `:1287-1291`, `:1560`; `roster-card.tsx:113-122`, `:103-107`, `:142-157` | HOLDS |
| 18 | No `asset` key; presenter takeaways; doc "done" on open | `calendar-view-modes.ts:60-75`; `presenter.ts:1113,1117`; `client-documents.tsx:1002-1011` | HOLDS |
| 19 | Step 0 `/onboarding`; waiting copy; "every row stays a destination"; `agentSetupHref` | `lib/setup-ladder.ts:577`; `:595-599`; `:639-641`; `:166-174` | HOLDS |
| 20 | think-reporting §2A: roster status is "page-local", Reporting would be "a second opinion" | `rosterStatus` + `agentsWithUpcomingContent` are already the one function both agent pages call (`agents/page.tsx:330-360`, `[agentId]/page.tsx:477-510`); only the input assembly is page-local | WRONG framing, right conclusion: extract the input assembly |
| 21 | think-reporting §2C: not-granted rows could link "Open {name}" | `[agentId]/page.tsx:299-304` `notFound()` for a client on an ungranted agent; no `not-found.tsx` under `agents/[agentId]/`; `AgentNotOnPlan` mounts only on the intake routes | WRONG for clients: Support only |
| 22 | think-agents §0: "Fix is S and makes Albert's agent Live today" | Logic holds; `agent-detail-archetypes.test.ts:~726` pins "ignores a draft, which never reaches a client's calendar", a premise `calendar-kind.ts:197-208` reversed | HOLDS, one pin to invert |

**GEO ids.** All three exist in `GEO_READINESS_CHECKS`: `seo-geo.ts:861` GEO-25, `:863` GEO-07, `:864` GEO-14, all bucket `offsiteEntity`. A client whose snapshot has none of the three failing (or unmeasured, or unconfirmed) gets an empty "Things only you can do"; think-reporting §1 keeps the heading with one sentence, which is right. Pins that invert: `seo-geo-client-suggestions.test.ts:77-78` (GEO-04 in), `:99-126` (GEO-11/27/35 in), `:329-334` (speculative regex over seven ids).

---

## D. Coverage matrix

| Ask (brief, "What he said") | Covered by | Status |
|---|---|---|
| Reporting recommends things our agents do; no general advice | think-reporting §1 | covered |
| Only structural, client-owned items; short | think-reporting §1 (three ids) | covered |
| "Things only you can do" to the bottom | think-reporting §3 | covered |
| "What we are actively doing", button per agent | think-reporting §2 (button per B4) | covered |
| One interaction logic; SEO cells vs KPI cells | think-home §1 | covered |
| Why one "Let's do this"; best CTA? | think-home §2.1, 2.2 | covered |
| Tailored steps: what is missing, land on the field, detect done | think-home §2.3 to 2.8 | covered (2.4, 2.7 are M) |
| Status strip "doesn't look that good" ("This box here") | think-agents §1 | covered |
| Is the RUNS ON REQUEST badge necessary at all | think-agents §1: chip goes | covered (E10) |
| Logic bug: daily content, page says runs on request | think-agents §0; B3 | covered |
| "Create a post" modal: collapse, button, footer, dashed box | think-agents §2 | covered |
| Sidebar unstarred stars | think-agents §3 | covered |
| "Research a better sidebar look" (whole rail) | think-agents §3 (agents block), think-home §1.3 (rail focus) | partial: nothing on the rail as a whole |
| Notifications: "2 unread" not clickable; one logic | think-home §3.1, 3.2 | covered |
| Remove Seats card; Documents stay | think-reporting §4 | covered |
| Agents tab audit incl. not-set-up states | think-agents §4 | covered (rows are E6) |
| ONE short high-level PDF | none | not covered (README step 2) |

---

## E. Consolidated decisions for Albert (10)

| # | Question | Recommended | Why |
|---|---|---|---|
| 1 | Count client-visible future drafts as "producing", with a 14-day ceiling? | Yes, 14 days | Applies the August draft-visibility decision to the status word; fixes the bug he named |
| 2 | Does "Complete your profile" require the website? | Yes | SEO/GEO and the blog agent read it first |
| 3 | Is "Looks right" the done gesture for a document, with "Something is off" opening Support? | Yes | Replaces "opened once" with a real confirmation; Support keeps the brand-voice question open (an editable field here WOULD depend on it) |
| 4 | Waiting-row horizon: fixed promise or staff-set date? | Fixed: "Usually ready within 2 business days" (he confirms the number) | Ops cannot hold a per-client date yet |
| 5 | Run dialog default: 1 post at "about 25 credits", price following the count? | Yes | Today 3 posts and 10 posts both quote 25; v2 settles to actual usage |
| 6 | Agents tab: full-width rows or keep cards plus status/last-made/verb? | Rows | Comparison is the roster's job; lists beat cards for it |
| 7 | Show agents not on the plan in the Reporting section? | Yes, as "Not on your plan" rows with Support | He asked for "every relevant Karos agent"; clients cannot open an ungranted page |
| 8 | Approve `?asset=` on the calendar (opens the item on load)? | Yes | The one key both the ladder's last step and any future notification row need |
| 9 | After the ladder completes, take "More ways to get value" (B12) or leave the slot empty? | Empty this round | Re-opens the round-4 Home list; decide with the PDF for round 7 |
| 10 | Remove the status chip beside the logo and replace the strip with one plain status line? | Yes | Same word twice in two voices today; his own question |

**Decided without him:** client uploads (no), "Coming Soon" rename (no), GEO-04 (out), "Ask about it" (no), dynamic agents (not v1), site-access flag (deferred), empty heading (keep), Karos-owned bell rows (dropped), phase-2 feed (deferred with 9), heading wording (B6a).

**Standing open questions** (brand voice, credit top-up): nothing recommended depends on them; only decision 3's rejected third option would.

---

## F. Implementation risks

- **Primitive blast radius.** `Card` is used in 52 files, `Button` in 79, `Input`/`Textarea`/`Select` in 45, admin directories included. The `ui.tsx` changes (`:19,21,39,71,99,113,127`) alter hover and focus on staff pages too. Own PR, visual sweep of `/admin/*`, `/jobs`, `/team`.
- **Test pins to change on purpose.** `agent-detail-archetypes.test.ts:~726` (invert), `home-recommended-tasks.test.ts:46-47` ("Let's do this"), `seo-geo-client-suggestions.test.ts:77-78, 99-126, 329-334`, `seo-geo-mounting.test.ts:125-129`, `settings-nav.test.ts:292-316` (add the Seats absence). `client-agents.test.ts` stays untouched if B1 holds. The `client-copy-boundary` dash sweep covers rendered strings; the pure lever table needs its own pin.
- **Production Firestore on localhost.** `.env.local` points at production. "Looks right", "Mark all as read", the ladder's "Done" and the dialog's "Create post" are writes; exercise them on prep only.
- **Data-model changes.** New `asset` query key (`calendar-view-modes.ts:60-75`); new `notificationsSeenAt` on the user; action 05 moves from signal-derived (`action-list.ts:338`) to event-tracked (`:302`); 21/22 change meaning from "opened" to "confirmed" (existing rows stay done, no migration).
- **`CREDITS_PLAN_V2_ENABLED`.** The dialog footer has two copy states; prep on, production pinned `"0"` (`cloudbuild.promote.yaml:54`). Test both; never run the promote workflow.
- **The predicate widening flips production statuses.** Every client with imported future drafts turns Live at once. Run think-agents §0's attribution query first (combined card vs plain `instagram-agent` folder; `agent-detail-archetypes.ts:58-79` is strict equality) so nobody reads "Not set up yet" instead.
- **Extra reads on the settings page.** The roster extraction adds `listPlannedScheduledRuns` and `listAssets` to Reporting; parallelise in the existing `Promise.all`.
- **One badge number.** Dropping the summary rows changes `unreadNotificationCount`; readers are `notification-bell.tsx`, `client-rail.tsx`, staff `sidebar.tsx`. Staff rows are untouched; pin that the three stay one number.
