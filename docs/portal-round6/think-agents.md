# Agents: status, run dialog, sidebar, roster

Read-only pass over `claude/portal-flow-audit-recs` in the worktree, 4 Sep 2026. Inputs: Albert's round-6
brief, `ux-deep-dive.md` (§1, N2, N3, N4, N8, N10, N16, C1, C4), `flow-audit.md` (F1, F12, F16, F19), and
the code named below. Every proposal keeps the standing rulings: staff read the client's page with
additive marked extras only; Ember's two inks and one rationed orange; "about N credits"; no em dashes in
client copy; Schedule a run stays staff-only and is not re-proposed.

---

## 0. The bug behind "RUNS ON REQUEST" (read this first)

The client's Instagram stream is imported from the lab and chained one post per day. Three rules,
each correct alone, make that stream invisible to the status word:

1. Imports are written as drafts: `src/lib/actions/lab-output-actions.ts:299` (`status: "draft"`).
2. The chain only ever moves DRAFTS onto future days and pins everything else:
   `src/lib/post-chain.ts:226-237` (`if (mode === "reflow" && a.status !== "draft") return false`).
   So every future day of a chained stream is a draft by construction.
3. The "Live" rung counts only `scheduled` and `placeholder` chips and explicitly rejects `draft`:
   `src/lib/agent-detail-archetypes.ts:396-402`, with the reason at `:385-387` ("draft is content
   still in review, not yet planned"). That reason is the pre-August doctrine that
   `src/lib/calendar-kind.ts:187-208` reversed ("a client's calendar and dashboard now show the same
   pending work staff see, including unapproved drafts"). Home's own upcoming predicate,
   `isUpcomingPost` (`calendar-kind.ts:92-96, 131-135`), already counts drafts. Two spellings of
   "upcoming" in the codebase, and the agent page uses the stale one.

The client sees those days: `getClientLibraryAssets` hands them over as locked "Upcoming post" chips
(`src/lib/asset-visibility.ts:75-100`, `redactLockedAsset` keeps `status` and `scheduledAt`). So the
calendar says "your week is planned" while the agent above it says "Runs on request"
(`src/lib/client-agents.ts:930-932`: unbound, delivered, nothing upcoming, therefore idle). The
strip's own aside compounds it: `SchedulePaceCard` prints "No schedule yet. Your Karos team sets one
up" for exactly this agent (`src/components/client-agents/legacy-agent-panel.tsx:284-288`).

Secondary check, not the primary cause (Albert's strip shows "Last delivered", so attribution works
for him): the combined `karos-instagram-tiktok-content-agent` card and posts imported from the plain
`instagram-agent` lab folder never match under `attributionSlug` (`agent-detail-archetypes.ts:60-79`,
deliberate equality, F147). Any client whose card is the combined agent and whose imports came from
the plain folder will read "Not set up yet" with posts in their Workspace. Worth one query against
production before the fix ships.

**Fix (S):** replace the body of `isUpcomingCalendarItem` with `isUpcomingPost(asset, now)` plus the
launch/test exclusions and a 14-day ceiling on `scheduledAt`, and delete the stale comment. Add the
draft case to `agent-detail-archetypes.test.ts`. That alone turns Albert's agent Live today.

---

## 1. Status logic

**Where it breaks**

- `src/lib/client-agents.ts:767-946`: seven output labels (Live, Needs attention, Setting up, Setup
  needs attention, Runs on request, Not set up yet, Coming Soon) across two tones-of-idle, and the
  AF-5 rung at `:872-877` can only rescue an idle outcome from data that, per §0, never qualifies.
- `src/app/(app)/clients/[id]/agents/[agentId]/page.tsx:1044-1065`: the header action slot stacks the
  48px identity tile, a mono uppercase status Badge and the Pin button. `:1121-1139` then mounts the
  strip, which repeats the same word 100px lower in an 11px mono uppercase label inside a tinted band
  (`src/components/client-agents/agent-sections.tsx:129-147`). Same word, twice, two typographic
  voices. `StatusBadge` at `:1560-1572` is a copy of `RosterStatusBadge`
  (`src/components/client-agents/roster-card.tsx:142-157`).
- `agent-sections.tsx:100`: the strip exists only if it has facts, an aside or is Live, so the
  not-set-up page has no status statement at all in the column and only the chip in the header.
- `[agentId]/page.tsx:822-825`: the only facts the strip can say are "Last delivered" and "In your
  Workspace". Nothing about what comes next, which is the one question a client of a daily stream has.

**What we change**

One status model, six client states, one precedence order, evaluated in `rosterStatus` and nowhere
else. Every input already exists; the only new signal is the widened `hasUpcomingContent` from §0.

| # | State (client word) | Exact signal | Roster row | Detail status line | Rail |
|---|---|---|---|---|---|
| 1 | **Paused** | `CustomAgent.enabled === false`; or schedule `status === "paused"` and nothing upcoming; or umbrella `live` with zero active templates and nothing upcoming | chip, row greyed, verb "Open" | "Paused by your Karos team" or "Paused. Nothing planned. Resume any time" | none |
| 2 | **Needs your input** | `refusalIsCurrent(...)`; or `latestBlockedIntake(...)`; or intake-driven and `!(setup.ready && setup.standUpDone)` and never delivered; or umbrella `not_launched` with `gate.allowed` (waiting on the client's Launch press); or gate `intake_required` / `credits_short` | chip (warning tone), verb "Set up" or "Launch" or "Add credits" | the reason, then the link: "Your X details are missing. Add them" / "Not enough credits for the next post. Support" / "Ready to launch. About 20 to 40 minutes, one time" | none |
| 3 | **Being set up** | umbrella `launching`, `curating` or `launch_failed` | chip (info tone), verb "Open" | "Being set up. About 20 to 40 minutes. You can leave this page" / for `launch_failed`: "Setup needs another pass. Your Karos team is on it" | none |
| 4 | **Live** | umbrella `live` with an active template; or schedule `active`; or any client-visible calendar item for this agent dated in the next 14 days (drafts and locked days included) | chip (success tone, breathing dot), verb "Create post" | "Live. Next post Thu 5. 7 posts planned. Last delivered Aug 4" | none |
| 5 | **Runs on request** | set up (`hasDelivered` or `readyToRun`) and none of the above | chip (neutral), verb "Create post" | "Runs on request. Last delivered Aug 4. 12 in your Workspace" | none |
| 6 | **Not set up yet** | everything else: granted, unbound, no intake family, never delivered | chip (neutral), verb "Request setup" | "Not set up yet. Your Karos team sets this up. Tell us when you want it" + Support | none |

Precedence is the row order: 1 > 2 > 3 > 4 > 5 > 6. A refusal the client owns still outranks a green
word (F24/F129 doctrine kept); an admin pause outranks everything (kept). "Needs attention" and
"Setting up" and "Coming Soon" retire as words: the first becomes a reason under state 2, the second
is state 3, the third is state 1 with the "by your Karos team" sub-line (see decision D4).

**Staff, additively.** `lastRunFailed` no longer changes the word for anyone. It becomes an
`Internal` badge beside the roster chip ("Internal · last run failed") and an `Internal` line under
the status line, both inside the existing marked idiom. AF-14 (clients never see our failures) and
the parity ruling are then both true, which today they are not: the same agent reads "Live" to the
client and "Needs attention" to staff (`client-agents.ts:902-910`). `IMPORTED_CONTENT_STAFF_NOTE`
(`:673-674`) keeps riding the same Internal line.

**Badge and strip: one survives.** The header chip beside the logo goes. The identity tile moves to
the left of the h1, the same anatomy as the roster row, and the Pin control stays right. The strip
becomes a single **status line** directly under the page header, no border, no tint, no mono
uppercase:

```
● Live · Next post Thu 5 · 7 posts planned · Last delivered Aug 4 · 12 in your Workspace     Adjust pace
```

Rules for the line: 13px Hanken, sentence case; the 8px dot carries the tone (`--success`,
`--warning`, `--info`, `--muted-2`; never orange); facts are separated by middots and each fact that
has a destination is a link (Next post opens the calendar on that day, In your Workspace opens the
archive); "Adjust pace" sits at the end of the line when a schedule exists and replaces
`SchedulePaceCard`; while the viewer's own run is in flight a second line appears, "Working on your
next post. About 30 minutes. You can leave this page", which is N8's run tray in the smallest form.
"7 posts planned" counts distinct future days inside the 14-day window, which is exactly what the
client's calendar already shows as locked chips, so A3/A4 are untouched (no titles, no counts of
batches, no generation times).

**Why.** One question, one answer, said once: NN/g's consistency heuristic, and the deep dive's N3
(status and the run control belong in one spine, not two voices).

**Effort.** S for the §0 predicate; M for the model rewrite (one function, one test file, the label
consumers in `roster-card.tsx`, `agent-sections.tsx`, the detail header); S to delete `StatusBadge`
and `SchedulePaceCard`'s aside slot.

---

## 2. The run dialog ("Create a post")

**Where it breaks**

- `src/components/custom-agents.tsx:2731-2763`: before any field, a blurb, then a boxed
  eyebrow/intro ("Social content system. Choose whether to set up, refresh, or produce from the
  client's social content system…", `src/lib/custom-agent-launch.ts:263-264`), an estimate badge and
  a deliverables list. Operator vocabulary, above the fold, on a client surface.
- `custom-agents.tsx:2802-2821` "Common starting points" chips with an orange selected state
  (`:2813`); `:2823-2868` six fields in a two-column grid, the required one marked with a red
  asterisk (`:2831`), including "What should the agent do?" with options "Set up the content system"
  and "Refresh strategy and formats" (`custom-agent-launch.ts:267-278`), which are staff operations
  offered to a client as a default.
- `:2870-2882` the "Creative inputs" fieldset, with `canUpload={!viewerIsClient}` (`:2881`): clients
  cannot upload (`src/app/api/clients/[id]/context/route.ts:70` returns 403), so a client with no
  library sees only the dashed box "No reference files are available. Your Karos team can add source
  material to the client context" (`src/components/agent-input-files.tsx:213-217`). A dead control.
- `:2627-2658` the footer: a bordered band (`src/components/modal.tsx:210`) holding a Clock icon, two
  sentences, the price, and the orange `accent` "Start run". The verb differs from the trigger that
  opened it ("Create a new post", `legacy-agent-panel.tsx:207`): F1's three vocabularies, still.
- Price honesty: "Number of posts" (`post_count`, default 3, `custom-agent-launch.ts:296`) is not the
  charge multiplier (`batch_size`, `:77`), so the footer quotes the flat per-run "about 25 credits"
  whether the client asks for 1 post or 10. Under credits v2 the settle charges actual usage, so the
  quote understates exactly the runs a client would be surprised by.

**What we change**

One screen at 1280×800, no scrolling with everything collapsed:

```
Create a post                                                        ✕
One on-brand post: creative, caption and hashtags. Your Karos team reviews it first.

What should this post be about?
┌──────────────────────────────────────────────────────────────────────┐
│ Create content that introduces the new offer to first-time buyers.  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
Try:  [Introduce our newest offer]  [A founder story]  [The problem we solve best]

Instagram + TikTok · 1 post · Produce content now                       Change

▸ More options

──────────────────────────────────────────────────────────────────────────
About 25 credits · ready in about 30 minutes · you can leave this page
                                                  [ Cancel ]  [ Create post ]
```

- **Required: one field.** "What should this post be about?" (the `request` field), 3 rows, no
  asterisk. GOV.UK's convention, already adopted in N4: optional fields say "(optional)", required
  ones say nothing. The three starting points become "Try:" chips under the field; a press fills the
  field (today's behaviour) and the chip reads selected in `bg-surface-2 border-border-strong
  text-foreground`, not orange.
- **Defaults as one summary line**, muted, with a "Change" text control that opens More options and
  focuses the first field: "Instagram + TikTok · 1 post · Produce content now". Default post count
  becomes 1 so the quoted price is the price (decision D3 if Albert wants 3).
- **More options** is one `<details>`-style disclosure (`aria-expanded`), collapsed by default,
  holding everything optional in a two-column grid so the open state still fits the height:
  Channel | Number of posts; Audience (optional) | Run type (Produce content now / Set up the content
  system / Refresh strategy and formats); Must include or avoid (optional), full width; for
  engine-dispatched pairs, Direction for this run (optional), full width. One level of disclosure,
  never two (NN/g progressive disclosure, cited in N3).
- **Files:** a plain secondary "Add files" button on the More options header row, attached files as
  chips beside it, no dashed empty box, nothing rendered when there is nothing to show. For staff it
  opens the library picker as today; for clients it needs decision D2 (allow the upload) or it is
  simply absent.
- **Footer:** one calm line, no icon, `text-xs text-muted`: "About 25 credits · ready in about 30
  minutes · you can leave this page" (the word "About" is the hedge the credits ruling asks for; with
  the rework off it reads "25 credits"). Right side: ghost "Cancel", paper primary "Create post"
  (`variant="primary"`, not `accent`). The Modal's pinned footer slot stays for the scrolling case;
  its top hairline is enough, no background band. The trigger on the page, the dialog title and the
  CTA all say "Create post" (noun-aware: "Create clip", "Draft reply"), closing F1.
- **Remove** the eyebrow/intro/deliverables box, the standalone estimate badge and the blurb
  paragraph. The subtitle carries the deliverables in one sentence.
- **After the press:** keep the started state, reword: "Your post is on its way. About 30 minutes.
  Your Karos team reviews it, then it lands in your Workspace." + Done.

Height at 1280×800 (dialog cap 752px): header 84 + field block 160 + chips 36 + defaults 24 +
disclosure row 36 + footer 64 + padding 72 = ~476px collapsed; ~700px with More options open.

**Why.** Baymard: hide infrequent fields behind a link and validate on blur, single column beats
multi-column forms; NN/g progressive disclosure (both cited in N4). Ember §7: primary actions are
paper, orange is rationed (`src/app/globals.css:64-70`, `src/components/ui.tsx:6-8`).

**Effort.** M (one component, one profile edit, the footer; the multiplier fix is S on top).

---

## 3. The sidebar agents list

**Where it breaks**

- `src/components/client-rail-agents-nav.tsx:78-100`: every row carries an always-visible star; the
  unpinned ones are grey glyphs with no meaning until hovered, the pinned ones are orange (`:96`),
  so a client with four pins spends the accent four times in the nav. `:61` reserves `pr-7` for it.
- `:221-232` and `:246`: the "AI agents" parent row is filled for every `/agents/*` path, and the
  child row is filled too, so two rows read as current at once.
- `src/components/client-agents/agent-star-button.tsx:43-60`: the page control already exists
  ("Pin to sidebar" / "Pinned"), also orange when pinned (`:53`).
- Parity is already by construction: the staff shell mounts the same component
  (`src/components/sidebar.tsx:826-831`), and so does the mobile Company sheet
  (`src/components/client-rail.tsx:292-299`). One change lands everywhere.

**What we change: the rail's agents block spec**

- Rows show the platform mark and the name. Nothing else. No star glyphs in the rail.
- Pinning lives on the agent page only (the existing Pin control), restyled: pinned = filled star in
  `text-foreground` on `bg-surface-2`, unpinned = outline star, no orange in either state.
- Pinned agents first, in pin order; then the rest in roster order; a hairline divider between the
  two groups only when both exist (today's rule at `:262-264`, kept); the unpinned group keeps the
  cap of 6 and "View all N agents" (`:28`, `:280-294`).
- Row: 32px tall (`py-1.5`, 20px line), `px-3`, mark 16px (`h-4 w-4`, the same size as the NavLink
  icons in `rail-nav-link.tsx:47-50`, up from 14px), `gap-3`, label 14px. Hover
  `bg-surface-2 text-foreground`. Active `bg-surface-2 text-foreground`, mark `text-foreground`,
  `aria-current="page"`. Identical to `NavLink`, which is the point.
- One current row per rail: when a child is active the parent "AI agents" row loses its fill and
  keeps `text-foreground`; it is filled only on the roster route itself.
- The `max-h-[40vh] overflow-y-auto` guard stays (`:239`).
- "No agents set up yet" (`:241`) becomes a link to the roster, "See your agents", so the block is
  never a dead sentence.

**Why (sources fetched 4 Sep 2026).**
- NN/g, *Left-Side Vertical Navigation on Desktop*: labels must stay visible, "a word is worth a
  thousand pictures", keep it "left-aligned, keyword front-loaded, and visible"; users look at the
  left half of the screen 80% of the time. Marks with names, no icon-only rows.
  https://www.nngroup.com/articles/vertical-nav/
- Apple HIG, *Sidebars*: "show no more than two levels of hierarchy in a sidebar", "use succinct,
  descriptive labels to title each group", "let people customize the contents of a sidebar" (that is
  what pinning is), keep icon colour purposeful and sparse.
  https://developer.apple.com/design/human-interface-guidelines/sidebars
- Material, *Navigation drawer* (component doc): icon 24dp, horizontal padding 28dp, one-line
  labelLarge label, active item = a full-round container fill with bold label, dividers inset to the
  label. Our 16px mark and 32px row are the proportional version at 14px type.
  https://github.com/material-components/material-components-android/blob/master/docs/components/NavigationDrawer.md
- GitHub Primer, *NavList*: current page marked with `aria-current="page"`; trailing visuals are for
  "auxiliary information", a trailing action is an exception, not a row default; up to four levels
  but "reconsider your navigation design if you need more". We use two.
  https://primer.style/product/components/nav-list/

**Effort.** S.

---

## 4. The roster, including the not-set-up states

**What a client sees today**

- `src/components/client-agents/roster.tsx:76`: a two-column card grid. Each card
  (`roster-card.tsx:64-111`): a top hairline, a 48px tile, the name, one mono status chip, a two-line
  blurb, a chevron that turns orange on hover. A Live Instagram agent and a never-run Reddit agent are
  the same rectangle (deep dive N2). No "last made", no "next", no verb.
- "Not set up yet" opens, for an intake-driven agent, a placeholder video frame reading "A preview of
  what this agent does is coming soon" above an orange "Set up this agent"
  (`agent-setup-hero.tsx:51-68`); for every other agent, an EmptyState with no action: "Your Karos
  team sets this agent up for your brand before it starts producing. They will let you know when it
  is ready" (`[agentId]/page.tsx:1287-1291`). A dead end, and the second sentence is a promise no
  code keeps (there is no notification path, deep dive §1).
- "Coming Soon" cards are inert and unexplained (`roster-card.tsx:124-130`, `client-agents.ts:872`).
- Empty roster: "No active agents yet" + Support (`agents/page.tsx:417-422`). Fine.

**What we change: the catalogue row (N2, high level)**

```
[mark] Instagram Agent          ● Live      Last made: "Founder mode" · 2d ago   Next: Thu 5     Create post ›
       Daily posts for your feed
[mark] LinkedIn Agent           Needs your input   Your LinkedIn details are missing              Set up ›
[mark] Reddit Agent             Not set up yet     Your Karos team sets this up                   Request setup ›
```

- One full-width row per agent, `min-h-[64px]`, the whole row one `<Link>` to the detail page (kept:
  middle-click, copyable URL). Columns in importance order: identity (mark + name + one-line blurb),
  status chip (the §1 word), last made (newest title from `agentProducedAssets`, relative stamp),
  next (next planned day inside the 14-day window, or the schedule's next fire), then the verb.
- The verb is a label plus the one trailing ChevronRight (F12's single glyph), never a nested button:
  Live / Runs on request → "Create post"; Needs your input → "Set up", "Launch" or "Add credits";
  Being set up → "Open"; Not set up yet → "Request setup"; Paused → "Open" (greyed row; an
  admin-paused row keeps no chevron and no link, as today).
- Below `@2xl` the last-made / next / verb collapse into one 11px meta line under the name (Baymard's
  mobile fallback, cited in N2).
- Not-set-up page: the EmptyState gains the R9 action and honest copy: "Not set up yet. Your Karos
  team sets this up. Tell us when you want it." + Support. Drop "They will let you know".
- Setup hero: no placeholder video frame when there is no video; the block is the sentence "Save what
  {agent} needs to know, and it starts producing for you" and a paper primary "Set up". The video
  frame returns only when `previewVideoUrl` exists.
- Roster description (`agents/page.tsx:62-63`) keeps its sentence; it already names the two verbs.

**Why.** Comparison is the roster's job and lists beat cards for comparison (NN/g cards vs tables,
Baymard product tables, both cited in N2); empty states must carry the way forward (R9).

**Effort.** M (row component, per-agent produced/next resolution on a page that already loads the
assets and jobs it needs, `agents/page.tsx:116-136`).

---

## 5. Cross-check against the rulings

**Parity.** Every surface above is one component for both readers: the roster, the detail header and
status line, the dialog, the rail. Staff extras stay additive and marked: the `Internal` failed-run
marker (§1), the staff library picker in the dialog, the intake pane already inside
`StaffOnlySection` (`custom-agents.tsx:2713-2715`), the "billed to the client" register. The one
place the current code breaks parity, a status word that differs per viewer, is removed by §1.

**One orange.** Proposals remove orange from: the rail's pinned star (`client-rail-agents-nav.tsx:96`),
the page Pin button (`agent-star-button.tsx:53`), the selected starting-point chip
(`custom-agents.tsx:2813`), and five `accent` CTAs that become paper `primary`:
`agent-detail-panel.tsx:210-227`, `legacy-agent-panel.tsx:201-208`, `agent-setup-hero.tsx:65`,
`launch-card.tsx:147-156`, `custom-agents.tsx:2655-2657`. Status tones use the judgment scale only
(`globals.css:72-77`: "Orange never participates in this scale"). Orange keeps its ruled jobs: the
coin beside a price the reader pays, link hovers, the chevron hover on rows.

**Credits.** Every price reads "About N credits"; the dialog quotes the total for the defaults it
shows. No "token".

**Copy.** No em dashes in any client string above. Reddit's dialog says "Draft reply", never "post".

---

## Decisions Albert must make

- **D1. Live window.** Count client-visible future drafts (the locked days on the calendar) as
  producing, with a 14-day ceiling. Recommended yes: it is the August draft-visibility decision
  applied to the status word. Alternatives: 7 days, or no ceiling.
- **D2. Client uploads in the run dialog.** Today the upload route refuses clients
  (`context/route.ts:70`). Either allow it (S: route + `canUpload`) so "Add files" exists for
  clients, or drop files from the client dialog entirely. Recommended: allow, capped at 4 MB as now.
- **D3. Default post count and price.** 1 post at "about 25 credits" (recommended), or keep 3 and
  make `post_count` the visible multiplier so the footer says "about 75 credits". Today it says 25
  for 3, and 25 for 10.
- **D4. "Coming Soon".** Fold admin-disabled agents into "Paused by your Karos team" (recommended,
  keeps six states) or keep a seventh word "Not available".
- **D5. Rows or cards.** The catalogue row (M) or keep cards and only add the status model, the
  last-made line and the verb (S). Recommended: rows; the comparison is why a client opens the page.

---

## Summary

1. The "runs on request" bug is one predicate: `isUpcomingCalendarItem` rejects drafts, and the chain only ever puts drafts on future days. Fix is S and makes Albert's agent Live today.
2. Six client states, one precedence, one function: Paused, Needs your input, Being set up, Live, Runs on request, Not set up yet. Failed runs become an Internal marker, never a different word per viewer.
3. The header chip beside the logo goes; the tinted strip becomes one plain status line: "Live · Next post Thu 5 · 7 posts planned · Last delivered Aug 4".
4. The run dialog asks one question, shows its defaults as one line, hides everything else under one "More options", and ends with one calm footer line and a paper "Create post".
5. The dashed "no reference files" box disappears; "Add files" is a secondary button that only exists when it can do something (decision D2).
6. The dialog's price must match its defaults: post count is not the multiplier today (decision D3).
7. The rail shows mark + name only, no stars; pinning lives on the agent page; pinned first, hairline, cap of 6, one current row. Four sources fetched and cited.
8. The roster becomes one row per agent with status, last made, next, and a state-matched verb; not-set-up pages get a real action and honest copy.
9. Orange leaves the pin, the chips and five CTAs; status colours stay on the judgment scale; staff parity holds by construction.
10. Five real forks for Albert (D1 to D5); everything else is decided above.

File: `/private/tmp/claude-501/-Users-albertkattan-Karos-Labs-CMO--claude-worktrees-instagram-post-ordering-5c8eaa/cdf3554f-eb4b-4145-babb-1262ff4f23f8/scratchpad/think-agents.md`
