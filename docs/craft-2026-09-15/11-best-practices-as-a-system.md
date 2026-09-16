# Best practices as a system

The platform pages (01 to 08) are the base. They are not what any single client gets. What a client gets is the base, adjusted for their sector, adjusted again by what works for them, and every adjustment is measured. This page says exactly how.

## 1. The three layers, one rule each

| Layer | What it is | Example (Instagram) | Who changes it | How often |
|---|---|---|---|---|
| **L1 Global base** | The platform page. Hard rules (dimensions, policies, limits) and defaults (anatomy, hooks, formats by stage, timing, checklist). Same for every client. | Body text ≥32 canvas px; carousel slide 2 must work as a cover; sends and saves are the target signals | Karos, from research and from cross-client evidence | Quarterly review; immediately when a platform changes a rule |
| **L2 Sector overlay** | The 10 to 20 rules that differ for the client's sector. Only the rule types the research showed to vary: proof, compliance and claims, tone and register, format lead, timing, mention and hashtag tolerance, visual style, buyer calendar. | Finance: on-slide disclaimer, no return claims, carousels lead; Hospitality: real venue photos, Reels lead, Wed 11–3 window | Built at onboarding from the client's category; refreshed monthly; later learned across clients in the sector | Monthly |
| **L3 Client layer** | What works for this client: formats, hooks, topics and times that won on their account; their voice lessons from edits; never-topics; their own top posts. | This account's carousels with a number on slide 1 get 3× saves; Tuesday 8 am beats every other slot; never mention pricing | Written by performance ingestion and by review; never by hand | Every ingestion, every review |

**Precedence:** L3 beats L2 beats L1 defaults. L1 hard rules always win (a client cannot "learn" past a dimension or a policy). Every override is logged with both rule ids, so a base rule that keeps losing gets reviewed.

**Every rule has the same shape:** `id · layer · platform · sector (L2) or client (L3) · hard | default · rule · why · source · date · metric it should move · evidence count`. A rule without a metric is a preference, not a rule; it can live in L3 as a preference but never in L1.

---

## 2. What changes per sector, and the sector map

The research pages tested six sector families. Real clients come from more sectors than that. Each sector maps to the closest family until it has its own overlay, built from the first two or three clients in it.

| Sector | Research family it starts from | What differs most (the overlay's focus) |
|---|---|---|
| B2B SaaS and tech | B2B SaaS | Proof = numbers, benchmarks, workflows; LinkedIn and X lead; long-form blog for evaluation |
| B2B services, consulting, agencies | Agency | Frameworks and before/after with caveats; no solicitation; LinkedIn personal profiles; Reddit solicitation is a ban trigger |
| DTC and e-commerce | Consumer and DTC | Real product photos, price paid, UGC; Reels and carousels; FTC disclosure on mentions; hidden costs kill landing pages |
| Retail, physical stores | Consumer and DTC + local | Location, hours, stock; Instagram and GBP; local windows |
| Local services (home, beauty, fitness, trades) | Local services and hospitality | Addresses, prices, hours, reviews; city subreddits need local flair; GBP posts and review replies |
| Hospitality, restaurants, travel, luxury venues | Local services and hospitality | Venue photography and releases, Reels lead, VAT-inclusive prices, seasonality calendar; Reddit "moving to" and travel threads |
| Real estate | Local + finance | Listings rules, fair-housing wording, local windows; proof = transactions |
| Finance, fintech, insurance | Finance and regulated | No return or advice claims; disclaimers on-slide and in-footer; compliance pre-review (FINRA 2210 in the US, FCA COBS 4 in the UK); vendor promotion banned in finance subreddits |
| Health, wellness, medical | Finance and regulated (YMYL) | Substantiated claims only (FTC "competent and reliable scientific evidence"); credentialed reviewer on blog; no personalised advice; AI-image ban on real people is absolute |
| Legal | Finance and regulated | Jurisdiction wording, no outcome promises, bar advertising rules; Reddit r/legaladvice bans vendors |
| Education and edtech | B2B SaaS + creator | Carousels lead; proof = outcomes with cohort sizes; academic calendar |
| Media, creators, personal brands | Creator and personal brand | Person over page everywhere; series formats; 9:1 on Reddit; AI-generated people label hits hardest |
| Music, entertainment, events | Creator + consumer | Release and event calendar drives timing; Reels and TikTok lead; rights on music and footage (Commercial Music Library on business accounts) |
| Nonprofits, public sector | Agency + regulated | Carousels lead (Rival IQ); proof = impact numbers; donation CTAs on landing pages with consent rules |
| Manufacturing, industrial, logistics | B2B SaaS | Long buying cycles; LinkedIn pages and personal; proof = specifications and case studies; YouTube for demos |
| Automotive, mobility | Consumer + regulated | Pricing and financing disclosures; Reels and YouTube; dealer local windows |

How a sector overlay is built at onboarding: (1) the profile's category picks the family; (2) the family's rows from each platform page's section 8 become the overlay's defaults; (3) the onboarding research on the client's competitors and the sector's top accounts confirms or replaces them (format lead, timing, proof, tone) with dated evidence; (4) the compliance rules for the sector are copied as hard rules. Sectors not on this map take the nearest family and get flagged for a real overlay after the second client.

---

## 3. What changes per client

The client layer starts empty except for three seeds and fills from evidence only.

| Source | What it produces | When |
|---|---|---|
| The client's own account (first run) | Top 10 posts by the primary metric, what they share (format, hook type, length, time, topic), current posting rhythm | First run per platform; refreshed monthly |
| Every published post (ingestion) | The post's metrics attached to its subject row: type, stage, hook pattern, format, time, length, template, source | Daily for the last 30 days of posts |
| Review (step 10) | Voice lessons (the diff between draft and final), never-topics, likes, standing instructions | Every review |
| The onboarding profile | Brand voice, off-limits, the buyer calendar | Setup |

What the client layer is allowed to override: any L1 or L2 default (length, hook pattern, format lead, timing, template, cadence weighting). What it cannot override: hard rules (dimensions, policies, compliance, disclosure, draft-only on Reddit).

Rules for writing a client rule from data:
- An outlier is a post above 2× the median of the client's last 20 posts on the platform's primary metric, with at least 24 hours of data. One outlier is a hypothesis; a rule needs three posts sharing the trait, or one trait present in the top 3 and absent in the bottom 10.
- A client rule carries the sample size and the date; it decays: if three later posts with the trait fall below median, the rule is retired.
- Voice lessons come only from edits the client made, never from likes alone.

---

## 4. How the system improves

| Loop | Trigger | What happens | Output |
|---|---|---|---|
| Per post | Ingestion | Metrics attached to the subject row and its rule ids | Evidence count per rule +1 |
| Per client, monthly | Job | Outlier analysis; client rules promoted, decayed, retired; the client's what-works summary rewritten; the sector overlay checked against the client's data | Updated L3; proposed L2 edits |
| Per sector, monthly | Job across clients in the sector | Rules that win in ≥2 clients become overlay defaults; rules that lose in ≥2 clients are removed | Updated L2 |
| Global, quarterly | Karos review | Base rules contradicted by cross-client evidence are demoted from default to note or removed; platform changes folded in; the platform page re-researched (each page lists its sources and date) | New L1 version |
| On platform change | Announcement | Hard rules updated immediately (dimensions, policies, labelling) | L1 patch, all clients |

Measuring a rule: for every rule id, compare posts that followed it with posts that did not, on the metric the rule claims to move, same client and platform, minimum 10 posts per side. Report the lift and the sample. A rule with no lift after 30 posts is a note, not a rule. This is the "argument we have" for each best practice, and it is what makes the document a system rather than a reading list.

Experiments: one change at a time per client per platform (the MKT1 rule); the sequencing slot carries an `experiment` tag when it deliberately breaks a default so the loop can read the result.

---

## 5. How engagement is measured, per platform

Denominators differ per study; Karos uses **reach-based** rates where the platform exposes reach or impressions, follower-based otherwise, and always says which. The primary metric is the one the platform's own ranking rewards.

| Platform | Primary metric (what ranking rewards) | Secondary | Denominator | Baseline to beat (source, date) | Stage measures |
|---|---|---|---|---|---|
| X | Replies and quotes per impression | Reposts, link clicks, profile visits, negative feedback (mute, block, report) | Impressions | ER by reach: text 3.56%, image 3.40%, video 2.96%, link 2.25% (Buffer, 2026-03); free-tier median impressions <100, Premium+ >1,550 (Buffer, 2025-10) | Attention: impressions, follows. Expertise: replies, bookmarks. Decide: link clicks, DMs |
| LinkedIn | Comments per impression (a comment ≈ 2 likes; a save ≈ 5 likes) | Reactions, reposts, dwell proxy (comments), profile visits | Impressions | Personal 2.60% vs page 1.60% (Metricool); 5.20% on Socialinsider's denominator; document posts 1.39× reach, reshares 0.29× (AuthoredUp) | Attention: impressions, followers. Expertise: comments, saves. Decide: clicks, DMs, named-role replies |
| Reddit | Upvotes at 2 h, 24 h, 7 d and rank position | OP reply, removal, mod message, indexed in Google, cited in an AI answer | Per reply | 60–75% of a thread's upvotes land in the first 90 minutes; top 3 replies take 80–85% of upvotes | Expertise: upvotes, OP reply. Decide: profile clicks, DMs, AI citation |
| Instagram | Sends per reach and saves per reach | Reach beyond followers, completion (carousel), comments, profile visits | Reach | Carousel ER 0.50% vs image 0.33% (Socialinsider, 35M posts, Q2 2026); carousels take ~9× the saves of images (Metricool, 2026) | Attention: reach beyond followers, follows. Expertise: saves, completion. Decide: profile clicks, link taps, DMs |
| TikTok and Reels | Completion rate and average watch time | Shares, saves, rewatches, follower conversion, comments | Views | 3.75 s average watch, 4% full-watch on a 41 s median video (Metricool, 5.7M videos, 2025-09); ER 0.7% (tech, agencies) to 2.6% (Hootsuite, 2026-04) | Attention: views, follows. Expertise: saves, completion. Decide: profile visits, link clicks |
| Newsletter | Click rate and click-to-open; replies | Unsubscribes, spam complaints, forwards | Delivered | Unsubscribe 0.38% weekly senders vs 0.87% irregular (MailerLite, 2025); spam <0.30% hard, <0.10% target (Google, Yahoo); opens unreliable after Apple MPP (62% of clients) | Educate: clicks on the lead. Update: replies. Convert: CTA clicks |
| Blog | Citations per AI engine and Search Console clicks | Impressions, position, time to rank, AI visitor conversion | Query | Top-result CTR down 34.5% to 58% under AI Overviews (Ahrefs, 2025); AI visitors convert 4.4× (Semrush) | Attention: impressions. Expertise: citations. Decide: conversions from the page |
| Landing page | Conversion rate by traffic channel | Scroll depth, form completion, LCP | Sessions per channel | Email 19.3%, paid social 12%, paid search 10.9% (Unbounce); LCP ≤2.5 s hard | Decide only |

Rules for reading the numbers:
- Never compare across denominators; a 5.2% and a 2.6% LinkedIn rate can be the same post.
- Sample before judgment: 10 posts per bucket, 24 hours of data per post, 7 days for Reddit.
- Report to the client per stage, not per vanity metric: attention (reach, follows), expertise (saves, comments, completion), decide (clicks, DMs, replies from buyer roles). The stage is on every post, so the report writes itself.
- Store every capture with its date; rates drift with platform changes, and the quarterly L1 review reads the drift.

---

## 6. What this changes in the flow

- Step 3 builds the sector overlay from the map above and the profile's category.
- Step 5 reads L1 + L2 + L3 for the platform; the run cites rule ids on the deliverable's internal record.
- Step 9's checklist is L1 section 10 plus the sector's hard rules.
- Ingestion attaches metrics to the subject row and the rule ids used.
- Monthly and quarterly jobs run the loops in section 4.
- The client's report shows stage measures and the client rules that were learned, in plain language ("your carousels with a number on slide 1 get three times the saves; we now lead with one").
