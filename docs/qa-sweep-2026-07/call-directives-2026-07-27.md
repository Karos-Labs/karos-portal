# Call directives — 2026-07-27 (Albert + Daniel + team)

Source: call summary + transcript dropped by Albert 2026-07-28. This file is the second
input to the QA-sweep master plan, alongside the 137-finding PDF inventory in
`inventory/`. Where a directive matches a PDF finding it is cross-referenced; items
marked **NEW** are not in the PDF and must be added to the plan.

## A. Product architecture directives (the big one)

### A1. Launch vs Runs model — maps to F148, F147, F129, F131
Every client-facing content agent splits into two layers under one umbrella
("Instagram agent for Geektime"):

1. **Setup agent (launch)** — one-time, heavy. Researches the client, defines goals,
   generates the template set, CTA logic, posting strategy. Portal shows guided
   progress ("we're doing research on you" → "these are your templates because…").
   Until launch completes, the agent is not live.
2. **Recurring templates agent (runs)** — after launch, UI flips to a live-agent view:
   parent agent + child templates, calendar, reorder/swap templates, manual
   "run this template now" for 25 credits, feedback controls.

Parent-child structure everywhere: parent = the platform agent for the client;
children = template streams. **Unify "Instagram agent" and "Social posts (IG/TikTok)"
into one** (F147). TikTok may be a 1-template agent; X maybe 2 — the model must
tolerate per-platform template counts.

### A2. Two-level feedback model — NEW (portal has nothing for this)
- **Global feedback** on the parent agent → shapes all templates ("all posts should
  feel more editorial", "only pull from our website").
- **Template-level feedback** on a child → shapes only that stream ("drop this
  format", "more of template B").
Feedback must be stored, visible, and consumed by run-day generation.

### A3. Calendar behavior — maps to F109, F111, F112, F84
- Calendar shows upcoming **slots** (template type + date), never pre-generated
  content. Content is generated on the day of execution.
- Client can reorder the calendar, choose template mix, set frequency.
- **Client can drop a note on a specific day/slot**; the run-day generation consumes
  the note ("today is Thursday, take this into account"). NEW.
- Clients must NOT be able to tell that (for now) posts are generated in advance
  internally — churn risk ("just give me all the posts"). No UI that implies the
  content already exists before its day.

### A4. Archive = posted only — maps to F149, F66
Flow: slot on calendar → day-of generation → client downloads/posts → client clicks
**"Mark as posted"** → item moves to Archive. Archive shows the last ~30 days of
*posted* items only (consider auto-expiry after 30 days). Unposted/unapproved drafts
never sit in the archive wall (also fixes F47's "unapproved drafts straight away").

### A5. Analytics: launch cost vs run cost — NEW (extends F130)
Under each parent agent, track and display separately:
- setup/launch cost (one-time) vs recurring run cost
- per-template usage/cost where useful
- manual "run now" vs scheduled runs
Rationale from the call: onboarding pipeline is the biggest cost driver (493 runs
logged incl. tests/retries, ~$8.5 each at one point; SEO GEO only ~$13 total). Albert
wants launch-vs-recurring economics visible. Credits pricing per agent should stop
being a flat "25 credits per output" everywhere (F130) and reflect this split.

## B. SEO GEO dashboard directives

- **B1. Rename "Search engines" label** — F144 (call: sounds like AI search; agreed on
  the call).
- **B2. Remove Perplexity and Copilot from tracked engines entirely** — NEW. Remove
  from tracked-engine set, UI chips, and scoring inputs.
- **B3. Category-queries-only measurement** — NEW. Client-vs-competitor visibility
  must be measured only on category/buyer queries, never branded queries (branded =
  unfair advantage = biased score shown to client). Audit where branded queries leak
  into the score/citation displays.
- **B4. Snapshot trust cutoff** — snapshots before 2026-07-23/24 (pre-redeploy) are
  unreliable; relates to F20 (bare machine date, no staleness cue). Consider marking
  pre-cutoff snapshots as stale/legacy in UI.
- **B5. AI Insights panel: leave as-is for now** — Albert: "no more touches on this,"
  improve later. Do NOT deep-rework AI Insights beyond fixing outright defects listed
  in the PDF (e.g. F125 demo-data badge, F126 literal asterisks).

## C. Operational / verification items (not code fixes, but in scope for our QA loop)

- **C1. Verify competitor tracking + engine citation data accuracy** — Albert took
  this on the call; our mock-client verification pass should sanity-check displayed
  data against stored snapshots.
- **C2. Reload credits + Regenerate SEO GEO** — human/ops step (needs real credits);
  note in handover.
- **C3. Connected channels / LinkedIn status accuracy** — check the status shown is
  real (relates to F145 silent token-death vanishing).
- **C4. Meetings tab sort order** — F146. Fix chronological ordering (Daniel said
  "I will fix it" — but it's in the PDF as F146, so it lands in our plan; check git
  for a recent fix before redoing).

## D. Tomer / infra-bound items (handover doc, not our build)

- **D1. Video deliverables via GCP block storage** — F150. Plan: videos stored in GCP
  block storage; agent service fetches from there; no media in GitHub. We can build
  the portal-side rendering/URL plumbing against a storage-URL field; Tomer wires
  actual GCP storage + upload path.
- **D2. TikTok connector** — blocked on TikTok verifying the Karos Labs account.
  Portal should represent the TikTok agent (unified model per A1) with connector
  state "pending verification" rather than pretending.
- **D3. Password rotation (Hello email account)** — pure ops, flag in handover only.

## E. Context worth keeping (no action)

- 8-agent TikTok build + demo video = Daniel's task, outside portal.
- Geektime is the target client for TikTok (podcast clips, tech content); Pitch by
  Deel currently gets posts via daily email from Hello account (no portal access yet);
  podcast scripts delivered but client can't access calendar — extra reason A3/A4
  must be smooth.
- Instagram proof point: Apple shared a post produced by the engine.
- Daniel is finishing a fuller product document; this plan should absorb it when it
  lands without restructuring (keep the ledger append-able).
