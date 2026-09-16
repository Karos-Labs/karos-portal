# Agent one-pagers — 2026-09-15

Facts from this repo only. `[Albert: …]` = to complete. Contract = `docs/*-agent-portal.md` (agent-service era, deleted 2026-09-02; rulings valid, plumbing dead). Engine path = what runs today on `agent-engine`.

Shared, every agent:
- Run form → `toEngineRunInput` (`src/lib/agent-engine/product-mapping.ts:524-638`): `request` (topic + direction), attachments (`mediaAssets`: source / reference / logo / overlay), audience, tone, cta, must-include, keywords where shown.
- "Number of posts" = N separate runs, each billed. One engine run = one output.
- Profile reaches the engine via the workspace projection at onboarding time, not per run.
- Standing intake, voice profiles, learning logs, prior drafts, feedback: built by the portal, **not sent** on the engine path (`src/lib/jobs/submit-custom.ts:420-651,900`). Exception: reputation intake (`:599-612`).
- No revision rounds, no feedback → re-run, no mid-run questions, status = one headline, client recurrence = weekly only.
- Catalog source: `scripts/sync-engine-agent-roster.ts:69-222`, `product-mapping.ts:142-212`.

---

## X — up and running

- Today: `karos-x-agent-v2` → `x-agent`. Runnable. 15 credits (launch 25). 1 run = 1 post; a thread = 1 post (ruling 2026-08-11, `X_V2_MAX_OUTPUTS_PER_RUN = 1`). Draft-only, X OAuth parked.
- Does: 1 post per run, 5 lanes (build-in-public / knowledge / POV / news-reaction / quote), picture attached or sourced.
- Stages: lab skill = 16 weekly steps. Voice, pillars, cadence, language BUILT by the agent (onboarding profile + own posts + edit loop), never asked. Setup may emit `voice-profile--<seat>.md` per seat. Engine step known: `09b-analyze-attached-media`. Modes: hot-news / deep-value / open-discussion (RFC-12).
- Standing inputs: company form (handle, how to come across, off-limits, engagement roster, Premium, first announcements) + seats (`src/lib/actions/x-agent-actions.ts:135-265`); what's-new box (`xNewsUpdates`); per-seat takes (`xTakes`); `x-agent-profile` doc.
- Per run: Draft for (company / a seat), Kind of post, Number of posts, Direction, extra material (`src/lib/custom-agent-launch.ts:618-690`).
- Reaches the engine: `requestedTopic`, `customPrompt`, `requestedMode`, `runScope`, `mediaAssets`, `mediaSource`. Not sent: intake, seats, takes, what's-new, learning log (`submit-custom.ts:442-451,834-857`).
- Rules: every claim sourced. Refused if the company form was never saved.
- Output: `x-post` → `social_post`; meta `lane, angle, targetHandle, hook, media*, contentMode, thread` (`materialize.ts:328-332`). Review `x-drafts-review.tsx` (lane = title, thread = stacked cards). Option picker before generation, X only (`slot-option-actions.ts:60-100`).
- Feedback: posted / posted with edits / not posted / note → `xDraftFeedback`; 30-row learning log per account (dead path). Standing: `clientAgentFeedback`.
- Bugs / gaps: any URL in a meta bullet renders as a link, no validation → the "first reply URL" bug (`x-drafts-review.tsx:181-205`, `x-drafts.ts:53,174-184`); only post 1 deep-linked; `thread` meta not rendered; no point-of-post line; no vetting.
- Examples: `[Albert: 2–3 target posts, one thread; one "sounds like AI" example that must not ship]`

---

## LinkedIn — up and running

- Today: `karos-linkedin-writer-v2` → `linkedin-agent`; setup key → same product (inlined `00-channel-setup`). 15 credits. Draft-only (LinkedIn bars unattended posting).
- **Verify**: writer refuses without a `liAgentState` foundation row (`submit-custom.ts:497-505`, `linkedin-agent-context.ts:215-218`); seats need a `seatVoiceProfiles` card (`:227-230`). Both written only by the dead webhook → new client may be refused every press.
- Does: 1 post per run, company page or one executive's seat, in that voice, picture attached or sourced.
- Stages (contract): **Setup** 11 steps: foundation, lanes, mix, cadence, compliance block, company voice card, topic catalog, empty ledger, from the onboarding docs; asks nothing. Seat variant: voice card from the person's real posts via Apify (direct fetch = HTTP 999), fallback voice sample → CV (substance only). **One press = manager (9 steps: audit what shipped + what the client did, adjust plan, refill pool, same-day research cache) then writer (12 steps)**. Precedence: run note → "What should we cover next?" → news drops → topic catalog. Engine steps known: `00-channel-setup`, `07b-select-content-mode`, `08b-analyze-attached-media`. Identity matched by NAME → portal sends `requestedExecutiveName` (`submit-custom.ts:494`).
- Standing inputs: company form, seats (shared `clientSeats`), "What should we cover next?" (`liDirectionRequests`), weekly what-happened box (`xNewsUpdates`), per-seat voice setup, CVs.
- Per run: Choose my seat, Kind of post, Number of posts, Direction, extra material (`custom-agent-launch.ts:396-470`).
- Reaches the engine: `requestedTopic`, `customPrompt`, `requestedMode`, `requestedIdentityScope`, `requestedExecutiveName`, `mediaAssets`, `mediaSource`. Not sent: intake file, ledger, topic catalog, foundation, plan, research cache, learning logs.
- Rules: one identity per run. Text posts ship, no visual required (2026-08-03). Nothing worth posting → `held`, ships nothing. Promotional ≤ 1 in 6. 8 hard gates: anti-slop lint (`lint.mjs`), numbers sourced + dated, claims traced, regulated → held, spotlight/quote → consent, format, nothing unfinished, no weak slot-filling.
- Output: `linkedin-post` → `social_post`; meta `archetype, hook, hashtags, callToAction, targetAudience, takeaway, media*, contentMode, formattingNotes` (`materialize.ts:344-346`). Review `li-drafts-review.tsx`: Pick & post (clipboard + `linkedin.com/feed/?shareActive=true&text=…`), Pick with edits, Request a change, Skip. Suggested date on the card.
- Feedback: posted / posted_with_edits / not_posted / edit_request / note → `liDraftFeedback`; edit request = standing instruction (contract).
- Gaps: setup gate; no point-of-post line; no vetting; state files have no writer.
- Examples: `[Albert: one company post + one seat post; what hot news / deep value / open discussion each look like]`

---

## Reddit — up and running

- Today: `karos-reddit-runner` → `reddit-agent`; setup key → same product. No price row (25). **Draft-only, hard rule**: no credential, no code path, `reddit` in `READ_ONLY_PLATFORM_IDS` (pinned by `platforms-publishable.test.ts`). A human posts from their own account.
- Does: finds live threads in target subreddits, checks each subreddit's rules, drafts replies in the account's voice.
- Stages (contract v2): **Setup** 8 steps, data only: subreddits in 3 rings (about the client / the category / buyers describing the problem without knowing the category), each subreddit's rules WITH DATE READ (product naming, disclosure, AI-comment ban, karma gate), recurring questions with proof threads, what people say about the client, who we reply as. Files: `foundation.md`, `rules-audit.json`, `question-pools.json`, `scan-config.json`, `reddit-ledger.json` + per account `voice-profile.md`, `facts-shelf.md`, `account.json`, `live-section.md`, `learning-log.md`, `agent-memory.md`. Ends with a dry-fire of the scanner. **Runner** 13 steps: safety check at 07 before drafting (banned subreddit = off-limits for every account of the client; karma/age gate; vendor participation rules), draft at 09, `check-draft.mjs` (exit 0 pass / 1 content fail → back to 09, max twice / 2 tooling broke, never a content verdict), judgment gate (delete every product mention → still useful? claims trace? culture fit?), outcome in `13-commit.json`. **Two approaches per thread, always**; the client's pick = the voice signal. 1–3 threads per run (Albert 2026-06-30: one listing pull, one thread, one draft; a big-budget run = build failure).
- Standing inputs: one account form: account, honest read of karma + age, off-limits subreddits, disclosure wording (`agentIntake` agent=reddit, no seats).
- Per run: Direction, extra material (`custom-agent-launch.ts:691-713`). Wire keys exist: `requestedSubreddit`, `requestedThreadUrl`, `requestedThreadTitle`.
- Reaches the engine: `requestedTopic`, `customPrompt`, the 3 keys when set. Not sent: intake, `feedback.jsonl`, rules audit, ledger, question pools.
- Rules: 4 outcomes: `delivered` / `held` / `blocked_intake` / `degraded` (= we could not read Reddit; own client copy, never "your niche was thin"). Warming mode = 0 product mentions. Value-first. No AI tells (no em dashes, exclamation marks, "great question", rule-of-three closers, bullet answers). Freshness (never a dead thread). Additive (name the whitespace). Outcomes learn per subreddit: 2× `too_promotional` or `rules` → value-only; `removed` → pattern retired there.
- Output: `reddit-reply` → `note` asset. Per thread: `approach-1.md`, `approach-2.md`, `about.txt` (thread link, "REWRITE REQUIRED: this subreddit bans AI-written comments", karma/age warning, recommended approach). Review `reddit-drafts-review.tsx`: two-approach toggle, "Why this thread", copy reply + open thread (no compose link on Reddit).
- Feedback: posted / posted_with_edits / not_posted (reason: `too_promotional`, `wrong_subreddit`, `thread_died`, `rules`, `removed`, `other`) / edit_request / note + `selectedApproach` + subreddit → `redditDraftFeedback`.
- Constraint: Reddit blocks datacenter IPs for keyless reads; a run without a read path must declare degradation. Engine read path not visible here.
- Examples: `[Albert: one thread with both approaches + the pick; one correct "held"]`

---

## Instagram — beta

- Today: `karos-instagram-agent` → `instagram-agent`. Routes; **halts at `03-claim-topic` on empty topics catalog**; `UNSPLASH_ACCESS_KEY` missing (`product-mapping.ts:164-171`). No price row (25). Managed `social_post` + `platform=instagram` lands here too.
- Does: 1 on-brand carousel per run: research, copy, imagery (client uploads first, then sourced or generated), branded render, visual QA.
- Stages: no contract doc here (`TASK-INSTAGRAM-FEEDBACK-LOOP-AND-MEMORY.md` = engine repo). Engine steps known: `03-claim-topic`; Tier 0 user media; `05z-attach-user-media` (refuses empty client-only run); `05b`; `06b–06e` rescue tiers (skipped when `mediaSource=client`); `12-render-preview-check`. Lists past images before writing copy, then reads templates (`run-step-headline.ts:7-11`).
- Per run ("Social content system", `custom-agent-launch.ts:291-389`): What should the agent do (produce / set up / refresh), What should this post be about (required), Channel (IG+TikTok / IG / TikTok), Instagram format (carousel 6–8 / single + deep caption / rotate every 3rd), Number of posts 1–5, Audience, Must include or avoid, Creative inputs (docs, images, mp4/mov), visuals from system / client.
- Reaches the engine: `requestedTopic`, `customPrompt`, `runMode`, `platform`, `requestedFormat`, `audience`, `mustInclude`, `mediaAssets`, `mediaSource`. `requestedLane` comes from client config, never the run.
- Brand: `client/brand.json` = palette, font **names**, logoUrl, dominant colours, visual style, guidelines (`context-doc-projection.ts:88-99,167`). No font files, no logo SVG.
- Rules: default 1 post/run (2026-09-04). `auto` = every 3rd post a single image. Call: use the client's typography; graphics + pulled images layered without overlap; AI images of real people allowed for now.
- Output: `instagram-carousel` `{ topic, caption, postId, slides[{n, fields}], renderedSlides[{n, path}] }` → slide PNGs rehosted `agent-engine/<jobId>/slide-<n>.png`; asset `social_post`, `channels: ["instagram"]`, `meta.slides[{imageUrl, headline}]`, cover = slide 1, content = caption (`materialize.ts:436-505`). Gallery in the calendar modal (PR #120).
- Feedback: asset-level only.
- Gaps: no topic-first gate for the client (staff gate is post-render); no price; no contract doc; fonts by name only.
- Examples: `[Albert: one target carousel (slide texts + look); layering rule good vs bad; one single-image post]`

---

## TikTok clipping — beta (today "TikTok Agent")

- Today: `karos-tiktok-agent` → `tiktok-agent`. Runnable. No price row (25). Deliberately not Branded shorts: "finds a moment inside someone else's long-form episode and puts the client's commentary on it" (`product-mapping.ts:197-204`).
- Does: clips a moment from footage the client attaches or owns + the client's commentary; or scripts an original short when nothing is attached.
- Stages: engine steps known: `01b-resolve-source` (client-only stops after user-asset tier); `11-clip-review` gate. Gate payload (`clip-review.ts:16-100`): video URL, `format` (`original-short` | `commentary-clip`), duration, voiceover, `costSoFarUsd` / `estimatedCostUsd` / `maxCostUsd`, `budgetPlan` (e.g. `stock-only`), `plateSources` (stock | still), `visualQa.weakBeats`, `repick`, script beats, `music`. Gate = staff-only.
- Per run: the Instagram "Social content system" form (matcher `/instagram|tiktok/`), so the client sees "Instagram format", which this agent ignores. Source = first `mediaAssets` with role `source`. Uploads mp4/mov ≤ 2 GB (`media-kinds.ts:25-27`), bucket `podcast-clips`. Bulk clip upload + auto-schedule exists (`bulk-upload-actions.ts:11-55`).
- Reaches the engine: `requestedTopic` only when `customPrompt` absent; `mediaAssets`, `mediaSource`, `platform`, `runMode`.
- Call input: a podcast, or "find podcasts in my niche" → **no field for the second**.
- Output: `{ caption, signedUrl, hookLine, hookType }` → `clip.mp4`; asset `social_post`, `videoUrl`, content = caption, meta hookLine/hookType (`materialize.ts:534-559`). UI `clip-gallery.tsx`.
- Gaps: own form; gate staff-only; no price.
- Examples: `[Albert: one target clip: source, moment, caption, on-screen text]`

---

## TikTok editing — beta (today "Branded Shorts", rename)

- Today: `branded-shorts` → `branded-shorts-agent`. Routes; **`blocked_intake` at `00-brand-resolve` without `brandedShortsProfilePath`**; `BRANDED_SHORTS_ENGINE_DIR` missing (`product-mapping.ts:164-171`). No price row (25). Managed `social_post` + `platform=tiktok` lands here (recorded as deliberately unchanged, `:57-70`).
- Does: one talking-head video → finished vertical short: filler-cut edit, camera-true colour, brand captions + graphics, render QA.
- Stages: engine steps known: `00-brand-resolve`, `01-load-intake` (attached source video; plate generation off when `mediaSource=client`). Direction reaches the two editorial steps, not the cut planner.
- Per run ("Short-form video brief", `custom-agent-launch.ts:224-286`): What should this short communicate (required), Source video link or upload (mp4/mov/webm/mp3/wav; >4 MB by link), Primary platform (Reels / TikTok / LinkedIn / cross), Target duration (15 / 30 / 45 / 60 s), CTA, Editing constraints.
- Reaches the engine: `requestedTopic`, `customPrompt` (editing notes folded), `platform`, `duration`, `cta`, `mediaAssets`, `mediaSource`.
- Output: `{ signedUrl }` → `final.mp4`; asset `social_post`, `videoUrl` (`materialize.ts:506-517`).
- Gaps: engine profile path + env; name; no price.
- Examples: `[Albert: one before/after; caption + graphic rules]`

---

## TikTok content designing — beta (no product)

- Today: no key, no product, no form. Nearest: `tiktok-agent` original-short mode (`format: original-short`, `plateSources` stock/still, `budgetPlan: stock-only`, `voiceover`, `music` in the clip-review payload).
- Call: video from 0 with open-source / AI pictures + video, voice, SFX; client gives nothing; hardest with current tech; may not reach the portal this month.
- Examples: `[Albert: script format, visual style, one reference video]`

---

## Newsletter — coming soon (works today)

- Today: `karos-newsletter-writer-v2` → `newsletter-agent`. 10 credits. Gate: refuses without `newsletterAgentState` rows (`submit-custom.ts:559-563`) → same era problem as LinkedIn. We never send; the client sends from their platform.
- Stages (contract): 4 skills, 1 card. **Setup**: content foundation, voice card from the client's own past issues, seeded topic pool, scan watch-list, issue index (re-run verifies, never re-seeds). **Writer**: 1 issue per run; claims the number at 01; 7-day scan; compliance sweep 08; code gate 09 refuses the whole issue; ships 11. **Manager**: refills pool, refreshes voice card from what shipped + what the client did. **Compliance lock**: refuse, never rewrite; open compliance question = review flag.
- Standing inputs (only what research can't reach): send day (null = real answer, never a default), email platform, audience note, banned phrases, open compliance question.
- Per run: issue theme + goal (required), reader segment, stories/links/dates, CTA, tone; attachments (`custom-agent-launch.ts:722-740`). Engine: `requestedTopic`, `customPrompt`, `audience`, `mustInclude`, `cta`, `tone`.
- Rules: empty pool = held, never an improvised topic. Voice card built once. Duplicate issue number = second copy to real subscribers.
- Output: envelope `newsletter-issue-v2`: `html` (dark), `htmlLight`, `text`, `about` (review flags first); asset `email`.
- Examples: `[Albert: one target issue]`

---

## Blog — coming soon (works today)

- Today: `karos-blog-writer-v2` → `blog-agent`. 10 credits. Gate: refuses without `blogAgentState` rows (`submit-custom.ts:579-583`) → same era problem. We prepare, the client publishes.
- Stages (contract): 3 skills. **Setup**: post index, cluster map + claim register, voice card from existing posts, `v1-posts.json` (rebuild keeps old articles), blog tokens + compliance patterns in the shared brand file. **Writer** 13 steps: claim number 01; precedence 02 (profile docs = what the business is, content foundation = editorial); subject from the **newsletter's last 6 issues** 04 (prefer a `mentioned` item); real research, 2 unrelated primary sources 06; outline 07; write 08; quality + compliance + review flags 09; links only to existing targets 10; render behind hard gates 11; 5 files 12; memory 13 (held run releases number, subject, slug). **Manager**: did they publish, link graph, runway = unused newsletter topics, honest performance.
- Standing inputs: own domains, voice correction, who the articles are for, off-limits subjects, where they publish.
- Per run: What should the agent do (article / set up / refresh), topic or reader question (required), audience + intent, keyword territory, point of view + proof, required sources (`custom-agent-launch.ts:742-768`). Engine: `requestedTopic`, `customPrompt` (POV + non-URL sources folded), `runMode`, `audience`, `keywords`.
- Rules: subject from the newsletter unless the client requested one (theirs wins). No em/en dashes, double hyphens, exclamation marks; sentence case. Compliance stop = code.
- Output: envelope `blog-post-v2`: branded page, CMS body fragment, markdown, `about.txt` (review flags first), `publish-notes.txt` (meta title, description, slug, canonical, keywords, structured data, what's left for the client); asset `article`.
- Examples: `[Albert: one target article]`

---

## Landing page — coming soon (works today)

- Today: `landing-builder` → `landing-builder-agent`. Fresh build only: portal always sends `runKind: "setup"`; `recurring` = apply one feedback delta, needs a `feedback-round.json` the portal can't produce. Deliverable `landing-page-site`, asset `landing_page`.
- Does: one premium landing page from brand + context docs + brief; preview published for review.
- Per run ("Conversion page brief", `custom-agent-launch.ts:769-786`): page goal (required), offer + promise (required), audience + traffic source, CTA, proof + objections, reference URLs; attachments. Engine: `requestedTopic`, `customPrompt` (references folded), `offer`, `proof`, `audience`, `cta`; direction spread into 3 steps.
- Stages, feedback rounds: nothing further in this repo.
- Examples: `[Albert: one target page]`

---

## Campaign — exists, not in the catalog

- `karos-campaign-orchestrator` → `campaign-orchestrator`, granted to every client since 2026-09-07. One brief → X, LinkedIn, Instagram, Reddit, blog drafts → one `13-campaign-review` gate. Deliverable `campaign-bundle`, asset `note`. Form: generic work order (goal, who is it for, success criteria).
- Decide: keep / hide / coming soon.

---

## Rebrand — coming soon (nothing exists)

- No key, no product. Only: a "Brand strategy brief" form matching no agent (`custom-agent-launch.ts:893-926`: positioning / refresh / full rebrand / voice system, business problem, audience, current vs desired perception, competitive set, non-negotiables); an icon rule (`agent-identity.tsx:110`); "deferred" in `docs/agent-integration.md:159`.
- Call: "maybe we don't even want it; we have a version; no one touches this."
- `[Albert: what a rebrand run produces, if it stays]`

---

## Marketplace: Micro-influencers · Motion design · PR — coming soon (nothing exists)

- No key, no product, no reference (only an Amazon-listing "Marketplace brief" form).
- Call: third-party services automated end to end, client pays extra. PR: budget → several articles → PR networks → referencing. Motion design via partners. Micro-influencer matching. Step 2, Albert.
- `[Albert: column wording on the catalog page]`

---

## Reporting systems (not agents)

**SEO / GEO**
- Today a runnable card (`seo-geo-agent-v2` → `seo-geo-agent`) + the recurring run of the onboarding schedule, same engine product.
- Measures AI-answer visibility: ChatGPT, Perplexity, Gemini, Claude, Copilot (appearance, citation, first position, share of roster, sentiment) + 60 site checks (`src/lib/seo-geo.ts`). Classic rankings: GSC fetcher unused.
- Persist `clientSeoGeo` (`persist-seo-geo-insights.ts`); recommendations → routable tasks (`docs/routable-recommendation-contract.md`). Reporting tab + Home card; lever table per agent family (`visibility-levers.ts:148-212`).
- Form when run as agent: business goal (direction), website, scope, market, competitors — read by the model; audited site still from the profile.

**Reputation**
- Today a runnable agent (`karos-reputation-runner` → `reputation-agent`, 25 credits). Standing form, all optional: review surfaces (seed; engine `00-roster-setup` resolves real listings), markets, context, **who an urgent review goes to** (`crisisRoutingTag`), never-claim list. The one intake that travels as run input (`submit-custom.ts:599-612`).
- One pulse: read new reviews on rostered surfaces, triage, draft a reply per review worth answering, flag what must go to a person. Output `reputation-pulse-v2`: `drafts[]`, `flags[]`, `about`; asset `note`. 0 drafts + 1 flag = successful run.
- Egress: Google Business, Yelp, App Store, Trustpilot, Facebook. No sentiment score; social comments not ingested (fetchers unused).

**Social metrics / growth / per-post performance**
- No product. `clientFollowerSnapshots` empty (writer never called); `clientMarketingAnalytics` per asset for connected channels, staff-only on Home. OAuth: IG, LinkedIn, X, YouTube, TikTok, Reddit, GSC, GA4, GBP. No scraping.
- `[Albert: KPI list for Home, in reading order]`
