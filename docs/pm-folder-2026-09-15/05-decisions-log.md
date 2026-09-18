# Decisions log

Status: approved 2026-09-15 · Owner: Albert · Changes when: a decision is made or reopened. One line per decision. Files link to the id; they do not restate the decision.

## Settled

| Id | Date | Decision | Where it applies |
|---|---|---|---|
| D01 | 2026-09-15 | "Intel" is renamed "Onboarding" everywhere; the pipeline is unchanged | 01, 02, portal UI |
| D02 | 2026-09-15 | The client profile is six client-visible documents; internal documents are added whenever an agent lacks one | 01, 02 |
| D03 | 2026-09-15 | The Home action list is static | portal |
| D04 | 2026-09-15 | One eleven-step flow for every agent; research and drafting are tailored per platform, the rest is shared | 01, 02 |
| D05 | 2026-09-15 | Steps 6 and 10 enrich the profile; a subject table per platform records what was posted | 02 |
| D06 | 2026-09-15 | Three learning sources: research, client feedback, performance; scraped metrics are how agents improve | 02, Craft 11 |
| D07 | 2026-09-15 | AI agents and reporting systems are different things; SEO/GEO and Reputation are reporting, not agents | 01, catalog |
| D08 | 2026-09-15 | TikTok is three agents with three inputs: clipping, editing (today "Branded shorts", to rename), content design | 01, catalog |
| D09 | 2026-09-15 | Catalog bands: up and running (X, LinkedIn, Reddit); beta (Instagram, three TikTok); coming soon (Rebrand, Newsletter/Blog, Landing page, Micro-influencers, Motion design, PR); marketplace items as columns without descriptions | catalog |
| D10 | 2026-09-15 | System first; beta agents ship "good enough" and improve monthly | roadmap |
| D11 | 2026-09-15 | Every output states the point of the post: goal, who it is for, why now; unneeded meta removed from the card | all agents |
| D12 | 2026-09-15 | Dynamic in-run questions replace generic upfront questions; at most two per run; never on calendar runs | portal, engine |
| D13 | 2026-09-15 | Feedback workbook: one tab per agent, one row per finding; Status New (grey) → To do → Done (yellow) → Verified; Won't do with the reason | 06 |
| D14 | 2026-09-15 | Stripe once the entity and bank account exist; not a blocker | roadmap |
| D15 | 2026-09-15 | Cadence is the client's choice in the calendar, not per agent; sequencing decides which post goes in each slot | 02, Craft |
| D16 | 2026-09-15 | The client chooses whether they see their strategy document | portal |
| D17 | 2026-09-15 | Instagram format and visuals are chosen per post by performance and relevance, never by a fixed ratio or rotation | Instagram, engine |
| D18 | 2026-09-15 | Manual Instagram run: the client picks the topic first; calendar run: autopilot | Instagram |
| D19 | 2026-09-15 | TikTok editing is on demand: the client uploads, the agent cuts and adds graphics and captions; no recording brief | TikTok editing |
| D20 | 2026-09-15 | TikTok content design ships as beta | catalog |
| D21 | 2026-09-15 | The newsletter goal mix follows the pillars and what readers open | Newsletter |
| D22 | 2026-09-15 | LinkedIn distribution: post from the person's own profile, the company page reposts, the link in the first comment, the person answers comments in the first hour | LinkedIn |
| D23 | 2026-09-15 | Owners: Shlomi for X, LinkedIn, Reddit and the three TikTok agents; Tomer for Instagram; Albert for Newsletter, Blog, Landing page | 01 |
| D24 | 2026-09-15 | X is text only: it does not create or source pictures; a client's own picture is attached if given | X, engine |
| D25 | 2026-09-15 | Reddit is draft-only by hard product rule; no posting code path exists or may be added | Reddit |
| D26 | 2026-09-15 | We do not sell Facebook. Instagram is the Meta channel; its metrics were removed from the portal. Meta plumbing stays because Instagram publishes and reports through it | 03, portal |
| D27 | 2026-09-15 | Two plans: Starter $29 a month for 200 credits with a $10 ceiling on our cost; Pro $299 a month for 2600 credits with a $130 ceiling. Both are $0.05 of our cost per credit, so a plan is only the client's monthly allowance and the engine needs no change | 07, portal (allowance per client) |
| D28 | 2026-09-15 | A payment system is coming, and the client picks their plan as the last step of onboarding. Until both exist, the credits rework stays switched off: turning it on with no plan field grants every existing client the Pro allowance of 2600 credits, and a granted balance is never clawed back | 07, portal (onboarding, billing, credits flag) |
| D29 | 2026-09-15 | Craft model approved as written in Craft 11: a global base per platform, a sector overlay on top, the client's own learned rules over both. Hard platform rules always win | Craft, N2, N3, N9 |
| D30 | 2026-09-15 | Humanizer: Rephrasy behind a per-client flag, off by default, blind test on one pilot client. Tomer integrates it, or proposes an alternative if it does not fit | N8, K5, Tomer |
| D31 | 2026-09-15 | AI-generated imagery is allowed. Not of real people: TikTok prohibits a real person's likeness and Instagram cuts reach on it, so that stays off limits everywhere. AI objects and scenes are fine, labelled where the platform requires it | Instagram and TikTok agents |
| D32 | 2026-09-15 | Default stage mix until a client has performance data: three attention, two expertise, one decide per six posts | N4 |
| D33 | 2026-09-15 | No Reddit AI-policy line at setup. The client posts the reply from their own account, so they read and own it by definition | Reddit setup copy |
| D34 | 2026-09-15 | The sector overlay and the platform pages are internal. Clients do not see how we write for a platform | F1 |
| D35 | 2026-09-15 | Autopilot: manual for every new client. Offered on Instagram, X (with the consent screen X requires) and TikTok after its Content Posting audit. Never on LinkedIn, Reddit, Google Business Profile or Pinterest. See 03 section 4 | CN7 |
| D36 | 2026-09-15 | Ayrshare is the fallback for the visual and video platforms, not the plan. Tomer builds direct; if that proves too complicated, we buy Ayrshare instead. X, LinkedIn and Google stay direct either way | CN9, Tomer |
| D37 | 2026-09-15 | Tomer owns opening the accounts and filing the platform applications listed in 03 section 8, in the order given there | CN2 to CN6 |
| D38 | 2026-09-15 | LinkedIn stays draft-only for publishing; the person posts in one click. Karos staff never act as a client's page admin | CN5 |
| D39 | 2026-09-15 | Every published post is charged exactly what it cost us, in credits. No separate per-post price, and no surcharge for autopilot | CN7, CN9, 07 |
| D40 | 2026-09-15 | Campaign is not an agent, because it only runs the other agents. It becomes a feature: a button the client presses when they have something to launch, which runs the relevant agents to produce a set of posts around that one event. It is never listed as an agent in the catalog. The engine's campaign-orchestrator stays, because it is what the button will call | F1, catalog, engine |
| D41 | 2026-09-15 | The writing rules on each Craft page are the agent's instructions, not a checklist applied afterwards. A draft graded after the fact is written wrong first, which is slower and produces worse drafts. The pre-delivery checklist stays, as the last gate rather than the method | K5, Craft, engine |
| D42 | 2026-09-18 | **O09 settled.** The learning tables live in Postgres, in the `config` schema, inside **agent-middleware** — and agent-middleware is the only thing that connects to them. The portal and the engine reach them through `project` and `collect`, never through a connection string. Firestore keeps what the portal renders to a person: assets, jobs, clients, credits, follower snapshots | 02, B1, B2, C1, N4, C7 contract |
| D43 | 2026-09-18 | **O10 settled.** Connected platforms only. We read a number when the client has connected the account and the platform's own API will tell us; for everything else we record nothing and say so. No scraping provider, this quarter or next | N6, reporting |

## Open

| Id | Question | Owner | Blocks | Proposed default until decided |
|---|---|---|---|---|
| O11 | Who takes each item in 04, and how long each one is. Without it we cannot say what fits in a week | Tomer, Shlomi | all items | Not estimated yet |
