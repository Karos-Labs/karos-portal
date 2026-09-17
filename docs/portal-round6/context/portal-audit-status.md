# Portal flow audit — what was suggested, what is done, what is still open

Source: the "Portal Flow Audit" report (2 Sep 2026) plus the setup-ladder and credits design audits. Everything below is on main and deployed to prep as of PR #79 unless marked open.

## Recommendations (R1–R18)

| # | Suggestion | Status |
|---|---|---|
| R1 | Keep the "Setup is running" promise: poll the intake page while a run is in flight | Done (age-bounded; a failed run gives the button back) |
| R2 | Fix the one Run button that threw clients onto the staff jobs page | Done (in-place "run started" state, errors sanitized) |
| R3 | Quote the price on every control that spends; stop charging silently from "Save company page" / "Add seat" | Done ("Costs about N credits"; labels now name the run) |
| R4 | Undo instead of confirm for dismissals; two-step confirm for one-off destructive presses | Done (6-second Undo; confirms on Stop tracking, Remove logo/avatar) |
| R5 | Put the calendar's state in the URL | Done (view, date, archive filters, legend chips; Back/Forward work) |
| R6 | Promote Archive out of the Day/Week/Month strip | Done (own control + "Back to calendar", legend hidden in archive) |
| R7 | One vocabulary per destination and action | Done (Archive / Pin / Support; intake labels match their page titles) |
| R8 | One row affordance: whole-row link with a trailing chevron, inert rows get no hover | Done |
| R9 | Every client-facing empty state gets an action | Done (agents, calendar preview, archive, dynamic agents, intakes' "No runs yet", not-on-plan boundary) |
| R10 | Make the bell honest (no link-shaped dead rows) | Done (client summary rows) |
| R11 | Restore /team and /transcripts to the navigation | Done (Team in the account menu for group admins; "See all meetings" in Settings) |
| R12 | Give the copilot one way out to a deliverable | Done (deliverable chip opens the asset modal) |
| R13 | Split the Documents stack: reader as a panel, Correct Info the only modal | Done |
| R14 | Break the branding dialog into two Saves; don't discard AI generations silently | Done (two sections, close-with-unsaved confirm; generation is already saved) |
| R15 | Resolve the two run buttons on the agent page | Done (primary button names the format it runs) |
| R16 | One family→route table | Done |
| R17 | Housekeeping (Show fewer, re-collapse channels, OAuth popup closed early, myaccount link, Seats link, Contact on coming-soon tiles and failure copy) | Done, except `task-ticket-modal.tsx` kept (tests and a spec still reference it) |
| R18a | Brand voice is editable only in the onboarding wizard; afterwards only a paid AI rewrite | **Open — your call**: add a plain brand-voice editor to Profile? |
| R18b | The Credits tab has no top-up path; "Request more credits" appears only once blocked | **Open — your call**: self-serve top-up, or an always-visible "how credits are added" line with Support |

## Findings not fully covered by a recommendation

| Finding | What it said | Status |
|---|---|---|
| F13 Depth to primary tasks | Enter agent inputs takes 3–4 clicks with three differently-labelled controls; connect a channel is 4 clicks via Account Center; edit brand voice impossible after onboarding; older meetings (>12) unreachable | Partly: intake labels unified, "See all meetings" added. **Open**: a direct "Set up" shortcut from the rail agent row; a Connect-channel shortcut on Home; brand voice (R18a) |
| F14 No active nav item on /team, /transcripts, intake pages; no breadcrumbs | The rail cannot say where you are on those pages | **Open**: mark the nearest rail item active (AI agents for intakes, Account Center for transcripts/team) and add a "‹ Back" breadcrumb like the agent page has |
| F15 Modals carrying whole workflows | BrandProfileModal mixes immediate writes (logo) with deferred ones behind one Save; the LinkedIn seats roster is an unbounded list inside a modal | Documents and Branding done. **Open**: split BrandProfileModal's immediate vs deferred writes; move the seats roster to a page section |
| F16 Three near-identical edit affordances in one 60px block | Two pencils + a contact glyph on the brand card lead to three different editors, no visible text; repeated on Profile | **Open**: one "Edit" entry opening a single editor with sections (profile, brand guidelines, colours) |
| F17 Raw system state reaching the client | Verbatim service errors; a browser alert() in documents; bare notFound() for ungranted agents | Done for the dynamic run and the not-on-plan boundary. **Open**: replace the `alert()` in client-documents.tsx with an inline notice |
| F18 Copilot is a terminal surface | /edit-output, /inspect-job, /reschedule-post, /schedule-run resolve to prose | Deliverable chip done. **Open**: chips for the other four commands (reschedule → calendar day, schedule-run → agent page) |
| F19 Smaller items | All listed | Done, except social squares with an unparseable handle still look identical to clickable ones (**Open**: dim them or hide them) |

## From the setup-ladder audit (Home checklist)

- Done: the six-step "Get set up" checklist, per-client agent order at onboarding (deterministic).
- **Open**: an optional LLM pass to re-order the ladder from the brief and brand voice (documented seam, not built).
- **Open**: a secondary "More ways to get value" list for the 18 later-value actions (connect channels, competitors, calendar habits, feedback, mark posted, seats, pinning, exports) — the old Next actions rows, shown after setup completes.
- **Open**: Instagram/karos-content agents have no client self-service setup path; the checklist shows "Karos is setting this up for you". A client-facing intake for that family would close it.

## From the credits audit

- Done (behind the flag): 2600/month cap and top-up, hold→settle to actual cost × 20, exemptions, self-calibrating estimates, staff "cost to us" panel.
- **Open**: in-app actions (copilot turns, Task Map refresh, insights, corrections, simulation) settle only once each engine returns its dollar cost; the machinery exists, the wiring is one engine at a time.
- **Open, your call**: does a client ever see their own "cost to Karos" or only credits? (today: credits only, staff see dollars).
- **Open**: run the five prep checks in PR #79 before enabling the flag anywhere.

## Things you asked about earlier that remain undecided

- Calendar "Schedule a run": still staff-only (de-accented, badged Internal) although the server action allows clients.
- Brand guidelines document: `docs/brand/KAROS-BRAND-GUIDELINES.md` is cited by the code but has never existed in the repo; the type rules live in globals.css. Worth writing the real doc.
