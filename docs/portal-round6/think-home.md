# Home, the setup ladder, and notifications: where it breaks, what we change

Read-only pass over `.claude/worktrees/instagram-post-ordering-5c8eaa` at `33080a55`, against the round-6 brief and every standing ruling. Nothing below adds a hue, re-themes, moves Reporting, brings content ideas back to Home, or touches "Schedule a run". Paths are under `src/`. Effort: S = under a day, M = one to three days, L = more.

---

## 1. One interaction logic for the whole portal

### 1.1 The rule set

1. **Link** (opens somewhere): the whole surface is the target, never a title inside it. Hover is one fill step (`surface-2` to `surface-3`) plus, on a bordered row or cell, the accent hairline (`row-lift`). It ends in one `ChevronRight` in `muted-2`, the only trailing glyph in the product. No translate, no shadow change, no glyph that slides.
2. **Button** (does something here): `primary` = paper/ink fill, one per view. `accent` = orange fill, **at most one per screen**, only on the control that moves the client forward. `outline` = hairline. `quiet` = text, `muted` to `foreground` with an underline on hover. Every hover is a colour change of 150 to 180 ms and nothing else. No glyph after a button label.
3. **Static** (no destination, no action): no border tint, no fill change, no chevron, default cursor. A static box may not wear the shell of a link; if it needs a box it drops the border and sits on a divider instead.
4. **States**: loading = `Spinner` replaces the leading icon, the label keeps its width, `aria-busy`. Disabled = 50% opacity plus the reason painted as text beside it, never only in a `title`. Pressed/selected = `bg-surface-2 text-foreground`.
5. **Focus**: one token `--focus: var(--foreground)` and one utility `.focus-ring { outline: 2px solid var(--focus); outline-offset: 2px }` on every interactive element, inputs included. The seven ring recipes go.
6. **Card** is a container and never hovers. Interactivity lives in the rows and cells inside it, or the whole card is a link and follows rule 1.
7. **Orange on a screen**: the one accent button, `row-lift` hovers, live signals (pulse, badge dot) and the ladder's progress fill. Icon chips, meter fills, sparklines and info bands are ink or grey.

Why ink for focus and not orange: `--neon` measures 2.84:1 on paper in light mode (deep dive, Contrast table), so an orange ring fails WCAG 1.4.11 on half the product; `--foreground` passes everywhere without a new hue.

### 1.2 The primitives are the root cause

**Where it breaks.** `ui.tsx:71`: every `Card` tints its border and raises its shadow on hover, so static cards look pressable. `ui.tsx:19,21`: `primary` and `accent` buttons lift 2px and bloom a shadow. `ui.tsx:39`: focus is `ring-foreground/25` (2.16:1 dark, 1.70:1 light). `ui.tsx:99,113,127`: inputs set `outline-none` and move a hairline from 1.57:1 to 2.15:1, so a keyboard user cannot see the field they are in. Counted: 130 client-facing files with an `onClick`, 29 with any focus style, 42 that remove the browser's.

**What we change.** `Card` loses `hover:border-border-strong hover:shadow-[var(--shadow-2)]`. `Button` loses `hover:-translate-y-0.5` and the shadow bloom; `accent` hovers to `--neon-bright`, `primary` to 90% of `--primary`. `Button`, `Input`, `Textarea`, `Select`, `TabButton` take `.focus-ring`. Add `@media (prefers-reduced-motion: reduce)` covering `transition-duration` too (`globals.css:418-428` covers only the seven keyframes).

**Why.** N15 (one focus token, 2.4.13), N18 (drop the lift: the hover is a colour event in this brand). Fixing the four primitives fixes most of the portal in one commit.

**Effort.** S.

### 1.3 Home, surface by surface

| Surface | file:line | Breaks | Change |
|---|---|---|---|
| KPI cells | `home-kpis.tsx:170-177` | Link with `row-lift` (right) but its own `ring-neon` focus; chevron slides on hover (`:183`); orange eyebrow icon (`:179`) | `.focus-ring`; static chevron; icon `muted-2` |
| "SEO & AI visibility" cells | `home-standing.tsx:33-56` | Static `div` in the **identical shell** to the KPI cell (border, `surface-2`, eyebrow, big figure). This is the "KPI cells light up, these do not" Albert saw | Make them links, whole cell, `row-lift`, chevron, `.focus-ring`: category presence opens `?tab=reporting#presence`, share of conversation opens `?tab=reporting#share` (two new anchors on `seo-geo-panel.tsx`, same device as `#visibility-scores`) |
| Same card, quiet link | `home-standing.tsx:143-149` | "See the breakdown" carries a chevron (rows carry chevrons, text links do not) and does not name where it goes (F10) | "Open the full report", no glyph, quiet style |
| Same card, empty tile | `home-standing.tsx:180-192` | Link with `row-lift` but no chevron and no focus style | Chevron + `.focus-ring` |
| Same card, takeaway | `home-standing.tsx:206-208` | Orange wash + orange sparkle on a sentence that does nothing | `surface-2` band, sparkle in `muted-2` |
| Meters and sparkline | `home-standing.tsx:46-48`, `home-kpis.tsx:33` | Orange as data fill | Fill `foreground`, track `muted-3/20`; the daily bars at `home-kpis.tsx:91` already do exactly this and are the precedent |
| Three icon chips | `home-kpis.tsx:360-361`, `home-standing.tsx:138-139`, `client-home-overview.tsx:455-456` | `bg-neon/10` chip on three reference cards | Bare glyph in `muted-2`, no chip (N1 keeps chips on the two action cards; this goes one step further so the button is the only orange fill) |
| Calendar preview rows | `home-calendar-preview.tsx:310-315` | Right shape (button, `row-lift`, chevron) but no focus style | `.focus-ring` |
| Calendar preview empty CTA | `home-calendar-preview.tsx:276` | Hand-rolled outline with orange text on hover | `Button outline` |
| Recent activity rows | `client-home-overview.tsx:510-520` | Link row (`row-lift`, no chevron, no focus) and its inert twin at `:519` wear the same shell | Link row gets chevron + focus; the inert row loses its border and sits on a divider (rule 3), or opens the item once `?asset=` exists (2.7) |
| Archive link row | `client-home-overview.tsx:543-552` | `row-lift` on a `border-transparent` row (hover tints a border that is not drawn) | Fill-only hover, chevron kept, `.focus-ring` |
| Attention primary button | `client-home-overview.tsx:617-625` | `ArrowRight` after a button label; orange border on hover | `Button outline`, no glyph |
| Attention secondary rows | `client-home-overview.tsx:664-675` | Link rows and inert rows share one shell; hint hidden in a `title` | Inert rows drop the border (rule 3); the hint renders under the label |
| Ladder rows | `home-task-row.tsx:277-288`, `:317` | Non-current rows are not links at all; the one button is a hand-rolled orange link with lift and shadow; `:210` and `home-get-set-up.tsx:170` are a third outline recipe | See section 2; the button becomes `Button accent`, the outline buttons `Button outline` |
| Rail nav rows | `rail-nav-link.tsx:40-46` | Fill hover (right) but **no focus style at all** on the primary navigation | `.focus-ring` |
| Bell | `notification-bell.tsx:262-269`, `:244-260`, `:398-404` | Own ring recipe; row variant has no focus; a non-link container hovers | See section 3 |

Effort for the whole table: **M** (mechanical once 1.2 lands).

### 1.4 Is "Let's do this" the screen's one orange CTA?

**Where it breaks.** It is the only orange *control* on Home, but not the only orange: three icon chips, two cell icons, the sparkline, two meter fills, the takeaway band, the progress fill, the rail's coin icon (`client-rail.tsx:210`) and the bell badge. Eleven orange things, so the one button does not read as the one.

**What we change.** After the demotions in 1.3, Home's orange is exactly: the ladder's button, the progress fill, `row-lift` hovers, the bell badge. Then yes, it is the one, and it stays the one until the ladder completes; after that Home has no accent button (the attention card's primary is `outline`).

**Why.** Brand note in `globals.css:57` ("emphasis only: markers, eyebrows, hovers, live signals") and NN/g visual hierarchy: at most two large elements and three contrast variations.

**Effort.** S (inside 1.3).

### 1.5 Reporting tab (`settings?tab=reporting`)

**Where it breaks.** Mostly right: the score cards (`seo-geo-panel.tsx:393-470`) and "Things only you can do" rows (`seo-geo/client-suggestions.tsx`, divider rows, no shell) are correctly static. Left: the score popover trigger is a 16px target (`seo-geo/score-popover.tsx:53-56`) with the failing ring; `disclosure.tsx:27-32`, `flag-button.tsx:77-80,117-119` and `gap-list.tsx:156-159` each carry a ring recipe; the reputation pointer link (`settings/page.tsx:560-568`) is a text link wearing a chevron and turning orange on hover.

**What we change.** Popover trigger to 24px with `.focus-ring`; the three ring recipes to `.focus-ring`; the reputation link to a quiet link, no chevron, ink hover. When the "What we are actively doing" agent list lands (brief, Reporting), its per-agent controls are `Button outline` labelled "Open the {Reddit} agent"; one accent at most on that tab, and none is needed.

**Why.** F10, F12; WCAG 2.5.8 target size.

**Effort.** S.

### 1.6 Agents surfaces

**Where it breaks.** Roster card (`client-agents/roster-card.tsx:113-122`): lifts, tints orange, adds a shadow ring, own focus ring; its chevron slides and turns orange (`:103-107`). Agent page: the run panel's accent button (`agent-detail-panel.tsx:210-227`) is right, but `task-kickoff-strip.tsx:121` puts a second orange button on the same page whenever `?task=` is present, and `agent-setup-hero.tsx:65` / `launch-card.tsx:149` are accent too. Run history rows (`client-agent-run-history.tsx:49-58`) are inert but boxed like links. `ArrowRight` after link text at `agent-sections.tsx:285,311`, `archetype-cards.tsx:140`, `agents/[agentId]/page.tsx:1483,1543`; `agent-detail-panel.tsx:238-243` writes the arrow as a character. Archive rows (`agent-archive-rows.tsx:85-106`) are the model, minus a focus style.

**What we change.** Roster card = rule 1 (fill + hairline, static chevron, `.focus-ring`). One accent per agent page: setup hero, launch card and run panel are mutually exclusive states so only one renders; the kickoff strip's button becomes `primary`. Run history rows drop the border (rule 3) or open the delivered output where one exists. Arrows go; text links become quiet links or rows with chevrons.

**Why.** F12 (four row patterns for one meaning), Hick's law on two run buttons (F1), rule 2.

**Effort.** M.

---

## 2. The Get set up ladder, tailored

### 2.1 Only the current step has a control; the other rows are dead

**Where it breaks.** `home-get-set-up.tsx:188-195` passes `start` only to `next`; `HomeTaskRow` has no row link (`home-task-row.tsx:277-288`), so four of six rows are not clickable, while `setup-ladder.ts:639-641` claims "every row stays a legitimate destination". Step 0's href is `/onboarding` (`setup-ladder.ts:577`), a wizard a finished client is bounced out of.

**What we change.** Every **incomplete** row is a whole-row link (rule 1) to its own landing, with a status word at the right: "Not started", or "After step 3" when its prerequisite is unmet (the destination already explains the block: `client-agent-runs.ts:169`). The **current** row alone adds the accent button. Done rows are plain, check glyph, no link, no controls. Step 0 gets no href.

**Why.** GOV.UK task list: every task is a link, any order, completed tasks turn plain; NN/g: one primary action per view. Both sources at once: the affordance is ordered, the access is not.

**Effort.** S.

### 2.2 "Let's do this" is not the CTA

**Where it breaks.** One label for six different actions (`home-task-row.tsx:319`); it predicts nothing about the destination, which is why "Complete your profile" lands on a page with no clue.

**What we change.** The button names the action and the missing thing, computed per step (exact strings in 2.3 to 2.7): "Add a short description", "Read your Brand Voice", "Add your X agent details", "Set up the LinkedIn agent", "Create your first Instagram post", "Open your first post". The row title keeps the step name; the description line under the current row says what is already done and what is left.

**Why.** NN/g Better Link Labels (specific, sincere, predicts destination); GOV.UK: start task links with a verb; F10.

**Effort.** S.

### 2.3 Step 1, "Complete your profile": detection and landing

**Where it breaks.** Signal is `description && category` (`page.tsx:348`). Three problems. The wizard already writes `category` (`onboarding-wizard.tsx:258-261`), so for nearly every client the step means "description missing" and never says so. The profile shows `client.description || client.brief` (`client-profile-panel.tsx:743`), so a client with an AI brief sees an About paragraph while the ladder says the profile is incomplete: Albert's "maybe it is already set up". And the description is edited only inside the Brand Profile slide-over behind an icon-only button (`:576-583`, field at `:416-423`), so `?tab=profile` lands beside the field, not on it. Website, the field SEO/GEO and the blog agent depend on, is not in the definition.

**What we change.** Profile complete = category, description, website, each checked separately; team size and socials stay optional. The row's line and button name the first missing one: "Your category is set. Add a short description and your website." / **Add a short description**. Landing: `?tab=profile&edit=description` opens the slide-over with the About field focused and outlined; `&edit=category` enters the inline edit with the category input focused; `&edit=website` the slide-over's Website field. If a `brief` exists and no description, the About field is pre-filled with the brief so the client confirms rather than writes.

**Why.** Setup-ladder audit P1 ("this one is honest") was true only while category was never pre-filled; deep dive N17: help at the moment of need, at the field.

**Effort.** S (detection) + S (two query params, one `autoFocus`).

### 2.4 Step 2, "Confirm your brand voice and audience"

**Where it breaks.** "Done" is a row written the moment a client **opens** the document (`client-documents.tsx:1002-1011`); nothing confirms anything, and the only control inside a document is the billable "Correct Info" (`:563`). If the pipeline has not written the docs yet they are filtered out of the list (`:930-933`) and the step points at an empty section. The step merges two documents and cannot say which one is unread.

**What we change.** Per-document state: missing (pipeline), unread, read. Row line: "Brand Voice read. Your Target Audience is waiting." Button: **Read your Target Audience**, landing `?tab=profile#documents&doc=target-audience`, which opens that document directly (`openDocType` seeded from the URL). At the foot of an opened document, one quiet pair: "Looks right" (writes 21/22 done) and "Something is off" (opens Support with the document named). While the docs are missing the step is a waiting row: "We are writing your Brand Voice and Target Audience. Usually ready within the hour." It does not tick and does not take the button.

**Why.** Chameleon: complete from activity, not from a click on the item; "opened" is the weakest activity there is. The waiting state reuses `docsPipelineState` (`:944`), so it cannot disagree with the Documents list.

**Effort.** M.

### 2.5 Step 3, "Set up your first agent": the rung is invisible

**Where it breaks.** Two coarse signals. (a) `agentSetupHref` always sends the client to the intake page (`setup-ladder.ts:166-174`), even when the form is saved and only the one-time stand-up run is missing (LinkedIn: `client-agent-rows.ts:373-381`), so they land on a filled form. For newsletter, blog and reputation the two rungs are folded into one `ready` (`:436,464,490`) and the ladder cannot tell them apart at all. (b) `live` is `launchState === "live"` alone (`page.tsx:460`), so a client receiving pre-created posts every day can still read "We are setting up your first agent" (the same logic bug the brief names on the agent page).

**What we change.** Surface `hasIntake` and `isSetUp` separately from `buildAgentSetup` (both are already computed). Intake missing: **Add your LinkedIn agent details**, landing the intake page with the first empty required field focused (`#lc-url` etc., the ids exist). Intake saved, stand-up missing: **Set up the LinkedIn agent**, landing `/clients/{id}/agents/{agentId}#setup` on the setup hero. Non-self-serve: live = `launchState === "live"` **or** any client-visible asset attributed to the umbrella; evidence beats the flag.

**Why.** F131 shape: a surface that knows one rung offers a press the server refuses. Same predicate everywhere (`submit-custom.ts` gates on both rungs).

**Effort.** S.

### 2.6 Step 4, "Run your first agent"

**Where it breaks.** Done = any non-launch, non-test job exists (`page.tsx:346-351`), including a failed one and one staff fired. The label does not name the agent or the format.

**What we change.** Done = one such job reached `review`, `approved` or `delivered`. Button: **Create your first Instagram post** (the run panel's own runnable format noun, `agent-detail-panel.tsx:226`), landing `/clients/{id}/agents/{agentId}#run` with the callout. Blocked (step 3 undone): the row is still a link, status "After step 3", and the run panel paints the reason it already paints.

**Why.** Setup-ladder audit P4 gap ("no succeeded clause"); R15 (the button names the format).

**Effort.** S.

### 2.7 Step 5, "See your first result"

**Where it breaks.** Done = a client-visible asset exists (`page.tsx:353`); nothing records that the client opened one, and the landing is the whole archive list, not the item.

**What we change.** Add `asset` to `CALENDAR_QUERY_KEYS` (`calendar-view-modes.ts:60-75`) so `/calendar?view=archive&asset={id}` opens the detail modal on load. Button: **Open your first post**, landing on the newest client-visible asset. Done = the modal opened for a client (write action 05 there, the way `client-documents.tsx:1010` writes 21). Same key serves the notification rows in 3.2 and N8's "ready, open" row.

**Why.** Deep dive N5: the one object a client would send a colleague has no URL; setup-ladder audit P5 ("proxy only").

**Effort.** M (URL key + modal open-on-load + one writer).

### 2.8 One landing pattern: "You're here for"

**Where it breaks.** No surface knows it was reached from the ladder; the client arrives on Profile, the intake page or the agent page with nothing pointing at the field.

**What we change.** One `<HereFor>` band (info tone, `role="status"`), rendered at the top of the landed section when the URL carries `?for={stepId}` alongside the anchor or `edit=` param: "You're here to add a short description. Every agent writes from it." The target field gets `outline-2 outline-offset-2` in `--focus` and focus. The band and outline clear on the first successful save (`replaceState` drops the params), or on its own "Got it". Nothing is stored; the ladder itself is the memory.

**Why.** NN/g onboarding: contextual help at the moment of need, dismissible; N17's four first-visit tips are the same primitive, so this is one component, not two.

**Effort.** S for the primitive, S per landing.

### 2.9 The waiting row

**Where it breaks.** "We are setting up your first agent / Karos is setting {name} up for you. Nothing is needed from you here." (`setup-ladder.ts:595-599`) is honest but has no horizon, no destination, does not carry the button, and can be wrong (2.5b).

**What we change.** Copy: "Karos is setting up your Instagram Agent. Usually ready within {n} business days." The row is a link to the agent's page (rule 1; the page shows the same state). It clears on live evidence (2.5b), never on a click. It keeps the `Clock` glyph and never takes the accent button (correct today).

**Why.** N17: "we're doing it" with no horizon is the state clients ask about.

**Effort.** S, once the horizon is decided (D3).

### 2.10 Once the ladder is done

**Where it breaks.** Completion shows one line and "Hide this" (`home-get-set-up.tsx:146-175`); the hide is a 7-day cooldown (`page.tsx:528-533`), so a finished ladder **comes back every week** even though `setupLadderComplete` already guards reopening.

**What we change.** On the visit that completes it: bar at 100%, "You're set up. Your agents are running.", one `outline` button "Done" that writes the row. After that the card is gone until a new grant reopens the ladder (the existing guard). Recommended follow-on (D4): the freed slot takes "More ways to get value" (B12: connect a channel, mark a post as posted, give feedback, export a day), reusing `HomeTaskRow` with its X and undo.

**Why.** Chameleon: hide when complete, secondary checklist after; deep dive C6.

**Effort.** S; B12 is M.

### 2.11 Where each signal is still too coarse (summary)

| Step | Today's definition | Honest definition |
|---|---|---|
| Profile | description and category | category, description, website, each named |
| Voice | both documents opened once | each document read and marked "Looks right"; waiting while missing |
| Agent | `ready && standUpDone`, or `launchState live` | intake saved, stand-up done, each named; live by evidence |
| Run | any non-launch, non-test job exists | one such job reached review, approved or delivered |
| Result | any client-visible asset exists | the client opened one |

---

## 3. Notifications with logic

### 3.1 The rule

A bell row is one event or one condition **the client can act on or open**, with one destination. If nothing the client can open exists, it is not a row, it is not counted, and the fact lives on Home's attention card as an indicator. The badge number is the number of rows. A summary sentence is allowed only when it has one destination that holds everything it counts.

**Why.** NN/g indicators vs notifications (N11): a persisting condition that asks nothing is an indicator; F8: rows that name work with nowhere to go are dead ends; Albert's ruling that every row leads somewhere.

### 3.2 Every client row today, and where it goes

| Row | file:line | Today | Change |
|---|---|---|---|
| "Your Karos team is reviewing new work" | `notification-bell.tsx:499-515`, produced by `notification-rows.ts:138` | Inert, counted as 1 | **Not a row for a client.** Karos-owned state; stays on Home as "N deliverables in review". Count drops by 1 |
| "Work is ready for your review" / "Tasks are in progress" | `:537-565`, produced by `notification-rows.ts:179-185` | Inert, counted as up to 2 | **Not rows for a client.** Sign-off is staff-only; content ideas already render on the calendar. Count drops by up to 2 |
| Meeting action item | `:397-436` (link is the 11px title at `:415-422`) | Whole row not a link; X at `:424-434` | Whole row is a link to `/transcripts/{id}`, chevron, `.focus-ring`; the check becomes a separate "Done" control in the right slot |
| "N unread" header chip | `:312-318` | Static, and a second number beside the badge's | Replaced by a quiet "Mark all as read" (only when unread event rows exist) |
| Empty state | `:323-330` | "All caught up!", no control | "Nothing needs you right now." plus one quiet link "Open your calendar" |
| Footer links | `:444-465` | Staff only | Unchanged |

Net effect for a client today: the bell shows meeting action items and nothing else, all clickable. Effort **S**.

### 3.3 The rows a client actually wants (new feed)

**Where it breaks.** The three feeds (`app/(app)/layout.tsx:78-90`) are about Karos's work. The events a client waits for, a post landing and a run finishing, produce no notification at all (deep dive N8: "no notification if they navigate away").

**What we change.** Four row kinds, each with a destination that exists:

| Row | Copy | Destination | Clears |
|---|---|---|---|
| Delivered post | "Your Instagram post is ready" / "Instagram Agent · Tue 17" | `/calendar?view=archive&asset={id}` (2.7) | opened, or Mark all as read, or 14 days |
| Failed publish | "1 post did not go out" / the client-safe reason | `/calendar?date={day}` | opened, or the post is marked posted |
| Channel dead | "LinkedIn needs reconnecting" | `?tab=settings` | the channel is usable again |
| Mark-as-posted due | "3 posts from this week are waiting to be marked as posted" | `/calendar` | none due |

Feed: a bounded read in the layout (client-visible assets by `updatedAt` over the last 14 days, plus integrations), through `unreadNotificationCount` so the badge, the panel and the mobile dot stay one number.

**Why.** N8/N11 (completion needs a salient, explicitly dismissed row because the user was not watching); the standing ruling that everything a client sees links to them getting outputs.

**Effort.** M.

### 3.4 Mark-read rules

- **Event rows** (delivered post, failed publish) are unread until the row is opened or "Mark all as read" is pressed, which stores `notificationsSeenAt` on the user; they leave the list 14 days after their event either way.
- **Condition rows** (channel dead, mark-as-posted due) are never "read"; they clear when the condition clears, and carry no X.
- **Meeting items** clear on "Done" (today's write, `dismissAssignedActionItemAction`).
- Opening the panel marks nothing. The badge equals the rows in the panel at all times.

### 3.5 Badge: rail versus mobile

**Where it breaks.** Nothing structural: the rail bell shows a numeral (`client-rail.tsx:216-223`), the mobile Company tab a dot (`mobile-shell.tsx:130-138`), the sheet's bell row a numeral (`client-rail.tsx:335-345`), all from `unreadNotificationCount`. What is wrong is only the number, inflated by the inert rows removed in 3.2.

**What we change.** Keep the split: a numeral on a bell, a dot on a tab (a number on a tab named "Company" reads as a company count). Both keep `bg-neon`: a live signal is a sanctioned use. With 3.2 the count becomes honest.

**Why.** CD-H7b (one number, one noun); rule 7.

**Effort.** none.

---

## Decisions Albert must make

1. **Profile definition (2.3):** does "complete" require the website? Recommended yes; it is the field SEO/GEO and the blog agent read first.
2. **Confirming a document (2.4):** "Looks right" as the done gesture, and what "Something is off" opens: Support with the document named (recommended), the billable Correct Info, or an editable brand-voice field. This is the open brand-voice-editability question; do not assume it.
3. **Waiting-row horizon (2.9):** a fixed promise ("usually within 2 business days") or a staff-set expected date per client. Recommended the fixed promise until ops can hold a date.
4. **After completion (2.10):** the slot stays empty until the ladder reopens, or takes "More ways to get value" (B12). Recommended B12; it is not content ideas, so it does not touch the standing ruling.
5. **Bell scope (3.2):** drop Karos-owned states from the client bell entirely (recommended) or keep them as rows linking to the agent's page, where "In review" is visible in run history.
6. **`?asset=` on the calendar (2.7, 3.3):** approve the URL key; it is the one piece both the ladder's last step and the notification rows need.
