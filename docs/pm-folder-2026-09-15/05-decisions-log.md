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

## Open

| Id | Question | Owner | Blocks | Proposed default until decided |
|---|---|---|---|---|
| O01 | Approve the three-layer craft model (global base, sector overlay, client layer) and its precedence | Albert | N2, N3, N9 | As written in Craft 11 |
| O02 | Humanizer: Rephrasy behind a per-client flag, and the budget | Albert | N8, K5 | Flag off; blind test on one pilot client |
| O03 | AI-generated people in images and video: the call allowed them; Instagram penalises reach on them and TikTok prohibits real-person likeness | Albert | Instagram and TikTok agents | No real people in AI imagery on any platform; AI objects and scenes allowed, labelled where required |
| O04 | Default stage mix until a client has performance data | Albert | N4 | 3 attention : 2 expertise : 1 decide per six posts, logged as a default |
| O05 | Reddit's May 2026 AI-content policy: tell the client at setup that a human must read, edit and own the reply | Albert | Reddit setup copy | One line at setup |
| O06 | Campaign agent: keep, hide, or coming soon | Albert | F1 | Hide until decided |
| O07 | Client visibility of the sector overlay and the platform pages ("how we write for X") | Albert | F1 | Internal |
| O08 | Autopilot policy per platform | Albert | CN7 | Manual for every new client. Autopilot offered on Instagram, X (with the separate consent screen the X rules require) and, after the Content Posting audit, TikTok. Never on LinkedIn (self-serve API terms forbid automated posting), Reddit, Google Business Profile, Pinterest. See 03 section 4 |
| O09 | Store for the subject table and logs: Firestore or Postgres | Tomer, Shlomi | B1, B2 | Firestore |
| O10 | Scraping provider per platform for metrics and own-account reads | Tomer, Shlomi | N6 | Connectors first; scraping only where the client does not connect |
| O11 | Owners and sizes for the build-plan items | Tomer, Shlomi | all items | tbd |
| O12 | Copywriting stack beyond the lint and humanizer: prompt spec per platform | Albert with Tomer | K5 | The platform pages' writing rules as the spec |
| O13 | Build or buy for the visual and video platforms | Albert | CN9 | Buy: Ayrshare Business, four-week paid pilot on three clients; keep X, LinkedIn and Google direct. See 03 section 5 |
| O14 | Open the accounts and file the applications listed in 03 section 8 (X developer, Meta verification, LinkedIn Community Management, TikTok audit, Google Business Profile access) | Albert | CN2 to CN6 | File in that order; each is weeks |
| O15 | LinkedIn stays draft-only for publishing (the person posts in one click); Karos staff never act as a client's page admin | Albert | CN5 | Yes |
| O16 | Credits charged per published post, and the extra charge for autopilot (the plans themselves are settled, D27) | Albert | CN7, CN9, 07 | One credit line per published post; autopilot posts charged higher; add the rows to 07 |
