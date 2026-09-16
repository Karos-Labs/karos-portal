# LinkedIn best practices (researched 2026-09-15)

Governs the LinkedIn agent. These are the base rules: the client's sector adjusts them, and what performs on the client's own account overrides both. See 11 Best practices as a system.

HARD = platform-enforced, LinkedIn-stated, legal, or Karos product rule. HEUR = data-backed default; client layer may override with a stored reason. ER = engagement rate (definitions differ, §9). vdB = Richard van der Blom; reports paywalled, figures as relayed by the linked page.

## Sources reviewed
- LinkedIn Eng: dwell-time ranking (2020-05-12) https://www.linkedin.com/blog/engineering/feed/understanding-feed-dwell-time · LLM feed rebuild (2026-03-12) https://www.linkedin.com/blog/engineering/feed/engineering-the-next-generation-of-linkedins-feed · fairness testing (2025-11-20) https://www.linkedin.com/blog/engineering/feed/putting-members-first-testing-and-measuring-how-content-appears-in-your-feed
- LinkedIn staff on record: Jurka/Roth (2024-02-27) https://www.socialmediatoday.com/news/linkedin-shares-insights-into-latest-feed-algorithm-updates/708710/ · Lorenzetti on AI slop (2026-05-19) https://www.entrepreneur.com/business-news/linkedin-is-fighting-back-against-ai-slop-and-ai-comments · 360Brew paper (2025-01-27) https://arxiv.org/abs/2501.16450 · official stats via Hootsuite (2026-06-29) https://blog.hootsuite.com/linkedin-statistics/
- vdB 2025 (1.8M posts, to Feb 2025) https://www.writtenlyhub.com/news/linkedin-engagement-down-50-algorithm-insights-report-2025 (2026-08-22) · vdB 2026 (1.3M posts, 50K creators) https://podcast.creatorscience.com/richard-van-der-blom-2/ (2026-06-02), https://melaniegoodmanlinkedinconsultant.substack.com/p/linkedin-algorithm-2026-reach-topic-authority (2026-05-07)
- AuthoredUp: formats (3M+ personal posts, Mar 2025–Feb 2026) https://authoredup.com/blog/best-performing-content-on-linkedin · limits/length (372,126 posts) https://authoredup.com/blog/linkedin-character-limit · timing (3M posts) https://authoredup.com/blog/best-days-to-post-linkedin · algorithm (621,833 posts) https://authoredup.com/blog/linkedin-algorithm — all updated Aug–Sep 2026
- Socialinsider (1.3M page posts, 16,645 pages, Jan 2024–Dec 2025, 2026-03-16) https://www.socialinsider.io/social-media-benchmarks/linkedin · Metricool (673,658 posts, 63,108 accounts, 2026-04-14) https://metricool.com/linkedin-trends/ · Buffer (2025-07-15) https://buffer.com/resources/linkedin-statistics/ · Sprout (2026-02-12) https://sproutsocial.com/insights/linkedin-engagement-rate/
- Hootsuite: timing (1M posts, Nov 2025) https://blog.hootsuite.com/best-time-to-post-on-linkedin/ · industry (2026-04-14) https://blog.hootsuite.com/social-media-benchmarks/ · algorithm (2026-07-14) https://blog.hootsuite.com/linkedin-algorithm/
- Ordinal: link study (900K+ posts, 2023–2025) https://www.tryordinal.com/blog/linkedin-link-penalty-study · company pages (2026-01) https://www.tryordinal.com/blog/the-declining-reach-of-linkedin-company-pages · reposts https://www.tryordinal.com/blog/how-to-repost-on-linkedin
- Refine Labs (7 profiles, 2023-04-21) https://www.refinelabs.com/article/personal-linkedin-engagement-vs-company-page · ConnectSafely editing (340 posts, 2026-08-11) https://connectsafely.ai/articles/does-editing-linkedin-post-affect-reach-2026 · magicpost emoji (1.2M posts, Jun 2026) https://magicpost.in/blog/linkedin-emojis · Originality.ai (5,000 posts, Jul 2026) https://originality.ai/blog/ai-content-published-linkedin · Closely bands (2026-01-12) https://blog.closelyhq.com/linkedin-engagement-rate-benchmarks-by-industry/
- ContentIn: Usera & Durham hashtags (991 posts, 2025) https://contentin.io/blog/do-hashtags-work-on-linkedin/ · stats roll-up (2026-08) https://contentin.io/blog/linkedin-content-statistics/ · hooks/formatting (own data, "success rate" undefined, 2026-09-02) https://contentin.io/blog/linkedin-algorithm-2025-the-complete-content-format-strategy-guide/ · golden hour (2026-07-22) https://contentin.io/glossary/golden-hour/
- Bait list (2026-07-06) https://linkedinpreview.com/blog/linkedin-engagement-bait-2026 · FINRA/SEC (2026) https://everyonesocial.com/blog/finra-social-media-compliance-what-rules-2210-3110-and-3120-mean-on-linkedin/ · document specs (2026-05-19) https://metricool.com/linkedin-carousel/
- Seen, not relied on: Forbes "60% link penalty" (2026-07-30, paywalled); Dataslayer "March 2026 Authenticity Update, polls 0.07%" (no primary); "Sprout Q1 2026 Index 4.7% vs 1–2%" (not on Sprout's site).

## 1. What the platform rewards now
- HARD: dwell time ranks — a P(skip) model down-ranks posts predicted to be skipped; one threshold fit text/image/video; +10% model AUC (2020-05-12, https://www.linkedin.com/blog/engineering/feed/understanding-feed-dwell-time); still live (2026-07-14, https://blog.hootsuite.com/linkedin-algorithm/).
- HARD: since 2026-03 retrieval is LLM-embedding based, ranking a transformer over 1,000+ prior interactions, surfacing "posts from authors you don't follow" (https://www.linkedin.com/blog/engineering/feed/engineering-the-next-generation-of-linkedins-feed). Author topic consistency is load-bearing; ~9–10% of feed is suggested posts (vdB 2026, https://podcast.creatorscience.com/richard-van-der-blom-2/).
- HARD: the "see more" click is no longer a signal — Jurka: "we just stopped using that" (2024-02-27, https://www.socialmediatoday.com/news/linkedin-shares-insights-into-latest-feed-algorithm-updates/708710/).
- HARD: generic AI posts/comments and attention-bait video get distribution capped to the immediate network; creation +14% YoY (2026-05-19, https://www.entrepreneur.com/business-news/linkedin-is-fighting-back-against-ai-slop-and-ai-comments); members can flag "Seems like AI slop" (2026-07-30, https://originality.ai/blog/ai-content-published-linkedin).
- HEUR: 1 save ≈ 5x a like ≈ 2x a meaningful comment; replies-to-comments ↔ up to 2.4x reach (https://authoredup.com/blog/linkedin-algorithm). Meaningful = >15 words (vdB 2025 via https://contentin.io/blog/linkedin-content-statistics/).
- HEUR: no official golden hour (https://contentin.io/glossary/golden-hour/); first 48h ≈ 50% of impressions (2026-04-14, https://metricool.com/linkedin-trends/); vdB 2025 names the first 60 min (https://www.writtenlyhub.com/news/linkedin-engagement-down-50-algorithm-insights-report-2025).
- HEUR, links — sources disagree: one body link −18.8% median reach (vdB 2026, https://melaniegoodmanlinkedinconsultant.substack.com/p/linkedin-algorithm-2026-reach-topic-authority); Ordinal: −26.5% avg, gap 5% (2023) → 42% (2025), comment-link −5–10% vs body −40–50%, mostly on pages (https://www.tryordinal.com/blog/linkedin-link-penalty-study). Metricool: page links +51% impressions, personal −27% (https://metricool.com/linkedin-trends/). LinkedIn's Sr. Director of PM denies intent (https://www.tryordinal.com/blog/the-declining-reach-of-linkedin-company-pages). Default: link out of the body.
- HEUR: person > page — ER 2.60% vs 1.60% on similar impressions (Metricool); employees 2.75x impressions, 5x engagement on 46% fewer followers (2023-04-21, https://www.refinelabs.com/article/personal-linkedin-engagement-vs-company-page); page reach −60–66% 2024→2026, pages ≈1–2% of feed (Ordinal 2026-01).
- HEUR: views −50%, engagement −25%, follower growth −59% (vdB 2025); active creators −60% over two years; 80% of first-5-min comments are AI (vdB 2026). Pre-2025 benchmarks are stale.

## 2. Post anatomy
- HARD: 3,000 chars; comments 1,250; "see more" at ~210 chars / 3 lines desktop, ~140 mobile; blank lines count (2026-08-11, https://authoredup.com/blog/linkedin-character-limit). 91% of browsing is mobile (https://authoredup.com/blog/linkedin-algorithm) → hook inside 140 chars, no blank line above it.
- HEUR length — disagreement: 1,301–2,500 chars peak ER 2.67% vs 2.10% under 400 (AuthoredUp 372K, same URL); 1,000+ chars 1.18x reach, <300 0.88x (AuthoredUp 3M, https://authoredup.com/blog/best-performing-content-on-linkedin); Buffer 1,300–1,900 (https://buffer.com/resources/linkedin-statistics/); AuthoredUp's older page 800–1,000. Default 1,200–2,000; document captions 0–100 chars, 1.28x (AuthoredUp 3M).
- HEUR: 1–2 sentence paragraphs, ≥3 line breaks (28% vs 46% "success", https://contentin.io/blog/linkedin-algorithm-2025-the-complete-content-format-strategy-guide/); reading level above grade 10 → −35% reach (AuthoredUp algorithm).
- HEUR: end on one specific question: +77% comments; explicit comment CTA +80% (Metricool). "Thoughts?" alone is bait (§4).
- HARD (Karos): link in the first comment by the author, immediately. Never add a link by editing: −42% impressions (https://connectsafely.ai/articles/does-editing-linkedin-post-affect-reach-2026).

## 3. Formats ranked, and which funnel stage each serves
Personal-profile multipliers (AuthoredUp 3M, https://authoredup.com/blog/best-performing-content-on-linkedin) beside page ER by impressions (Socialinsider, https://www.socialinsider.io/social-media-benchmarks/linkedin):

| Format | Reach | Eng. | Page ER | Stage |
|---|---|---|---|---|
| Document/carousel | 1.39x | 1.30x | 7.00% (+14% YoY) | Middle (expertise); bottom for case studies; wins above 20K followers |
| Image + text | 1.20x | 1.33x | 5.30% | Top/middle; best under 5K followers |
| Text only | 1.07x | 0.78x | 4.50% | Any stage; founder-voice default |
| Poll | 1.78x | 0.37x | 4.20% | Top only; 0.65 comments avg (Metricool) |
| Video | 0.86x | 0.93x | 6.00% | Middle; 3+ min 1.21x vs 30 s 0.96x |
| Article | 0.69x | 0.44x | — | Bottom; prefer a newsletter edition |
| Reshare | 0.29x | 0.22x | — | Never the deliverable |

- Video disagreement: LinkedIn reports views +36%, creation +27% (https://blog.hootsuite.com/linkedin-statistics/); Socialinsider shows page video views −36% YoY; Metricool calls it "underperforming" though it is the most-used personal format. Most posted, not best performing.
- Carousels: 11x interactions vs a single image, 1,451 impressions vs 606 for video (Metricool); multi-image ER 6.45% (Socialinsider) vs 3.71% (Metricool, different denominator).
- Newsletters: 489 of the top 500 are individuals', 35–45% open rates (https://contentin.io/blog/linkedin-content-statistics/); vdB gets 80% of paying conversions via newsletter. Out of scope for a one-post run; surface as a recommendation.

## 4. Hooks
- HEUR: statements beat questions (42% vs 35% "success", 6.6% vs 4.3% ER); 5–7-word first line best, 11+ words drops to 35% (ContentIn hooks page).
- Working patterns, each tied to one buyer problem: number + outcome ("Cut onboarding from 14 days to 3. Here's the checklist."); contrarian claim about the buyer's process ("Your RFP is why your agency underdelivers."); first-person cold open ("I priced our audit wrong for two years."); named mistake + fix.
- HARD (flagged as bait): binary votes, quote + "Agree?", "Tag 3 founders", "Only 1% will share", follow-baiting, fake questions with a thumbs-up ask (https://linkedinpreview.com/blog/linkedin-engagement-bait-2026); LinkedIn confirms bait detection (Hootsuite 2026-07-14).
- Reads as AI/broetry: one sentence per line for 20 lines, "Here's the thing.", "Let that sink in.", "Unpopular opinion:", triads, em-dash chains, "Why? Because…", a hook the body never pays off. 81.2% of long posts already read as AI (Originality, Jul 2026); the bar is "sounds like this person".
- First line: ≤140 chars; no emoji before word one; no blank line, hashtag, mention, or link; names the problem or the result.

## 5. Writing rules
- Voice: the identity's own vocabulary from the profile read; "I" for founders, "we" for pages; one idea per post.
- No-AI-tells: "In today's fast-paced", "game-changer", "delve", "navigate the landscape", "It's not X, it's Y", rule-of-three padding, closing "Thoughts?", emoji bullets on every line, hashtag walls, "Let's dive in".
- Hashtags HEUR: 0–3 at the end; 0–3 tags +5–10% vs more, 10+ −30–50% (vdB 2026, Goodman); 2–3 sweet spot, tagging people beats hashtags, hashtag-following removed 2024 (https://contentin.io/blog/do-hashtags-work-on-linkedin/). Default 0–2 niche tags.
- Mentions: ≤2, only people/pages likely to reply; tag chains are bait.
- Emoji HEUR: 0–2; median likes 26 (none) → 34 (two) → 26 (five); usage fell 64.1% → 48.3% 2024→mid-2026 (https://magicpost.in/blog/linkedin-emojis). Punctuation, never bullets.
- Numbers: every statistic sourced in the body or first comment; no unsourced round numbers from the brief.
- Regulated claims HARD: finance posts are FINRA 2210 retail communications — principal review, SEC 17a-4 retention, testimonial disclosures (https://everyonesocial.com/blog/finra-social-media-compliance-what-rules-2210-3110-and-3120-mean-on-linkedin/). Health/legal: no outcome guarantees; client disclaimer verbatim.
- Paragraphs ≤2 sentences, sentences ≤25 words, reading grade ≤8.

## 6. Media rules
- Default is text. Add an image only when it carries a fact (screenshot, chart, photo of the thing). Images with people perform up to 50% better (vdB 2025, writtenlyhub); a selfie routes reach toward connections — right for story posts, wrong for expertise posts (vdB, Creator Science).
- Client-supplied document HARD: PDF/PPT/DOC, ≤100 MB, ≤300 pages (https://metricool.com/linkedin-carousel/). HEUR: 7–15 slides, 1080×1080, mobile-legible, CTA on the last slide, caption ≤100 chars.
- Never generate stock imagery or attach a document the client did not supply. Media cannot be edited after posting (2026-06-08, https://linkedinpreview.com/blog/does-editing-a-linkedin-post-reduce-reach) — vet before delivery.
- Video only if client-supplied; captions on; longer beats 30 s (AuthoredUp 3M).

## 7. Distribution mechanics
- Windows HEUR — disagreement: Hootsuite (1M posts, Nov 2025): Tue 6–8am, Wed 9am, Thu 2pm; finance 5–7pm, hospitality Wed 12pm, tech Mon 11am (https://blog.hootsuite.com/best-time-to-post-on-linkedin/). AuthoredUp (3M): personal profiles vary <10% by weekday, weekends within 7%, peak 8–11am local; pages Wed ≈1.7x Sunday, weekdays +48%; "a carousel at a mediocre hour beats text at the perfect time" (https://authoredup.com/blog/best-days-to-post-linkedin). Default Tue–Thu 8–10am in the buyer's timezone; weekends allowed for founders.
- Cadence HEUR: 2–4/week; daily −26% per post, −45% over time (vdB 2026, Goodman); 4–5/week gives the best ER, 2.60%, 870 median impressions (AuthoredUp 3M); never two posts in 24h (AuthoredUp algorithm).
- First hour: author replies to every comment; replies within 30 min → 64% more comments, 2.3x views (Closely 2025 via https://contentin.io/blog/linkedin-content-statistics/). Comment on others' posts 15–30 min around posting, up to +20% (vdB via https://www.dowsocial.com/linkedin-algorithm-2026/, 2025-10-28).
- Reposts: the page reposts the founder's post after the first hour; personal reposts earn ~2x a page repost (https://www.tryordinal.com/blog/how-to-repost-on-linkedin); reshares reach 0.29x (AuthoredUp 3M). Disagreement: vdB says instant repost beats repost-with-thoughts (via AuthoredUp algorithm); Ordinal/Gromming say the opposite without data.
- Editing HARD: typos within 10 min cost nothing measurable; 10–30 min −10–15%; 30–90 min −30–40%; hashtag edits −12–18%; added link −42% (ConnectSafely). After 10 min, correct in a comment.

## 8. What varies by industry
ER benchmarks: https://blog.hootsuite.com/social-media-benchmarks/ (2026-04-14); timing: https://blog.hootsuite.com/best-time-to-post-on-linkedin/ (Nov 2025).

| Segment | Tone | Proof | Formats | Timing | Hard constraints |
|---|---|---|---|---|---|
| B2B SaaS | Operator, specific | Metrics, teardowns | Text, document, screenshot | Tue–Thu am; tech Mon 11am | Bench 3.72%; no invented case-study numbers |
| Consumer & DTC | Founder ops, margins | Unit economics, ops photos | Image+text, carousel | Tue–Thu am | Bench 4.15% (retail); buyer is retailers/investors/hires, not shoppers |
| Local services & hospitality | Warm, place-specific | Before/after, occupancy, team | Image, carousel | Wed 12pm | Bench 4.5%; consent for guest/staff photos; no review quotes without permission |
| Finance & regulated | Explainer, hedged | Macro context, process, credentials | Text, document | 5–7pm | Bench 3.44%; FINRA 2210 pre-review, 17a-4 retention, no performance promises |
| Creator & personal brand | First person, opinionated | Own results, receipts | Text; selfie for story only | Any day, weekends OK | One topic lane; never impersonate |
| Agency | Practitioner, no jargon | Client results with permission | Document, text | Tue–Thu am | Bench 4.02%; client names only with sign-off; never narrate review/approval |

## 9. What to measure and benchmarks
- Definitions differ: Socialinsider = engagements ÷ impressions on pages, 5.20% avg (+8% YoY); Sprout, same formula, puts most brands at 3–5% (https://sproutsocial.com/insights/linkedin-engagement-rate/); Metricool personal 2.60% / page 1.60%; Hootsuite industries 2.95–4.5%. Compare a client only to its own vendor's series.
- Per post: impressions, ER by impressions, comments and comments ≥15 words, saves, profile visits, follows, first-comment link clicks. Platform trend: clicks +5% while likes −13%, comments −17%, shares −10% (Metricool).
- Follower bands (by followers, https://blog.closelyhq.com/linkedin-engagement-rate-benchmarks-by-industry/): 1–5K: 4–8%; >50K: 1–3%. Page audience growth 24.5% (1–5K) vs 6.4% (100K–1M) (Socialinsider). Median impressions at 4–5 posts/week, personal: 870 (AuthoredUp 3M).
- Comments per post by format: image 2.80, carousel 2.38, text 1.75, video 0.98, poll 0.65 (Metricool).

## 10. Pre-delivery checklist
1. Hook ≤140 chars, no blank line above, names the buyer problem or result
2. Funnel stage and which of the three questions it answers are stated
3. No URL in the body; link drafted as the first comment
4. 1,000–2,500 chars (text) or ≤100-char caption (document)
5. Paragraphs ≤2 sentences, ≥3 line breaks, reading grade ≤8
6. Zero bait phrases from §4
7. Zero AI-tell phrases from §5; no line-per-sentence broetry
8. ≤2 hashtags at the end or none; ≤2 mentions, each likely to reply
9. ≤2 emoji, none as bullets
10. Every number sourced in body or first comment
11. Regulated client: disclaimer verbatim, no outcome promise, compliance flag set
12. Media only if client-supplied, spec-checked, not stock
13. Ends on one specific question, not "Thoughts?"
14. Voice matches the profile read (vocabulary, pronoun, cadence)
15. Posting window and 60-minute reply plan in the delivery note

## 11. Feedback for the developer integrating this
- Research: pull the identity's last 20 posts and compute ER-by-impressions, comment rate, format mix; same for 3 competitors. Record the topic lanes the identity already owns — the 2026 feed ranks on author topic history.
- Decide: funnel stage first, then format (§3), then hook family (§4). Top → statement hook, image+text or poll; middle → document or 1,500+ char method post; bottom → text with a named result plus first-comment link. Text is the default at every stage.
- Vet: run §10 as pass/fail against a 140-char mobile preview. Any HARD fail rejects; HEUR fails downgrade with the reason shown to the reviewer.
- Draft: emit body, first comment (link + sources), posting window, 3 reply seeds for the first hour. Honour client "none" settings (hashtags, emoji) absolutely.
- Hard vs default: HARD = §2 limits, no body link, no bait, no post-edit link, regulated review, draft-only, one post per run. Every HEUR is overridable per client with a stored reason ("always 3 hashtags", "post 19:00 Paris", "no emoji").
- Learning loop: log format, length, hook family, hashtag and emoji counts, posted time, first-hour comments, 48h impressions, saves, first-comment clicks; recompute per-client multipliers monthly and prefer them over these globals once n ≥ 20 posts.
- Refresh quarterly: vdB (Apr–May), Socialinsider (Mar), Metricool (Apr), AuthoredUp (monthly). The 2026-03 LLM feed rebuild invalidates timing and format lore older than that.
