# Karos: the learning loop, reporting and the full scope

For the team. What the system must do so that every run makes the next one better and the client sees where they stand; exactly what happens at each step; where the code is today; and everything to build to get there. Code references are to the portal repo on `main` 35f366f3. The engine (`agent-engine`) is a separate repo and was not opened.

## 1. The principle

Steps 6 and 10 of the flow need to enrich the client profile. All relevant information found, and all comments the client gives, need to be catalogued so that the next run is more accurate.

Reporting / structuring AI systems (systems that enable agents to perform well, help collect extra data, and give the client proper reporting):
- Onboarding run (output)
- SEO / GEO run
- Reputation run: what the client's customers are saying about them on review websites and in comments on social media. Goal: one global sentiment of what people think of them.
- From scraping: track social media metrics (audience across platforms).
- Show growth data.

These systems scrape data to give accurate reporting to the client of where their business stands, and let us collect additional data on the client. This, plus the data on their activity across our agents (number of posts and so on), comes together on the home page as a full overview of how they perform digitally and how we make them better.

Tracking metrics is crucial to improve each agent. Once we can track how posts perform, we report back to the specific agent or client profile: now we know what performs and we double down. Determine why one specific thing worked better → implement it.

---

## 2. The flow, full scope

What each step takes in, what it does, what it writes, and what the next run reads. This is the target; §5 says where each step is today.

| Step | Data in | What happens | Data written | Read next by |
|---|---|---|---|---|
| 1. Sign up | Name, email, website | Account created, client created, onboarding started | Client record with website | Step 2 |
| 2. Study the business | Website | Crawl the site; research the market, competitors, audience language; extract the brand kit (site + Instagram grid); baseline search and AI visibility | Onboarding report, competitor list, brand kit, SEO/GEO baseline | Step 3, reporting |
| 3. Profile | Step 2 output | Six client documents + internal documents (client guidelines, action plan) + the checklist; client reads and corrects | Profile v1, versioned; correction history | Every run (step 5) |
| 4. Run | Agent, optional note, options; or a calendar slot | Manual run: the client's note is the steer. Calendar run: the client's cadence gives the slot, sequencing (§3.4) picks stage, type and subject for it | Run record: agent, identity, slot, goal | Step 5 |
| 5. Read the profile | Profile, brand kit, platform state, subject table, feedback log, what-works summary, forbidden topics | Everything the agent needs is assembled and handed to the run, live, not a snapshot from onboarding | Run context | Steps 6–9 |
| 6. Research | Platform, audience, competitors' socials, trends, the client's own account | Platform-specific research. First run: build the platform state (where the client stands there, top posts, what works, options) and the platform voice file. Every run: update it | Platform state doc, voice file, research findings appended to the profile's learned log | Step 7, next run's step 5 |
| 7. Decide | Research + strategy map + what-works | Relevant × trending × performing → one candidate with its stage and goal, and why now | Candidate record | Step 8 |
| 8. Vet | Candidate, profile direction, forbidden topics, competitor list | Direction fit; forbidden topics; no competitor promotion; platform rules | Pass or hold, with the reason | Step 9 |
| 9. Draft | Candidate, voice, brand kit | Copy with hook and story; visuals for Instagram and TikTok | Deliverable with goal, for, why now, sources; subject-table row (status: drafted) | Step 10 |
| 10. Review | Deliverable | Approve, change, regenerate; outcomes recorded | Feedback log row; derived preferences (never-topics, likes, voice lessons); revision | Next run's step 5; the subject row (approved / skipped) |
| 11. Repeat | Cadence from the calendar | Scheduled runs; on posting, the subject row is marked posted | Subject row status; schedule | Performance ingestion |
| After posting | Post metrics, follower counts | Ingest performance per post and per platform; find the outliers and why; regenerate the what-works summary | Performance table, follower series, what-works summary per platform | Next run's steps 5 and 7; reporting |

---

## 3. The learning loop in detail

### 3.0 Where the store lives (D42)

**The learning tables are Postgres tables in the `config` schema, and they live inside
agent-middleware.** That is the answer O09 was asking for, and it was an option nobody put
on the list: the question read "Firestore or Postgres", and both answers assumed whoever
needed a row would open a connection to it. Neither the portal nor the engine has one.
agent-middleware owns the schema and is the only thing that connects to it; everyone else
asks it. The engine receives a projection into its run workspace before the run and hands
its state back to `collect` afterwards, and it never sees a database of any kind — that is
invariant 3 of the C7 run-context contract, not a convention. The portal reads the same way,
through the middleware's API.

What is in there: the subject table, the feedback log and the preferences derived from it,
the strategy map and its rows, the craft rules, the per-client-per-platform platform state,
the per-run state records, and the learning settings. Nine tables, all keyed by client slug
and platform, all created by `migrations/0007_learning_loop.sql`.

**What stays in Firestore is everything a person looks at.** Clients, jobs, assets and their
meta, credits and the credit ledger, the marketing-analytics rows, and the follower
snapshots. The rule that separates them is not "old versus new": it is whether the row is
rendered to a human in the portal, or read by an agent to write better next time. A follower
count is on a client's dashboard, so it is Firestore; a subject row exists so that next
week's post does not repeat this week's, so it is Postgres. Anything that needs to be both
is written once, where its reader is, and projected — never copied.

### 3.1 Three sources, and what is catalogued from each

**Research (step 6).**
- Market facts and competitor moves with source and date.
- How the audience talks on that platform: vocabulary, formats they consume, accounts they follow.
- Platform state per client: account size, posting history, top posts and why, what we have posted there, the options for direction.
- Trends used, so a trend is not reused after it fades.

**The client (steps 3 and 10).**
- Never-topics and off-limits ("never talk about this").
- Likes ("I like content like this"), with the post it referred to.
- Edits: the original draft and the final text. The difference is the voice lesson.
- Skips with the reason; change requests as standing instructions.
- Corrections to the documents.

**Performance (after posting).**
- Per post: impressions or views, likes, comments, shares, saves, clicks, engagement rate, with the date captured.
- Per platform: followers over time.
- Aggregates per type, stage, template, source: what works, on evidence.

### 3.2 The stores (target)

| Store | Keyed by | Holds | Written by | Read by |
|---|---|---|---|---|
| Profile documents | client × doc type | The six client documents and the internal ones, versioned; a learned log appended per run | Onboarding, corrections, research write-back | Every run |
| Platform state (the introduction doc) | client × platform | Account, followers, posts total, posts by us, top posts and why, what works, options, voice file, last updated | First run builds, every run updates, performance ingestion updates | Every run on that platform |
| Subject table | client × platform × date | Subject, angle, type, stage, goal, run, asset, status (drafted / approved / posted / skipped), metrics reference | Draft (step 9), review (step 10), posting (step 11) | Sequencing, research, anti-repetition |
| Feedback log | client × agent × account | Action (posted / posted with edits / skipped / change requested / note), reason, original text, final text, date | Review (step 10) | Every run; preference derivation |
| Derived preferences | client | Never-topics, likes, voice notes, standing instructions | Derived from the feedback log | Every run; vetting |
| Performance table | client × platform × post | The per-post metrics above, per capture date | Ingestion (API or scrape) | What-works summary, reporting, sequencing |
| Follower series | client × platform × date | Followers, following, posts | Ingestion | Reporting (audience, growth) |
| What-works summary | client × platform | The outliers, why they worked, the rules derived, per type and stage | Regenerated after each ingestion | Steps 5 and 7 |

Anti-repetition rule: no subject repeats on the same platform within the window (Reddit already uses 30 days; the window per platform is a setting). The subject table is what the rule reads.

Store choice: Firestore for all of the above. It is the database we have, every read is per client, and the subject table is a per-client, per-platform query. Postgres only if cross-client analytics is needed later; telemetry already goes to BigQuery for that. Tomer and Shlomi confirm.

### 3.3 Read-back: what every run receives

1. The profile documents the agent needs (Instagram: brand guidelines and the brand kit are mandatory).
2. The platform state for that platform.
3. The subject table for that platform, recent window.
4. The feedback log for that account, recent rows, plus derived preferences.
5. The what-works summary for that platform.
6. Forbidden topics and the competitor list, for vetting.
7. The strategy map (problems × stages) and the slot's stage when the run comes from the calendar.
8. The platform rules for that platform, from its Craft page: the base rules, the client's sector overlay on top, and the client's own learned rules over both. The run cites the rule ids it applied so the loop can measure them. See Craft 11 Best practices as a system.

Mechanism: assembled by the portal at submit time and handed to the run as run input, or projected into the engine workspace immediately before dispatch. Either way it is live data at run time, never an onboarding-time snapshot.

### 3.4 Sequencing: which post goes when, and why

- Input: the client's cadence from the calendar; the strategy map with a stage on every row; the subject table; the what-works summary; news anchors and client requests.
- Output per slot: stage, type, subject, goal, why now.
- Rules: never the same stage or type twice in a row; promotional at most one in six; a timely post only when a real anchor exists; weight towards what performs; a client request wins.
- Instagram: format and visuals per post by performance and relevance, never a fixed ratio.
- TikTok editing is outside sequencing: on demand.

### 3.5 The goal on every output

Every deliverable carries: the goal (earn attention / show expertise / help them decide), who it is for (the problem it speaks to), why now (news, trend, request, or a post of this kind that performed), the type, the sources. Shown to the client; recorded on the subject row.

---

## 4. Reporting systems in detail

| System | Measures | Sources | Frequency | The client sees | Feeds back to |
|---|---|---|---|---|---|
| Onboarding output | The business, market, competitors, audience, brand | Site crawl, research, brand extraction | Once, then on regenerate | The onboarding report; the six documents | The profile |
| SEO / GEO | Classic search rankings for the target queries; visibility inside AI answers (ChatGPT, Perplexity, Gemini, Claude, Copilot): appears, cited, first; site and readiness checks; recommendations | Search Console; AI engines queried directly; site crawl | Monthly, and on demand | Rankings and AI visibility over time; the prioritised plan; what we do per agent to improve it; what only they can do | Tasks; the blog cluster map; the profile |
| Reputation | New reviews and comments; sentiment per surface and overall; recurring themes; what needs a reply; what needs a person now | Google Business, Yelp, App Store, Trustpilot, Facebook; comments and mentions on the social platforms | On the client's cadence | One sentiment score and its trend; the themes; the drafted replies; the flags | The profile (what customers say); the agents' topics |
| Social metrics | Followers per platform, total audience | Platform APIs where connected; scraping where not | Daily or weekly | Audience per platform and total | Platform state; growth |
| Growth | Change over the month and over time, per platform | The follower series | Derived | Growth over the month, over time | Reporting |
| Post performance | Per post: views, likes, comments, shares, saves, clicks; per type, stage, template | Platform APIs where connected; scraping where not | Daily for the last 30 days of posts | Each post's numbers; the best post and why | What-works summary; sequencing; the agents |
| Agent activity | Posts produced, approved, posted, per agent and platform | The subject table and assets | Live | What the agents produced this month | Home |

Home page composition, top to bottom: where you stand (search and AI visibility, sentiment, audience and growth), what performed (best posts and why), what the agents produced, what to do next (the checklist and the tasks). Plus the plain-language line per agent on how it improves presence, which exists today as the Reporting tab's lever table.

Data acquisition: API through the existing OAuth integrations (Instagram, LinkedIn, X, YouTube, TikTok, Reddit, Search Console, GA4, Google Business) where the client connects; scraping where they do not. Providers in use today: Scrappy Coco (brand evidence only), xAI for X reads, Apify for LinkedIn profiles. The scraping provider per platform for metrics is a decision to make.

---

## 5. Where we stand now

Per component, with the evidence. Everything runs on agent-engine since agent-service was deleted on 2026-09-02; the six agent contract docs in `docs/*-agent-portal.md` describe the deleted path.

**Flow steps 1–3.**
- Signup is invitation-key only (`src/app/signup/page.tsx:33`); no key → disabled queue (`src/lib/auth.ts:164-181`). The client wizard never asks for a website; only staff create clients (`src/lib/actions/client-actions.ts:29`). Onboarding refuses without a lab slug (`src/lib/agent-engine/dispatch-research-agents.ts:57`).
- The onboarding pipeline dispatches two engine runs and scrapes nothing itself (`src/lib/intel/report.ts:126-237`); the portal fetches the site only for branding (`src/lib/branding.ts:901`, Scrappy Coco for screenshot and Instagram grid). "Intel" still appears in seven UI places.
- Eight document types, six client-visible (`src/lib/intel/agent-onboarding.ts:65-82`); corrections work (`src/lib/intel/doc-corrections.ts`); no revision history (`src/lib/data.ts:1858`). The checklist is preset (`src/lib/action-list.ts:8-17`); the generated action plan is read by nothing. Brand kit carries font names, not files (`src/lib/types.ts:1737-1775`).

**Step 4, the run.**
- One steer box plus kind of post and number of posts (`src/lib/custom-agent-launch.ts`). No dynamic questions. Status is one keyword headline (`src/lib/run-step-headline.ts`). Client recurrence is weekly only (`src/lib/actions/planned-run-actions.ts:247-318`). No sequencing: a calendar slot does not choose a stage or subject.

**Step 5, reading the profile.**
- The engine reads the profile from its workspace: `context/<docType>.json`, `client/brand.json`, `client/profile.json`, written at onboarding end, regenerate, or branding refresh (`src/lib/agent-engine/context-doc-projection.ts:49-59`), plus `knowledge/*.json` from the reconcile cron (`src/lib/agent-engine/knowledge-sync.ts`). Not per run.
- The per-agent context files (intake, seat voice profiles, what's-new, takes, learning logs, prior drafts, state files, standing feedback) are still built on every run (`src/lib/jobs/submit-custom.ts:420-651`) but attached only to the deleted agent-service call (`:900`). The engine run receives the form fields (`toEngineRunInput`, `src/lib/agent-engine/product-mapping.ts:524-638`) plus, for reputation only, the intake (`submit-custom.ts:599-612`). Nothing the portal learned reaches a run.

**Step 6, research and platform state.**
- Research is engine-side, not visible here. No first-run branch; X has no setup; LinkedIn, Reddit and Reputation setups are engine pre-flights. Voice profiles (`seatVoiceProfiles`) and state rows (`liAgentState`, `redditAgentState`, `newsletterAgentState`, `blogAgentState`) were written only by the deleted webhook. No platform state doc. Own-account fetchers for Instagram exist with no callers (`src/lib/integrations/analytics-providers.ts:276,306`). Competitor sync from SEO/GEO has no caller (`src/lib/intel/competitor-sync.ts:30`).

**Steps 7–8, decide and vet.**
- No performance signal reaches a run: benchmarks feed only the Task Map and chat (`src/lib/execution-engine.ts:397`, `src/lib/agent-swarm.ts:608`). `Client.forbiddenTopics` is enforced only on Dynamic Agent Studio runs (`submit-custom.ts:1168-1268`). No competitor check anywhere.

**Step 9, drafting.**
- No portal-side copywriting control. Instagram halts at `03-claim-topic` on an empty topics catalog, `UNSPLASH_ACCESS_KEY` missing (`product-mapping.ts:164-171`); Branded shorts blocks at `00-brand-resolve` without a profile path. The Instagram "rotate" format is a fixed every-third rule today. No goal on any output; X shows a lane label, Reddit shows "why this thread", LinkedIn nothing; the engine's lane, angle, content mode and thread meta are stored and not rendered (`src/lib/agent-engine/materialize.ts:332`).

**Step 10, review.**
- Draft actions are stored per family (`xDraftFeedback`, `liDraftFeedback`, `redditDraftFeedback`) and standing feedback in `clientAgentFeedback`. Nothing regenerates; "request changes" is staff-only (`src/lib/actions/agent-engine-actions.ts:48`); no revision rounds. No derived preferences; `forbiddenTopics` has no writer. The X reply-URL bug: any URL in a meta bullet renders as a link (`src/components/x-drafts-review.tsx:181-205`).

**Step 11 and after: repeat, performance.**
- Per-post metrics are captured for connected channels by cron (`src/app/api/analytics/sync/route.ts`) into `clientMarketingAnalytics`, shown staff-only (`src/app/(app)/clients/[id]/page.tsx:1051-1093`), never read by a run. Follower snapshots have a store and a writer with no caller (`src/lib/follower-tracking.ts:11-30`); the audience tile is hidden. No what-works summary. No subject table: the nearest are per-family text blobs with no live writer, nothing for X or Instagram.

**Reporting.**
- Onboarding report rendered (`src/app/api/clients/[id]/report/route.ts`).
- SEO/GEO measures AI-answer visibility across five engines plus 60 site checks (`src/lib/seo-geo.ts`); classic rankings missing, the Search Console fetcher has no callers (`src/lib/integrations/google-search-console.ts:40`); monthly schedule; renders on the Reporting tab and a Home card; the lever table per agent exists (`src/lib/visibility-levers.ts:148-212`).
- Reputation is a runnable agent with a five-field intake; drafts and flags; no sentiment score; comment and mention fetchers exist with no callers (`analytics-providers.ts:306,376,433`).
- Social metrics and growth: missing; OAuth wired for nine platforms (`src/lib/integrations/platforms.ts:197-461`); no scraping layer.
- Home: setup ladder, calendar preview, published count, category presence and share of conversation, attention items. No unified performance view.

**Catalog and gates.**
- Roster is flat, no band or beta field (`src/lib/client-agents.ts:702`); SEO/GEO and Reputation ship as runnable agents; content design, Rebrand and the marketplace three have no product; Campaign exists unlisted. LinkedIn, Newsletter and Blog gate on state rows only the deleted webhook wrote (`submit-custom.ts:497-505,559-563,579-583`): a new client may be refused; verify on prep.

**Payments.** None. Credits with admin grants; no price row for Instagram, TikTok, Branded shorts.

---

## 6. What needs to be adapted

Every item needed to get from §5 to §2–§4. Owner and size to be assigned by Tomer and Shlomi; order in §6.2.

### 6.1 The work

**A. Plumbing: live context into every run**
- A1. Hand the run everything in §3.3 as run input or a per-run workspace projection before dispatch, replacing the dead `context_files` attachment (`submit-custom.ts:420-651,900`). Engine side: read them.
- A2. Capture what a run produces back into the portal: state files, voice files, platform state, subject rows. The engine reconcile (`src/app/api/agent-engine/reconcile`) is the seam; today it materialises assets only.
- A3. Fix the setup gates for LinkedIn, Newsletter and Blog on the engine path (or have the engine write the rows A2 captures).

**B. The stores (§3.2)**
- B1. Subject table: collection, write on draft, review and posting; read by sequencing and research; anti-repetition window per platform.
- B2. Feedback log unified across agents (one shape, per account), plus derived preferences written to the client: never-topics into `forbiddenTopics`, likes, voice notes, standing instructions.
- B3. Platform state doc per client × platform (the introduction doc), built on the first run, updated every run and by ingestion.
- B4. Profile learned log: research findings appended per run to the documents, versioned; revision history on documents.
- B5. Performance table and follower series wired to writers (D1, D2); what-works summary regenerated after ingestion.

**C. Sequencing and the goal**
- C1. Strategy map per client per platform with a stage on every row (LinkedIn first; X and Reddit adapted; Instagram templates; blog clusters; newsletter pillars).
- C2. Sequencing (§3.4): cadence from the calendar → stage, type, subject per slot; replaces the fixed rotations, including Instagram's every-third rule.
- C3. Goal, for, why now, type and sources on every deliverable, rendered on the card; remove account manager and revision meta; fix X thread rendering and the reply URL (`x-drafts-review.tsx:181-205`).

**D. Performance ingestion**
- D1. Follower snapshots: a cron calling the existing fetchers per connected platform; scraping fallback.
- D2. Per-post metrics for every posted asset, API where connected, scraping where not; link to the subject row.
- D3. Outlier analysis: why the best post worked → the what-works summary → the agent (step 7).
- D4. Decide the scraping provider per platform.

**E. Reporting**
- E1. SEO/GEO: classic rankings from Search Console (fetcher exists), history over time.
- E2. Reputation: sentiment score and themes; social comment and mention ingestion (fetchers exist); move from the agent catalog to Reporting.
- E3. Audience and growth: series and tiles from D1.
- E4. Per-post performance visible to the client, with the best-post explanation from D3.
- E5. Home composition per §4: one performance view; keep the lever table.

**F. Catalog**
- F1. A band and maturity field (up and running / beta / coming soon) with sections on the roster; beta label; coming-soon cards that can carry a description or a bare column.
- F2. Three TikTok cards (clipping, editing renamed from Branded shorts, content design) with their own forms: clipping gets "podcast link or find podcasts in my niche".
- F3. Demote SEO/GEO and Reputation to Reporting; placeholders for Rebrand, Micro-influencers, Motion design, PR; decide Campaign.
- F4. Price rows for Instagram, TikTok, Branded shorts.

**G. Run experience**
- G1. Live status of what the agent is doing (more than one headline); step ids from the engine.
- G2. Dynamic questions mid-run, design needed (Tomer).
- G3. Instagram topic-first switch: manual run = client picks, calendar = autopilot.
- G4. Client-side feedback → regenerate, with revision rounds; "request changes" for clients.
- G5. Client-settable cadence beyond weekly, from the calendar.

**H. Vetting and copy**
- H1. Forbidden topics and competitor check on every agent, read from the profile and derived preferences.
- H2. Copywriting stack: LLM choice, anti-AI pass, hook and story checks; Albert's per-platform best-practice pages as the spec.

**I. Onboarding and signup**
- I1. Self-serve signup with the website; onboarding without a lab slug.
- I2. Rename Intel → Onboarding in the seven UI places; the generated action plan on Home or dropped.
- I3. Brand kit with font files and the logo file, for Instagram rendering.

**J. Docs and payments**
- J1. Correct `CLAUDE.md` and the six agent contract docs for the engine path.
- J2. Stripe after the entity exists.

### 6.2 Order of work

1. A1, A2, A3 first: until the run receives live context and hands its state back, nothing else in the loop can be tested. This week.
2. B1, B2, C1, C3: the subject table, the feedback log with preferences, the strategy map, the goal on every output. This week for X, LinkedIn, Reddit.
3. F1–F3, G3: the catalog in three bands with the five agents visible on prep by Friday 2026-09-18.
4. D1–D3, B5, B3: performance ingestion, what-works, platform state. Needed before the double-down loop is real.
5. C2, G5: sequencing from the calendar.
6. E1–E5: reporting and Home.
7. H1, H2, G1, G2, G4, I1–I3, F4, J1, J2.

### 6.3 Decisions

Settled: D01 to D43 in 05 — D42 (O09: the store is Postgres inside agent-middleware, see 3.0) and D43 (O10: connected platforms only, no scraping provider) were settled on 2026-09-18, which unblocks B1, B2, C1, N4 and N6. Open: O11 alone, with Tomer and Shlomi.
