# Karos CMO client portal — UX deep dive

Read-only pass over `claude/credits-prep-enable` (= main) in
`.claude/worktrees/instagram-post-ordering-5c8eaa`. Inputs: `portal-audit-status.md`,
`flow-audit.md`, `setup-ladder.md`, `credits-design.md`, plus the current code of every
client screen and `globals.css` / `ui.tsx`.

Everything here keeps the Ember system: two inks, one rationed orange, DM Mono labels,
Hanken body, Spectral display. **No new hues are proposed.** Where a colour is named it
is a token that already exists (`--success`, `--warning`, `--danger`, `--info`) or a
correction to a value that is already failing.

Measurements in this document were computed against the actual token values in
`src/app/globals.css` and counted across the client-facing components; the arithmetic is
reproducible from the file paths given.

---

## 1. Where the portal stands

The flow audit's eighteen recommendations have almost all landed, and they landed
*properly* — R5's calendar URL state is a real `pushState`/`popstate` implementation with
a debounce and a WebKit throttle note, not a shim; R6 gave Archive its own control and a
remembered return view; R1's poller is gated on the server's own in-flight answer rather
than a client boolean. The code is unusually well reasoned and the copy is the best
writing in the product. The portal is no longer *broken*.

It is, however, still shaped like the data model rather than like a week of a marketer's
work. What follows is where.

### The system underneath (this is the biggest finding)

Three numbers, counted across the client-facing components:

**Type.** 427 font-size declarations across the client surfaces
(`home-*.tsx`, `client-home-overview.tsx`, `client-rail*.tsx`, `archive-view.tsx`,
`run-calendar.tsx`, `credits-panel.tsx`, `blog-agent-intake.tsx`,
`client-agents/*.tsx`, `seo-geo-panel.tsx`):

| size | count |
|---|---|
| `text-xs` (12px) | 175 |
| `text-[11px]` | 135 |
| `text-sm` (14px) | 64 |
| `text-[10px]` | 32 |
| `text-[9px]` | 2 |
| `text-base` (16px) | 5 |
| `text-lg` / `text-xl` / `text-2xl` / `text-3xl` | 3 / 2 / 2 / 7 |

**344 of 427 declarations (81%) are 12px or smaller. 169 (40%) are 11px or smaller.
There is effectively no 16px text in the client portal.** A client reads their brand's
strategy, their agent's reasoning and their own money in 11 and 12 pixel type. This is
the single strongest tell that the surface was built by people reading it on a 32-inch
display at arm's length, and it is the root cause of the "feels like a tool, not a
product" impression.

**Focus.** 126 component files contain an `onClick`; **26** contain any `focus-visible`
styling; **37** set `outline-none` (which removes the browser default). There are seven
different ring recipes in the codebase — `ring-foreground/25` (21×), `ring-neon` (6×),
`ring-neon/40` (4×), `/50` (3×), `/60` (2×), `ring-foreground/40` (2×), `ring-warning/40`
(1×) — plus `ring-1` vs `ring-2`. The dominant one measures **2.16:1** on charcoal and
**1.70:1** on paper. `Input`/`Textarea`/`Select` (`ui.tsx:99,113,127`) have no ring at
all: they set `outline-none` and move the border from `foreground/15` to `foreground/25`,
which is a **1.57 → 2.15** change on `--surface`. A keyboard user genuinely cannot see
where they are in a form.

**Spacing.** The vocabulary in the Home widgets alone is
`0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 8` — a 2px scale with every half-step in play
(`p-3.5`=14px, `px-2.5`=10px, `mt-1.5`=6px, `mt-2.5`=10px). There is no named rhythm, so
nothing enforces it and nothing can be tuned globally.

Two more system-level inconsistencies worth naming because they contradict decisions the
codebase itself documents:

- **`StatCard` sets its number in mono** (`ui.tsx:246`, `font-mono text-2xl`) while
  `globals.css:25-31` spends six lines explaining that numbers are sans with tabular
  digits and that this exact disagreement was fixed in 2026-09. The primitive was missed.
- **`.eyebrow` is barely used.** The class exists (`globals.css:219`: 12px, 0.14em,
  orange) and appears in ~7 files, while the same idea is hand-rolled inline **45 times**
  at 10px, grey, with **five different tracking values** (0.06 / 0.08 / 0.1 / 0.12 /
  0.14em). The design system's own label token is not the one the product uses.
- **Four client-facing error messages use `text-red-400`** — a colour the Ember palette
  does not contain — instead of `text-danger`:
  `blog-agent-intake.tsx:60`, `newsletter-agent-intake.tsx:77`,
  `reputation-agent-intake.tsx:60`, `meeting-action-items.tsx:337`.

### Contrast, measured

Computed from the actual token values (WCAG 2.x relative luminance):

| | on `--surface` | on `--background` |
|---|---|---|
| **dark** `--danger` #d65a52 | **4.00** ✗ | 4.51 |
| dark `--muted-2` | 4.81 | 5.42 |
| dark `--neon` | 5.44 | 6.13 |
| **light** `--neon` #ff6b2c | **2.84** ✗ | **2.51** ✗ |
| **light** `--neon-bright` #e05a1f | **3.72** ✗ | **3.29** ✗ |
| **light** `--warning` #a8781e | **3.91** ✗ | **3.46** ✗ |
| **light** `--success` #4f7d4e | 4.80 | **4.24** ✗ |
| light `--info` | 5.06 | **4.47** ~ |

All four failures have one-line fixes with measured replacements — see **N14**.

Non-text (WCAG 1.4.11 wants 3:1): every hairline is **1.25–1.63** dark and **1.28–1.45**
light; input borders **1.36–1.57**; the danger Badge's text on its own `danger/10` fill is
**3.60**.

Two of these matter a lot. **`--danger` at 4.00:1 on `--surface` is the error colour**,
and it is under the floor on the surface errors are painted on. And **`.eyebrow` is
orange, and orange in light mode is 2.51–2.84:1** — the signature label style of the brand
fails contrast in the light theme, which is why the light mode "feels flat": the accent is
doing no work there because it cannot.

### Screen by screen

**Home** — `clients/[id]/page.tsx:955-1010`

Works: the setup ladder (`home-get-set-up.tsx`) is genuinely good — one list, one press,
done rows kept and muted, no X, auto-completion from real signals, count and bar computed
from one array. Every KPI cell links to something about *its own* number rather than to
"the report" (`home-kpis.tsx:168-188`). The calendar-preview rows now open the same
`AssetDetailModal` the calendar chip does.

Still an engineer's page: it is six cards in a single column (2-up at `@4xl`) with no
hierarchy between them — Get set up, Calendar preview, Your numbers, SEO & AI visibility,
Needs your attention, Recent activity — each an equal-weight `Card` with `p-5`, a
`text-lg` serif title and, on three of them, an identical `h-6 w-6 rounded-md bg-neon/10`
icon chip (`home-kpis.tsx:360`, `home-standing.tsx:138`,
`client-home-overview.tsx:455`). The one rationed colour has become the default card
decoration. "Your numbers" is a whole card for **two** figures, because the followers cell
never renders (nothing writes `clientFollowerSnapshots` — `home-kpis.tsx:339`). The
`PageHeader` spends ~100px on *"Welcome back, {name} / Here's what's happening across the
{client} workspace"* and answers nothing. And there is no answer anywhere on the page to
the question a returning client actually has: **what happened since I was last here.**
"Recent activity" is three titles and a relative stamp.

**AI agents** — `agents/page.tsx:375-424`, `client-agents/roster.tsx:76`, `roster-card.tsx`

Works: the whole card is a real `<Link>` (middle-click, cmd-click, copyable URL); the
paused card is inert *and* chevron-less; the empty state now carries Support.

But it is a **directory**, not a catalogue and not a control panel. Every entry is
identical in shape: mark, name, one status Badge, a two-line blurb, chevron. A live
Instagram agent that shipped seven posts this week and a Reddit agent that has never run
render as the same rectangle. Nothing on the roster says what it last made, when it next
runs, how much a run costs, or how many drafts are waiting — so the question that brings
a client here ("what has my Instagram agent done for me?") always costs a page load. The
grid is `sm:grid-cols-2` and never wider (`roster.tsx:76`), so on a 1100px content column
eight agents is a scroll.

**Agent detail** — `agents/[agentId]/page.tsx:1102-1440`

Works: the one breadcrumb in the portal; the primary button now names the format it will
run (R15, `agent-detail-panel.tsx:216`); a disabled run paints its reason rather than
hiding it in a `title`; run-history rows are honestly inert and say so in a comment.

The problem is the opposite of over-disclosure: **nothing is disclosed progressively at
all.** It is one scroll of up to ten stacked sections (kickoff strip, banners, status
strip, hero, run panel, live card, inputs band, settings facts, run history, archive rows,
"Open archive") plus a 320px aside, with no in-page navigation, no anchors, no sticky
sub-nav. The three things a client comes for — *see the work*, *change the inputs*, *run
it* — sit at three different scroll depths, and "change the inputs" leaves for a different
route.

And the run banner (`agent-detail-panel.tsx:148-170`) is a static sentence — *"Making your
X post now. This takes 10–20 minutes."* — with a `<AutoRefresh>` behind it doing a full
`router.refresh()` **every 4 seconds** (`auto-refresh.tsx:43`). For a 20-minute run that
is ~300 full server re-renders of the route segment tree, and the client gets no elapsed
time, no stage, no estimate that moves.

**Intakes** — `blog-agent-intake.tsx`, and the five siblings

Works: R1 (the poller), R3 (`CreditPriceNote`) and R7 (one badge phrase per state) all
landed; the copy is the best in the product ("*We build a picture of your voice from your
own writing. Where this disagrees with it, this wins.*").

But structurally these are essays with input boxes in them. Every field is
`(optional)` — five of five on the blog form — every field is a bare `Textarea`, and each
carries 2–4 lines of `text-xs text-muted` help beneath it, so the help outweighs the
field. There is no grouping, no step, no required/optional split, no character guidance,
**no validation of any kind**, no autosave and no unsaved-changes guard: `cancel()`
(`blog-agent-intake.tsx:212-220`) silently discards, and navigating away does the same.

**Calendar** — `run-calendar.tsx`

Works, and this is the screen that improved most: `?view`/`?date`/`?status`/`?agent`/`?q`/
`?hidden` all round-trip, view mode is a real `pushState` so Back steps Archive → Week,
`popstate` restores filters through the same narrowing rule, and Archive is its own
labelled control with a "back to the view you came from" memory (`:1770-1782`).

Left: **there is no "Today" button.** Prev/next arrows and a range label, and once you
have paged into March there is no way home but the URL. The month grid's target is the
day *number* — `h-5 w-5`, a **20×20px** hit area (`:2323`) — not the cell; `+N more`
is still an inert `<p>` (`run-calendar.tsx:2355`); and the open asset is **not** in
`CALENDAR_QUERY_KEYS`, so the one object a client would want to send a colleague — *this
post* — has no URL at all, on a screen where everything else now does.

**Account Center** — `settings/page.tsx:923-957`, `settings-tabs.tsx`

Works: the eight horizontal tabs became a grouped 13.5rem side-nav with roving `tabIndex`,
arrow/Home/End keys, `aria-selected`, and a native `<select>` below `md`. That is a proper
`tablist`.

But **Reporting is filed in a settings hub.** The SEO/GEO report, the analytics charts,
the connected-channel list and "Things only you can do" — arguably the second most
valuable surface in the product, and the one that justifies the retainer — is reached by:
avatar menu at the bottom of the rail → Account Center → Reporting. Competitors is beside
it. `replaceState` (`settings-tabs.tsx:107`) means Back still leaves the page rather than
stepping tabs. And F16 is untouched: two pencils and a contact glyph within ~60px on the
Profile tab open three different editors
(`client-profile-panel.tsx:579`, `:587`; `client-context-sections.tsx:655`).

**Copilot** — `copilot-dock.tsx`, `chatbot-widget.tsx`

Works: dismissible, state persisted, `inert` while collapsed (so it is not a keyboard
trap), a real focus pass on the rising edge, and the R12 deliverable chip.

But it holds a **permanent 48px column on every desktop page** whether or not it is ever
opened, and that collapsed strip is `aria-hidden` with `tabIndex={-1}`
(`copilot-dock.tsx:321-322`) — a keyboard user's only handle is the 28px circle. Inside,
it shows **no sources, no tool calls, no "what I looked at"**; its three action chips and
three suggestions (`chatbot-widget.tsx:983`) are static strings, identical on Home, on the
calendar and on an agent page. It is a chat box beside an application that knows exactly
what the reader is looking at, and it never uses that.

**Mobile** — `mobile-shell.tsx`, `client-rail.tsx:262-352`

Works: the sheet, the settings `<select>`, the phone agenda in month view, sign-out is
reachable, the bell moved somewhere it can be seen.

But the tab bar is **two destinations and a drawer**: Home, Calendar, and a "Company"
button. **AI agents — the product — is not a tab.** It lives inside the sheet
(`client-rail.tsx:292-299`), two taps deep, under a label that does not name it, beside
brand colours, Team, notifications, Support, the theme switch and Log out — nine things
in one drawer. The bar is 54px (`constants.ts:91`) with a ~36px copilot strip parked above
it (`MOBILE_TAB_BAR_OFFSET_CLASS`), so ~90px of a phone viewport is permanent chrome, and
**there is no `env(safe-area-inset-*)` anywhere in the repo** and no `viewport` export in
`app/layout.tsx`. The sheet's only dismissal is an X in the top-right — the furthest point
from a right thumb.

### Three things that are missing entirely

- **No toast, snackbar or global status primitive.** Every confirmation is a local text
  swap ("Saving…", "Sent.", "Profile updated." on a 3.5s timer). There is no way to tell
  a client "your run finished" anywhere except by them being on the page.
- **No undo outside `HomeTaskUndoRow`.** R4 built the pattern; it lives on one row type.
- **No search, no command palette, no keyboard shortcut of any kind.** Every `keydown`
  listener in `src/components` is an Escape-to-close. The only text search in the product
  is the archive's title box.

---

## 2. The open backlog, re-prioritised

Ranked by user impact ÷ effort. One-line design for each — what to build, not just what
to fix. **Status verified against the current code**, not taken from the tracker.

| # | Item | Source | Impact ÷ effort | The design |
|---|---|---|---|---|
| **B1** | `alert()` reaches a client | F17 · `client-documents.tsx:302` | **very high ÷ XS** | Replace with an inline `--warning` notice inside the doc panel header: *"Your browser blocked the PDF window. Allow pop-ups for this site, then press Export again."* plus the Markdown export as a second button in the same row — a blocked pop-up should hand the reader the export that always works, not an OS dialog. |
| **B2** | `text-red-400` in four client error paths | new (§1) | **high ÷ XS** | One `FieldError` in `ui.tsx` (`text-xs text-danger`, `role="alert"`, icon + text). Delete the four local `fieldError()` copies. Do it in the same commit as B10 so `--danger` is legible when it lands. |
| **B3** | Credits has no top-up path | R18b · `credits-panel.tsx:281` | **high ÷ S** | Do not build self-serve billing. Make the *route in* unconditional: a permanent footer row on the Credits card — *"Credits are added by your Karos team. Ask for more →"* — opening the same Support dialog, always visible, not only once blocked. Add the same line to the low-balance state on the run controls. One sentence removes the product's only dead end that costs the client money. |
| **B4** | Brand voice is unwritable after onboarding | R18a · `onboarding-wizard.tsx:270` vs `client-editor.tsx:262` (staff only) | **high ÷ S** | Put a plain `Textarea` on Account Center → Profile, above the documents list, labelled *"How we should sound"* with the current value pre-filled and one Save. Keep the billable "Correct Info" for the generated **Brand Voice document**; this field is the client's own sentence and should never have had a price. The write already exists on the server. |
| **B5** | No active nav item / no breadcrumb on intakes, `/transcripts`, `/team` | F14 | **high ÷ S** | Two moves. (a) `RailNavLink` gains an `alsoActiveFor: RegExp` so an intake route lights **AI agents** and `/transcripts` + `/team` light **Account Center**. (b) Lift the agent page's `‹ All agents` into a shared `<BackLink>` and put it on all three page types, naming the real destination (`‹ X agent`, `‹ Account Center`). |
| **B6** | Three edit affordances in 60px | F16 · `client-profile-panel.tsx:579,587`; `client-context-sections.tsx:655` | **high ÷ M** | One text control — **Edit** — on the brand card, opening one dialog with three labelled sections (Profile · Brand guidelines · Colours) and one Save per section. Kills two icon-only buttons, the modal-vs-inline split, and half of F15 at the same time. |
| **B7** | Depth to "set up this agent" | F13 | **medium ÷ S** | The rail agent row grows a right-aligned `Set up` link when `buildAgentSetup(...).ready === false` — the roster already resolves that boolean (`agents/page.tsx:222`). Two clicks instead of four, and it appears only where it is the blocking step. |
| **B8** | `BrandProfileModal` mixes immediate and deferred writes; seats roster inside a modal | F15 | **medium ÷ M** | Falls out of B6: logo upload/remove moves to its own section with its own explicit control and a two-step confirm; contact/website/about keep one Save. The LinkedIn seats roster leaves `integrations-tab.tsx:690` for a section on the LinkedIn agent's own intake page, where the seat forms already live. |
| **B9** | Copilot commands still terminate in prose | F18 | **medium ÷ M** | Reuse the `FeedbackChip` shape (`chatbot-widget.tsx:717`) for the other four: `/reschedule-post` → a chip opening the calendar at that day; `/schedule-run` → a chip to the agent page; `/inspect-job` → the run-history row; `/edit-output` → the asset modal (already possible via R12's resolver). Four mounts, no new capability. |
| **B10** | Fix `--danger` and the light-mode accent | new (§1) | **very high ÷ S** | `--danger` dark **#d65a52 → #e58079** (5.66:1 on `--surface`, **4.86:1 on its own 10% badge fill**, where the current value is 3.60). Light-mode label orange: add `--neon-ink: #b8430f` (4.83:1 on paper, 5.46 on white) **used only for orange text in light mode**; `--neon` itself never changes, so fills, markers, `.hl` and the accent button keep the exact brand colour. `.eyebrow` reads `--neon-ink` under `.light`. |
| **B11** | One focus ring | new (§1) | **very high ÷ S** | `--focus: color-mix(in srgb, var(--neon) 70%, var(--foreground))` + a `.focus-ring` utility (`outline: 2px solid var(--focus); outline-offset: 2px`). It self-adjusts: **#fb9366 in dark (6.3–7.9:1)**, **#ba5327 in light (4.0–4.8:1)** — both well over SC 1.4.11's 3:1, both still the brand orange mixed with the brand ink, so no new hue enters the system. Apply to `Button`, `Input`, `Textarea`, `Select` in `ui.tsx`; delete the seven ad-hoc recipes. Highest-value accessibility fix in the codebase, and it is one declaration plus one class. |
| **B12** | "More ways to get value" list | setup-ladder §6.2 item 8 | **medium ÷ M** | The 18 later-value rows return as a collapsed `<details>` under the setup card, rendering **only** once the ladder is complete, reusing `HomeTaskRow` + `useUndoableDismiss` unchanged. Header: *"More ways to get value · 4 of 18"*. Nothing new is built; the rows already exist in `action-list.ts`. |
| **B13** | Calendar "Schedule a run" for clients | undecided | **medium ÷ S (decision)** | Recommendation in §4. |
| **B14** | LLM re-order of the setup ladder | setup-ladder §4.2 | **low ÷ M** | Deprioritise. The deterministic order is already per-client and the ladder is six rows; an LLM re-rank of six rows is unobservable to the client and adds a failure mode to the first screen they ever see. |
| **B15** | Instagram/karos-content self-service intake | setup-ladder §3.1 | **medium ÷ L** | Real, but it is a product build (a seventh intake family), not a UX fix. Until it exists, the ladder's *"Karos is setting this up for you"* row should carry an expected date, not just a `Clock` glyph — see N8. |
| **B16** | Credits: settle in-app actions to real cost | credits-design §3(b) | **low (client-visible) ÷ M** | Engine-by-engine wiring. Invisible to the client except that a ledger row reads less than the quote. Ship behind the flag as planned; no UX work needed beyond copy already specified in credits-design §3(d). |
| **B17** | Brand guidelines doc that `globals.css:4` cites | undecided | **low ÷ S** | `globals.css` and `ui.tsx` already *are* the guidelines, and they are better written than most design-system sites. Write `docs/brand/KAROS-BRAND-GUIDELINES.md` as a short index that points at the two files and records the four decisions they encode (two inks, one orange, three faces, three surfaces) — not a second copy that can drift. |

**Verified as already closed, contrary to the tracker:**
F19's inert social squares are now dimmed (`client-profile-panel.tsx:721`,
`opacity-60`); the bell's "see all meetings" is staff-gated so the three inconsistent
reachability states are one (`notification-bell.tsx:220`). `task-ticket-modal.tsx` is
still present and still has no production mount.

---

## 3. New directions from research

Eighteen proposals the flow audit did not cover. Each names the problem *in this
portal*, the pattern, the sources actually fetched (URL given; nothing is cited that was
not retrieved), a design in words, and effort.

---

### N1 · Home: replace the greeting with an answer, and give the six cards a rank — **M**

**Problem.** Home opens with `Welcome back, {name}` in 30px Spectral plus *"Here's what's
happening across the {client} workspace"* (`clients/[id]/page.tsx:957-960`) — ~100px that
answers nothing — and then presents six `Card`s of identical weight, three of them wearing
the same `bg-neon/10` icon chip. There is no visual rank, so the eye has no entry point,
and no card answers *what happened since I was last here*.

**Pattern.** NN/g's dashboard guidance: a dashboard is an at-a-glance answer surface, and
length and 2D position are the attributes people judge most accurately — colour is read
categorically and must never encode magnitude
([nngroup.com/articles/dashboards-preattentive](https://www.nngroup.com/articles/dashboards-preattentive/)).
Visual hierarchy: **no more than three size variations, at most two "large" elements, no
more than three contrast variations**, and grouping is done by *decreasing* whitespace
inside a group and increasing it between groups
([nngroup.com/articles/visual-hierarchy-ux-definition](https://www.nngroup.com/articles/visual-hierarchy-ux-definition/)).
Aesthetic-and-minimalist as a hierarchy technique rather than a taste: every extra unit of
information competes with the relevant units
([nngroup.com/articles/aesthetic-minimalist-design](https://www.nngroup.com/articles/aesthetic-minimalist-design/)).

**Design.** Three tiers, not six peers.

- **Tier 1 — the answer line.** The `PageHeader` title becomes the state of the week in
  Spectral 30px, resolved server-side from data already in hand:
  *"3 posts land this week. 1 needs you."* / *"Nothing is scheduled this week."* /
  *"Your Instagram agent is writing now."* The name moves to a 12px line under it
  (*"Hi Albert · {client}"*). Same slot, same height, an answer instead of a salutation.
- **Tier 2 — the two cards that ask for a press:** Get set up (or, once complete, Needs
  your attention) and Calendar preview. Keep the 2-up grid, keep the orange icon chip
  **on these two only**.
- **Tier 3 — the three reference cards:** Your numbers, SEO & AI visibility, Recent
  activity, at `gap-4` inside a group separated from Tier 2 by `gap-10`, with the icon
  chips dropped to a bare `text-muted-2` glyph. That takes the page from six orange chips
  to two, which is what "rationed" means.
- Fold "Your numbers" (two live cells) into the SEO card as a four-cell strip, since the
  followers cell never renders (`home-kpis.tsx:339`). One card, four numbers, one border.

---

### N2 · The agents roster: a catalogue row, not a directory card — **M**

**Problem.** `roster-card.tsx` renders a homogeneous set — every entry is mark + name +
one Badge + blurb + chevron — in a `sm:grid-cols-2` card grid (`roster.tsx:76`). A live
agent that shipped seven posts this week and one that has never run are the same
rectangle. The client's actual question is comparative: *which of my agents is working,
what did each last make, what does each cost, when does each next run.*

**Pattern.** Cards are for **heterogeneous** collections; they are less scannable than
lists because element positions vary card to card, and they cost more vertical space
([nngroup.com/articles/cards-component](https://www.nngroup.com/articles/cards-component/)).
Tables win when the task is comparison, because adjacent data points compare without eye
travel or memory load — human-readable identifier in column 1, columns ordered by
importance, row hover for orientation, and a **non-modal side panel rather than a modal**
for single-record detail
([nngroup.com/articles/data-tables](https://www.nngroup.com/articles/data-tables/)).
Baymard reaches the same conclusion for spec-heavy items on desktop, with a fallback to a
list view carrying 2–3 attributes on mobile
([baymard.com/blog/use-product-tables-for-desktop-product-listings](https://baymard.com/blog/use-product-tables-for-desktop-product-listings)).
Image grids inflate scroll length badly and users pick from the first visible row
([nngroup.com/articles/image-vs-list-mobile-navigation](https://www.nngroup.com/articles/image-vs-list-mobile-navigation/)).

**Design.** One full-width row per agent, `min-h-[64px]`, still a real `<Link>`:

```
[mark] Instagram Agent            Live ●     Last: "Founder mode" · 2d ago    Next: Tue 09:00   ~25 cr  ›
       Daily posts for your feed                                              [Set up →]  ← only when blocked
```

Columns, in importance order: identity (mark + name + blurb, truncating), status Badge,
**last output** (title + relative stamp — the thing they came for), **next run**, **run
cost**. `row-lift` on hover, one trailing `ChevronRight` (R8's rule already). Below
`@2xl` the last three columns collapse into one 11px meta line under the name — Baymard's
mobile fallback. Paused agents keep the same row, greyed, with no chevron. The vertical
cost of eight agents drops from four scrolling card rows to eight 64px rows, and the
comparison the roster exists for becomes possible without a page load.

---

### N3 · Agent detail as a workspace: three zones and a sticky spine — **M/L**

**Problem.** Ten sections stacked in one scroll with a 320px aside and no in-page
navigation (`agents/[agentId]/page.tsx:1102-1440`). The three things a client comes for —
*see the work*, *change the inputs*, *run it* — are at three scroll depths, and the inputs
open a different route.

**Pattern.** Progressive disclosure: show the few most important options first, the rest
on request, and **never exceed two levels**
([nngroup.com/articles/progressive-disclosure](https://www.nngroup.com/articles/progressive-disclosure/)).
For complex applications specifically: provide flexible non-linear pathways, reduce
clutter without reducing capability, and **ease the transition between primary and
supplemental information so detail is reachable without leaving the screen**
([nngroup.com/articles/complex-application-design](https://www.nngroup.com/articles/complex-application-design/)).
Tabs require *parallel* content — same layout, different data — and fail when users must
compare across them; labels should be 1–2 words with strong scent
([nngroup.com/articles/tabs-used-right](https://www.nngroup.com/articles/tabs-used-right/)).
Accordions suit sections that are independent and mostly unread, and should allow multiple
open panels
([nngroup.com/articles/accordions-on-desktop](https://www.nngroup.com/articles/accordions-on-desktop/)).

**Design.** Do **not** tab the page — the sections are not parallel and a client does want
the run control visible while reading the archive. Instead:

- **A sticky spine.** Under the `PageHeader`, a 40px sticky bar carrying the agent's
  status, the run control, and four anchor links: `Work · Inputs · Schedule · History`.
  Scroll-spy marks the current one. That is the "flexible non-linear pathway" without
  losing the single scroll.
- **Zone 1 (Work)** — the run panel and the archive rows move to the *top*, above the
  live-card format list. The first thing on the page is what it made and the button that
  makes more.
- **Zone 2 (Inputs)** — the inputs band becomes an *expanded, editable* section rather
  than a list of links to another route: render the same `SavedFormCard` the intake page
  renders, in place. One level of disclosure, not two hops. The intake route stays as the
  deep-linkable canonical URL.
- **Zone 3 (Schedule + History)** — the format list, pace, week strip, run history, each a
  `<details>` open by default, multiple-open allowed, so a returning client can collapse
  what they never read.
- The 320px aside keeps only connections and source material.

---

### N4 · Intake forms: sections, a required/optional decision, real save states — **M**

**Problem.** Five bare textareas, all `(optional)`, each with 2–4 lines of help beneath;
no grouping, no validation, no autosave, no unsaved-changes guard; `cancel()` discards
silently (`blog-agent-intake.tsx:212-220`); errors in `text-red-400`.

**Pattern.** GOV.UK: start with one question per page, group only where research supports
it, labels visible and above the field, **placeholders are not labels** because they
vanish on typing, and mark optional fields "(optional)" — *"Never mark mandatory fields
with asterisks"*
([design-system.service.gov.uk/patterns/question-pages](https://design-system.service.gov.uk/patterns/question-pages/),
[/components/text-input](https://design-system.service.gov.uk/components/text-input/)).
NN/g takes the opposite view — mark every required field, red asterisk preceding the label
([nngroup.com/articles/required-fields](https://www.nngroup.com/articles/required-fields/)).
**This is a genuine standards conflict; pick one and say why.** Baymard: validate `onblur`,
never on keystroke, because premature validation reads as nagging, and 31–32% of
benchmarked sites validate nothing
([baymard.com/blog/inline-form-validation](https://baymard.com/blog/inline-form-validation));
single column, labels above, hide infrequent fields behind a link, and pair strict
validation with soft "are you sure" warnings
([baymard.com/learn/form-design](https://baymard.com/learn/form-design),
[/blog/avoid-multi-column-forms](https://baymard.com/blog/avoid-multi-column-forms)).
Primer: explicit save belongs on declarative controls, auto-save on imperative ones,
**never mix the two on one page**, keep the save button always enabled, warn on navigation
via `beforeunload`
([primer.style/product/ui-patterns/saving](https://primer.style/product/ui-patterns/saving/)).
Errors go next to the field, with an icon, not colour alone
([nngroup.com/articles/errors-forms-design-guidelines](https://www.nngroup.com/articles/errors-forms-design-guidelines/));
if a summary is used, put it at the top of `main` above the `h1`, move focus to it, and
repeat the wording inline
([design-system.service.gov.uk/components/error-summary](https://design-system.service.gov.uk/components/error-summary/)).

**Design.**

- **Adopt GOV.UK's convention** — "(optional)" on optional fields, nothing on required
  ones — because on these forms *most* fields are optional and asterisking the minority
  required ones would put red marks on the two fields a client is most willing to fill.
  Say so once in `ui.tsx`'s `Label` docstring so the next form does not re-decide.
- **Two sections, not five loose fields.** `What we write about` (audience, banned
  topics) and `How we hand it over` (your sites, CMS, tone note), each a `<fieldset>` with
  a `<legend>` in the 12px mono label style. Help text collapses to one line per field
  with a `More` disclosure for the rest — the three-line explanations are excellent copy
  and belong one press away, not permanently between two inputs.
- **Explicit save only** (Primer): keep one always-enabled `Save details`, add
  `beforeunload` while dirty, and change `Cancel` to `Discard changes` with a two-step
  inline confirm — the pattern `client-key-inline.tsx:94` already ships.
- **Validation on blur** for the two fields that have a shape: domains (must parse as
  hosts) and CMS (free text, no validation). One `FieldError` primitive (B2), icon + text,
  `--danger` after B10.
- **A "check your answers" band** above `Set it up`, listing each saved value with a
  `Change` link — GOV.UK's summary pattern — so the client sees what the run will read
  before spending 25 credits on it.

---

### N5 · The calendar as the daily surface: Today, real targets, and no drag-and-drop — **M**

**Problem.** No `Today` control; the month target is the 20×20px day *number*, not the
cell (`run-calendar.tsx:2323`, `:2331`); `+N more` is an inert `<p>` (`run-calendar.tsx:2355`); the open asset
has no URL; week is the default at every width.

**Pattern.** WCAG 2.2 SC 2.5.8 (AA): **targets at least 24×24 CSS pixels**, or spaced so a
24px circle centred on each does not intersect another
([w3.org/WAI/WCAG22/Understanding/target-size-minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)).
Apple: 44×44pt default, 28×28pt minimum
([Apple HIG, Accessibility](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json));
Android: 48×48dp
([developer.android.com/guide/topics/ui/accessibility/apps](https://developer.android.com/guide/topics/ui/accessibility/apps)).
**Drag-and-drop is constrained at AA**: SC 2.5.7 requires every dragging operation to have
a single-pointer alternative — click-A-then-click-B, a "move to" menu, increment buttons
([w3.org/WAI/WCAG22/Understanding/dragging-movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)) —
and NN/g independently says use DnD only when there is no lower-cost alternative, and that
on touch a menu-based move is usually less error-prone
([nngroup.com/articles/drag-drop](https://www.nngroup.com/articles/drag-drop/)).
Calendar pickers suit dates within about a year of now
([nngroup.com/articles/date-input](https://www.nngroup.com/articles/date-input/)).
Android's width classes give a clean switch-over rule: **compact <600dp** is single-column
territory, medium 600–839, expanded 840–1199
([developer.android.com/develop/ui/compose/layouts/adaptive/window-size-classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/window-size-classes)).
The month-grid keyboard model is WAI-ARIA's Grid pattern: roving `tabindex`, arrows move
one cell, Home/End within the row, Ctrl+Home/End to the corners
([w3.org/WAI/ARIA/apg/patterns/grid](https://www.w3.org/WAI/ARIA/apg/patterns/grid/)).

**Design.**

- **`Today`** as an outline button immediately left of the `‹ ›` pair, disabled when the
  anchor already contains today. It writes `?date=` through the existing
  `writeCalendarQuery` — three lines.
- **The whole day cell becomes the button** in month view (`min-h-[84px]`, so ~84×150px),
  with the day number as a static badge inside it. That fixes a 20px target *and* removes
  the "the cell looks pressable but only the number is" lie in one edit.
- **`+N more` becomes a real button** opening the day panel — the panel already exists and
  already lists everything.
- **`?asset=` in `CALENDAR_QUERY_KEYS`**, seeded on the server and written with
  `pushState`, so Escape/Back closes the modal and a client can send a colleague *this
  post*. This is the single highest-value calendar change and it is one key in an existing
  map.
- **No drag-and-drop.** Rescheduling stays a menu action on the post ("Move to…" → the
  day panel) — cheaper to build, SC 2.5.7-compliant by construction, and better on touch.
- **Default view by width, not always Week:** `day` below 600px, `week` 600–1199, `month`
  at 1200+ where a month grid has room for three chips a cell. Seeded server-side from a
  client hint or resolved on mount before first paint of the grid.
- **Grid keyboard model** for month: roving tabindex + arrows + Home/End, per the APG.

---

### N6 · The archive as a library: counts, chips, sort, and bulk hand-off — **M**

**Problem.** Three filter controls in a strip, a **static label reading "Newest first"**
that is not a control (`archive-view.tsx:330`), no result count, no applied-filter chips,
no bulk actions, and a tile grid whose only interaction is "open a modal".

**Pattern.** Filters exclude on one or two criteria; facets are multiple simultaneous
dimensions and cost real metadata and interaction budget — confirm the need first
([nngroup.com/articles/filters-vs-facets](https://www.nngroup.com/articles/filters-vs-facets/)).
Instant filtering suits exploratory users; batch + Apply suits users arriving with
criteria — the named risk of instant filtering is visual distraction and repeated waits
([nngroup.com/articles/applying-filters](https://www.nngroup.com/articles/applying-filters/)).
Filter values should be ordered general-to-specific, or by user priority when names are
unfamiliar
([nngroup.com/articles/filter-categories-values](https://www.nngroup.com/articles/filter-categories-values/)).
Bulk actions: offer Select All, surface operations in a **contextual action bar that
appears with selection**, and give feedback with an undo
([nngroup.com/videos/bulk-actions-design-guidelines](https://www.nngroup.com/videos/bulk-actions-design-guidelines/)).
And Baymard's warning about preview overlays: for spec-driven items a quick view is
usually compensating for a weak list row — fix the row first
([baymard.com/blog/ecommerce-quick-views](https://baymard.com/blog/ecommerce-quick-views)).

**Design.**

- **A result line** under the filter strip: *"24 deliverables · 3 agents · last 30 days"*,
  and when anything is filtered, dismissible chips (`Status: Posted ×`, `Agent: X ×`,
  `"launch" ×`) with a `Clear all`. Keep instant filtering — the set is small and local.
- **Make "Newest first" a real `<select>`** (Newest / Oldest / By agent). It already looks
  like one and does nothing.
- **Bulk selection.** A checkbox on each tile, appearing on hover/focus; on first
  selection a contextual bar slides in above the grid: *"3 selected · Download · Mark as
  posted · Clear"*. `Download` reuses the existing `/api/clients/{id}/downloads` bundle;
  `Mark as posted` reuses `markAssetPostedAction` and shows one undo row. This is the
  weekly-handoff job the product currently makes clients do one modal at a time.
- **Richer tiles before richer previews** (Baymard): put the platform mark, the template
  name and the first ~80 characters of the body on the tile so the modal is a choice, not
  a requirement.
- **`?asset=`** here too, from the same key as N5.

---

### N7 · Promote Reporting out of the settings hub — **S/M**

**Problem.** The SEO/GEO report, "Things only you can do", the analytics charts and the
connected-channel list live at
Account Center → Reporting (`settings/page.tsx:929`), reached from an avatar menu at the
bottom of a rail whose nav has three rows. Home links to it three times because it is hard
to find.

**Pattern.** Left vertical nav suits broad, growing hierarchies with keyword-frontloaded
text labels and less-important items at the bottom
([nngroup.com/articles/vertical-nav](https://www.nngroup.com/articles/vertical-nav/), cited
in the flow audit's own research and consistent with it). NN/g on tabs: a tab strip needs
*parallel* content — Profile, Competitors, Reporting, Settings and Credits are not five
views of one subject
([nngroup.com/articles/tabs-used-right](https://www.nngroup.com/articles/tabs-used-right/)).
And the 3-click rule is false — the fix for depth is information scent and wayfinding, not
fewer clicks
([nngroup.com/articles/3-click-rule](https://www.nngroup.com/articles/3-click-rule/), from
the flow audit's fetched set).

**Design.** A fourth rail row, **Visibility**, between Calendar and the account block,
routing to `/clients/{id}/reporting` — a real page that renders today's `reportingSection`
plus the Competitors panel under it (they are one subject: where you stand, and against
whom). Account Center keeps a Reporting entry that redirects, so every existing deep link
survives, exactly as `?tab=archive` and `?tab=meetings` already do
(`settings/page.tsx:116-132`). Home's three separate links then all point at one
destination with one name. Account Center drops to Profile · Settings · Credits + the two
account tabs — which is what a settings hub should hold.

---

### N8 · Long-running work needs a run tray, not a sentence — **M**

**Problem.** A run takes 10–20 minutes. The client gets a static line and a pulsing dot
(`agent-detail-panel.tsx:148-170`), a full `router.refresh()` every 4 seconds
(`auto-refresh.tsx:43`), and **no notification at all if they navigate away** — which they
will, because 20 minutes.

**Pattern.** The three response limits: 0.1s instantaneous, 1.0s flow of thought, **10s
the limit of held attention — past which you owe a percent-done indicator and a way to
interrupt**
([nngroup.com/articles/response-times-3-important-limits](https://www.nngroup.com/articles/response-times-3-important-limits/)).
A good progress indicator conveys four things: the system is alive, roughly how much time
remains, what is happening in words, and how much is done
([nngroup.com/articles/progress-indicators](https://www.nngroup.com/articles/progress-indicators/)).
The closest source to a 20-minute job: past 10 seconds report percentage or time
remaining; **where no estimate exists, list completed vs remaining steps and name the
current one**; let it run in the background; and on completion show a salient, explicitly
dismissed success message carrying duration and results plus a link to the artefact,
*because the user was not watching*
([nngroup.com/articles/designing-for-waits-and-interruptions](https://www.nngroup.com/articles/designing-for-waits-and-interruptions/)).
Complex apps: waits over 10s are normal and generic loop animations fail there — state
elapsed time and remaining steps
([nngroup.com/articles/usability-heuristics-complex-applications](https://www.nngroup.com/articles/usability-heuristics-complex-applications/)).

**Design.** A **run tray**: a 44px strip pinned to the bottom of the content column
(above the copilot's mobile strip), present on *every* page while any run is in flight.

```
● Instagram Agent · writing the draft          4:12 elapsed · usually 10–20 min     [Cancel]
```

- The dot uses `--info` and `animate-pulse-ring`; the stage name comes from the job's own
  status (`queued` → *"waiting for a slot"*, `running` → *"writing the draft"*), which is
  the "completed vs remaining steps" substitute NN/g prescribes when no percentage exists.
- **Elapsed time counts up client-side** — a number that moves is the cheapest possible
  proof the system is alive, and it needs no server round-trip.
- Two or more runs collapse to *"2 agents are working · 4:12"* expanding to a list.
- **On completion the tray becomes a persistent, explicitly-dismissed success row**:
  *"Instagram post ready · 11 min · Open →"*, linking `?asset=` (N5). This is the piece
  that is entirely missing today.
- Move the polling to the narrow `statusUrl` path `AutoRefresh` already supports
  (`auto-refresh.tsx:36`) so the tray costs one small read per tick instead of a full
  segment re-render.

---

### N9 · Copilot: a contextual assistant and a command palette, not a permanent column — **L**

**Problem.** 48px of every desktop page is reserved for a chat that shows no sources, no
tool calls, and the same three static suggestions on every screen
(`chatbot-widget.tsx:983`). Its collapsed strip is `aria-hidden`. There is no command
palette, no search and no keyboard shortcut anywhere in the product.

**Pattern.** Nielsen on the paradigm: intent-based outcome specification is real, but pure
chat forces users to write their problem as prose, and he explicitly defends
clicking/tapping as essential — plus flags the transparency deficit
([nngroup.com/articles/ai-paradigm](https://www.nngroup.com/articles/ai-paradigm/)).
Generative UI in practice: free-text follow-ups are error-prone and taxing across turns;
**selectable options cut friction and improve accessibility wherever the answer set is
bounded**
([nngroup.com/articles/genui-buttons-and-checkboxes](https://www.nngroup.com/articles/genui-buttons-and-checkboxes/)).
Prompt suggestions belong **adjacent to the input**, one click should *insert* so the user
can edit, and for signed-in users they should be context-aware to that user's history
([nngroup.com/articles/designing-use-case-prompt-suggestions](https://www.nngroup.com/articles/designing-use-case-prompt-suggestions/)).
Microsoft's HAX guidelines pair G7 *efficient invocation* with G8 *efficient dismissal*
([microsoft.com/en-us/haxtoolkit/library](https://www.microsoft.com/en-us/haxtoolkit/library/)).
Vercel's command menu gives hard rules: bind ⌘K/Ctrl+K and never reuse it for an in-page
filter; split into sub-pages once a flat list would exceed ~30 items; write items as Title
Case **verb phrases so commands act rather than browse**
([vercel.com/geist/command-menu](https://vercel.com/geist/command-menu)).

**Design.** Split the one surface into three, each doing what it is good at.

1. **⌘K command palette** (new, `S/M`). Verb-phrase actions over the data the page already
   has: `Open Instagram Agent`, `Run a new X post`, `Go to this week`, `Find "launch"`,
   `Show my credits`, `Contact support`. This is the missing navigation layer — it makes
   the depth findings (F13) mostly moot without moving a single route, and it is the one
   feature that would make the portal feel fast.
2. **A contextual ask, at the point of need** (`M`). Replace the permanent 48px column
   with a 36px `Ask about this` control in the `PageHeader` of each screen, opening the
   same dock **pre-seeded with page context** and three suggestions written for *that*
   screen — on an agent page: *"Why did it write this?"*, *"Make the next one shorter"*,
   *"What does a run cost?"*; on the calendar: *"What's thin next week?"*. NN/g's rule that
   suggestions sit adjacent to the input and insert rather than send, so they stay
   editable.
3. **Option chips inside the transcript** (`M`). When a turn's answer is a bounded choice
   ("which competitor?", "which format?"), render chips instead of asking for prose —
   NN/g's GenUI finding, and it reuses `FeedbackChip`'s shape.

The dock stays; it stops being furniture. That recovers 48px on every desktop page and
removes an `aria-hidden` control from the layout.

---

### N10 · Showing the work: sources, scope, and what the agent read — **M**

**Problem.** For an AI product, the portal is remarkably silent about *why*. A draft
appears in the archive with a title and a stamp. The copilot claims *"I have full context
on {client}'s brand, competitors, strategy documents, and content history"*
(`chatbot-widget.tsx:1000`) and then never shows any of it. `AgentSetupSection` ("what the
launch run decided") is the closest thing and it is read-only facts, not provenance.

**Pattern.** Microsoft HAX: **G1/G2** make clear what the system can do *and* how well it
does it; **G11** make clear why the system did what it did; **G9** support efficient
correction; **G16** convey the consequences of user actions
([microsoft.com/en-us/haxtoolkit/library](https://www.microsoft.com/en-us/haxtoolkit/library/)).
NN/g on explainable chat: style citations **visually differently from the response body**,
place each source **next to the specific claim it supports**, deep-link to the relevant
section, label with the title rather than "Source" — and notably, **prefer citations plus
limitation disclaimers over step-by-step reasoning displays**, which are often post-hoc
rationalisations
([nngroup.com/articles/explainable-ai](https://www.nngroup.com/articles/explainable-ai/)).
Google PAIR: tie explanations to user actions, explain at high-stakes moments, and **do not
show confidence when it would not change the decision** — categorical (High/Med/Low) is
the safest form, raw percentages the riskiest; be clear about data scope, reach and
removal
([pair.withgoogle.com/chapter/explainability-trust](https://pair.withgoogle.com/chapter/explainability-trust/)).
IBM: the user must be able to ask why on an ongoing basis, clear and up front
([ibm.com/watson/assets/duo/pdf/everydayethics.pdf](https://www.ibm.com/watson/assets/duo/pdf/everydayethics.pdf)).

**Design.**

- **A "What this was written from" disclosure on every deliverable**, in
  `AssetDetailModal` under the body: the template/format, the brand-voice document
  version, the intake answers that steered it, and any competitor or news item the run
  read — each a link to that record. Not a reasoning trace: a **provenance list**, which is
  what NN/g says is defensible.
- **No confidence numbers.** PAIR's test — would it change the decision? — says no here:
  a client cannot act on "72% confident" about a caption. Where the run *did* hold
  something back (a banned topic hit, a missing link), say it categorically in the same
  disclosure.
- **Scope, once, in plain words**, on the copilot's empty state and in the agent page's
  aside: what the agents can read (your documents, your competitors, your published
  posts), what they cannot (your inbox, the live web), and how to remove something. This
  replaces the current unbacked "full context" claim.
- **Cost before action is already half-built** — `CreditPriceNote` quotes 11 surfaces
  worth. The remaining gap is the *consequence* half of HAX G16: the run tray (N8) is what
  tells them what the press actually did.

---

### N11 · Notifications and status as a system — **M**

**Problem.** No toast, no snackbar, no live-region convention; feedback is ad-hoc inline
text with hand-rolled timers; there is no channel for "something finished while you were
elsewhere".

**Pattern.** The taxonomy that settles inline-vs-global: **indicators** are passive,
inline, and persist while the condition holds; **validations** are inline to a field and
persist until corrected; **notifications** report system events and may be global or
contextual, dismissible or auto-fading — and using the wrong vehicle is itself the failure
([nngroup.com/articles/indicators-validations-notifications](https://www.nngroup.com/articles/indicators-validations-notifications/)).
A three-tier severity model — high (errors/confirmations needing action), medium
(warnings/success), low (informational, badges) — plus notification *modes* rather than a
wall of toggles, starting at low frequency
([smashingmagazine.com/2025/07/design-guidelines-better-notifications-ux](https://www.smashingmagazine.com/2025/07/design-guidelines-better-notifications-ux/)).
Confirmations should be reserved for actions that destroy work, cost money or cannot be
undone, must carry the specifics, and **undo is preferred wherever possible**
([nngroup.com/articles/confirmation-dialog](https://www.nngroup.com/articles/confirmation-dialog/)).

**Design.** Three vehicles, chosen by rule, not by whoever wrote the component:

| Vehicle | When | Shape |
|---|---|---|
| **Inline indicator** | a condition that persists (setup missing, channel expired, credits low) | the `--warning` band already in use; never auto-dismisses |
| **Toast** (new primitive) | a completed action the reader triggered | bottom-left above the run tray, `--surface` + hairline, 6s, `role="status"`, **always carries Undo when the action is reversible** |
| **Run tray** (N8) | asynchronous work the reader started and left | persistent until dismissed |

One `useToast()` and one `<ToastRegion aria-live="polite">` in the app shell. Migrate the
`HomeTaskUndoRow` pattern into it so undo stops being one list's private feature. Do not
build a preferences screen — Smashing's "modes not toggles" argument, and this product has
one notification channel.

---

### N12 · Empty, loading and error states as one system — **M**

**Problem.** `Skeleton` and `Spinner` both exist and are chosen by taste; there is no rule
tying either to a duration. `EmptyState` accepts an `action` and, since R9, several client
surfaces pass one — but the loading and error halves have no equivalent.

**Pattern.** Duration bands: **under 1s show nothing** — a flashing skeleton is worse than
none; **2–10s** spinner or skeleton; **over 10s** a progress bar. Skeletons are for
*full-page* loads; spinners for a single card or module; progress bars for processes
([nngroup.com/articles/skeleton-screens](https://www.nngroup.com/articles/skeleton-screens/),
[/progress-indicators](https://www.nngroup.com/articles/progress-indicators/)). Empty
states must do three things: say *why* it is empty (distinguishing "no results in this
range" from "still loading"), teach what belongs there, and provide a direct path to the
task that fills it
([nngroup.com/articles/empty-state-interface-design](https://www.nngroup.com/articles/empty-state-interface-design/)).
Errors: adjacent to the problem, high contrast, icon **plus** colour, severity matched to
treatment, input preserved, plain language, no blame words, no humour
([nngroup.com/articles/error-message-guidelines](https://www.nngroup.com/articles/error-message-guidelines/)).
Optimistic UI is honest only at a 1–3% error rate on simple binary actions completing
inside ~2s
([smashingmagazine.com/2016/11/true-lies-of-optimistic-user-interfaces](https://www.smashingmagazine.com/2016/11/true-lies-of-optimistic-user-interfaces/)).

**Design.** Write the rule into `ui.tsx` as a docstring and follow it:

- **Route transitions** (`loading.tsx`) → `Skeleton` in the shape of the page. Already
  right.
- **A card refetching in place** → `Spinner` in the card header, never a skeleton (it
  would flash).
- **Anything a person started that runs over 10s** → the run tray (N8), never a spinner.
- **Optimistic writes stay where they already are** — dismissals, stars, mark-posted: all
  binary, all sub-2s, all reversible. Do **not** extend optimism to runs or saves.
- **One `<Notice tone>` primitive** replacing the ~15 hand-rolled `border-warning/30
  bg-warning/10` blocks, taking `icon`, `title`, `body`, `action` — so error, warning and
  info stop being re-derived per file, and B2's error colour lands everywhere at once.
- **Every empty state answers "why"**: the archive's `Nothing here yet` becomes *"Nothing
  posted in the last 30 days"* when filters are clean and the window is the reason.

---

### N13 · A type ramp and a spacing scale, checked against the current CSS — **M**

**Problem.** 81% of type is ≤12px; there is no 16px body; the type ramp has eight sizes
with no defined roles; the spacing vocabulary is every 2px step from 2 to 32; `.eyebrow`
is defined once and hand-rolled 45 times with five tracking values; `StatCard` sets its
number in mono against `globals.css`'s own rule.

**Pattern.** Line length **45–90 characters, 66 ideal**, line-height **≥1.5** for long
text, and body copy **at least 16px**
([designsystem.digital.gov/components/typography](https://designsystem.digital.gov/components/typography/);
[practicaltypography.com/line-length.html](https://practicaltypography.com/line-length.html)).
Spacing on multiples of **8px with 4px half-steps**: 4, 8, 12, 16, 20, 24, 32, 40, 48…
([designsystem.digital.gov/design-tokens/spacing-units](https://designsystem.digital.gov/design-tokens/spacing-units/)).
Primer ships a real density scale — control heights 24/28/32/40/48px and three named stack
gaps, condensed 8 / normal 16 / spacious 24
([primer.style/foundations/primitives/size](https://primer.style/foundations/primitives/size)).
M3's type scale pairs every size with a line-height that is a multiple of 4 — body 16/24,
14/20, 12/16; label 14/20, 12/16, 11/16
([developer.android.com/develop/ui/compose/designsystems/material3](https://developer.android.com/develop/ui/compose/designsystems/material3)).
Apple's minimum body is 11pt on iOS with a 17pt default, and *"in general, avoid light font
weights"*
([Apple HIG, Typography](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/typography.json)).
NN/g: no more than three size variations, at most two large elements
([nngroup.com/articles/visual-hierarchy-ux-definition](https://www.nngroup.com/articles/visual-hierarchy-ux-definition/)).

**Design.** Seven roles, added to `globals.css` beside the existing type note:

| role | size / line-height | face | used for |
|---|---|---|---|
| `display` | 30 / 36 | Spectral 500 | page `h1` (already) |
| `title` | 20 / 28 | Spectral 500 | card titles (up from `text-lg` 18) |
| `body` | **16 / 24** | Hanken | **the new default for prose in cards, help text, chat, documents** |
| `body-sm` | 14 / 20 | Hanken | dense rows, table cells |
| `caption` | 12 / 16 | Hanken | stamps, secondary meta — **the floor for anything a person reads** |
| `label` | 11 / 16 | DM Mono, 0.08em, uppercase | the eyebrow, one tracking value, `--muted-2` |
| `stat` | 30 / 32 | Hanken tabular | the big figure (fixes `ui.tsx:246`) |

Migration is mechanical and does not need to be one commit: `text-[11px]` → `caption`
where it is read, `label` where it is a chip; every `text-xs` inside a `Card` body →
`body`. **Delete `text-[9px]`.** Cap prose blocks at `max-w-[68ch]` — at 16px in a ~530px
card column that is ~66 characters, USWDS's ideal.

Spacing: adopt USWDS's ladder as three named gaps (Primer's naming) —
`--gap-condensed: 8px`, `--gap: 16px`, `--gap-spacious: 24px` — and forbid `.5` steps in
new code. `Card` goes `p-5` (20px) → `p-6` (24px) so the 16px body has room.

---

### N14 · Colour semantics with one accent — **S**

**Problem.** The judgment scale exists and is used (`Badge` tones, `--success/--warning/
--danger/--info`) and the orange is correctly kept out of it. But `--danger` is **4.00:1**
on `--surface`; the danger badge's text on its own fill is **3.60:1**; in light mode
`--warning` is **3.46:1** on the ground and `--neon` is **2.51:1**, which makes `.eyebrow`
illegible in the light theme. Meanwhile several statuses are carried by colour plus a word
in a Badge — which is correct — but the calendar legend chips and the KPI meters lean on
hue alone.

**Pattern.** SC 1.4.1: colour must not be the *only* means; a hue difference plus a
lightness difference reaching 3:1 counts, **but that escape closes the moment users must
identify which colour means what**
([w3.org/WAI/WCAG22/Understanding/use-of-color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)).
SC 1.4.3: 4.5:1 normal, 3:1 large (≥18pt or 14pt bold), and **no rounding** — 4.499:1
fails
([w3.org/WAI/WCAG22/Understanding/contrast-minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)).
SC 1.4.11: 3:1 for the parts of a component that identify it **and its states**
([w3.org/WAI/WCAG22/Understanding/non-text-contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)).
The structural answer to a one-accent brand: M3 generates 13 tones per key colour and
pairs every role with an `on-` role, so legibility comes from tone separation within one
seed rather than from adding hues
([developer.android.com/develop/ui/compose/designsystems/material3](https://developer.android.com/develop/ui/compose/designsystems/material3));
Carbon confines semantics to four named `$support-*` tokens and interaction to
`$interactive-01`–`04`
([v10.carbondesignsystem.com/guidelines/color/usage](https://v10.carbondesignsystem.com/guidelines/color/usage/)).
GOV.UK's functional set is likewise fixed and tiny — error #ca3535, success #0f7a52
([design-system.service.gov.uk/styles/colour](https://design-system.service.gov.uk/styles/colour/)).

**Design.** Keep the four-token judgment scale exactly as it is — it is already Carbon's
shape. Four measured corrections and one rule:

| token | now | proposed | measured |
|---|---|---|---|
| `--danger` (dark) | #d65a52 | **#e58079** | 5.66 on `--surface`, 6.38 on ground, **4.86 on its own 10% badge fill** (was 3.60) |
| `--neon-ink` (light, **new**, text only) | — | **#b8430f** | 4.83 on paper, 5.46 on white |
| `--warning` (light) | #a8781e | **#8a5f13** | 4.98 on paper, 5.63 on white |
| `--success` (light) | #4f7d4e | **#47713f** | 5.02 on paper (was 4.24), 4.97 on its own fill |

`--neon` itself is **untouched** in both modes, so every fill, marker, `.hl` highlight and
accent button keeps the exact brand colour; `--neon-ink` exists only so orange *text* is
legible on paper. `.eyebrow`, `text-neon` links and the coin glyph read it under `.light`.

Then one rule, written into `globals.css`: **every status is carried by an icon *and* a
word, never by a fill alone.** That is already true of `Badge`; make it true of the
calendar's legend chips (add the glyph) and of the KPI meters (whose caption already names
the band, so the meter just needs to stop being the only signal).

---

### N15 · Accessibility: one focus token, real keyboard paths, honest reduced motion — **S/M**

**Problem.** Seven ring recipes; the dominant one is 2.16:1 dark / 1.70:1 light; form
fields have no ring at all; 100 of 126 interactive component files have no focus styling;
`prefers-reduced-motion` disables only the seven named keyframes and none of the ~200
`transition-*` utilities or the `hover:-translate-y-0.5` lifts (`ui.tsx:19,21`,
`roster-card.tsx:121`); the `Modal` has `role="dialog" aria-modal` but no `aria-labelledby`
(`modal.tsx:156-157`, and the `<h2>` at `:165` carries no id).

**Pattern.** SC 2.4.13 Focus Appearance (AAA) sets the bar precisely: an indicator at
least the area of a **2px perimeter** of the component and a **3:1 contrast change**
between focused and unfocused states
([w3.org/WAI/WCAG22/Understanding/focus-appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html)) —
note this is 2.4.13 in WCAG 2.2, while **2.4.11 is Focus Not Obscured**, which a bottom
tab bar plus a copilot strip can violate outright
([/focus-not-obscured-minimum](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)).
MDN's guidance on reduced motion is to author normally and **override with a muted
alternative** inside the query — its own example swaps a scale-pulse for an opacity
dissolve rather than deleting motion
([developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)).
Dialog: Escape closes, focus returns to the invoker, `aria-labelledby` required
([w3.org/WAI/ARIA/apg/patterns/dialog-modal](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)).
Tabs: the tablist is one tab stop, arrows move, automatic activation when panels are
preloaded
([/patterns/tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)) — `settings-tabs.tsx`
already does all of this correctly and is the model to copy.

**Design.**

- **One `--focus` token and one `.focus-ring` utility** (see B11). `outline` rather than
  `ring`, so it never participates in layout and cannot be clipped by `overflow-clip`
  (which the copilot dock deliberately uses).
- **Form fields get it too** — `Input`/`Textarea`/`Select` currently have
  `outline-none` and a 2.15:1 border change. This is the worst single failure in the
  product.
- **Reduced motion covers transitions**: add
  `@media (prefers-reduced-motion: reduce) { *,*::before,*::after { transition-duration: .01ms !important; animation-duration: .01ms !important } }`
  and, per MDN, keep the *state changes* (colour, border) so the affordance survives —
  what goes is the 200ms and the `-translate-y`.
- **`aria-labelledby`** on `Modal`, pointing at an id on the existing `<h2>`; the close
  button gets the focus ring and `p-1.5` so it clears 24×24.
- **Focus Not Obscured**: the mobile tab bar + copilot strip must not cover a focused
  field — add `scroll-padding-bottom: 96px` to `html` at `<md`.

---

### N16 · Mobile: four tabs, a proper sheet, and the bottom 90px back — **M**

**Problem.** Two destinations and a drawer; **AI agents is not a tab** — it is inside a
sheet labelled "Company" with eight other things (`client-rail.tsx:292-352`); 54px tab bar
+ ~36px copilot strip = ~90px of permanent chrome; no `env(safe-area-inset-*)` anywhere in
the repo and no `viewport` export; the sheet's only dismissal is an X in the top-right.

**Pattern.** Navigation bars carry **three to five destinations**, default height 80dp,
icon 24dp
([material-components-android BottomNavigation.md](https://raw.githubusercontent.com/material-components/material-components-android/master/docs/components/BottomNavigation.md)).
NN/g: past **5 options** you cannot keep optimum touch targets, and hidden navigation is
penalised — *"out of sight is out of mind"*
([nngroup.com/articles/mobile-navigation-patterns](https://www.nngroup.com/articles/mobile-navigation-patterns/)).
Apple gives no hard iPhone count but says tab bars are for **navigation, not actions**
([Apple HIG, Tab bars](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/tab-bars.json)).
Sheets: two detents (medium ≈50%, large), **always show a grabber on a resizable sheet** —
it is VoiceOver-operable — support swipe-to-dismiss with an unsaved-changes confirmation,
one sheet at a time
([Apple HIG, Sheets](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/sheets.json));
Material's drag handle has a **48dp minimum** precisely because it is a touch target and
an accessibility affordance, not decoration
([material-components-android BottomSheet.md](https://raw.githubusercontent.com/material-components/material-components-android/master/docs/components/BottomSheet.md)).
Grip research: of 1,333 observations, **49% one-handed, 36% cradled, 15% two-handed**; 67%
of one-handed use is the right thumb — but Hoober explicitly warns against naive
thumb-zone inference because people switch grips constantly
([uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php](https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php)).

**Design.**

- **Four tabs: Home · Agents · Calendar · Company.** Agents is the product; it belongs in
  the bar. That is within Material's 3–5 and NN/g's ceiling, and it removes the worst
  mobile IA defect in the portal. `MobileTabBar` already maps `items` — this is one entry
  plus a route.
- **Bar height 56px + `env(safe-area-inset-bottom)`**, and a `viewport` export with
  `viewportFit: "cover"` in `app/layout.tsx`. Today the constant is a bare 54.
- **The Company sheet becomes a real sheet**: a 48px-wide grabber at the top (Material's
  minimum), swipe-to-dismiss, and a `Done` in the *top-left* alongside the X — Hoober's
  finding is not "put everything bottom-right", it is "do not assume one grip", so give
  two exits.
- **Retire the copilot's mobile strip** in favour of an `Ask` button in the page header
  (N9), returning ~36px and removing the second layer of fixed bottom chrome that can
  obscure a focused field (SC 2.4.11).

---

### N17 · Onboarding beyond the checklist: contextual, at the moment of need — **M**

**Problem.** The setup ladder is good and it ends. After it, the client is handed a portal
with a docked AI, a calendar with seven statuses, credits, an archive and six intake forms,
and no help of any kind — no tips, no "what is this", no first-run anything. And the
copilot's own empty state makes a capability claim it never evidences.

**Pattern.** Push revelation (a tutorial that fires regardless of need) vs pull revelation
(help triggered by an actual activity signal): tutorials fail because users want to start
immediately, out-of-context help is hard to recall at the moment of need, and dismissal
costs effort. Five rules: dismissible **and** retrievable later, progressive disclosure,
help alongside each step, don't explain conventional UI, and research where help is
genuinely needed
([nngroup.com/articles/onboarding-tutorials](https://www.nngroup.com/articles/onboarding-tutorials/)).
New AI users specifically lack a mental model of what the tool is for and ask the bot
about its own capabilities when the UI does not say; prefer brief contextual help and
**broad general examples over niche prompts** (n=6, directional)
([nngroup.com/articles/new-AI-users-onboarding](https://www.nngroup.com/articles/new-AI-users-onboarding/)).
The only tour-completion figures traceable to a first-party source: 2–4 step guides
complete near 50%, up to 8 steps average 45%, beyond 9 completion dwindles
([pendo.io/pendo-blog/measuring-the-effectiveness-of-walkthrough-guides-in-pendo](https://www.pendo.io/pendo-blog/measuring-the-effectiveness-of-walkthrough-guides-in-pendo/)).
*(The widely circulated "63% abandon at five steps" / "847 B2B SaaS applications" figures
could not be traced to any primary source and are not used here.)*

**Design.** **No product tour.** Instead:

- **Four contextual first-visit tips**, each fired by arriving on a screen for the first
  time, each one sentence in a `--info` band with a `Got it`, each writing one
  `ClientActionState` row so it never returns: the calendar (*"Chips are your posts. Open
  one to read it, or mark it posted."*), the archive (*"Everything we've delivered, for 30
  days after you mark it posted."*), the first agent detail page (*"Inputs steer it,
  feedback corrects it, and a run costs about 25 credits."*), credits (*"Runs spend
  credits. Your Karos team adds them."*).
- **A permanent `?` next to each page title** re-opening that screen's tip — NN/g's
  "dismissible *and* retrievable" rule, and the reason a tour cannot substitute.
- **Rewrite the copilot's empty state** to the scope statement from N10 and give it three
  **broad** examples rather than the current specific three.
- **The ladder's waiting row gets a date**: *"Karos is setting this up · expected by
  Friday"*, because "we're doing it" with no horizon is the state clients ask about.

---

### N18 · Motion within Ember restraint — **S**

**Problem.** Seven keyframes at seven ad-hoc durations (150ms, 200ms, 280ms, 350ms, 500ms,
1.6s, 1.8s, 2.2s) with no tokens; two easing curves written inline; `hover:-translate-y-0.5`
on `Button` (`ui.tsx:19,21`) and on the roster card, so every hover in the product lifts;
and reduced motion covers none of it.

**Pattern.** Displaced objects should animate over roughly **100ms**
([nngroup.com/articles/drag-drop](https://www.nngroup.com/articles/drag-drop/)). Under
~100ms reads as simultaneous, 100ms–1s needs a visual cue bridging the gap, 1–10s needs an
indeterminate indicator, over a minute should let the user leave and be notified
([mattstromawn.com/writing/ui-density](https://mattstromawn.com/writing/ui-density/)).
Apple's Reduce Motion guidance: tighten springs, **replace x/y/z transitions with fades**,
avoid animating depth and blur
([Apple HIG, Accessibility](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json)).
M3's shape and motion scales are multiples of 4
([developer.android.com/develop/ui/compose/designsystems/material3](https://developer.android.com/develop/ui/compose/designsystems/material3)).

**Design.** Four tokens in `globals.css`, and nothing outside them:

```
--motion-instant: 100ms;  /* hover, focus, colour   */
--motion-quick:   180ms;  /* disclosure, chip enter */
--motion-move:    280ms;  /* sheet, dock, drawer    */
--ease: cubic-bezier(0.22, 1, 0.36, 1);   /* already used by slide-in-right */
```

Then: **drop the lift.** `hover:-translate-y-0.5` on a button is a 2px vertical move on
every hover in a product whose brand note says the accent is for "markers, eyebrows,
hovers, live signals" — the hover is supposed to be a *colour* event here, and `row-lift`
already does it correctly. Keep exactly three motion moments: the accent hairline on
`row-lift`, the `pulse-ring` live mark, and the sheet/dock slide. Everything else is a
180ms colour change. That is Ember's restraint applied to time rather than hue, and it
makes the reduced-motion override in N15 nearly free.


---

## 4. Critical thinking: what we might be wrong about

Eight decisions the portal has already made that are worth re-opening. For each: the
strongest case *for* keeping it, the strongest case *against*, and a recommendation. I am
not neutral on any of them.

---

### C1 · The copilot as a permanent right rail

**For.** It is the product's differentiator and it is one press away from every screen.
It remembers state, it is `inert` when collapsed so it is not a keyboard trap, and its
default is closed — a first-time viewer gets a 48px strip, not a 380px panel. Removing it
would make an AI product hide its AI.

**Against.** It costs **48px of every desktop page, permanently**, for a feature that
cannot show a single source, cannot open anything except one feedback chip, and offers the
same three static suggestions on Home, on the calendar and on an agent page
(`chatbot-widget.tsx:983`). The collapsed strip is `aria-hidden` with `tabIndex={-1}`
(`copilot-dock.tsx:321-322`) — the keyboard path is a 28px circle. Nielsen's argument against
pure chat is exactly this shape: it forces a client to write their problem as prose when
the application already knows what they are looking at
([nngroup.com/articles/ai-paradigm](https://www.nngroup.com/articles/ai-paradigm/)).
Microsoft's HAX pairs efficient invocation with efficient dismissal
([microsoft.com/en-us/haxtoolkit/library](https://www.microsoft.com/en-us/haxtoolkit/library/));
a rail you cannot make go away is only half of that.

**Recommendation.** Keep the copilot; **retire the permanent column.** Replace it with an
`Ask about this` control in each page header that opens the same dock pre-seeded with page
context (N9), and add ⌘K for the navigation half of what people currently type at it. That
is a strictly better AI surface *and* recovers 48px on every page. The risk — that
discoverability drops — is answered by the fact that the strip is currently
`aria-hidden` and closed by default, so its discoverability is already low.

---

### C2 · Reporting and Competitors inside Account Center

**For.** They are not daily-use surfaces. The consolidation was deliberate and it worked:
one home instead of two renders, and the Account Center description now names what the
tabs hold. The rail has three rows on purpose — the portal's whole IA thesis is that a
client has three places to be.

**Against.** The SEO/GEO report is the artefact that justifies the retainer. It is the one
screen a client screenshots for their boss. Filing it under a hub named *Account Center*,
reached from an avatar row at the bottom of the rail, is filing the deliverable in the
filing cabinet. The evidence that it is hard to
name is in the code: Home builds one `reportHref` (`clients/[id]/page.tsx:316`) and hands
it to **two** different controls with two different labels — "See the breakdown"
(`home-standing.tsx:143-148`) and the Visibility KPI cell (`:643`) — neither of which contains
the word the destination is actually filed under. That is the F9 duplicate-route problem
in miniature, and its cause is that the place has no name a client would use. And NN/g's tabs rule is that a tab strip needs *parallel* content;
Profile, Competitors, Reporting, Settings and Credits are five different subjects
([nngroup.com/articles/tabs-used-right](https://www.nngroup.com/articles/tabs-used-right/)).

**Recommendation.** Promote it. A fourth rail row, **Visibility**, holding the report and
Competitors (N7), with the Account Center tab redirecting so no link breaks. A rail of
four is still a rail of four. The counter-argument I take seriously — "the rail must stay
short" — is real, and the answer is that *Credits* is the row that should not be a
first-class pill, not Reporting.

---

### C3 · The credits model's visibility

**For.** The rail's credits pill is honest and cheap, and `credits-panel.tsx` is one of
the better screens in the product: spendable vs balance, two meters, a full price list, a
ledger, and the settle-to-actual copy already written. Prices are quoted on eleven
surfaces. This is more transparent than most usage-billed products.

**Against.** Two things. First, the pill is **the second-most prominent number in the
rail**, sitting above the account menu on every page — a client is reminded of their meter
more often than of their calendar. Usage-based products that do this train anxiety, not
literacy; the one credible primary source on late-surfacing costs is Baymard's 39%
abandonment on unexpected charges, which argues for cost *at the point of commitment*, not
cost *always on screen*
([baymard.com/learn/reduce-cart-abandonment](https://baymard.com/learn/reduce-cart-abandonment)).
Second, and worse: **when the number reaches zero there is nothing to press.** "Request
more credits" renders only once spending is already blocked (`credits-panel.tsx:281`).
Nielsen's confirmation guidance is that money-spending actions warrant specifics
([nngroup.com/articles/confirmation-dialog](https://www.nngroup.com/articles/confirmation-dialog/));
the specifics are all there — the exit is not.

**Recommendation.** Keep the pill but **demote it below the account row** and make it
render only under 25% of the monthly allowance, or on the Credits page itself. Ship the
always-visible "how credits are added" line (B3) regardless of what happens to the pill —
that one is not a design preference, it is a dead end that costs the client money. And
answer credits-design §5 Q5 the client-friendly way: never charge above the quote, and
show a settlement that came in *under* as a small win (*"18 credits · we quoted 25"*).

---

### C4 · The rail's brand card in the top slot

**For.** It was asked for by name, twice, and defended in a long comment
(`client-rail.tsx:141-160`): a client should see their own brand first in their own
sidebar, and the colour swatches are the one thing in the rail people copy a value *out
of*, several times a day.

**Against.** It occupies roughly the top 40% of a 288px rail — logo, name, contact glyph,
edit pencil, "add team size" chip, up to six social squares, four swatches, a third
pencil — above a navigation of three rows. NN/g's vertical-nav guidance is
keyword-frontloaded text labels with less-important items at the bottom
([nngroup.com/articles/vertical-nav](https://www.nngroup.com/articles/vertical-nav/)). And
the block is where F16 lives: two identical pencils and a contact glyph within 60px, three
destinations, no visible text.

**Recommendation.** **Keep the brand card; fix what is in it.** The complaint is not
"identity in the rail", it is "three icon-only editors and eleven controls in the identity
block". Collapse it to: mark + name + one **Edit** text control (B6), the four swatches,
and nothing else. Socials and the team-size chip move to the Profile tab, which is where
they are edited anyway. That halves the block's height without touching the decision that
put it there — and the swatches, which is the argument's actual load-bearing part, stay.

---

### C5 · The calendar owning the archive

**For.** R6 did this properly. Archive is its own labelled control, it remembers which
time view you came from, it has a "back to calendar" link, and it lives at a real URL with
real filters. Consolidating it out of Account Center removed a whole tab. And the two
genuinely share a dataset.

**Against.** They share a dataset and nothing else. One is a time grid you scan for the
week ahead; the other is a searchable library of everything ever delivered, grouped by
agent, that a client opens to find *a specific thing*. Bolting the library onto the
calendar means the library inherits the calendar's chrome (a "Agent Calendar · 3 upcoming"
header it has nothing to do with) and cannot grow its own — there is nowhere to put a
result count, a sort control, a bulk-action bar or a saved view without those appearing to
belong to the calendar. Eight of the flow audit's F9 duplicate routes point at
`?view=archive`; that is a destination behaving like a page and being addressed like one.

**Recommendation.** **Leave it for now, and plan the split.** The URL is already
`/calendar?view=archive`, so promoting it later to `/library` is a redirect, not a
migration. Trigger to split: the moment bulk actions land (N6). A contextual action bar
inside a calendar component is where this arrangement stops being tidy.

---

### C6 · Recommended tasks as a checklist only

**For.** Ruthlessly correct, and the reasoning in `home-get-set-up.tsx:16-58` is the best
product writing in the repo. The old widget rendered LLM-authored *content ideas* as if
they were setup steps, several of the 24 rows could only be completed by staff, and "See
all 24" opened onto a wall of greyed rows. Six auto-completing steps with a bar, one
press, no X, is right — and it matches the evidence the setup-ladder audit gathered.

**Against.** The ladder answers *"how do I start?"*. Nothing on Home answers *"what should
I do this week?"* once it is finished — at which point the card can be hidden and Home
loses its only list. The swarm's content ideas did not die (they render on the calendar as
suggestion chips) but they are now three clicks from Home and invisible in Week view's
grid. And the 18 later-value rows — connect a channel, mark a post posted, give feedback,
export a day — are the *habits* that make the product sticky, and they currently render
nowhere at all.

**Recommendation.** Ship **B12** ("More ways to get value") as the collapsed secondary
list, exactly as the setup-ladder audit specified. It is the missing half of a design that
is otherwise finished, it reuses `HomeTaskRow` and `useUndoableDismiss` unchanged, and it
means the client who completes setup is handed a next thing instead of an empty slot. Do
**not** bring the content ideas back to Home — the calendar is the right home for a dated
suggestion.

---

### C7 · Staff parity as a design constraint

**For.** The parity pass is genuinely good engineering and good product: staff see the
client's page, element for element, in the client's order, with operator extras in one
labelled `StaffOnlySection` beneath. That is how you stop the two views drifting, and it
is why a staff member previewing an account can tell what the client will actually get.

**Against.** Parity is a *rendering* rule that has quietly become a *design* rule. Three
symptoms: the calendar's "Schedule a run" is de-accented and badged `Internal` on the
client's own calendar rather than being absent (`run-calendar.tsx:2180-2196`) — a control
the client can see and must never press, which the codebase elsewhere argues against
("*a control you can see and must not press is worse than one that is not there*",
`home-get-set-up.tsx:70`). The agent detail page carries ten sections partly because both
audiences' needs are stacked on one route. And the client Home's information architecture
is now *also* the staff dashboard's, which means any client-first move has to be argued
past a second audience.

**Recommendation.** Keep parity for **content and order**; drop it for **presence**. A
staff-only control should not render on a client's page at all — the `StaffOnlySection`
frame exists precisely so operator surface can be grouped rather than sprinkled. Move
"Schedule a run" into a staff block above the grid. And write the boundary down: *parity
means a client and a staff viewer see the same things in the same order; it does not mean
a client sees things they cannot use.*

---

### C8 · "No client surface lists a draft"

**For.** A deliberate, documented rule (`client-home-overview.tsx:299-341`,
`contentStatusHref` returning null for clients). Karos reviews before the client sees
anything; showing drafts would publish the generation batch and undercut the promise that
what reaches a client has been checked. It is also why the archive's status filter excludes
Draft.

**Against.** It creates two visible artefacts. The attention rows *"N tasks ready for
review"* and *"N deliverables in review"* exist and are deliberately inert for a client
(the flow audit's F8) — the portal tells a client that work exists and then declines to
show it, which reads as a bug rather than as a policy. And `"Review deliverable →"` in the
calendar requires a status a client is never given (`calendar-past-runs.ts:72`), so it is
unreachable dead code on a client's screen.

**Recommendation.** Keep the rule; **stop half-saying it.** Either remove those rows from
the client branch entirely, or make them say the policy out loud: *"2 posts are with your
Karos team. They land on your calendar once approved."* — a sentence, not a link-shaped
row with no destination. That is R10's ruling for the bell applied to Home, and it is the
difference between a policy and a dead end.

---

## 5. A proposed sequence

Three coherent sets. Each wave is independently shippable and leaves the product in a
consistent state; nothing in a later wave is a prerequisite for an earlier one.

---

### Wave 1 — this week · "stop the bleeding, and make it legible"

Small, mostly token-level, disproportionate effect. Nothing here needs a product decision.

| Item | Files |
|---|---|
| **B11** one `--focus` token + `.focus-ring`, applied to Button/Input/Textarea/Select; delete the seven ad-hoc recipes | `src/app/globals.css`, `src/components/ui.tsx` (+ sweep the 21 `ring-foreground/25` sites) |
| **B10** `--danger` → #e58079; `--neon-ink` #b8430f for light-mode orange text; `--warning` light → #8a5f13; `--success` light → #47713f; `.eyebrow` reads `--neon-ink` under `.light` | `src/app/globals.css` |
| **B2** one `FieldError` primitive; delete the four `text-red-400` copies | `ui.tsx`, `blog-agent-intake.tsx:60`, `newsletter-agent-intake.tsx:77`, `reputation-agent-intake.tsx:60`, `meeting-action-items.tsx:337` |
| **B1** kill the `alert()`; inline notice + the Markdown export beside it | `client-documents.tsx:301-304` |
| **B3** always-visible "how credits are added · Ask for more →" | `credits-panel.tsx:281-311` |
| **N5a** the calendar's `Today` button; the whole day cell as the target; `+N more` as a real button | `run-calendar.tsx:2196-2216, 2300-2360` |
| **N5b** `?asset=` in `CALENDAR_QUERY_KEYS`, seeded server-side, `pushState` | `run-calendar.tsx:1750-1762`, `calendar/page.tsx`, `archive-view.tsx:451` |
| **N15a** reduced-motion covers transitions; `aria-labelledby` on `Modal`; padding on its close button | `globals.css:417-428`, `modal.tsx:156-166` |
| **N18a** the four motion tokens; drop `hover:-translate-y-0.5` from `Button` and `roster-card` | `globals.css`, `ui.tsx:19,21`, `roster-card.tsx:121` |
| **`ui.tsx:246`** `StatCard` number → `.stat-number` (sans), per `globals.css:25-31` | `ui.tsx` |

**Why this set.** Every item is a defect against a rule the codebase already states, or a
measured accessibility failure. `?asset=` is the one feature in the list and it is a key
in an existing map. Ship as one PR; it touches no layout.

---

### Wave 2 — this month · "make it read like a designed product"

The typography pass plus the four IA moves that stop the portal feeling like a settings
app with agents attached.

| Item | Files |
|---|---|
| **N13** the seven type roles + 16px body + `--gap` scale; `Card` `p-5`→`p-6`; `max-w-[68ch]` on prose; delete `text-[9px]`; one tracking value for labels | `globals.css`, `ui.tsx`, then a mechanical sweep of `home-*.tsx`, `client-home-overview.tsx`, `archive-view.tsx`, `credits-panel.tsx`, the six intakes |
| **N1** Home's answer line + three-tier hierarchy; fold "Your numbers" into the visibility card; two orange chips instead of five | `clients/[id]/page.tsx:955-1010`, `home-kpis.tsx`, `home-standing.tsx`, `client-home-overview.tsx:455` |
| **N2** the roster becomes catalogue rows with last output / next run / cost | `client-agents/roster.tsx`, `roster-card.tsx`, `agents/page.tsx:296-320` (the data is already resolved) |
| **N7 / C2** promote **Visibility** to a rail row; Account Center's Reporting tab redirects | `client-rail.tsx:74-76`, new `clients/[id]/reporting/page.tsx`, `settings/page.tsx:116-132, 929` |
| **N8** the run tray (elapsed time, stage, cancel, persistent completion row) + move polling to `statusUrl` | new `run-tray.tsx`, `(app)/layout.tsx`, `agent-detail-panel.tsx:148-170`, `auto-refresh.tsx` |
| **N11** one `useToast()` + `ToastRegion`; migrate `HomeTaskUndoRow` into it | new `toast.tsx`, `(app)/layout.tsx`, `home-task-row.tsx:181-215` |
| **N16** four mobile tabs (Home · Agents · Calendar · Company); 56px + safe-area; `viewport` export; sheet grabber + swipe-dismiss | `mobile-shell.tsx`, `client-rail.tsx:262-352`, `constants.ts:91`, `app/layout.tsx` |
| **B6 / B8 / C4** one **Edit** control on the brand card opening one sectioned dialog; socials + team-size chip move to Profile; seats roster leaves the modal | `client-profile-panel.tsx:579-590`, `client-context-sections.tsx:655`, `integrations-tab.tsx:690` |
| **B5** rail active-state for intakes/`/transcripts`/`/team` + a shared `<BackLink>` | `rail-nav-link.tsx`, `client-rail.tsx`, the six intake pages, `transcripts/`, `team/` |
| **B12** "More ways to get value" under a completed ladder | `home-get-set-up.tsx`, `clients/[id]/page.tsx`, reusing `action-list.ts` unchanged |
| **B4** brand-voice field on the Profile tab | `settings/page.tsx` profileSection, existing server action |

**Why this set.** N13 is the spine — it is what makes everything else look intentional,
and it is mechanical rather than clever. N1/N2/N7 are the three moves that change what the
portal *is about* (an answer, a catalogue, a visible report) without adding a feature.
N8 and N11 close the two structural gaps: nothing tells a client that work finished, and
nothing tells them an action succeeded.

---

### Wave 3 — this quarter · "the parts that need a product decision"

| Item | Files | Decision needed first |
|---|---|---|
| **N9** ⌘K command palette; retire the copilot's permanent column for an in-header `Ask about this`; context-seeded suggestions; option chips in the transcript | new `command-palette.tsx`, `copilot-dock.tsx`, `chatbot-widget.tsx:215-300, 983`, every `PageHeader` call site | C1 — does the dock stop being furniture? |
| **N10** provenance on every deliverable; the scope statement; no confidence numbers | `asset-detail-modal.tsx`, `agent-sections.tsx`, `chatbot-widget.tsx:1000` | how much of the run's inputs may a client see? |
| **N3** agent detail as a workspace: sticky spine, work-first order, inputs edited in place | `agents/[agentId]/page.tsx:1102-1440`, `agent-sections.tsx`, the six intake components (reused, not forked) | — |
| **N4** intake forms: two `<fieldset>` sections, blur validation, `beforeunload`, "check your answers" band, GOV.UK optional convention | the six `*-agent-intake.tsx`, `saved-form-card.tsx`, `ui.tsx` `Label` | required/optional convention (§N4) |
| **N6** archive: result line, filter chips, real sort, bulk select + contextual action bar (Download · Mark as posted · Undo), richer tiles | `archive-view.tsx`, `mark-posted.ts`, `/api/clients/[id]/downloads` | — |
| **C5** split the library out of the calendar to `/library` | `run-calendar.tsx`, new route, redirect from `?view=archive` | trigger: when N6's bulk bar lands |
| **N17** four contextual first-visit tips + a retrievable `?` per page; rewrite the copilot empty state; a date on the ladder's waiting row | new `first-visit-tip.tsx`, `action-list-actions.ts` (existing `ClientActionState`), `setup-ladder.ts` | — |
| **N12** the loading/error/empty rule written into `ui.tsx`; one `<Notice tone>` replacing ~15 hand-rolled bands | `ui.tsx`, sweep | — |
| **C7 / B13** move "Schedule a run" into a staff block; decide whether clients may schedule | `run-calendar.tsx:2180-2196` | product |
| **B15** an Instagram/karos-content client intake | new intake family | product |
| **B17** `docs/brand/KAROS-BRAND-GUIDELINES.md` as an index to `globals.css` + `ui.tsx` | new doc | — |

**Explicitly not scheduled.** **B14** (LLM re-ordering of six ladder rows) — unobservable
to the client and a new failure mode on the first screen they see. **Drag-and-drop
rescheduling** — SC 2.5.7 requires a single-pointer path anyway, so build the menu and
stop. **A notification preferences screen** — one channel does not need a settings page.

---

## Appendix — method, and what could not be verified

**How the numbers in §1 were produced.** All of them are counts or computations over the
worktree at `claude/credits-prep-enable`, reproducible from the paths given:

- **Type ramp** — `grep -ohE "text-(\[[0-9]+px\]|xs|sm|base|lg|xl|2xl|3xl)"` over
  `home-*.tsx`, `client-home-overview.tsx`, `client-rail*.tsx`, `archive-view.tsx`,
  `run-calendar.tsx`, `credits-panel.tsx`, `blog-agent-intake.tsx`,
  `client-agents/*.tsx`, `seo-geo-panel.tsx` (427 declarations).
- **Focus** — files containing `onClick` (126) vs `focus-visible` (26) vs `outline-none`
  (37) across `src/components`.
- **Contrast** — WCAG 2.x relative luminance over the literal token values in
  `globals.css`, with alpha composited against the stated background before the ratio is
  taken. Both themes computed against `--surface` and `--background` separately, because
  a card and the page ground are different backdrops and several tokens pass on one and
  fail on the other.
- **Spacing / tracking / eyebrow counts** — `grep` over the same set.
- **The proposed replacement values in N14 and B10/B11 were computed the same way**, not
  eyeballed: each candidate was tested against `--surface`, `--background` *and* its own
  10%-alpha badge fill before being chosen, which is why `--danger` lands on #e58079
  rather than the first value that clears 4.5 on a card.

**Sources.** Around 90 citations across 20 domains, every one of them fetched and read
during this pass (NN/g ×44, W3C/WAI ×10, Baymard ×6, Apple HIG ×5, Android/Material ×5,
GOV.UK ×4, Microsoft HAX ×3, plus Smashing, Primer, USWDS, Vercel Geist, Carbon v10,
Google PAIR, IBM, MDN, Pendo, UXmatters, Butterick and Matthew Ström). Where the flow
audit had already fetched a page (NN/g on vertical navigation, the 3-click rule,
duplicate links, cards, confirmation dialogs, empty states, progressive disclosure), it is
re-used rather than re-fetched and is marked as such.

**Not fetchable, and therefore not cited anywhere above.** Worth knowing, because these
are the sources a reader would expect and their absence is deliberate rather than an
oversight:

- **Material 3** (`m3.material.io`) — every page returns a JS shell with no body. The M3
  citations here come from Google's own Android developer documentation, which publishes
  the same type scale, colour roles and window-size classes as retrievable prose.
- **Apple HIG** (`developer.apple.com/design/...`) — same problem. Workaround used: the
  documentation JSON endpoint
  (`developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json`)
  returns the real text; all four Apple citations came through it.
- **IBM Carbon v11** — every fetched page truncated before the body. The one Carbon
  citation is from the **v10** documentation, which is explicitly labelled as such.
- **Shopify Polaris** — 301s to a docs index; no first-party Polaris AI-guidance page was
  found, and none of the third-party "Polaris AI guidelines" write-ups are cited.
- **Product-tour completion statistics.** The figures that circulate widely — "63%
  abandon at five steps", "research across 847 B2B SaaS applications", "3-step tours
  complete at 72%" — could not be traced to any primary publication and are **not used**.
  The only first-party number in N17 is Pendo's own 2018 post (2–4 steps ≈ 50%, up to 8
  steps ≈ 45%), which is older and much less dramatic.
- **Usage-based-billing UX.** There is no credible primary research on credit meters. C3
  and N10's cost arguments rest on Nielsen's confirmation-dialog guidance and Baymard's
  39% figure for late-surfacing costs; the AI-credits patterns circulating on vendor blogs
  are treated as illustrative practice, not evidence, and are not cited.

**One live standards conflict, flagged rather than resolved.** GOV.UK forbids asterisks
and marks "(optional)"; NN/g endorses marking every required field with a red asterisk.
N4 picks GOV.UK's convention *for these forms specifically* — because most fields on them
are optional — and says so, rather than pretending there is one right answer.

**Two corrections to terminology used in the brief.** In WCAG 2.2, **2.4.11 is Focus Not
Obscured (Minimum)**, at Level AA; the criterion about the *appearance* of the focus
indicator is **2.4.13 Focus Appearance**, at Level AAA. Both are relevant here and they
are cited separately in N15. And the target-size minimum is **2.5.8** at 24×24 CSS px
(AA); 44×44pt is Apple's platform default, not a WCAG figure.
