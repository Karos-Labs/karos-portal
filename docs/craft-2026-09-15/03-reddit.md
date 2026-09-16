# Reddit best practices (researched 2026-09-15)

Governs the Reddit agent. These are the base rules: the client's sector adjusts them, and what performs on the client's own account overrides both. See 11 Best practices as a system.

HARD = site policy, published sub rule or ban mechanic. HEUR = evidence-based default the client layer may tune.

## Sources reviewed
Primary: Reddit Rules https://redditinc.com/policies/content-policy · Reddiquette (2025-08-18) https://support.reddithelp.com/hc/en-us/articles/205926439 · spam definition (2024-02-09) https://support.reddithelp.com/hc/en-us/articles/360043504051 · self-promotion wiki https://www.reddit.com/wiki/selfpromotion · CQS (2024-04-25) https://support.reddithelp.com/hc/en-us/articles/19023371170196 · AI/manipulated content (2026-05-19) https://support.reddithelp.com/hc/en-us/articles/41180423371156 · AI search (2026-07-30) https://support.reddithelp.com/hc/en-us/articles/32026729424916 · Transparency H1 2025 https://redditinc.com/transparency-report-january-to-june-2025-reddit, H2 2025 https://redditinc.com/policies/transparency-report-july-to-december-2025-reddit · Best-sort post (2009) https://redditblog.com/2009/10/15/reddits-new-comment-sorting-system/ · sort code https://github.com/reddit-archive/reddit/blob/master/r2/r2/lib/db/_sorts.pyx · r/SaaS, r/smallbusiness sidebars (Wayback) · FTC FAQ https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking.
Research/press: arXiv 2411.05328 · Zurich abstract https://retractionwatch.com/wp-content/uploads/2025/04/ExtendedAbstract-Zurich-AI-Reddit.pdf · TechCrunch 2025-05-06, 2026-02-05, 2026-03-25 · Semrush 2025-06, 2026-08 · Tinuiti Q1 2026 via https://saasintelligence.substack.com/p/reddits-ai-citation-share-just-grew · Sistrix via https://thestacc.com/blog/reddit-seo-statistics-2026/.
Practitioner (observational): Octolens https://octolens.com/reddit-b2b-saas-study · replyt https://replyt.co/research/how-long-reddit-replies-stay-visible · redditgrow https://redditgrow.ai/blog/reddit-karma-requirements · soar.sh · reddgrow · Wikipedia "Signs of AI writing".

## 1. What the platform rewards now
- HARD: "Best" (default comment sort) = Wilson lower bound on votes; time is not a factor (2009 post; code uses 80% confidence, the post said 95%). Early votes move rank most; 10:1 can outrank 40:20.
- Post "hot" = log10(score) + age/45000 s: 10x votes buys 12.5 h (sort code).
- Timing: 6.0% of comments land in the first 30 min, 9.4% in the first hour; first-30-min comments are significantly lower quality than the next 30 min (https://arxiv.org/pdf/2411.05328). First-90-min replies take ~60–75% of upvotes; after hour 6, 1–2 (replyt 2026-08). Replies within 2 h get 4.7x engagement; 73% of activity is inside 6 h (Octolens 2026-03). HEUR window: 30 min–3 h.
- Top 3 replies take 80–85% of upvotes (replyt).
- Google: 4th most visible US domain, 842M monthly organic clicks (Sistrix 2026-03); AI Overviews quote Reddit comments as "Community Perspectives" since 2026-05-07 (https://nobori.ai/blog/google-ai-overviews-community-perspectives-reddit-citations-2026); indexed threads send traffic 8–14 months (replyt).
- AI answers: Reddit = 40.1% of 150k LLM citations (Semrush 2025-06 https://www.semrush.com/blog/most-cited-domains-ai/); ChatGPT's share fell 60%→10% Aug–Sep 2025 and 3.8%→0.5% Aug 2026 (https://www.semrush.com/blog/reddits-citations-in-chatgpt-fall/); sole-source citations +31% on product queries (Tinuiti 2026-01). Reddit Answers (15M weekly users) cites the exact comment (TechCrunch 2026-02-05): write a quotable, self-contained answer.
- Karma/age: CQS (5 tiers) is filterable in AutoMod via `contributor_quality`; Lowest is filtered regardless of karma. Observed gates: niche 50–200 karma/1–2 weeks; mid 200–500/2–4 weeks; large 500–2,000+/3–6 months (redditgrow 2026-08).
- Removal: 2.66% of content removed (1.41% mods, 1.25% admins); spam = 57.5% of admin removals (H1 2025); 68.6% of mod removals automated and silent (H2 2025).

## 2. Reply anatomy
- Length (HEUR; no public dataset): 60–180 words for a direct question, 200–350 for comparisons. Helpful replies average 89 upvotes vs 11 promotional (Octolens).
- Line 1 = the answer or the condition it hinges on. No greeting, praise or restating.
- Body: answer → 2–4 concrete reasons/steps → where it fails → optional offer to expand.
- Lists only for steps or ≥3 options; no headers, bold, emoji.
- Links (HARD): none in warming; established only where allowed; no shorteners, redirects or tracking params (spam page; r/SaaS strips UTM links per reddgrow); third-party sources first.
- Disclosure (HARD on any mention), in the comment not the bio (FTC FAQ): "Disclosure: I work at X." before the mention.

## 3. Formats ranked, and which funnel stage each serves
1. Direct answer — attention + expertise; highest upvote and citation odds; default.
2. Experience share — expertise; strongest trust; must be true for the account owner (§5).
3. "Here's how I'd think about it" — expertise → decide; for malformed questions; no product needed.
4. Criteria-based comparison — decide; established mode, vendor-tolerant subs only; 2–3 options, client last, disclosed.
5. AMA-style "happy to answer follow-ups" — decide; closing line only.

## 4. Openers
- Land: a condition ("Depends whether you're on the free tier; if so…"); a verdict ("Don't. Here's why."); a scoped experience ("Ran this two years at a 12-person shop.").
- Read as AI: "Great question", "I totally get it", "Here's the thing:", restating OP, "As someone who…", triplets, em dashes, "it's not X, it's Y", summary closer (Wikipedia).
- Read as shill, and get called out: brand in sentence one, "we/our platform", "DM me", identical phrasing across threads, a new account mentioning one brand, invented credentials, bot-speed replies.

## 5. Writing rules
- Culture: technical subs = specifics, bluntness; hobby/DTC = first person, humour; finance/health/legal = caveats, sources, no vendors; local = place names. Match the sub, not the brand voice.
- No-AI-tells (reject on any): delve, landscape, tapestry, leverage, robust, seamless, crucial, testament, "not only…but also", "it's worth noting", rule-of-three, em dashes, "Hope this helps".
- Humour: one dry line, only where the sub uses it. Numbers: unit + source or own observation; round like a person.
- HARD, nothing invented (biography, employer, customer, result): Rule 5 "Be authentic… do not intentionally mislead". The 2026-05-19 policy allows AI-assisted text subject to sub rules but bans AI content that "presents itself as human-generated": the draft is a proposal the human edits and adopts, built only from their true experiences. Zurich's invented-persona bots were 3–6x as persuasive as humans (1,061 posts, Nov 2024–Mar 2025) and drew Reddit's legal threat.
- Product mention when allowed: after the answer, one sentence, disclosed, with a real limitation, no link unless permitted; the reply must still solve the problem with that sentence deleted (r/SaaS rule 2: only if "relevant and actually helpful"; r/smallbusiness: "not done repeatedly").

## 6. Thread selection rules
- Answer: under 6 h old (under 24 h in a sub with under ~5 posts/day); OP asked a question/comparison or described the problem; under ~25 comments, none covering the client's angle (whitespace); score ≥ 1; not locked, removed or "no promo"-flaired.
- Evergreen exception: an older thread ranking in Google for a buyer query with thin top replies: no votes, months of Google/AI readership (replyt). Rings 2–3 only, no mention.
- Skip: megathreads/promo threads (unless the client opts in), memes, polls, vendor-forbidden flairs, threads where mods removed vendor replies, OP marked solved, threads already answered by the account.
- 23% of B2B threads carry buying intent (Octolens). Score = intent × freshness × whitespace × tolerance.

## 7. Account and posting mechanics
- HARD 9:1: at most 1 in 10 contributions is your own content (Reddiquette 2025-08-18; wiki: "10% or less"); ledger over the last ~100 items.
- HARD: no vote requests, colleague upvotes, alt accounts, or the same text across subs (spam page; Rules 2, 5). Sub-ban evasion escalates 3-day → 7-day → permanent (H1 2025).
- Rate: new accounts ~1 comment/10 min, undocumented (https://www.soar.sh/blog/reddit-error-doing-that-too-much-rate-limit 2026-05). Writing speed is a bot signal (TechCrunch 2026-03-25).
- Warming (HEUR): 30+ days and 100–300 combined karma before any mention; r/marketing gate reported as 30 days/300 karma (signals.sh) vs 60 days/100 karma (soar.sh): conflict, read the live sidebar.
- Velocity: ≤3 replies/day warming, ≤6 established, across ≥3 subs; ≤1 mention per sub per week.
- Verified sub rules: r/SaaS bans unsolicited direct sales and PM requests; r/smallbusiness and r/startups allow promotion only in designated threads (https://www.redditmaster.com/subreddit-rules/startups); r/personalfinance bans vendors (soar.sh); r/changemyview bans AI text (TechCrunch 2025-05-06). On removal: one polite modmail, never a repost.

## 8. What varies by industry
| Vertical | Subs (rings 1→3) | Tone | Proof | Mention tolerance | Hard constraints |
|---|---|---|---|---|---|
| B2B SaaS | r/SaaS, r/startups → r/devops → r/smallbusiness | blunt, technical | configs, numbers | low; comments only, disclosed | 30–60 day + karma gates; no UTM |
| Consumer/DTC | brand sub → r/BuyItForLife → advice subs | casual, first person | photos, price paid | medium; zero in advice subs | "no vendor" flairs; FTC disclosure |
| Local/hospitality | city subs → r/travel-type → "moving to" threads | local, specific | addresses, prices | low | local flair gates; no self-listing |
| Finance/regulated | r/personalfinance, r/fatFIRE → r/legaladvice, r/AskDocs | cautious, sourced | citations, regulator links | none | vendor ban; disclaimers; jurisdiction |
| Creator/personal brand | r/youtubers, r/podcasting → craft subs → r/smallbusiness | peer, generous | process, real metrics | medium if a real person | strict 9:1; no link drops |
| Agency | r/marketing, r/PPC, r/SEO → r/smallbusiness → r/Entrepreneur | expert, no pitch | frameworks, caveated results | very low; "DM me" = ban trigger | r/marketing 10% rule + flair |

## 9. What to measure and benchmarks
- Per reply: score at 2 h / 24 h / 7 d; Best rank; OP replied; removal (AutoMod/mod/admin) + reason. Per account: karma trend, silent-filter rate (CQS proxy), profile views.
- Benchmarks (HEUR): 89 vs 11 avg upvotes helpful vs promotional (Octolens; niche-sub median 1–10); platform removal baseline 2.66% (H1 2025), a brand account above 5% is mis-vetting; 6.9% of user reports lead to removal (H2 2025).
- Visibility: indexed in 3–7 days, referrals within 2 weeks (replyt); ranks for the buyer query; appears in Community Perspectives, Reddit Answers or Perplexity (24% Reddit, Tinuiti).
- Funnel: profile clicks → reddit.com-referred sessions → trials; 1–5% click-to-trial (https://www.abetheagency.com/guide/reddit-b2b-advertising-benchmarks-2026).

## 10. Pre-delivery checklist
1. Thread under 6 h (or evergreen-ranked, thin replies); not locked/removed.
2. First sentence answers what OP asked.
3. Sub rules re-read today; no vendor, link, AI-text or age rule broken.
4. Account clears the karma/age gate; not rate-limited.
5. Warming mode = zero product, brand or domain mentions.
6. With every mention deleted, the reply still solves the problem.
7. If mentioned: one sentence, after the answer, disclosed, real limitation stated.
8. No links unless allowed; no shorteners/UTM.
9. Zero AI tells (word list, em dashes, triplets, closer, greeting).
10. Every fact is true for the account owner; nothing invented.
11. Numbers sourced; register matches the sub; length within §2.
12. Text not reused; 9:1 ledger and per-sub weekly cap still hold.
13. The two options differ in approach, not wording.

## 11. Feedback for the developer integrating this
- Research: capture thread age, comment count, OP replies, score, flair, lock state; cap at 6 h unless an "evergreen" (Google-ranked) flag is set. Cache each sub's sidebar, wiki and pinned threads; refresh weekly.
- Decide: score = intent × freshness × whitespace × tolerance; drop already-answered and promo threads unless opted in.
- Vet (HARD, not overridable): sub-rule scan for promotion/vendor/affiliate/AI/link/karma/age; account vs gate; mode; 9:1 ledger; weekly cap; duplicate text; link policy; disclosure. AI-text ban → skip the sub; prior silent removals → hold.
- Draft: enforce §2 length and §5 tells with regex plus a model pass. Generate the product sentence separately; inject only in established mode after the deletion test passes.
- Hard vs default: HARD = Reddit Rules, sub rules, 9:1, disclosure, nothing invented, no banned links, draft-only. DEFAULT (client-tunable within HARD) = length, mention cadence, sub list, register, evergreen flag, velocity caps. The client layer supplies the owner's true-experience allow-list (the only permitted biography), real product limitations, banned subs, disclosure text; show it the 2026-05-19 AI policy at setup.
- Log per reply: sub, thread age, position, mode, mention, length, format (§3), score at 2 h/24 h/7 d, OP reply, removal + reason, indexed date, cited-in-AI. Feed removal reasons into per-sub vet rules.
- Two-approach output: A = direct answer (§3.1); B = experience or decision frame (§3.2/3.3). Different opener type, structure and length; identical facts and disclosure. Never paraphrases.
