# Albert's feedback, round 6 (4 Sep 2026) — the brief every agent works from

## What he said (paraphrased closely; treat as rulings)

### Reporting — "Things only you can do"
- WRONG today: it recommends things our agents exist to do ("Get your name in front of buyers", "Get quoted where the engines are already looking", "Catch up with the competitor leading these answers"). The client does not know how to do those; they are exactly what they pay us for. General advice is not wanted at all.
- WANTED: only STRUCTURAL things that, based on the analysis we ran, the client is doing wrong AND our agents cannot fix (accounts, records, relationships they own). "Claim your public company record" / "Point your public record at your own site" are the right kind. Keep it short.
- Move "Things only you can do" to the very bottom of Reporting.
- ADD above it a section "What we are actively doing to improve your SEO and GEO" (can be general): list every relevant Karos agent with what it does for visibility — e.g. Reddit agent → references in threads the engines cite; LinkedIn agent → LLMs like to quote LinkedIn; X, blog, newsletter, landing page, Instagram — each with a button that links DIRECTLY to that agent's page where they can run it.

### Interaction logic — "unified throughout"
- Home KPI cells light up on hover; the SEO & AI visibility cells do not. Every card/button/row must follow ONE interaction logic across the portal (what is clickable looks clickable, what is not does not; same hover, same focus, same chevron rules).

### Get set up (Home checklist)
- Why does only one step show "Let's do this"? Is "Let's do this" even the best CTA?
- Clicking "Complete your profile" lands on Account Center → Profile with no indication of what to do; the profile may already be complete. Each step must be TAILORED: say precisely what is missing, land on the exact field, and the CTA should name the action. Detect what is already done. Needs real thought.

### Agent detail page
- The status strip ("RUNS ON REQUEST", last delivered, in your Workspace) "doesn't look that good"; the "RUNS ON REQUEST" badge beside the logo is maybe unnecessary — investigate whether it should exist at all.
- LOGIC BUG: we pre-created content that the client receives every day on their portal, yet the page does not say the agent is live; it says runs on request. The status must reflect reality (content is being produced daily).
- "Create a post" modal: collapse everything optional into one section; it is "a bit scary, a lot of details". The "Start run" button looks bad; the footer box (~30 min · costs about 25 credits) looks bad; the dashed "No reference files" box looks bad. Make starting a run straightforward.

### Sidebar
- Unstarred stars in the agents list: should they be there at all? Maybe starring lives only on the agent page. Research what a good sidebar list/button style looks like and propose.
- General: "not sure this sidebar is the best look"; research and propose.

### Notifications
- "2 unread" is not clickable; every notification row must be clickable and lead somewhere. Install one logic.

### Account Center
- Remove the Seats card from Profile (not useful).
- (Documents inside Profile stays.)

### Agents tab
- Audit its UI/UX including the not-set-up states.

### Deliverable
- ONE short PDF, high level: what can be changed, where it breaks, what can be done better. No detail dumps. He approves, THEN we integrate on a separate branch with executor agents and risk agents.

## Standing rulings from earlier rounds (do not derail)
- Staff client context renders identical to the client portal; staff extras only as additive, marked blocks (StaffOnlySection / Internal badge).
- Ember brand: charcoal + paper + ONE rationed orange (`--neon`), no new hues; DM Mono for labels, Hanken sans body (numbers sans + tabular), Spectral display. He said he likes the mono "less and less" (already swapped from JetBrains).
- No em dashes in client-facing copy.
- Recommended tasks on Home = the setup ladder (6 steps, progress bar, per-client order), NOT the swarm's content ideas. Content ideas stay on the calendar and the agent-page kickoff strip.
- The SEO/GEO "What we're fixing" canned plan is gone for good; no Approve-to-task from the report.
- Facebook is removed from the product.
- Reporting tab has no Performance / Connected channels; Documents live in Profile; Archive lives on the calendar (`?view=archive`); Meetings inside Settings.
- Credits: 2600/month, hold→settle to actual cost × 20, flag `CREDITS_PLAN_V2_ENABLED` (on for prep, off for production). Prices shown as "about N credits".
- Calendar "Schedule a run" stays staff-only (open decision, do not re-propose).
- Everything a client sees must link to our agents and to them getting outputs; the reporting tab may carry the small amount of feedback we cannot act on.
- Open product questions he has NOT answered: brand voice editable after onboarding? self-serve credit top-up? Do not assume answers; propose, mark as decision.
