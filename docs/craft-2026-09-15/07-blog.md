# Blog best practices, SEO and GEO (researched 2026-09-15)

Governs the Blog agent. These are the base rules: the client's sector adjusts them, and what performs on the client's own account overrides both. See 11 Best practices as a system.

HARD = Google policy, legal, or structured-data validity. HEUR = evidence-backed default the client layer may tune.

## Sources reviewed
- Google Search Central: [Optimizing for generative AI features](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) (upd. 2026-07-10) · [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features) (2025-12-10) · [Creating helpful content / E-E-A-T](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) (2025-12-10) · [Gen-AI content guidance](https://developers.google.com/search/docs/fundamentals/using-gen-ai-content) (2025-12-10) · [Spam policies](https://developers.google.com/search/docs/essentials/spam-policies) (2026-08-28) · [Ranking systems](https://developers.google.com/search/docs/appearance/ranking-systems-guide) (2025-12-10) · [Article schema](https://developers.google.com/search/docs/appearance/structured-data/article) (2026-09-08) · [Structured-data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies) (2026-07-10) · [Title links](https://developers.google.com/search/docs/appearance/title-link) · [Snippets](https://developers.google.com/search/docs/appearance/snippet) (2026-04-20) · [Byline dates](https://developers.google.com/search/docs/appearance/publication-dates) · [Links](https://developers.google.com/search/docs/crawling-indexing/links-crawlable) · [Canonicals](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) (2026-07-10) · [Sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) (2026-07-08) · [SEO starter guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide) · [Core Web Vitals](https://web.dev/articles/vitals).
- Ahrefs: [AIO clicks −34.5%](https://ahrefs.com/blog/ai-overviews-reduce-clicks/) (2025-04-17) · [freshness, 17M URLs](https://ahrefs.com/blog/do-ai-assistants-prefer-to-cite-fresh-content) (2025-07-28) · [brand mentions, 75k brands](https://ahrefs.com/blog/ai-overview-brand-correlation/) (2025-05-26) · [AIO citations vs top-10](https://ahrefs.com/blog/ai-overview-citations-top-10/) (data 2026-03-02) · [AIO vs AI Mode, 730k pairs](https://ahrefs.com/blog/ai-overviews-vs-ai-mode) (2025-09) · [llms.txt, 137k sites](https://ahrefs.com/blog/llmstxt-study/) (2026-06-15) · [time to rank](https://ahrefs.com/blog/how-long-does-it-take-to-rank-in-google-and-how-old-are-top-ranking-pages/) (2025-05-15) · [stats roll-up](https://ahrefs.com/blog/ai-seo-statistics/).
- Semrush: [AI Mode comparison, 5k kw](https://semrush.com/blog/ai-mode-comparison-study) (2025-07-21) · [AI traffic value](https://www.semrush.com/blog/ai-search-seo-traffic-study/) (2025-07-21) · [AIO study, 200k kw](https://www.semrush.com/blog/ai-overviews-study/) (data 2024-09).
- [Pew Research, 900 adults / 68,879 searches](https://www.pewresearch.org/short-reads/2025/07/22/google-users-are-less-likely-to-click-on-links-when-an-ai-summary-appears-in-the-results/) (2025-07-22) · [Profound, 680M citations](https://www.tryprofound.com/blog/ai-platform-citation-patterns) (2024-08→2025-06) · [BrightEdge, 16-month overlap](https://www.brightedge.com/resources/weekly-ai-search-insights/rank-overlap-after-16-months-of-aio) (2025-09) · [SE Ranking AI Mode, 10k kw](https://seranking.com/blog/ai-mode-research/) (2025-06-20) and [stats roll-up](https://seranking.com/blog/ai-statistics/) · [Surfer, AIO sources](https://surferseo.com/blog/how-ai-overviews-choose-sources) (2026-09-09) · [Aggarwal et al., GEO, KDD 2024](https://arxiv.org/abs/2311.09735) · Kevin Indig [AIO UX study](https://www.growth-memo.com/p/the-first-ever-ux-study-of-googles) (2025-05-12) and [H1-2026 report](https://www.growth-memo.com/p/ai-halftime-report-h1-2026) (2026-07-27) · [Zyppy title rewrites, 81k titles](https://zyppy.com/seo/google-title-rewrite-study/) (2022) and [McAlpin Q1-2025](https://www.hireawriter.us/seo/google-changed-76-of-title-tags-in-q1-2025-why) · [Zyppy internal links, 23M links](https://zyppy.com/seo/internal-links/internal-linking-study/) (upd. 2026-02-23) · [Orbit Media survey, 1,042 marketers](https://www.orbitmedia.com/blog/blogging-statistics/) (2026) · [SEJ on FAQ rich results](https://www.searchenginejournal.com/google-drops-faq-rich-results-from-search/574429/) (2026-05) · [EU AI Act Art. 50](https://artificialintelligenceact.eu/article/50/) · Ahrefs Dec-2025 CTR update via [Medianama](https://www.medianama.com/2026/02/223-google-ai-overviews-click-through-rates-58-study/) (secondary; primary blocked).

## 1. What gets ranked and what gets cited now
- HARD (Google, 2026-07-10): AI Overviews and AI Mode run on core ranking, "no additional requirements"; page must be indexed and snippet-eligible; `nosnippet`/`max-snippet`/`noindex` also limit AI use; no special schema; llms.txt ignored; no chunking or rewriting for AI, no "inauthentic mentions".
- Clicks: top-result CTR −34.5% under an AIO (Ahrefs, 300k kw, 2025-04), −58% on Dec-2025 data (Ahrefs via Medianama, 2026-02). Pew, 2025-03: 8% click a result under an AIO vs 15% without; 1% click inside it; 26% end the session.
- Each click is worth more: AI-search visitors convert 4.4× organic (Semrush, 2025-07); 0.5% of Ahrefs traffic gave 12% of its signups (2025).
- Rank feeds citations unevenly: domain overlap with Google top-10 is 91% Perplexity, 86% AIO, 54% AI Mode, ChatGPT lowest (Semrush, 2025-07). AIO citations from ranking pages rose 32.3%→54.5% (BrightEdge, 2024-05→2025-09), yet only 16.7% come from the top-10; top-10 share fell ~76%→37.1% and 36.7% now come from outside the top-100 via fan-out (Ahrefs, 2026-03).
- Freshness: AI-cited URLs average 1,064 days vs 1,432 organic, 25.7% fresher; ChatGPT 958; AIO equals organic (Ahrefs, 17M URLs, 2025-07). Updated <3 months: 2× as likely cited by ChatGPT; <2 months: +28% in AI Mode (SE Ranking, 2025).
- Brand beats links: branded web mentions correlate 0.664 with AIO visibility, backlinks 0.218; top-quartile brands get 169 AIO mentions vs 14 (Ahrefs, 75k brands, 2025-05).
- Third parties dominate: ChatGPT cites Wikipedia 7.8%, Perplexity Reddit 6.6%, AIO Reddit 2.2% and YouTube 1.9% (Profound, 680M citations, 2025-06); ChatGPT cites pages ranked 21+ ~90% of the time (Semrush). Engines disagree: AIO↔AI Mode 13.7% citation overlap (Ahrefs, 2025-09); 91% of citations appear in one engine only (Indig, 2026-07).
- Text features that win (Aggarwal et al., KDD 2024): quotations +41%, statistics +33%, cited sources +28%, fluency +29%; keyword stuffing −9%; gains largest for lower-ranked pages (rank-5 +115%, rank-1 −30%).
- Divergence: Google rewards rank, brand and page experience; ChatGPT and Perplexity reward recency, depth and third-party corroboration. Rank is the entry ticket for AIO and Perplexity, not ChatGPT.

## 2. Article anatomy
- Title = H1, 30–60 chars (HEUR): 84.87% of unrewritten titles sit there; 76.04% get rewritten (McAlpin, Q1-2025); 70+ chars rewritten 99.9% (Zyppy, 2022). Numbers survive 97.3% when in title and H1.
- Answer-first: the first 40–70 words answer the query (AIO median 67 words, Pew 2025-03), with one first-hand fact.
- H2s as questions for informational intent: 60% of question searches trigger an AIO vs 8% of 1–2-word ones (Pew).
- Sections of 120–180 words earn 70% more citations than <50-word ones (SE Ranking, 2025). Paragraphs ≤4 sentences, sentences ≤20 words (HEUR, no primary data).
- Lists for steps, tables for comparisons; commercial answers run ~2× longer than informational (Semrush, 2025-07).
- ≥1 sourced, dated statistic per H2 (+33%); ≥1 quote from a named person with role and date (+41%); the client's staff count.
- FAQ: 3–5 questions as in-page headings; FAQPage markup gives no rich result since 2026-05-07 (SEJ); harmless, optional.
- Length: Google has "no preferred word count". Average post 1,312 words, 13.9% report strong results (Orbit, 2026); pages >2,900 words are 59% more likely cited (SE Ranking, 2025). HEUR: attention 1,200–2,000; expertise 1,800–3,000; decide 1,000–1,800.
- Images: 2–3 visuals optimal (Orbit, 2026); schema image ≥50k px in 16:9, 4:3, 1:1; alt text says what the image shows.
- Schema: `BlogPosting` with `headline`, `author` (Person + `url`), `datePublished`, `dateModified`, `image`; plus `Organization`, `BreadcrumbList`.

## 3. Formats ranked, and which funnel stage each serves
1. Original research / data post → every stage; the page others cite; earns brand mentions; Google's original-content system elevates first publishers.
2. Comparison → expertise → decide; tables; longest AI answers.
3. How-to → expertise; numbered steps; HowTo rich result gone since 2023.
4. Listicle / best-of → decide; "best-of lists, product pages and guides drive most AI traffic" (Ahrefs).
5. Guide / explainer → attention; 80% of AIO triggers are informational (Semrush, 2024-09): cited, rarely clicked.
6. Opinion → attention, brand; Google asks for "a unique point of view"; linked more than cited.
7. Glossary → attention; high AIO trigger, near-zero clicks; short, links into guides.

## 4. Openings and titles
- Title patterns: "How to [task] in [timeframe] ([constraint])"; "[X] vs [Y]: which for [use case] (2026)"; "[N] [things] for [audience], tested on [metric]".
- Opening: one-sentence answer → why it matters → what follows; a number and a source in the first paragraph.
- Reads as AI or clickbait: "In today's fast-paced world", "Ultimate guide", "unlock", "game-changer", "Let's dive in", rhetorical-question openers, triads, colon-stacked titles, promises without a number.
- Google rewrites (2025-12-10): boilerplate, repeated keywords, half-empty titles, stale years, title/H1 mismatch; 63% of rewrites strip brand names (McAlpin, Q1-2025): topic first, brand last.

## 5. Writing rules
- Voice: the client's; second person; concrete nouns; one idea per paragraph.
- No-AI-tells: em-dash chains; "delve, leverage, robust, seamless, landscape, navigate, crucial"; "It's important to note"; "not X, but Y"; rule-of-three lists; uniform paragraph length; hedge stacks; restating conclusions; sentence-initial "Additionally/Moreover".
- Sourcing (HARD, Karos): two independent sources per non-obvious claim, primary preferred, linked inline; every number dated; no source, no claim. Google's bar: "no easily-verified factual errors".
- E-E-A-T: byline linking to a profile (`author.url`); "who, how, why" on the page; first-hand evidence (screenshots, client data, own tests). Trust matters most; not a direct ranking factor (Google).
- AI disclosure: Google recommends, doesn't require, saying how content was created (2025-12-10). HARD from 2026-08-02: EU AI Act Art. 50(4) requires disclosing AI-generated text on matters of public interest unless it "has undergone a process of human review or editorial control" with named editorial responsibility → every article names a human editor, or carries the label.
- Internal links: 3–10 per article, only to URLs verified live; descriptive, varied anchors (anchor variety is the strongest correlate of clicks; 40–44 inbound links ≈4× the traffic of 0–4 — Zyppy, 2026-02); no "click here"; ≥1 inbound link from an existing page.
- Canonical: self-referencing on the original; syndicated copies point to it; never `noindex` to canonicalise (Google, 2026-07-10).

## 6. Technical and publishing rules
- Meta title 30–60 chars; meta description unique, 1–2 sentences, ~150–160 chars before truncation (Google sets no limit, 2026-04-20).
- Slug: hyphenated words, no date, matching the title (slug/title alignment marks "core" AIO sources — Surfer, 2026-09).
- Structured data (HARD): JSON-LD; markup matches visible content; images crawlable; validate in Rich Results Test; violations bring a manual action.
- Dates (HARD): visible "Published"/"Updated" matching `datePublished`/`dateModified`; no stray dates; never re-date without substantive change.
- Speed: LCP ≤2.5 s, INP ≤200 ms, CLS ≤0.1 at the 75th percentile (web.dev).
- Sitemap: accurate `lastmod` (Google trusts it only if consistently accurate; ignores `priority`/`changefreq`); submit in Search Console; request indexing via URL Inspection.
- No `nosnippet`/`max-snippet` on articles meant to be cited.
- Cadence (HEUR): decide/pricing pieces every 60–90 days, evergreen yearly; 73% of bloggers update old posts (Orbit, 2026).

## 7. What varies by industry
| Industry | Depth (words) | Proof | Compliance | Schema | Hard constraints |
|---|---|---|---|---|---|
| B2B SaaS | 1,800–3,000 | benchmarks, customer quotes, screenshots | honest comparisons | BlogPosting, Organization | no invented competitor claims; AIO overlap 71%, rank first |
| Consumer / DTC | 1,000–1,800 | tests, photos, UGC | affiliate disclosure | BlogPosting, Product on PDPs | `rel="sponsored"` on paid links; no fake reviews |
| Local services / hospitality | 800–1,500 | local photos, dated prices, named staff | national consumer law | LocalBusiness, BlogPosting | exact NAP; AIO overlap 19–24%, Maps and reviews carry |
| Finance / YMYL | 1,500–2,500 | credentialed reviewer, regulator citations | disclaimers, licence numbers | BlogPosting + reviewedBy | no personalised advice or return promises; AIO overlap 32% |
| Creator / personal | 800–1,500 | first-person experience | sponsorship disclosure | Person, BlogPosting | own-name byline only |
| Agency | 1,500–2,500 | anonymised client data, original research | client consent | Organization, BlogPosting | no client data without written consent |

## 8. What to measure and benchmarks
- Search Console: impressions, clicks, CTR, position per URL; AIO/AI Mode traffic sits inside "Web", not separable (Google, 2025-12-10).
- Karos AI visibility: citations and mentions per engine, weekly averages; AI Mode URL consistency is 9.2% across three identical runs (SE Ranking, 2025-06).
- Time to rank: 1.74% of new pages reach the top-10 within a year; of those, 40.82% within a month; #1 pages average 5 years old (Ahrefs, 2025-05). Judge at day 90, then 365.
- CTR: expect 8% vs 15% with/without an AIO (Pew).
- AI referrals ~0.25% of sessions, ChatGPT 80%+ (Ahrefs); 4.4× value per visit (Semrush).
- Targets (HEUR): top-20 organic and ≥1 engine citation by day 90; ≥1 earned third-party mention per article.

## 9. Pre-delivery checklist
Each line is pass/fail.
1. Query answered in the first 70 words.
2. Title = H1, 30–60 chars, topic first, no stale year.
3. Every non-obvious claim has two independent linked sources.
4. Every number carries its date.
5. ≥1 named-person quote; ≥1 sourced statistic per H2.
6. No §5 AI-tell, no §4 clickbait pattern.
7. Named author with profile URL; named human editor.
8. Internal links return 200; anchors descriptive, varied.
9. BlogPosting JSON-LD validates; dates match visible text.
10. Alt text on every image; hero in three ratios, ≥50k px.
11. Meta description unique ≤160 chars; slug hyphenated, no date.
12. §7 industry constraints met.
13. Word count inside the intent range, or deviation noted.
14. No `nosnippet`/`max-snippet`; canonical self-referencing.

## 10. Feedback for the developer integrating this
- Subject selection: weight cluster gaps by the industry's AIO overlap (§7); attention clusters yield citations, not clicks; prefer comparisons and data posts for decide.
- Research: `claim`, `sources[2]`, `asOfDate` as schema fields; flag claims older than 12 months; capture quotes with name, role, date.
- Outline: answer-first paragraph, question H2s for informational intent, 120–180-word sections, ≥1 stat per H2, in-page FAQ, no FAQPage markup.
- Write: lint against the §5 tell list and §4 clickbait list, reject on hit; title = H1, ≤60 chars.
- Compliance (HARD): named author and editor, EU AI Act label when no editor; YMYL needs a credentialed `reviewedBy`; paid links `rel="sponsored"`; markup matches visible text.
- Render: BlogPosting JSON-LD with author.url, both dates, three image ratios; visible dates; self-canonical; no snippet-limiting meta.
- Publishing notes: title ≤60, description ≤160, slug, 3–5 keywords, JSON-LD, verified internal-link list, `lastmod`, request-indexing step.
- Hard vs default: HARD items are locked; the client layer may override length ranges, cadence, tell-list additions, quote and FAQ counts, §7 row defaults.
- Learning loop: log intent, format, word count, stat and quote counts, source ages, internal links, title length, editor, publish date; join with GSC position/CTR and per-engine citations at day 30/90/365.
- Send to measurement: canonical URL, target cluster, publish/update timestamps, funnel stage, claims-with-sources list so citation checks can match quoted numbers to the article.
