# QA Sweep 2026-07 — Findings ledger (single source of truth)

Status values: OPEN · IN-PROGRESS · RESOLVED · RESOLVED-in-merge (struck on the
sweep branch as a phantom, made real by Tomer's branch and fixed while merging
it) · OPS-PENDING (code merged, human ops step required — see notes) ·
DEFERRED-TOMER · STRUCK.
Phase 1 notes: F24/F131 verified by code lenses post-bounce; live trigger states
not constructible locally (agent service env unset). F127 OPS-PENDING on
`npx tsx scripts/backfill-agent-blurbs.ts` (dry-run first, then --apply; needs
Albert). F47 verified with one residual (literal *italics* in X-reader draft
metadata — logged to F70's owner in rescopes).
A row flips to RESOLVED only after the three-step gate (tsc/build → Opus
risk+drift+mock-client lenses → Fable review) passes. Spec for each finding lives
in inventory/ (file column); screenshots in inventory/screenshots/.
Phase 1 = blocker wave · Phase 2 = subsystem clusters · Phase 3 = ARCH build
(F147/F148 + call directives A1-A5). Call-directive items without a finding number
are tracked in the CD table at the bottom.

| F# | Sev | Trk | Cluster | Phase | Status | Shot | Title | Spec file |
|---|---|---|---|---|---|---|---|---|
| F1 | BLOCKER | A | SEO | 1 | RESOLVED | yes | A finished client-facing action plan with a working Approve button is rendered on no page, whil | findings-p009-046.md |
| F3 | HIGH | B | SEO | 2 | RESOLVED | yes | Card bodies are raw audit-model prose, and "What good looks like" just repeats the card title | findings-p009-046.md |
| F4 | HIGH | A | SEO | 2 | RESOLVED | yes | Cards promise Karos will apply the fix "automatically" — no such code path exists and there is  | findings-p009-046.md |
| F5 | HIGH | A | WORKSPACE | 2 | RESOLVED | — | Grids split into multiple columns at window widths where the side rail and copilot dock have al | findings-p009-046.md |
| F7 | HIGH | B | SEO | 2 | RESOLVED | yes | No "What we're fixing" card can hand off to an agent — the one link built for it can never rend | findings-p009-046.md |
| F9 | HIGH | B | SEO | 2 | RESOLVED | yes | The "What we're fixing" cards show clients raw engineering check labels — the plain-English rew | findings-p009-046.md |
| F10 | HIGH | B | SEO | 2 | RESOLVED | yes | The headline AI-visibility score uses a different question set from every number below it, and  | findings-p009-046.md |
| F11 | HIGH | B | SEO | 2 | RESOLVED | yes | The same problem appears as two cards with contradictory priority chips | findings-p009-046.md |
| F12 | HIGH | B | SEO | 2 | RESOLVED | yes | There is no way to see what any AI engine actually answered — the per-question answer grid is c | findings-p009-046.md |
| F133 | HIGH | B | SEO | 2 | RESOLVED | yes | The report says the site was never cited and cited 11 times, on the same screen | findings-p009-046.md |
| F152 | HIGH | B | SEO | 2 | RESOLVED | — | Two of the nine signed-off v1 fixes shipped and were silently reverted by a merge the same day | findings-p009-046.md |
| F15 | MEDIUM | B | COPILOT | 2 | RESOLVED | — | Clicking an AI action posts a fabricated message in the client's own voice, stage directions in | findings-p009-046.md |
| F16 | MEDIUM | B | SEO | 2 | RESOLVED | yes | The "Search engines" filter files four search checks under "AI answers" instead | findings-p009-046.md |
| F17 | MEDIUM | A | SEO | 2 | RESOLVED | yes | The "mentions you" chip does nothing, and the number of chips contradicts the sentence above it | findings-p009-046.md |
| F18 | MEDIUM | A | SEO | 2 | RESOLVED | yes | The buyer-questions list is an unpunctuated flat dump, and it hides the competitor roster and t | findings-p009-046.md |
| F19 | MEDIUM | A | SEO | 2 | RESOLVED | yes | The citation leaderboard silently truncates, and the whole citation story disappears in the cas | findings-p009-046.md |
| F20 | MEDIUM | A | SEO | 2 | RESOLVED | yes | The snapshot date is a bare machine date with no staleness cue, and the client has no way to ge | findings-p009-046.md |
| F22 | MEDIUM | B | SEO | 2 | RESOLVED | yes | Urgent cards sort below important ones under a header that says the list is ordered by impact | findings-p009-046.md |
| F23 | MEDIUM | B | SEO | 2 | RESOLVED | yes | When the AI capture fails, the report tells the client it asked zero buyer questions | findings-p009-046.md |
| F144 | LOW | A | SEO | 2 | RESOLVED | yes | Rename the "Search engines" label — the call agreed it reads as AI search | findings-p009-046.md |
| F24 | BLOCKER | A | AGENTS | 1 | RESOLVED | yes | An always-on agent that has failed every single run still shows a green pulsing "Live" badge | findings-p009-046.md |
| F127 | BLOCKER | B | AGENTS | 1 | OPS-PENDING | yes | Agent descriptions are raw lab-repo skill manifests, shipped to clients unedited | findings-p009-046.md |
| F131 | BLOCKER | A | AGENTS | 1 | RESOLVED | yes | "Run now" is fully enabled on an agent whose own card says "Setup needed" | findings-p047-084.md |
| F25 | HIGH | A | AGENTS | 2 | RESOLVED | yes | A client who hits their spend cap gets a greyed-out Run button, no explanation, and advice that | findings-p047-084.md |
| F27 | HIGH | B | AGENTS | 2 | RESOLVED | yes | The Reddit agent's schedule dialog offers up to 35 replies a week and bills for them — the prod — 07-28 RE-APPLIED for the merged e15 (b949563): scheduleLimitsFor pins outputsPerRun=1 and caps 5 runs/week for Reddit, clamped SERVER-side and mirrored in the dialog. Stored rows above 5 still not retro-clamped (migration = product call) | findings-p047-084.md |
| F28 | HIGH | B | AGENTS | 2 | RESOLVED | — | The agent intake pages tell clients to pick, edit and skip drafts "in your Workspace archive" — | findings-p047-084.md |
| F29 | HIGH | B | AGENTS | 2 | RESOLVED | yes | The amber "3 ready" badge on an agent card never goes away, no matter how many times you review | findings-p047-084.md |
| F128 | HIGH | A | AGENTS | 2 | RESOLVED | yes | Agent descriptions are cut off mid-word, with no ellipsis and no way to read the rest | findings-p047-084.md |
| F129 | HIGH | A | AGENTS | 2 | RESOLVED | yes | "Ready to build your weekly content queue." sits on all seven cards — including the one that sa | findings-p047-084.md |
| F132 | HIGH | A | AGENTS | 2 | RESOLVED | yes | Run history rows are labelled with the operator's raw typing, typos included | findings-p047-084.md |
| F134 | HIGH | A | AGENTS | 2 | RESOLVED | yes | An unfilled template placeholder is shown to the user: "Focus this batch on [person]'s seat." | findings-p047-084.md |
| F30 | MEDIUM | B | AGENTS | 2 | RESOLVED | yes | A run you cancelled on purpose comes back as a red "Failed", and a client cannot cancel at all | findings-p047-084.md |
| F31 | MEDIUM | B | AGENTS | 2 | RESOLVED | yes | After a client presses Run, the page never updates again — no progress, no completion signal | findings-p047-084.md |
| F32 | MEDIUM | A | AGENTS | 2 | RESOLVED | yes | Dialogs cap at 720 pixels tall with one scroll box and no fixed action bar, so Start run scroll | findings-p047-084.md |
| F33 | MEDIUM | A | AGENTS | 2 | OPS-PENDING | — | Every agent deliverable is titled "<Agent name> - <Client name>" — the client sees their own co | findings-p047-084.md |
| F34 | MEDIUM | A | AGENTS | 2 | RESOLVED | — | If the agent service is unconfigured, a client's agents silently vanish behind "No active agent | findings-p047-084.md |
| F35 | MEDIUM | A | AGENTS | 2 | RESOLVED | — | On the staff Agents page you can only discover an agent's client binding and its missing setup  — 07-28: the binding-display half, previously N/A because it depended on struck F38, is now BUILT (4757ffd): the card states "<slug> only" | findings-p047-084.md |
| F36 | MEDIUM | A | AGENTS | 2 | RESOLVED | yes | Pressing "Start run" on the LinkedIn or Reddit agent without typing anything is refused — even  | findings-p047-084.md |
| F37 | MEDIUM | A | AGENTS | 2 | RESOLVED | yes | Staff cross-client lists render every row in the database with no search, filter, sort or pagin | findings-p047-084.md |
| F38 | MEDIUM | B | AGENTS | 2 | RESOLVED-in-merge | — | The Agents hub offers agent-and-client pairings the server is guaranteed to refuse, after the w — UN-STRUCK 07-28: the strike said perClientAgentSlug/agentKeyMatchesClientSlug were phantoms; Tomer's branch created exactly those symbols, so the premise is now true. Fixed in the merge (4757ffd): hub clients carry agentsRepoSlug, picker filtered, fixed chip at one eligible, Run disabled at none | findings-p047-084.md |
| F39 | MEDIUM | B | AGENTS | 2 | RESOLVED | — | The four managed lab products (Social, Newsletter, Blog, Landing page) cannot be run from anywh | findings-p047-084.md |
| F40 | MEDIUM | A | AGENTS | 2 | RESOLVED | yes | The schedule dialog's "Posts per week" is actually runs per week — the cost line one paragraph  | findings-p047-084.md |
| F130 | MEDIUM | A | AGENTS | 2 | OPS-PENDING | yes | Every agent is priced identically at "25 credits per output" | findings-p047-084.md |
| F41 | LOW | A | AGENTS | 2 | RESOLVED | yes | Clients are shown the raw internal status word for their agent runs — "Run 2026-07-27 · review" | findings-p047-084.md |
| F42 | LOW | A | AGENTS | 2 | RESOLVED | — | Seat forms refuse to save over a field that is not marked required | findings-p047-084.md |
| F43 | LOW | A | AGENTS | 2 | RESOLVED | — | Staff land on a completely blank AI Agents page for any client whose agent list is empty | findings-p047-084.md |
| F44 | LOW | A | AGENTS | 2 | RESOLVED | yes | The client AI Agents page stacks two near-identical headings and taglines on top of each other | findings-p047-084.md |
| F45 | LOW | A | AGENTS | 2 | RESOLVED | — | Two managed-product run components and their submit action are dead code — the four catalog pro | findings-p047-084.md |
| F135 | LOW | A | AGENTS | 2 | RESOLVED | yes | "3 runs × 1 outputs × 25 credits" — unpluralised units in the cost line | findings-p047-084.md |
| F147 | HIGH | B | ARCH | 3 | RESOLVED | yes | One content stream, two agent identities: "Instagram Agent" and "Social posts (IG/TikTok)" run  | findings-p047-084.md |
| F148 | HIGH | B | ARCH | 3 | RESOLVED | — | The portal has no launch-vs-runs model — the architecture the team decided on has nowhere to li | findings-p047-084.md |
| F46 | BLOCKER | B | WORKSPACE | 1 | RESOLVED | — | A client can never act on a draft — the pick/post/skip loop the intake copy promises does not e | findings-p047-084.md |
| F47 | BLOCKER | B | WORKSPACE | 1 | RESOLVED | — | The client's Archive shows the agent deliverable as raw text with all its formatting symbols on | findings-p085-122.md |
| F48 | HIGH | B | WORKSPACE | 2 | RESOLVED | — | "Autopilot on" stays on forever but only ever runs one batch | findings-p085-122.md |
| F50 | HIGH | B | WORKSPACE | 2 | RESOLVED | — | "Refresh Task Map" promises a market-footprint scan; the run never looks outside the account | findings-p085-122.md |
| F51 | HIGH | B | WORKSPACE | 2 | RESOLVED | — | A client clicking "New content ready" in their notification bell gets silently bounced to their | findings-p085-122.md |
| F53 | HIGH | A | WORKSPACE | 2 | RESOLVED | yes | A one-time 100-credit charge is sold to the client as "≈ $29/mo" | findings-p085-122.md |
| F54 | HIGH | A | WORKSPACE | 2 | RESOLVED | yes | A task moved to "Review Pending" from the ticket vanishes from the board with no way back | findings-p085-122.md |
| F55 | HIGH | B | WORKSPACE | 2 | RESOLVED | yes | Branded "Connect with Instagram" buttons open a popup showing a bare error sentence, and only a | findings-p085-122.md |
| F56 | HIGH | B | WORKSPACE | 2 | RESOLVED | — | Every client user can hand out permanent workspace access, and the key can never be rotated fro | findings-p085-122.md |
| F57 | HIGH | A | DOCS | 2 | RESOLVED | — | The AI Execution Guide shows clients raw markup — "## Overview", "**Task**" and all | findings-p085-122.md |
| F58 | HIGH | B | WORKSPACE | 2 | RESOLVED | — | The Autopilot switch spends the client's credits and fires five agent runs with no label, no pr | findings-p085-122.md |
| F149 | HIGH | B | WORKSPACE | 2 | RESOLVED | — | Nothing marks a post as posted, so the archive shows everything the moment it is generated | findings-p085-122.md |
| F150 | HIGH | B | WORKSPACE | 2 | OPS-PENDING | — | Video deliverables have no path into the portal — clips are hand-delivered by email — portal render half shipped; clip ingestion/upload = CD-D1 Tomer seam | findings-p085-122.md |
| F60 | MEDIUM | A | WORKSPACE | 2 | RESOLVED | yes | "View as client" mode is invisible — real impersonation gets a banner, the client switcher gets | findings-p085-122.md |
| F61 | MEDIUM | B | WORKSPACE | 2 | RESOLVED | — | A task the platform then refuses still costs the client a credit | findings-p085-122.md |
| F62 | MEDIUM | B | WORKSPACE | 2 | RESOLVED | yes | Adding a competitor from the sidebar does nothing visible when you are not on a client page | findings-p085-122.md |
| F63 | MEDIUM | A | WORKSPACE | 2 | RESOLVED | yes | Broken icon names render a sparkle glyph across 24 files — including beside the red error messa | findings-p085-122.md |
| F64 | MEDIUM | A | WORKSPACE | 2 | RESOLVED | yes | Clicking a task notification drops you on a board tab that does not contain that task | findings-p085-122.md |
| F65 | MEDIUM | A | WORKSPACE | 2 | RESOLVED | yes | Task-creating actions never hand you off to the board where the tasks landed | findings-p085-122.md |
| F66 | MEDIUM | A | WORKSPACE | 2 | RESOLVED | — | The client's Archive is every deliverable they have ever received in one wall, with no filter,  | findings-p085-122.md |
| F67 | MEDIUM | B | WORKSPACE | 2 | RESOLVED | — | The resume a client uploads is never read — but the UI says it powers their voice | findings-p085-122.md |
| F68 | MEDIUM | B | WORKSPACE | 2 | RESOLVED | yes | The staff notification bell can never show a review or a task | findings-p085-122.md |
| F69 | MEDIUM | A | WORKSPACE | 2 | RESOLVED | — | When generation is running or has failed, the Documents group tells the client the wrong story  | findings-p085-122.md |
| F70 | MEDIUM | A | WORKSPACE | 2 | RESOLVED | — | X drafts are titled with lab-internal vocabulary — clients read "Avenue 3 · News-reaction (live | findings-p085-122.md |
| F136 | MEDIUM | A | WORKSPACE | 2 | RESOLVED | yes | Task cards are a single column of tall blocks — roughly two fit on screen | findings-p085-122.md |
| F71 | LOW | A | WORKSPACE | 2 | RESOLVED | — | Client-facing strings use a spaced hyphen where the rest of the UI uses an em dash — including  | findings-p085-122.md |
| F72 | LOW | A | WORKSPACE | 2 | RESOLVED | yes | One page, three different names: the staff sidebar says "Tasks", the client rail says "Workspac | findings-p085-122.md |
| F73 | LOW | A | WORKSPACE | 2 | RESOLVED | — | The Activity tab's empty state promises clients "notes" that are filtered out of their view, an | findings-p085-122.md |
| F74 | HIGH | B | DOCS | 2 | RESOLVED | yes | "Correct Info" charges the client 2 credits and reports success even when the correction was th | findings-p085-122.md |
| F75 | HIGH | B | DOCS | 2 | RESOLVED | — | After Regenerate or a correction, the staff sidebar keeps serving the OLD document — the button | findings-p085-122.md |
| F76 | HIGH | B | DOCS | 2 | RESOLVED | yes | Internal, staff-only analyst documents are shipped to the client's browser — and the client nav | findings-p085-122.md |
| F77 | HIGH | B | DOCS | 2 | RESOLVED | yes | Regenerate destroys every document and every correction the client ever made, with no warning a | findings-p085-122.md |
| F78 | HIGH | B | DOCS | 2 | RESOLVED | yes | Regenerate runs the whole multi-minute pipeline inside one request, so it can report failure on | findings-p123-160.md |
| F79 | MEDIUM | A | DOCS | 2 | RESOLVED | — | A document that generated empty still shows in the nav and opens to a completely blank panel | findings-p123-160.md |
| F80 | MEDIUM | A | DOCS | 2 | RESOLVED | yes | Brand and strategy documents open as one flat wall with no section navigation, and the helper t | findings-p123-160.md |
| F81 | MEDIUM | B | DOCS | 2 | RESOLVED | yes | Correcting a document does not reach the AI that quotes it — the Copilot and the X agent keep a | findings-p123-160.md |
| F82 | MEDIUM | B | DOCS | 2 | RESOLVED | — | Exported PDFs silently swallow any text in angle brackets, including the templates' unfilled pl | findings-p123-160.md |
| F83 | MEDIUM | A | DOCS | 2 | RESOLVED | yes | Raw markdown leaks into the document viewer: literal hash marks, orphaned nested bullets, and u | findings-p123-160.md |
| F84 | MEDIUM | B | DOCS | 2 | RESOLVED | yes | The Schedule modal shows the wrong "Next run" date for any cadence longer than monthly | findings-p123-160.md |
| F85 | MEDIUM | A | CREDITS | 2 | RESOLVED | yes | The client is billed 2 credits for a correction with no price shown anywhere in the flow | findings-p123-160.md |
| F138 | MEDIUM | B | DOCS | 2 | RESOLVED | yes | Document body numbering starts at "2." and the numbers are baked into the text | findings-p123-160.md |
| F86 | LOW | B | DOCS | 2 | RESOLVED | yes | No document tells you how old it is — no last-updated, no version, and no way to navigate a fou | findings-p123-160.md |
| F139 | LOW | A | DOCS | 2 | RESOLVED | yes | A teammate's real name is used as the example of a wrong fact in client-facing copy | findings-p123-160.md |
| F140 | LOW | A | DOCS | 2 | RESOLVED | yes | A fill-in-the-blank label ships as "EVERY ___ MONTH(S)" | findings-p123-160.md |
| F87 | HIGH | B | COPILOT | 2 | RESOLVED | — | "Competitor Deep-Dive" asks for a competitor's web address it has no way to open | findings-p123-160.md |
| F88 | HIGH | A | COPILOT | 2 | RESOLVED | yes | All four AI actions disappear after the first message, and the only way back destroys the threa | findings-p123-160.md |
| F89 | HIGH | A | COPILOT | 2 | RESOLVED | — | Raw model markup is shown to the client — asterisks, hashes and table pipes land in the panel | findings-p123-160.md |
| F90 | HIGH | B | COPILOT | 2 | RESOLVED | — | The War Room reports "Consensus reached" when it created nothing, then closes before the reason | findings-p123-160.md |
| F91 | MEDIUM | B | COPILOT | 2 | RESOLVED | — | "AI Content Dispatch" says it queues content runs; nothing is queued | findings-p123-160.md |
| F92 | MEDIUM | B | COPILOT | 2 | RESOLVED | — | A War Room run can create an extra campaign the console never mentions, the count excludes, and | findings-p123-160.md |
| F93 | MEDIUM | A | COPILOT | 2 | RESOLVED | — | Escape or a stray click outside throws away a minute-long War Room run with no warning | findings-p123-160.md |
| F94 | MEDIUM | A | COPILOT | 2 | RESOLVED | yes | On a phone the Copilot opens as a sliver and the four actions sit below the fold | findings-p123-160.md |
| F95 | MEDIUM | A | COPILOT | 2 | RESOLVED | — | The copilot is given a credit price list that omits the most expensive thing a client can buy | findings-p123-160.md |
| F97 | BLOCKER | B | DASHBOARD | 1 | RESOLVED | — | The client's top call to action promises an approval they cannot make, and the link lands on th | findings-p123-160.md |
| F125 | BLOCKER | B | DASHBOARD | 1 | RESOLVED | yes | AI Insights is badged "Demo data" and still tells the client to cut LinkedIn spend | findings-p123-160.md |
| F99 | MEDIUM | A | DASHBOARD | 2 | RESOLVED | yes | The client dashboard is one unbroken scroll and the plain-English weekly briefing sits dead las | findings-p123-160.md |
| F124 | MEDIUM | A | DASHBOARD | 2 | STRUCK-BY-ALBERT | yes | The dashboard opens with four counters that the two cards beneath them restate — Albert 07-28: revert; baseline tiles restored (CD-G6) | findings-p123-160.md |
| F126 | MEDIUM | A | DASHBOARD | 2 | RESOLVED | yes | Single-asterisk emphasis renders as literal asterisks in AI Insights | findings-p123-160.md |
| F145 | MEDIUM | A | DASHBOARD | 2 | RESOLVED | yes | A channel whose token dies silently vanishes from "Connected channels" instead of asking to be  | findings-p123-160.md |
| F100 | LOW | A | DASHBOARD | 2 | RESOLVED | — | British and American spellings sit side by side — "Analysing" on one screen, "Analyzing" on ano | findings-p161-199.md |
| F101 | HIGH | A | CREDITS | 2 | RESOLVED | — | One misclick on a trash icon destroys a LinkedIn seat — no confirm, no undo, no feedback if it  | findings-p161-199.md |
| F102 | HIGH | B | CREDITS | 2 | RESOLVED | yes | The client's headline credit number is labelled "credits available" but is not what they can sp | findings-p161-199.md |
| F103 | MEDIUM | A | CREDITS | 2 | RESOLVED | yes | Client Settings is a nine-section single-column stack ending in a panel whose only content is a | findings-p161-199.md |
| F104 | MEDIUM | A | CREDITS | 2 | RESOLVED | yes | Hitting a spend cap never explains itself and offers no way forward | findings-p161-199.md |
| F105 | MEDIUM | B | CREDITS | 2 | RESOLVED | — | The auto-publish switch snaps back with no explanation, and Disconnect silently does nothing wh | findings-p161-199.md |
| F141 | LOW | A | CREDITS | 2 | RESOLVED | yes | The credit ledger is the only place that tells a client what anything costs | findings-p161-199.md |
| F107 | HIGH | B | CALENDAR | 2 | RESOLVED | — | Choosing "Manual push" when approving tells you to publish from the calendar. There is no Publi | findings-p161-199.md |
| F108 | HIGH | B | CALENDAR | 2 | RESOLVED | — | Scheduled runs are previewed in your timezone but stored and printed in the server's | findings-p161-199.md |
| F151 | HIGH | A | CALENDAR | 2 | RESOLVED | yes | The calendar day detail prints the raw run record — internal status, product code, job hash, ma | findings-p161-199.md |
| F109 | MEDIUM | A | CALENDAR | 2 | RESOLVED | yes | A calendar run badged "Ready to review" has nothing to click | findings-p161-199.md |
| F110 | MEDIUM | B | CALENDAR | 2 | RESOLVED | — | Pause and Cancel on a scheduled run fail silently, and Cancel deletes it forever with no confir | findings-p161-199.md |
| F111 | MEDIUM | A | CALENDAR | 2 | RESOLVED | yes | The month calendar is a fixed seven-column grid at every screen size, with chips well under the | findings-p161-199.md |
| F112 | LOW | A | CALENDAR | 2 | RESOLVED | yes | A client's Calendar is read-only and its empty state offers no next step | findings-p161-199.md |
| F142 | LOW | A | CALENDAR | 2 | RESOLVED | yes | The calendar's primary button wraps to two lines | findings-p161-199.md |
| F113 | HIGH | A | SHELL | 2 | RESOLVED | yes | Opening any client page swallows the whole staff sidebar — and employees have no way to get it  | findings-p161-199.md |
| F115 | MEDIUM | B | SHELL | 2 | RESOLVED | — | An approved user is never told they were approved; the pending screen is a static dead end | findings-p161-199.md |
| F116 | MEDIUM | A | SHELL | 2 | RESOLVED | yes | Clients get no notification badge on desktop — the bell is buried in the account menu | findings-p161-199.md |
| F117 | MEDIUM | B | SHELL | 2 | RESOLVED | yes | No admin surface shows any client's credit balance, yet every denial tells the client to "ask y | findings-p161-199.md |
| F118 | MEDIUM | A | SHELL | 2 | RESOLVED | — | The Connect page promises "submit managed jobs" and walks through an Instagram job the MCP serv | findings-p161-199.md |
| F119 | MEDIUM | A | SHELL | 2 | RESOLVED | — | The smallest type in the portal sits below the accessibility contrast floor in 143 places | findings-p161-199.md |
| F120 | MEDIUM | A | SHELL | 2 | RESOLVED | yes | The three agent pages print the raw database job status "review" to clients, when the portal al | findings-p161-199.md |
| F143 | MEDIUM | A | SHELL | 2 | RESOLVED | yes | Every notification is truncated mid-sentence and none of them are notifications | findings-p161-199.md |
| F146 | MEDIUM | A | SHELL | 2 | RESOLVED | yes | The Meetings list is not in date order — synced meetings land wherever the sync ran | findings-p161-199.md |
| F121 | LOW | B | SHELL | 2 | RESOLVED | yes | Dismissing a "new content ready" notification only hides it until the next page load | findings-p161-199.md |
| F122 | LOW | A | SHELL | 2 | RESOLVED | yes | Platform names are title-cased from their ids: "Linkedin", "Youtube" | findings-p161-199.md |
| F123 | LOW | A | SHELL | 2 | RESOLVED | yes | "20 agent runs · last 9h ago." | findings-p161-199.md |

**Cluster reassignments (2026-07-28, file-ownership rule):** F110→AGENTS
(custom-agents.tsx), F135→CALENDAR (schedule-run-modal), F15→COPILOT
(chatbot-widget), F85→CREDITS (client-rail), F5→WORKSPACE (archive-view grids).

## Call-directive items (no PDF finding number)

| ID | Cluster | Phase | Status | Directive |
|---|---|---|---|---|
| CD-A2 | ARCH | 3 | RESOLVED | Two-level feedback model: global (parent agent) + per-template |
| CD-A3 | ARCH | 3 | RESOLVED-PARTIAL | Per-slot notes captured, guarded, surfaced to staff with applied-stamp; AUTOMATIC run-day consumption = Tomer seam (per-slot cron + webhook slot branch, handover §4) |
| CD-A5 | ARCH | 3 | RESOLVED | Analytics/credits: launch cost vs recurring-run cost split per agent umbrella |
| CD-B2 | SEO | 2 | RESOLVED | Remove Perplexity + Copilot from tracked engines (set, chips, scoring) |
| CD-B3 | SEO | 2 | RESOLVED | Category-queries-only measurement; branded queries never feed client-vs-competitor score |
| CD-B4 | SEO | 2 | RESOLVED | Mark pre-2026-07-23 snapshots stale/legacy in UI |
| CD-C1 | — | loop | OPEN | Mock-client pass sanity-checks competitor/citation data vs stored snapshots |
| CD-D1 | ARCH | 3/4 | RESOLVED-PORTAL / TOMER-INFRA | Video: portal half complete (videoUrl type, resolver, 3 render surfaces); bucket/upload/access = Tomer T5 |
| CD-D2 | AGENTS | 2 | RESOLVED | TikTok connector state shown as pending verification, not pretending |
| CD-E1 | SHELL | 2 | RESOLVED | Remove "Agent-specific documents" section from the client rail (setup lives on AI Agents cards) |
| CD-E2 | SHELL | 2 | RESOLVED | Brand colors: 3-4 swatches + internal usage-percentage catalog (staff-visible %, client sees swatches) |
| CD-E3 | SHELL | 2 | RESOLVED-PARTIAL | No-scroll contract holds at ≥1440×900 after CD-H2's inline Brand Colors; at 1280×800 rails are 56px (staff) / 80px (client) over — Albert decision pending: accept scroll there or name a section to compress |
| CD-F1 | — | end-loop | RESHAPED→CD-G7 | Fleet regenerate: superseded by CD-G7 completion-pass design (internal agents, no API key top-up) |
| CD-F2 | SHELL | 2 | RESOLVED | Competitor Track favicons: every row shows the real favicon (fix resolution/fallback for rows showing the generic building icon) |
| CD-G1 | AGENTS/P3 | 3 | RESOLVED | Agents roster → full-page per-agent detail route; no Run Now on cards; click opens page (rescopes.md third batch) |
| CD-G2 | AGENTS/P3 | 3 | RESOLVED | Client blurbs rewritten: concrete/salesy-short, no buzzwords; backfill script drafts, code fallback |
| CD-G3 | AGENTS/P3 | 3 | RESOLVED | Kill "one agent per platform" copy + demote Bind to staff plumbing |
| CD-G4 | SHELL | 3 | RESOLVED | STAFF sidebar top block = baseline to DOCUMENTS; chip ↗ → client website; competitor rows get ↗ + keep hover trash |
| CD-G5 | SHELL | 3 | RESOLVED | Regenerate admin-only (verify) + add client-dashboard Regenerate entry point (covers docs+SEO/geo) |
| CD-G6 | DASHBOARD | 3 | RESOLVED | Revert F124 counter collapse to baseline tiles; keep F99 |
| CD-G8 | SHELL | 3 | RESOLVED | Copilot dock fixed to bottom, spans to right edge, no dead air in panel; phone/md/lg verified; Albert-match review lens at wave end |
| CD-G9 | SHELL | 3 | RESOLVED | Bottom tab bar below md in client-context staff shell; copilot outside-click dismissal; support/theme/bell move into Company (overrules F116 bell placement) |
| CD-G10 | WORKSPACE | 3 | RESOLVED | Board toolbar one straight row; run-pending CTA placed without distorting it |
| CD-G11 | SHELL | 3 | RESOLVED | Brand color swatch click copies hex to clipboard with visual confirmation |
| CD-H1 | DASHBOARD | audit | RESOLVED | Counter tiles first section under Overview (client) |
| CD-H2 | SHELL | audit | OPEN-ALBERT | Rails fit 1440×900 after inline Brand Colors; 1280×800 still 56/80px over — accept scroll or authorize compression |
| CD-H3 | SHELL | audit | RESOLVED | Competitor ↗ derives via favicon's domainFromName when url absent |
| CD-H4 | SHELL | audit | RESOLVED | Client overview cards min-w-0, no 375px clipping |
| CD-H5 | SHELL | audit | RESOLVED | Client bell into Company sheet + dot; slim logo/credits strip kept (flagged to Albert) |
| CD-H6 | SHELL | audit | RESOLVED | Company sheet closes on md crossing; no orphan click catchers |
| CD-H7 | WORKSPACE/SHELL | audit | RESOLVED | a) container-query toolbar (deviation flagged) b) one badgeLabel c) one-clock calendar d) Landing Builder blurb |
| CD-H8 | AGENTS | audit | RESOLVED | Legacy live-schedule detail page: run gesture, pace, deliverables |
| CD-I1 | AGENTS | 5 | OPEN | Per-archetype agent detail pages (template-calendar / clip-maker / daily-finder) + staff parity; after Tomer merge |
| CD-G7 | — | end-loop | OPEN | Fleet COMPLETION refresh: one team per client, keep existing data, internal Claude agents, --apply-gated Firestore writes; runs after CD-G1..G6 |

## Guard zones (all phases)
- No deep rework of AI Insights (fix listed defects only) — call directive B5.
- Never expose pre-generation of content to clients — churn rule A3/A4.
- CLAUDE.md conventions: server-action writes, epoch millis, credits vocabulary.
