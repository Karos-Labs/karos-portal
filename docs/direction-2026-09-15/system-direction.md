# Karos system direction — 2026-09-15

- Launch: end of September 2026.
- Prep with the system + 5 agents (X, LinkedIn, Reddit, Instagram, TikTok): Friday 2026-09-18.
- Mission: building is easy now, distribution is the bottleneck. We market for product teams and SMBs.
- Moat: the data. Every run enriches the client profile. After one month we know the client too well for them to leave.
- Per-agent detail: [agent-one-pagers.md](agent-one-pagers.md).
- Code audit = this repo on `main` 35f366f3. The engine repo (`agent-engine`) was not opened.

## Renames

- Intel → **Onboarding** (run + report). The word "Intel" disappears.
- Tweak = feedback / changes.
- Client profile = the 6 client-visible documents (+ internal ones).
- Investors hear "10 agents". Internally: **AI agents** + **reporting systems**.
- TikTok agent → 3 agents: **clipping**, **editing** (= Branded shorts, to rename), **content designing**.
- SEO/GEO + Reputation = reporting, not agents.
- Marketplace = paid third-party services we automate (step 2).

---

## General flow for data input

1. Client signs up → gives website.
2. We scrape + run onboarding.
3. 6 documents created + list of actions on Home (static, same for everyone).
4. Client triggers an agent run + optional input (inputs differ per agent).
5. Agent reads the client profile (only the docs it needs; Instagram needs branding + typography).
6. Agent does the required research → Scrappy Coco.
   - Research is platform-specific: Reddit = threads, Instagram = hot topics, X/LinkedIn = what the audience talks about.
   - First run: scrape the client's own profile on the platform, look at the onboarding competitors' socials, how the target audience speaks and what it consumes, come up with options, write a **platform-specific voice file**.
   - **Introduction doc per client per agent** (Shlomi): where things stand on the platform (first post ever? posts that already work → continue that direction), updated on every run.
7. Agent decides: relevant for this client + audience / trending / what performs. Trending but irrelevant = no. Relevant + performing = yes.
8. Vetting: fits the direction, does not promote competitors.
9. Agent drafts. Copywriting: not generic, not AI-sounding, good hook + storyline, brand voice. Humanizer pass after drafting; LLM choice open (Claude adds AI patterns).
   - X / LinkedIn / Reddit stop here.
   - Instagram / TikTok: copy per slide → create graphics → pull images → layer without overlap.
   - Option: show the topic to the client first, render only after a yes (graphics are the expensive part).
10. Client gets the output → feedback / changes → new output (loop until happy).
    - Every output states **the point of the post** (acquisition, knowledge, POV…).
    - Remove meta the client doesn't need (account manager, revision 0, lane knowledge).
    - Fix X thread rendering + the "first reply URL" (showed a Notion source instead of the reply link).
11. Client can set a recurring automation ("every Monday"). UI only.

Steps 6 + 10 enrich the profile. Every research finding and every client comment is catalogued so the next run is more accurate. During a run: live status of what the agent is doing + tailored questions mid-run instead of generic questions up front (Tomer: agents take questions at the start today, needs a design).

### Where the code is today, per step

1. **Signup**: invitation key only (`src/app/signup/page.tsx:33`); no key → disabled queue (`src/lib/auth.ts:164-181`). `/request-access` only writes a staff request. Client wizard never asks for a website; only staff create clients (`src/lib/actions/client-actions.ts:29`). Onboarding refuses without `agentsRepoSlug` (`src/lib/agent-engine/dispatch-research-agents.ts:57`). `CLAUDE.md:17` / `SETUP.md:79` wrong about `ADMIN_EMAILS` (alert list only).
2. **Onboarding run**: `runIntelReportPipeline` (`src/lib/intel/report.ts:126-237`) scrapes nothing itself; dispatches `intel-report-agent` + `seo-geo-agent` on the engine. Portal fetches the site only for branding (`src/lib/branding.ts:901`). Scrappy Coco = brand evidence only (site screenshot + IG grid, `src/lib/branding-scrappycoco.ts:140-215`). "Intel" still in 7 UI places: `clients/[id]/page.tsx:934`, `client-documents.tsx:910,1184`, `regenerate-workspace-button.tsx:39`, `transcript-tools.tsx:319,328`, `meetings-client.tsx:256`, `transcripts/[id]/page.tsx:100`, `task-ticket-modal.tsx:43`.
3. **Documents**: 8 types, 6 client-visible (brand-voice, market-strategy, competitor-analysis, product-information, branding-guidelines, target-audience), 2 internal-only (client-guidelines, action-plan) (`src/lib/intel/agent-onboarding.ts:65-82`). Composed by templating, condensed by model. Correct Info: client-accessible, targeted regeneration, credit-charged (`src/lib/intel/doc-corrections.ts:33-131`). No revision history (overwrite in place, `src/lib/data.ts:1858`). Home: 6-step ladder (`src/lib/setup-ladder.ts:960-1048`) + preset 24-row action list (`src/lib/action-list.ts:8-17`); the generated action-plan is read by nothing. Brand kit: colours, font **names**, logoUrl → `client/brand.json` (`context-doc-projection.ts:88-99`). No font files, no logo SVG.
4. **Run input**: one "Direction for this run" box + Kind of post + Number of posts (X, LinkedIn) + seat (LinkedIn) (`src/lib/custom-agent-launch.ts:396-470,618-690`). Instagram/TikTok share one form (`:291-389`). No dynamic questions. Status = one keyword headline (`src/lib/run-step-headline.ts:19-33`); step detail staff-only. No mid-run question mechanism; only gate = staff approval (`src/lib/actions/agent-engine-actions.ts:37-58`).
5. **Reads the profile**: the engine reads its workspace: `context/<docType>.json` (6 docs + x/linkedin/reddit profiles), `client/brand.json`, `client/profile.json`, written at onboarding end / Regenerate / branding refresh (`context-doc-projection.ts:49-59`) + `knowledge/*.json` by the reconcile cron (`knowledge-sync.ts`). **Not per run.** The per-agent context files (intake forms, seat voice profiles, what's-new, takes, learning logs, prior drafts, state files, standing feedback) are still built (`src/lib/jobs/submit-custom.ts:420-651`) but attached only to the agent-service call (`:900`), deleted 2026-09-02 (`product-mapping.ts:108-146`). Engine run = `toEngineRunInput` (form fields) + reputation intake only (`:834-857`, `:599-612`). **→ nothing the portal learned reaches today's runs.**
6. **Research**: engine-side, not visible here. No first-run flag. X has no setup agent. LinkedIn/Reddit/Reputation setup = engine pre-flight (`00-channel-setup`, `00-roster-setup`). Voice files (`seatVoiceProfiles`) have no live writer (webhook gone). No introduction doc. IG audience/comment fetchers exist, no callers (`analytics-providers.ts:276,306`). Competitor sync from SEO/GEO never called (`src/lib/intel/competitor-sync.ts:30`).
7. **Decision**: no portal-side signal. Per-post benchmarks feed Task Map + chat only (`execution-engine.ts:397`, `agent-swarm.ts:608`), never a run.
8. **Vetting**: `Client.forbiddenTopics` enforced only for Dynamic Agent Studio (`submit-custom.ts:1168-1268`, `docs/dynamic-agent-guardrails.md`). No competitor check anywhere. Engine gates per contracts (LinkedIn 8 gates + lint, Reddit check-draft + judgment, newsletter compliance lock, blog code gate) — not verifiable from here.
9. **Drafting**: no portal-side copywriting control (no humanizer, no hook/brand-voice check). Instagram deliverable = topic + caption + slides + rendered PNGs (`materialize.ts:436-505`); halts at `03-claim-topic` on empty topics catalog; `UNSPLASH_ACCESS_KEY` missing (`product-mapping.ts:164-171`). Topic-first gate: none for clients (staff gate is post-render). X option picker exists (`slot-option-actions.ts:60-100`).
10. **Feedback**: posted / posted with edits / not posted / note per draft (`x-agent-actions.ts:514`; Reddit adds reason codes). Standing feedback `clientAgentFeedback`. Nothing re-runs; "Request changes" is staff-only; no revision counter. Point of post: X lane label only, Reddit "Why this thread"; LinkedIn nothing; engine `lane/angle/contentMode/thread` stored, not rendered (`materialize.ts:332`). X reply-URL bug: any URL in a meta bullet renders as a link, no validation (`x-drafts-review.tsx:181-205`, `x-drafts.ts:53,174-184`).
11. **Automation**: client can set weekly only (`planned-run-actions.ts:247-318`); other cadences admin-only. X clamped to 1 post/run; N posts = N runs, each billed.

---

## Learning loop

- 3 sources → profile: research findings, client feedback ("never talk about X", "I like this"), performance metrics.
- Subject table per platform (date, subject, platform, run): what was already posted. Table, not document. Store open (Firestore vs Postgres) → Tomer + Shlomi decide.
- Save everything about the company: every message, output, feedback.
- Performance loop: find why the outlier post worked (130 views vs 60) → implement → all posts reach that floor → repeat on the next outlier.

**Today**
- No write-back from feedback, research or performance into `clients` / `clientContextDocs`. `forbiddenTopics` has no writer.
- Only run → profile write = SEO/GEO (`persist-seo-geo-insights.ts:98-130`).
- No subject table. Nearest: per-family text blobs (`liAgentState`, `newsletterAgentState`, `redditAgentState`, `types.ts:3247-4024`), written by the dead webhook, none for X/Instagram, not queryable.
- Per-asset metrics stored for connected channels (`clientMarketingAnalytics`), never read by a run. Follower snapshots: writer never called (`src/lib/follower-tracking.ts:11-30`).
- Transcripts: agent-service = 7-day URLs (dead); engine = engine store, staff-only. Nothing archived here.
- Firestore only. No Postgres / Supabase / Prisma.

---

## Reporting / structuring systems

1. Onboarding run output.
2. SEO / GEO run: visibility in search + AI answers.
3. Reputation run: review sites + social comments → global sentiment.
4. Social metrics from scraping: followers per platform, total audience, monthly growth.
5. Growth data over time.
6. Per-post performance (views, likes) → why did this one work → double down.

All of it + agent activity (posts created, growth, ranking) on **Home** as one view. Reporting explains in plain language how each agent improves presence (X agent → SEO/GEO).

**Today**
- Onboarding report: rendered page (`src/app/api/clients/[id]/report/route.ts`).
- SEO/GEO: AI-answer visibility only (ChatGPT, Perplexity, Gemini, Claude, Copilot: appearance, citation, first position, share of roster, sentiment) + 60 site checks (`src/lib/seo-geo.ts:61,503-513,805`). Classic rankings: Search Console fetcher has no callers (`integrations/google-search-console.ts:40`). Monthly schedule. Reporting tab + Home card. Lever table per agent family already exists (`src/lib/visibility-levers.ts:148-212`).
- Reputation: an agent (5-field intake, drafts + flags, `note` asset). No sentiment score. Social comment/mention fetchers exist, no callers (`analytics-providers.ts:306,376,433`).
- Social metrics / growth: missing. OAuth integrations for IG, LinkedIn, X, YouTube, TikTok, Reddit, GSC, GA4, GBP (`integrations/platforms.ts:197-461`). No scraping. Audience tile hidden (`home-kpis.tsx:315`).
- Per-post performance: captured, shown staff-only (`clients/[id]/page.tsx:1051-1093`).
- Home: setup ladder, calendar preview, published count + 30-day delta, category presence / share of conversation, attention items. No unified performance view.
- Crons (`src/app/api/*`): analytics sync, onboarding schedule, scheduler, run-scheduled, publish, runway, task auto-generate, daily digest, engine + agent-service reconcile, credits reconcile, log cleanup.

---

## AI agents

Fully automated agents that make decisions to create an output.

**Up and running**
- X
- LinkedIn
- Reddit

**Beta**
- Instagram — carousels (also usable for TikTok)
- TikTok clipping — input: a podcast, or "find podcasts in my niche"; finds the relevant parts, adds captions, formats the clip
- TikTok editing (= Branded shorts, rename) — input: the client's video; cuts gaps in speech, on-brand captions + graphics
- TikTok content designing — input: nothing; video from 0 with open-source / AI pictures + video, voice, SFX (hardest with current tech)

**Coming soon** (columns only, no descriptions for the marketplace three)
- Rebrand
- Newsletter / Blog
- Landing page
- Micro-influencers agent
- Motion design agent (SaaS flash)
- PR agent (news-article placement for referencing)

Not in the catalog: SEO/GEO, Reputation → reporting. Newsletter + landing page work (Tomer) but stay in Coming soon (UI tailoring not this week).

**Marketplace** (step 2, extra cash from the client, Albert): PR (budget → we draft articles → PR networks publish → referencing), motion design via partners, micro-influencer matching. Automated end to end.

### Today

Catalog = `customAgents` docs seeded by `scripts/sync-engine-agent-roster.ts:69-222`, granted to every client, rendered flat (`src/components/client-agents/roster.tsx`). No band / maturity / beta field: `RosterStatusTone = live | attention | progress | idle | disabled` (`client-agents.ts:702`); "Coming Soon" = `enabled === false`, strips all controls (`client-roster.ts:382`).

| Agent | Key → engine product | Runnable | Note |
|---|---|---|---|
| X | `karos-x-agent-v2` → `x-agent` | yes | 15 credits, launch 25 |
| LinkedIn | `karos-linkedin-writer-v2` → `linkedin-agent` | yes | was **verify**; the `liAgentState` foundation gate was real and is carved out of the engine path by `460a77cc` — `00-channel-setup` resolves the channel from the form |
| Reddit | `karos-reddit-runner` → `reddit-agent` | yes | no price row → 25 |
| Instagram | `karos-instagram-agent` → `instagram-agent` | halts | empty topics catalog; no price row |
| TikTok (clipping + original shorts) | `karos-tiktok-agent` → `tiktok-agent` | yes | same form as Instagram; no price row |
| Branded Shorts (editing) | `branded-shorts` → `branded-shorts-agent` | blocked | needs `brandedShortsProfilePath`; no price row |
| Content designing | none | no | nearest: tiktok-agent original-short mode |
| Blog | `karos-blog-writer-v2` → `blog-agent` | yes | same gate, same carve-out (`460a77cc`); 10 credits |
| Newsletter | `karos-newsletter-writer-v2` → `newsletter-agent` | yes | same gate, same carve-out (`460a77cc`); 10 credits |
| Landing Builder | `landing-builder` → `landing-builder-agent` | yes | fresh build only, no feedback rounds |
| Campaign | `karos-campaign-orchestrator` → `campaign-orchestrator` | yes | exists, granted to all, not in Albert's list → decide |
| Reputation | `karos-reputation-runner` → `reputation-agent` | yes | move to Reporting; 25 credits |
| SEO & GEO | `seo-geo-agent-v2` → `seo-geo-agent` | yes | move to Reporting |
| Rebrand | none | no | only a "Brand strategy brief" form, no key (`custom-agent-launch.ts:893-926`) |
| Micro-influencers / Motion design / PR | none | no | no reference anywhere |

---

## Payments + credits

- Stripe, after entity + bank account (~2 weeks). Not a blocker.
- Today: no payment code. Credits admin-granted, weekly/monthly caps. Price = `agent.creditCost` → family default → 25 (`run-price.ts:92-119`, `credits.ts:246-283,657-706`). Client sees credits, not dollars ($0.25 = staff view, `jobs/[id]/page.tsx:265`).

---

## Decisions (call, 2026-09-15)

1. Intel → Onboarding, pipeline unchanged.
2. Profile = 6 client-visible docs; add internal docs whenever an agent lacks one.
3. Home action list is static.
4. One 11-step flow for every agent; research + drafting tailored per platform.
5. Steps 6 + 10 enrich the profile; subject table per platform.
6. 3 learning sources: research, feedback, performance. Scraping metrics = how agents improve.
7. AI agents ≠ reporting systems. SEO/GEO + Reputation = reporting.
8. TikTok = 3 agents, 3 inputs.
9. Bands: up and running (X, LinkedIn, Reddit) / beta (Instagram + 3 TikTok) / coming soon (rest). Marketplace = columns without descriptions.
10. System first: a better system makes X/LinkedIn/Reddit better automatically. Beta agents ship "good enough" and improve over months (Mikhail may help).
11. Video agents are technology-capped; focus on copy + relevance.
12. Albert writes one page per agent (inputs, outputs, examples).
13. Each output states the point of the post; unneeded meta removed.
14. Dynamic in-run questions replace generic upfront questions (design needed).
15. Feedback doc: grey = still to read, yellow = integrated.
16. AI images of real people allowed for now.
17. Stripe after the entity.
18. Anna gets the notes; this structuring is a large part of her work.

## Open

| Question | Owner |
|---|---|
| Audience-language research: in onboarding, per agent, or both | Tomer, Shlomi |
| Subject table: store (Firestore vs Postgres) + shape | Tomer, Shlomi |
| Introduction doc per client per agent: format, location | Shlomi |
| Copywriting stack: LLM, humanizer, hook/story checks | Albert + Tomer |
| Topic approval before render (Instagram / TikTok) | Albert |
| Design for dynamic in-run questions | Tomer |
| Campaign: keep / hide / coming soon | Albert |
| Client-facing name for the editing agent | Albert |

## This week (2026-09-15 → 2026-09-18)

- Today: Tomer + Shlomi wrap the beta agents ("good version, not perfect"); think through the system structure (Tomer writes it technically). Shlomi splits video into 3 agents once descriptions arrive.
- Albert (hours): full descriptions of the 4 beta agents, then X/LinkedIn/Reddit; runs + feedback in the shared feedback doc; UI/UX round (progress animation, point of post, remove meta, X thread + reply link).
- Tomorrow: X, LinkedIn, Reddit through the improved system.
- Friday: flow + enrichment + data system working; 5 agents on prep, "even if the betas are bad".
- End of month: launch.

---

## Gaps, ranked

1. **Per-run context never reaches the engine.** Intake, voice profiles, learning logs, prior drafts, feedback: built, then dropped at the deleted agent-service boundary. No agent learns between runs. (`submit-custom.ts:420-651,900`)
2. **No profile enrichment, no subject table.** Nothing writes back; nothing queryable.
3. **No performance ingestion.** Followers never written, rankings never fetched, per-post metrics never reach a run or the client.
4. ~~**LinkedIn, Newsletter, Blog may be unrunnable for a new client.**~~ **CLOSED 2026-09-16** by `460a77cc` (PR #122). It was confirmed rather than disproved — the gates really did read rows only the dead agent-service webhook ever wrote — and the fix was to carve the ENGINE path out of all three (`submit-custom.ts`: each rung is now behind `!engineProductId`). `linkedin-agent` resolves its own channel in `00-channel-setup` from the filled form, and the newsletter and blog rungs made the same class of claim about indices the engine builds itself. The INTAKE rung stays on both paths, because the form is what the pre-flight resolves from. Verified in code, not on prep: a new client is refused on none of the three.
5. **No client feedback loop.** Stored, never regenerates; "request changes" staff-only; no revisions.
6. **No vetting for live agents.** Forbidden topics = Dynamic Studio only; no competitor check.
7. **No first run.** No intro doc, no company-page voice file, X has no setup.
8. **Catalog can't express the bands.** No beta field, no sections; SEO/GEO + Reputation still runnable agents; content designing / Rebrand / marketplace absent; Campaign unlisted.
9. **Signup not self-serve; client never gives a website.** Onboarding needs a lab slug.
10. **Instagram + Branded shorts halt on engine data** (topics catalog, profile path, Unsplash key, engine dir); brand kit = font names only.
11. **Status = one headline; no mid-run questions; no topic-first gate.**
12. **"Intel" in 7 UI places; Home ignores the generated action plan.**
13. **No portal-side copywriting lever.** Anti-AI rules live in engine skill instructions.
14. **No price rows for Instagram / TikTok / Branded shorts; no payments.**

## Docs to fix

- `CLAUDE.md:23,56`: still says agents run on `agent-service/` (removed from repo 2026-08-23, stack deleted 2026-09-02).
- `CLAUDE.md:17`, `SETUP.md:79`: `ADMIN_EMAILS` is an alert list, not an admin path.
- `docs/{x,linkedin,reddit,blog,newsletter,reputation}-agent-portal.md`: describe the agent-service plumbing (context files, webhook capture). Rulings valid, plumbing dead. Need an engine-path section.
- `src/lib/branding.ts:70` references `TASK-INSTAGRAM-FEEDBACK-LOOP-AND-MEMORY.md` (engine repo). No Instagram / TikTok contract doc here.
