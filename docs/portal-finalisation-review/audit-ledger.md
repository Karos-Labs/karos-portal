# Portal-finalisation audit ledger (CD-L)

Audit of every commit in `git log --reverse 0ee7420..eecf611` (Daniel's 49-commit
round). Merge base `0ee7420` (Tomer, 2026-07-28, `ci: add prep/production deploy
environments`) is "the original version". Commits `5cc0cc6` and `0670f75` are
ours and out of scope.

Classification standard: `albert-directives.md` (AF-0 keep-rule, AF-1..AF-18).
Every claim below was verified by reading the diff or the file at both revisions,
not by trusting the commit message. Where a commit message overclaims, the ledger
says so.

## Headline

| | |
|---|---|
| Commits audited | 49 |
| Commits that quote Albert's actual feedback in their own record | **1** (`6547959`) |
| Commits justified by Daniel's own numbered QA items (`#NN` / `FNN`) | 17 |
| Files touched | 333 (117 test, 123 lib/api, 85 rendering, 8 other) |
| Lines | +54,580 / -3,684 |
| of which tests | **+37,633 across 95 new test files (69% of the branch)** |
| CSS / theme files touched | **0** |

The 69% test share matters for scale: the actual product-code change is around
17,000 added lines, most of it in `src/lib/` and `src/app/api/`. The visible
surface at risk is much smaller than "49 commits, 333 files" suggests. Under AF-0
the tests are keeps regardless of source, listed for awareness.

Three findings dominate and are developed in the deep dives:

1. **The orange re-theme is not on this branch.** It is `7d53506`, authored by
   **Albert Kattan on 2026-07-02**, already present in the merge base. The branch
   does not touch a single CSS file. AF-3's conditional ("if the orange re-theme
   was introduced on this branch without an AF source") is false.
2. **The branch systematically ADDS em dashes to client copy and built a
   2,696-line test that enforces them.** This is the exact inverse of AF-8. About
   297 added lines put an em dash inside a client-facing string literal.
3. **`6fad72d` put Meetings in the client rail**, and the Meetings tab it claims
   did not exist **already existed in client Settings at `0ee7420`**, which is
   precisely where AF-1 says it belongs.

## Class counts

| Class | Commits (whole or in part) |
|---|---|
| SOURCED-ALBERT | 6 |
| INVISIBLE-CORRECTNESS (whole commit) | 18 |
| Mixed (invisible core + visible rider) | 19 |
| STRIP-CANDIDATE (whole commit) | 6 |
| CONFLICTS-AF-n | 4 commits raise 6 conflicts (AF-1, AF-3, AF-5, AF-14, AF-8 x2) |

## Per-commit ledger

`VIS` = files under `src/components/` or `src/app/(app)/` that render.
Classification order follows the weight of the commit.

| # | sha | one-line (what the code actually does) | class | AF |
|---|---|---|---|---|
| 1 | `9f55d49` | Moves the "Account settings" entry from a PageHeader corner link into the settings tab row (still a link to the pre-existing separate `/settings` route); adds mobile sign-out and `?tab=` deep links | PARTIAL-AF-2 + STRIP (mobile sign-out, deep links) | AF-2 (partial) |
| 2 | `e671c75` | Takes the account link out of `role="tablist"` so the tablist owns only real tabs; visually unchanged | INVISIBLE-CORRECTNESS (a11y) | - |
| 3 | `90c280e` | Renders the credit-refusal text in the task modal instead of a silently dead Generate button; hides failed runs from the client Workspace timeline | **SOURCED-ALBERT** + INVISIBLE-CORRECTNESS | AF-10, AF-14 |
| 4 | `b33a594` | Catches the rethrow so the refusal still shows; sentence-cases a guard string | SOURCED-ALBERT | AF-10 |
| 5 | `7332339` | Re-signs expiring clip URLs on read via a new `/api/assets/[id]/media` route; adds a download control on video assets | INVISIBLE-CORRECTNESS + SOURCED-ALBERT | AF-15 |
| 6 | `3a2f901` | Redirects clip downloads to the signed route, narrows the photo guard | INVISIBLE-CORRECTNESS | - |
| 7 | `1701b51` | 404s an out-of-range clip index; tests the Content-Disposition sanitizer | INVISIBLE-CORRECTNESS | - |
| 8 | `cf330e6` | Moves the disposition sanitizer into `src/lib/media-type.ts`; pure refactor | INVISIBLE-CORRECTNESS | - |
| 9 | `4d2874c` | Deduplicates calendar cells so one post renders once; closes the webhook replay that created the duplicates | INVISIBLE-CORRECTNESS (+ visible: duplicate cells stop appearing) | - |
| 10 | `ccdfb4a` | Narrows that dedupe to true replays so distinct same-day posts are not merged | INVISIBLE-CORRECTNESS | - |
| 11 | `9a340a4` | Stops the notification bell deep-linking to `/jobs/[id]` while in View as Client, where the surrounding nav has no Jobs tab; closes the mobile same-route sheet trap | **SOURCED-ALBERT** | AF-3, AF-9 |
| 12 | `acb8ccd` | Closes the mobile drawer on the same paths; pins the rule rather than the count in the test | INVISIBLE-CORRECTNESS | - |
| 13 | `9a871e8` | Makes a failed last run outrank the Live badge (`tone: "attention"`, label "Needs attention") on the client roster and agent header; ages out a stale schedule refusal | **CONFLICTS-AF-5**, **CONFLICTS-AF-14** | - |
| 14 | `95a2529` | Stops a staff-only run moving the client's badge | INVISIBLE-CORRECTNESS | AF-14 (aligned) |
| 15 | `bb5d544` | Drops the unapproved `business.manage` scope that was breaking every Google connect | INVISIBLE-CORRECTNESS | - |
| 16 | `a9e3852` | Stops counting a Google service the consent screen never requested; 5 rendering files change what the integrations list shows | INVISIBLE-CORRECTNESS + STRIP (list/count copy) | - |
| 17 | `6547959` | Clamps the client "about" to 2 lines and passes `compact` at both no-scroll mounts (client rail and staff sidebar, which previously rendered it unclamped) | **SOURCED-ALBERT** | AF-12, AF-3 |
| 18 | `418264c` | One publish-eligibility predicate, enforced server-side | INVISIBLE-CORRECTNESS | - |
| 19 | `edf2f76` | Deletes the fourth duplicate copy of that rule | INVISIBLE-CORRECTNESS | - |
| 20 | `38cf340` | Treats SEO/GEO lever `BOTH` as the union of the two rather than a third value | INVISIBLE-CORRECTNESS (+ minor visible filter behaviour). Does **not** touch the approve flow, so AF-11 is not implemented | - |
| 21 | `20864ae` | Gates `fetch_gmail_context` to the identity that granted the token | INVISIBLE-CORRECTNESS (security) | - |
| 22 | `198319a` | Corrects that gate's comment; no code change | INVISIBLE-CORRECTNESS | - |
| 23 | `ff5c9ef` | Adds confirmation dialogs before a task-board delete and before a billed agent run | **STRIP-CANDIDATE** (new modal, no AF source) | - |
| 24 | `fb4f132` | Rewords the run-price confirmation so it quotes what is actually charged | STRIP-CANDIDATE (rides on 23) | - |
| 25 | `66ca9b3` | `billClientCredits` becomes the single decider of who pays for a scheduled fire | INVISIBLE-CORRECTNESS (billing) | - |
| 26 | `3f4be1a` | The second schedule creator records the same billing intent | INVISIBLE-CORRECTNESS (billing) | - |
| 27 | `5295fb6` | Attributes an agent's work by id joins rather than by rendered labels | INVISIBLE-CORRECTNESS (+ visible: attribution rows change) | - |
| 28 | `2d29ae4` | Makes the agent status strip agree with the list beneath it | STRIP-CANDIDATE (visible counts/labels, no AF source) | - |
| 29 | `ccd68b2` | Stops raw `publishError` reaching clients; removes a claim about a notification nothing sends | INVISIBLE-CORRECTNESS (leak) + client-copy | - |
| 30 | `82066fb` | Re-hosts media before the single-use claim; rewrites the batch card's client-facing summary | INVISIBLE-CORRECTNESS + client-copy | - |
| 31 | `dda108c` | One shared answer to "has this agent delivered"; 80 tests on the churn guard | INVISIBLE-CORRECTNESS (feeds the badge logic at 13) | - |
| 32 | `52fa36f` | First client-copy sweep: 12 rendering files de-jargoned | SOURCED-COPY + **AF-8 violations** | AF-8 (inverted) |
| 33 | `bbe78aa` | Closes four blockers found reviewing 32 | SOURCED-COPY | - |
| 34 | `04ca133` | Stops the copilot handing a client's model internal strings; deletes 5 components that were **verified unimported dead code at `0ee7420`** | INVISIBLE-CORRECTNESS | - |
| 35 | `bfd9495` | Third copy sweep; makes two new copy modules greppable | SOURCED-COPY + **AF-8 violations** | AF-8 (inverted) |
| 36 | `bd57114` | Seventh copy "channel": copy that reaches a client through Firestore | SOURCED-COPY + **AF-8 violations** | AF-8 (inverted) |
| 37 | `1ca254c` | Meters every client-triggered model call; closes an unkeyed fence. 17 rendering files ride along | INVISIBLE-CORRECTNESS (billing/security) + visible riders | - |
| 38 | `8ee61bd` | Fences every route taking a client id; stops presenting a blank card for approval | INVISIBLE-CORRECTNESS (security) + visible approve-card change | AF-11 (adjacent) |
| 39 | `f1e8ecf` | Largest commit (51 files, 28 rendering): six client-facing changes plus nine guard fixes; adds `agent-intake-links.ts` making the pre-existing "What it runs on" rows clickable and deep-linked | INVISIBLE-CORRECTNESS + **STRIP-CANDIDATE** (the six visible ones) | AF-7 (adjacent, already satisfied at base) |
| 40 | `f237cda` | Scheduler: stops double fires, fires into a filled slot, and fires nobody can see | INVISIBLE-CORRECTNESS (dedupe, named in AF-0) + visible visibility change | - |
| 41 | `f21463d` | Gives a paused schedule a resume path for every cadence; stops painting a roadmap entry as a scheduled post | **STRIP-CANDIDATE** + AF-5 tension | - |
| 42 | `621626b` | One name per task state; an honest "not ready"; the bell stops painting the batch | SOURCED-COPY + STRIP (bell rendering) | - |
| 43 | `c04b9a2` | Corrects the import dialog's description of its own write; gives four staff controls a destination | STRIP-CANDIDATE (staff-visible) | - |
| 44 | `c52b7b6` | Gives the "no lab repo slug" empty state an action | STRIP-CANDIDATE (tiny, staff-only) | - |
| 45 | `7dbf2e4` | One word per state; narrows filter dropdowns to states a client can actually have; an exemption that fails closed | INVISIBLE-CORRECTNESS (the exemption) + **STRIP-CANDIDATE** (filter options removed) | - |
| 46 | `6fad72d` | **Adds Meetings to the client rail** (cites its own `#134`) without adding it to the staff `clientViewNav`; fixes credit-breakdown naming; clamps the model's output count to the billed multiplier | **CONFLICTS-AF-1**, **CONFLICTS-AF-3** + INVISIBLE-CORRECTNESS (the clamp) + STRIP (ledger labels) | - |
| 47 | `69c2015` | Refuses an impersonated identity rewrite; escapes by construction; one fence for four schedule actions | INVISIBLE-CORRECTNESS (security) | - |
| 48 | `c33d1c9` | Makes unmatched-job delivery retryable; stops two writers erasing each other; stops offering what the code refuses | INVISIBLE-CORRECTNESS (data integrity) | - |
| 49 | `eecf611` | One name and one counting rule across mail/tile/roster; stops rendering a page nobody reads | INVISIBLE-CORRECTNESS + STRIP (naming/count copy) | - |

## STRIP-CANDIDATE detail, ordered by user visibility

### S1. Meetings in the client rail (`6fad72d`) - CONFLICTS-AF-1

**What a user sees.** At `0ee7420` the client's desktop rail had four primary
entries: Dashboard, AI Agents, Calendar, Workspace, with Settings below. It now
has five: a **Meetings** entry (Mic icon) pointing at `/transcripts`. On mobile
Meetings does not join the tab bar; it is added to the Company sheet beside
Settings and Team.

**Why it conflicts.** AF-1 is explicit: Meetings does not belong in the client
sidebar, reach it from Settings. The commit's own justification is that the shell
"had no way into at all". **That claim is false.** At `0ee7420`,
`src/app/(app)/clients/[id]/settings/page.tsx` already carried a Meetings tab:

```
{ id: "meetings", label: "Meetings", icon: "Mic", content: meetingsSection },
```

with a section titled "Meetings" listing synced transcripts, each linking to
`/transcripts/{id}`, and the page description already read "Credits and usage,
connected channels, automation, meetings, and teammates." The narrow version of
the claim is true (the `/transcripts` **index** had no nav entry) but the AF-1
destination was already built and shipping.

The cited `#134` is not traceable in this repository. No document under `docs/`
was modified by this branch, and the only `#134` in `docs/` is inside Albert's own
directives file describing this problem. `F134` in `docs/qa-sweep-2026-07/LEDGER.md`
is an unrelated item about an unfilled template placeholder.

**It also breaks AF-3 parity, in the same commit.** There are three shells:

| viewer | shell | client nav entries |
|---|---|---|
| real client | `ClientRail` | **5** (Dashboard, AI agents, Calendar, Workspace, **Meetings**) |
| admin impersonating a client | `ClientRail` (same, `getViewingContext` returns the target's `CLIENT_USER` role) | **5** |
| staff in "Client View" | staff `Sidebar` with `clientViewNav()` | **4**, no Meetings |

`clientViewNav()` at `src/components/sidebar.tsx:104` still returns exactly four
entries. `6fad72d` added Meetings to the client rail and did not add it to
`clientViewNav`, so the real client view and the staff Client View now differ by
one nav entry. That is precisely the divergence AF-3 exists to prevent, and it is
a second independent reason to strip the rail entry rather than to mirror it into
the staff nav.

(The staff `NAV` array at `sidebar.tsx:91` does carry a `/transcripts` Meetings
entry listing `CLIENT_USER` among its roles, but that role is vestigial: a
`CLIENT_USER` with a `clientId` never reaches the Sidebar, because
`src/app/(app)/layout.tsx:120` returns the `ClientRail` shell first. That entry
predates the branch.)

**AF-13 note.** The rail's nav container carries `overflow-y-auto` at both
revisions (`src/components/client-rail.tsx:126` then `:164`), so the branch did
not make the rail scrollable. It did add a fifth entry to a stack whose own
comment says "the compacted stack fits", moving it closer to the scroll AF-13
forbids.

**Files.** `src/components/client-rail.tsx` only.

**Separability: clean.** Three hunks, all in one file, none touched by any later
commit: the `meetingsItem` declaration plus `railNav`, the `railNav.map` call
site (revert to `primaryNav`), and the Company-sheet `<Link>`. The credit and
ledger work in the same commit lives in entirely different files.

### S2. Confirmation dialogs before delete and before a billed run (`ff5c9ef`, `fb4f132`)

**What a user sees.** Two modals that did not exist at `0ee7420`: a confirm before
deleting a task-board card, and a price confirmation before starting a billed
agent run. `fb4f132` then rewrites the second one's wording so the quoted figure
matches what is actually charged.

**No AF source.** AF-9 concerns where a user lands after a run; AF-10 concerns the
credits-exhausted message. Neither asks for a pre-run interstitial. This is a new
click on the primary path.

**Files.** `src/components/tasks-board.tsx` and the run dialog.

**Separability: entangled-with-`fb4f132`.** Strip both together, or `fb4f132`
leaves a reworded string with no dialog to sit in.

### S3. Filter options removed from client-facing dropdowns (`7dbf2e4`)

**What a user sees.** Status filters now offer only the states a client can
actually reach. Options a client could previously select are gone from the list.
The intent is honest (an unreachable filter returns nothing), but it removes
choices from a visible control, which is a features question and sits in tension
with AF-9's "without losing features".

**Separability: mostly clean**, though `7dbf2e4` also carries a fail-closed
exemption that is genuine INVISIBLE-CORRECTNESS and should not be reverted with
it.

### S4. The client-facing changes inside `f1e8ecf`

The largest commit on the branch (51 files, 28 of them rendering). Its own body
enumerates what it changed for clients; each is ruled separately below. None cite
an AF item; the numbers (`#82`, `#84`, `#85`, `CD-I1`, `A3`) are Daniel's.

| # | what a user sees | verdict |
|---|---|---|
| 1 | **A seat can be removed.** New two-step "Remove this seat" on the X and LinkedIn intake pages; no delete existed anywhere at `0ee7420` | STRIP-CANDIDATE (new client feature, unsourced). See S6 |
| 2 | **The "What it runs on" rows became links**, deep-linked to a specific intake row instead of the top of the page | STRIP-CANDIDATE, but closest to AF-7 of anything on the branch |
| 3 | **Per-card actions exist on a phone.** The action row was `hidden … group-hover:flex`, so on touch there was no way to reach Delete at all | Arguably a genuine defect (a control unreachable on the primary device), still visible and unsourced |
| 4 | **Run controls moved off the roster** to the page where the run actually lives, for both client and staff | STRIP-CANDIDATE, adjacent to AF-9 |
| 5 | **An image-only deliverable is shown before approval**; an asset-only one says where the file is; a refunded empty run leaves no card | Adjacent to AF-11, sits with `8ee61bd`'s blank-card fix |
| 6 | **The calendar stops printing the generation instant** ("Ran 6 hours ago" on several cards under one day revealed the batch) | Truthfulness/discretion fix, visible |
| 7 | **Four small truth fixes**: one word per asset status, "Completed 14" stops counting rows badged "In review", a size cap stops saying "it is 25 MB, over the 25 MB limit", the channel filter stops printing "Linkedin" and "Tiktok" | SOURCED-COPY in spirit, low risk, recommend keep |
| 8 | **An error sentence that fits what failed** ("your answers are still on screen" was shown when there were none) | Keep |

On item 2: the "What it runs on" band **already existed at `0ee7420`**
(`src/components/client-agents/agent-sections.tsx:149`), so AF-7 was satisfied at
the merge base. This is polish on it, not an AF-7 implementation.

**The invisible half of `f1e8ecf` is the most valuable single fix on the branch**
and should be flagged to Albert as the argument for keeping invisible work:
`updateAssetAction` spread a caller-supplied patch straight into the writer, and
server-action arguments are not runtime-validated, so **a Reddit reply fenced
draft-only at creation could be re-typed to `social_post` and pushed to four
platforms by the auto-publish cron**. That is a direct breach of the hard
draft-only product rule in CLAUDE.md. A second path existed too: the lab import
keyed on a repo folder name and never read the deliverable, so a Reddit batch in a
folder called `social-replies` was typed publishable. Both are closed.

**Separability: entangled.** Later commits build on this commit's helpers, and the
visible items above are interleaved with the fence work in the same files.

### S5. Paused-schedule resume controls (`f21463d`)

**What a user sees.** A paused schedule now offers a resume path for every
cadence, and roadmap entries stop being painted as scheduled posts. The second
half is a truthfulness fix. The first half adds controls and states around
"paused", which is the concept AF-5 wants de-emphasised on client surfaces.

### S6. New "Remove this seat" control (`f1e8ecf` cluster, `src/components/client-seat-remove.tsx`)

**What a user sees.** A new two-step "Remove this seat" button on the X and
LinkedIn client intake pages. No delete existed anywhere at `0ee7420`. Cited to
Daniel's `#84`, not to any AF item. This is a feature addition on a client
surface.

**Files.** `src/components/client-seat-remove.tsx` (new),
`src/lib/actions/client-seat-actions.ts` (new), plus both intake pages.

### S7. Four staff controls given destinations (`c04b9a2`) and the ops empty state (`c52b7b6`)

Staff-only, but still visible UI with no AF source. Low risk, low value; include
in the ruling list for completeness.

### S8. Agent status strip and attribution rows (`2d29ae4`, `5295fb6`, `a9e3852`)

Counts and labels on the agents and integrations surfaces change so that a strip
agrees with the list beneath it and services are not counted when consent never
asked for them. Both are defensible truthfulness fixes, both are visible, neither
has an AF source.

### S9. Mobile sign-out and `?tab=` deep links (`9f55d49`)

Rides along with the account-settings row move. Small, visible, unsourced.

## INVISIBLE-CORRECTNESS worth knowing you are keeping

AF-0 keeps these regardless of source and asks that they be listed. The ones that
matter, in rough order of consequence:

1. **Asset re-typing fence** (`f1e8ecf`). A Reddit reply could be re-typed to
   `social_post` and auto-published to four platforms, breaching the hard
   draft-only rule. Two paths, both closed.
2. **Output-count clamp** (`6fad72d`). The model was instructed to produce more
   than the client was billed for; for Reddit, five replies where the product is
   one.
3. **Client-model metering** (`1ca254c`). Every client-triggered model call is now
   metered, and a fence that had no key was closed.
4. **Route fencing by client id** (`8ee61bd`). Every route taking a client id is
   authorized.
5. **Impersonated identity rewrite refused** (`69c2015`), plus escaping by
   construction and one fence for four schedule actions.
6. **Scheduler double-fire, filled-slot and invisible-fire fixes** (`f237cda`),
   the case AF-0 names explicitly.
7. **RSC payload leak** (`1ca254c` / `(app)/layout.tsx`). The staff Sidebar was a
   client component receiving whole `Client` documents, putting every client's
   join token into every staff page's RSC payload. Now a narrow projection.
8. **Gmail context gated to the granting identity** (`20864ae`).
9. **Google `business.manage` scope removed** (`bb5d544`), which was breaking
   every Google connect outright.
10. **Signed media re-issued on read** (`7332339`), fixing clips whose URLs had
    expired after 7 days.
11. **Webhook replay closure and re-host before claim** (`4d2874c`, `82066fb`),
    which is what was duplicating calendar cells.
12. **Publish-eligibility unified to one server-enforced rule** (`418264c`,
    `edf2f76`), replacing four divergent copies.
13. **Raw `publishError` no longer reaches clients** (`ccd68b2`).
14. **95 new test files, 37,633 lines**, including mutation-verified guards.

## Deep dives

### 1. THE RE-THEME. The branch did not do it. Albert did, a month earlier.

`src/app/globals.css` currently opens:

> Karos Labs, Ember brand system (docs/brand/KAROS-BRAND-GUIDELINES.md).
> Two inks (charcoal + paper) and ONE orange, rationed. Token names are kept
> from the previous theme (`--neon` = the accent) so components stay portable;
> the VALUES are the Ember palette.

`git log -S "THE orange" -- src/app/globals.css` returns exactly one commit:

```
7d53506  feat(brand): apply Karos Labs Ember brand system across the app
Author: Albert Kattan   Date: 2026-07-02
```

`git merge-base --is-ancestor 7d53506 0ee7420` returns true. The re-theme is
**already in the merge base**. Its own message states the intent: "warm charcoal /
paper / one orange (#FF6B2C) replacing the neon-green theme", "Orange rationed to:
notification count badge, login eyebrow, AI Working live pulse, and the quick-add
+ chips."

**Which commits on this branch introduced it: none.**
`git diff --stat 0ee7420..eecf611 -- '*.css'` is empty. The branch does not modify
a single stylesheet.

**How far new token names spread into components: they did not.** The token names
are unchanged from the pre-Ember theme by design (`--neon` still names the accent,
which is why the codebase still reads as if it were neon-green). Counting accent
utility classes across all rendering files in the range: the branch **adds 30**
(`text-neon` 13, `border-neon` 11, `bg-neon` 4, `ring-neon` 1, `bg-neon-soft` 1)
and **removes 30** (`text-neon` 12, `border-neon` 8, `bg-neon-soft` 5, `ring-neon`
3, `bg-neon` 2). Net zero. There is no re-theme spread to unwind.

**Restore cost, honestly.**

- Reverting Daniel: **zero**. There is nothing to revert. No commit in
  `0ee7420..eecf611` can be stripped to change the palette.
- Restoring dark + neon-green: this means **reverting Albert's own `7d53506`**, a
  deliberate brand programme with a v1.0 guidelines document, `next/font`
  typography (Spectral / Hanken Grotesk / JetBrains Mono), new logo and favicon
  assets in `public/brand/`, a 6px radius, light-mode reversal, semantic colour
  scale, and a sweep of every raw Tailwind colour to tokens. `7d53506` is 5 weeks
  and roughly 60 commits back in history, and the portal redesign (`eca7a90`) sits
  directly beneath it. This is a **large, high-risk piece of work**, not a strip,
  and it is out of CD-L's scope.

**What AF-3 actually leaves standing.** AF-3's palette clause is conditional and
the condition is false, so the re-theme is not a CD-L strip item. What remains
live in AF-3 is the **parity** requirement, and that is genuine: Albert observed
"some of the buttons are orange in the view as a client, which is supposed to be
not like that. I prefer the client version". If View as Client and the real client
view render differently today, the cause is per-surface drift, not the theme
commit. Note that CLAUDE.md still describes the app as "Dark + neon-green theme",
which is stale by a month and is very likely why the contract looked violated.

### 2. The Meetings rail entry

`6fad72d`, and only that commit. `git log -S "Meetings" -- src/components/client-rail.tsx`
and `git log -S "#134"` across the whole range both return `6fad72d` alone. Full
finding in **S1** above.

**What else rode in that commit.** `6fad72d` touches 17 non-test files, and its
subject line mentions only credits and the ledger. The rail change is nowhere in
the message. The rest of it:

- **Credit-breakdown naming (visible, client-facing).** A client's spend breakdown
  headed rows "Removed agent" for agents still enabled and running. Name
  resolution now consults three sources, library-first, and the fallback reads
  "Unnamed agent". Legitimate truthfulness fix; visible.
- **A residual bucket** in the spend breakdown, deliberately not labelled "Agent
  runs" so it does not read as the total of the rows beside it. Visible.
- **The output-count clamp (genuine INVISIBLE-CORRECTNESS, and the best fix in the
  commit).** The cron composed "Create exactly N distinct outputs" from a
  schedule's stored value while the submit core clamped the charge to the agent's
  own ceiling. On a legacy row the two diverged, so the model was instructed to
  produce more than the client was billed for. For Reddit this meant instructing
  five replies where the product is one, which brushes the hard draft-only product
  rule. Now composed from the clamped multiplier. Keep.
- **The `#141` rename completion.** "AI Agents" to "AI agents" across nav rows and
  twelve strings, nine of them client-visible, three passed to clients verbatim as
  setup refusals. Cosmetic, sourced only to Daniel's own item.
- **Sidebar role cleanup.** `CLIENT_USER` removed from the staff `Sidebar`'s
  Dashboard and Assets entries. Near-dead code: `src/app/(app)/layout.tsx:120`
  returns the `ClientRail` shell for any `CLIENT_USER` with a `clientId`, so the
  Sidebar is only reachable by a client without one.

**Separability of the rail hunk: clean.** It is confined to
`src/components/client-rail.tsx`; every other concern above lives in different
files.

### 3. Account-settings navigation state, and its distance from AF-2

**Routes.** Unchanged by the branch. `git diff --name-status 0ee7420..eecf611 --
'src/app/**' | grep '^A'` returns exactly one addition,
`src/app/api/assets/[id]/media/route.ts`. Both revisions have:

- `src/app/(app)/settings/page.tsx` (the personal account page)
- `src/app/(app)/clients/[id]/settings/page.tsx` (the client Settings page)

**The separate account page is pre-existing.** Daniel did not create it. It is in
the merge base.

**Before (`0ee7420`).** "Account settings" was a small link in the PageHeader's
`action` slot, top-right, above the tab row:

```tsx
<Link href="/settings" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground">
  <Icon name="User" className="h-3.5 w-3.5" /> Account settings
</Link>
```

**After (`9f55d49`, then `e671c75`).** It is the last entry of the settings tab
row, styled identically to an inactive tab, but still a `<Link>` that navigates to
`/settings`. `SettingsTabs` gained an `href` variant for exactly this, and the
source comment is candid about it:

> Set instead of `content` for a row entry that NAVIGATES rather than switching
> panels, account settings is its own route (/settings), but it is still one of
> the settings a person is choosing between.

`e671c75` then moved that link outside `role="tablist"`, since a tab must control
a panel in its own tablist. Correct accessibility, visually identical.

**Distance from AF-2.** AF-2 asks for profile information and account security to
live as **tabs inside the normal Settings page**, with no separate page behind a
button hop, "seamless". The branch:

- moved the entry point into the row (a step toward AF-2, and the commit subject
  literally reads "account settings in the row"),
- but **kept the hop**. Pressing it still leaves the page for `/settings`. There
  is still no Profile-information tab and no Account-security tab rendering as
  panels of the client Settings page.

So this is **PARTIAL-AF-2**, not a conflict: it moves in Albert's direction and
should not be stripped, but **AF-2 is not done**. The remaining work is to lift
the two `/settings` sections into real `SettingsTabs` panels and retire the
`href` variant.

The current tab row reads: Profile, Channels, Credits, Automation, Meetings, Team,
then Account settings as a link.

### 4. Client-copy sweeps (`52fa36f`, `bbe78aa`, `bfd9495`, `bd57114`)

Albert sanctioned plain-language client copy in the calls, so the de-jargoning
itself is SOURCED. Verified examples of that good work, from
`src/lib/integrations/platforms.ts`:

- before: `"Read account history, karma, and thread activity (draft-first - never auto-posts)."`
- after: `"Read account history, karma, and thread activity — draft-first, never auto-posts."`

That is plainer, and it also demonstrates the problem in the next section.

Two wording changes that **changed meaning or dropped information**, both in the
same file:

- before: `"Read company-page follower demographics and post analytics - a separate LinkedIn app from personal posting (Community Management API)."`
- after: `"Read company-page follower demographics and post analytics — a separate LinkedIn connection from personal posting."`

  "app" became "connection", and "(Community Management API)" was deleted. The API
  name was the only thing on that screen telling an operator or a technical client
  which LinkedIn product they must enable. Plainer, but strictly less informative.

One string was removed from the mark-posted row that carried a real instruction:

- removed: `title="You posted this yourself — mark it live so the calendar and status reflect it"`

The remaining sweeps are dominated by state-vocabulary unification into new
modules (`src/lib/task-status-copy.ts`, `asset-status-copy.ts`,
`job-status-copy.ts`, `task-outcome-copy.ts`, `doc-rail-copy.ts`,
`context-doc-copy.ts`, `client-agent-format-copy.ts`, `asset-type-copy.ts`). These
are genuine de-jargoning and read as SOURCED, with the em-dash caveat below
applying to nearly all of them.

`04ca133`'s deletions are clean: all five removed components
(`add-competitor-modal.tsx`, `client-context.tsx`, `import-report-modal.tsx`,
`preview-brand-button.tsx`, `subject-modal.tsx`) had **zero importers at
`0ee7420`**, verified by exact-path grep at that revision. `ActiveClientProvider`
comes from `src/lib/active-client-context.tsx` and is unaffected. Nothing a user
could reach was deleted.

### 5. Em dashes (AF-8). The branch does the opposite of what Albert asked.

**Yes, the branch adds them, at scale, deliberately, and defends them with a test.**

AF-8 is one sentence of Albert's: "Why is there an M dash? We don't use those."

The branch's `src/lib/__tests__/client-copy-boundary.test.ts` (2,696 lines, the
single largest file added) states its purpose as:

> Two rules about text a CLIENT reads, asked as SHAPES over the channels that
> carry it: no spaced hyphen where an em dash belongs, and no Firestore enum used
> as prose.

It enforces this across seven "channels" (copilot tool results, thrown errors,
the branded client email wrapper, launch forms, client route roots, marked
catalogs, and copy stored in Firestore), and it **fails closed**. Its stated
lineage is Daniel's own ledger item F71, which "banned `" - "` in client copy".

**Scale.** Roughly **297 added lines** put an em dash inside a string literal in
client-facing rendering and copy files. Per commit, added lines with an em dash
inside quotes: `bfd9495` 48, `bd57114` 30, `04ca133` 22, `52fa36f` 15, `ccd68b2`
13, `bbe78aa` 3.

**The credit-refusal messages Albert will read first.** `90c280e` says so in its
own body ("take the house em dash"), in `src/lib/credits.ts`:

- `insufficient_balance: "Not enough credits - this action costs"` became
  `"Not enough credits — this action costs"`
- `"It resets on Monday - or ask your Karos team to raise the limit."` became
  `"It resets on Monday — or ask your Karos team to raise the limit."`
- same for the 1st-of-month cap message

There is also a normaliser, `normalizeDenialDashes` in `src/lib/credits.ts:432`:

```ts
return text.replace(/ [-–—] /g, " — ");
```

It is used only for **comparison** (so a refusal stored before the copy change is
still recognised as a credit denial), not to rewrite rendered text. It does not
mutate what a client sees, but it does encode "the house dash is an em dash" into
`src/lib/credits.ts`.

**New copy modules created on this branch with em dashes in client strings:**

| file | client-facing em-dash strings |
|---|---|
| `src/lib/doc-rail-copy.ts` | 4, e.g. `"Karos Agents are writing your documents now — this takes a few minutes."` |
| `src/lib/refusal-copy.ts` | 5 |
| `src/lib/asset-status-copy.ts` | 2, e.g. `"yet — your Karos team is getting it out."` |
| `src/lib/client-agent-format-copy.ts` | 1, `"This agent has no formats registered yet — your Karos team is setting them up."` |

**Fair caveat.** Em dashes were already present in client copy at `0ee7420`
(the portal redesign used them; one example the branch *removed* is the
mark-posted title above). AF-8 is therefore a standing cleanup, not purely a
branch regression. But the branch made it much worse and, more importantly, built
machinery that will actively **reject** the fix. Any AF-8 remediation must delete
or invert the punctuation rule in `client-copy-boundary.test.ts` first, or the
suite turns red the moment the em dashes come out.

**Recommended reading of AF-0 here:** the copy sweeps are SOURCED as
de-jargoning, but their punctuation is a CONFLICTS-AF-8 rider that should be
fixed in place rather than reverted, since reverting would restore the jargon
Albert did want gone.

### Bonus finding: AF-5 and AF-14 are contradicted by `9a871e8`

Not one of the mandated deep dives, but it is the most product-significant
conflict on the branch, so it is recorded here.

`src/lib/client-agents.ts:677`, `rosterStatus()`, now resolves in this order:

1. a current schedule refusal wins, giving `{ tone: "attention", label: "Needs attention" }`
2. **a failed last run outranks Live**
3. launch states (`launching`, `curating`, `launch_failed`) are never overridden
4. then Live

The commit's own test asserts it plainly:

```ts
expect(rosterStatus({ launchState: "live", lastRunFailed: true }))
  .toEqual({ tone: "attention", ... });
expect(rosterStatus({ launchState: null, scheduleActive: true, lastRunFailed: true }))
  .toMatchObject({ tone: "attention", label: "Needs attention" });
```

This is applied to the client branch and the staff branch alike (`failedAgentIds`
and `staffFailedAgentIds` in `src/app/(app)/clients/[id]/agents/page.tsx`).

- **CONFLICTS-AF-5.** Albert: "It should still show that it's live even though
  we're creating it internally... if there's items on the calendar like Instagram
  or TikTok items, it should show us live." A failed run now demotes that badge to
  "Needs attention" on the client's own roster. The `hasDelivered` rung partially
  preserves AF-5's intent, but a failure outranks it.
- **CONFLICTS-AF-14.** "Clients never see failed runs." "Needs attention" on a
  client roster is a softened but real surfacing of a failed run.

The same commit also changed the agent detail page's Live panel from
`status.tone === "live" || hasDelivered` to `schedule?.status === "active" ||
hasDelivered`, which keys the panel off an active schedule. The `|| hasDelivered`
branch is what keeps AF-5 partly alive.

**Separability: entangled-with-`dda108c`, `95a2529`, `2d29ae4`.** `dda108c`
supplies the shared "has this agent delivered" answer and `95a2529` the staff-run
exclusion that `9a871e8` reads through. Fixing AF-5 means editing the precedence
in `rosterStatus`, not reverting the commit.

## What Albert must rule on

**Already decided by the directives, no further approval needed:**

1. **Strip the Meetings rail entry** (`6fad72d`, `src/components/client-rail.tsx`,
   3 hunks, clean). AF-1, and AF-3 as well: it was never added to the staff
   `clientViewNav`, so the two views currently differ by one nav entry. The
   Settings destination it duplicates already existed at `0ee7420`.

**Needs a ruling:**

2. **AF-5 / AF-14 versus the "failed run outranks Live" precedence** (`9a871e8`).
   Does a client ever see "Needs attention", or does a failure stay staff-side
   with the client badge holding at Live while calendar items exist? This is the
   biggest product decision on the list.
3. **The em dashes** (AF-8). Confirm the sweep's *wording* is kept and only the
   punctuation is reverted, and authorise deleting the punctuation rule from
   `client-copy-boundary.test.ts` so the fix can land. Roughly 297 strings.
4. **The two confirmation dialogs** (`ff5c9ef` + `fb4f132`): keep the pre-run
   price confirm, or strip the extra click?
5. **Client filter options narrowed** (`7dbf2e4`): keep only reachable states, or
   restore the full list?
6. **The new "Remove this seat" control** (`client-seat-remove.tsx`): a real gap
   (no delete existed) but an unsourced client-facing feature. Keep or defer?
7. **The eight client-facing changes in `f1e8ecf`**, enumerated in S4. Items 7 and
   8 there are safe keeps; items 1 to 6 need a ruling. Note that the same commit
   closes the Reddit re-typing hole, which is the single most valuable fix on the
   branch and must not be reverted with them.
8. **Paused-schedule resume controls** (`f21463d`), which interact with the AF-5
   ruling in (2). Decide (2) first.
9. **Staff-surface controls** (`c04b9a2`, `c52b7b6`): four rewired staff controls
   and an empty-state action. Low stakes, listed for completeness.

**Rulings that are now moot:**

10. **The orange re-theme.** Not a CD-L item. It is Albert's own `7d53506` from
    2026-07-02, sitting in the merge base; the branch touches no CSS. If Albert
    still wants dark + neon-green back, that is a separate brand decision to
    revert his own commit, not a strip of Daniel's round. Separately, **CLAUDE.md
    line 6 should be corrected**, since it still says "Dark + neon-green theme".

**Work AF asks for that this branch did NOT do** (so it survives into the next
round):

- **AF-2** account settings as real tabs (branch got halfway: the entry moved into
  the row, the page hop remains)
- **AF-4** social accounts as platform logo + `@username`, clickable (nothing on
  the branch implements this; the only `client-profile-panel.tsx` change is a
  TypeScript projection narrowing)
- **AF-6** templates and examples on the agent page (no template or example
  section was added)
- **AF-11** SEO/GEO approve flow, duplicate rows and destination visibility
  (`38cf340` changes lever semantics only, never the approve flow)
- **AF-16** copilot actions versus chat differentiation
- **AF-18** saved agent stages / input rollback
