# Landing page best practices (researched 2026-09-15)

Governs the Landing page agent. These are the base rules: the client's sector adjusts them, and what performs on the client's own account overrides both. See 11 Best practices as a system.

**HARD** = law, accessibility standard, platform policy or Google threshold. **HEUR** = tested but contextual. "Reported" = secondary summary; primary unreachable today.

## Sources reviewed
- Unbounce CBR (41k pages, 464M visits, Q4 2024): https://unbounce.com/landing-pages/whats-a-good-conversion-rate/ , https://unbounce.com/conversion-benchmark-report/saas-conversion-rate/
- WordStream/LocaliQ Google Ads benchmarks 2025 https://www.wordstream.com/blog/2025-google-ads-benchmarks and 2026 via SEJ (2026-06-16) https://www.searchenginejournal.com/what-is-a-good-ctr-for-google-ads/492785/
- HubSpot stats (2024-10-07) https://blog.hubspot.com/marketing/landing-page-stats ; forms (2025-07-17) https://blog.hubspot.com/marketing/optimize-conversion-forms
- Baymard: fields (2024-06-26) https://baymard.com/blog/checkout-flow-average-form-fields ; abandonment https://baymard.com/lists/cart-abandonment-rate ; seals (2013) https://baymard.com/blog/site-seal-trust
- Google: CWV (2024-10-31) https://web.dev/articles/vitals ; LCP (2025-03-31) https://web.dev/articles/optimize-lcp ; WebP (2018) https://web.dev/articles/serve-images-webp ; AVIF (2021) https://web.dev/articles/compress-images-avif ; Mobile Speed Playbook (2017) https://www.thinkwithgoogle.com/_qs/documents/4290/c676a_Google_MobileSiteSpeed_Playbook_v2.1_digital_4JWkGQT.pdf ; Ads destinations https://support.google.com/adspolicy/answer/6368661 ; interstitials https://developers.google.com/search/docs/appearance/avoid-intrusive-interstitials ; EU consent policy https://www.google.com/about/company/user-consent-policy/
- NN/g eyetracking (2018-04-15) https://www.nngroup.com/articles/scrolling-and-attention/ ; first 2 words (2009) https://www.nngroup.com/articles/first-2-words-a-signal-for-scanning/
- WCAG 2.2 (2023-10-05) https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/ , https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html ; EAA https://www.levelaccess.com/compliance-overview/european-accessibility-act-eaa/
- EDPB cookie taskforce (2023-01-17) https://www.edpb.europa.eu/system/files/2023-01/edpb_20230118_report_cookie_banner_taskforce_en.pdf ; CNIL (2019) https://www.cnil.fr/en/cookies-and-other-tracking-devices-cnil-publishes-new-guidelines ; GDPR Art. 13 https://gdpr-info.eu/art-13-gdpr/ ; CCPA https://oag.ca.gov/privacy/ccpa ; FTC Endorsement Guides (2023) https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking ; FTC fake-reviews rule (2024-08-14) https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials ; FCA COBS 4.2 https://www.handbook.fca.org.uk/handbook/COBS/4/2.html
- Practitioners: Aagaard/Unbounce CTA tests (2012) https://unbounce.com/conversion-rate-optimization/how-to-write-a-call-to-action/ ; social-proof roundup https://www.klientboost.com/landing-pages/landing-page-testimonials/ ; VWO sample size (2025-05-01) https://vwo.com/blog/how-to-calculate-ab-test-sample-size/ ; Leadpages page-type ranges (2026) https://leadpages.com/blog/landing-page-conversion-benchmarks-2026 ; field non-linearity https://www.cobloom.com/blog/form-fields-and-conversion-rates-is-less-really-more ; Open Graph https://ogp.me/ ; Wistia 2026 https://wistia.com/learn/marketing/video-marketing-statistics ; Contentsquare DXB 2026 https://go.contentsquare.com/en/digital-experience-benchmark/

## 1. What converts now
- **Message match (HEUR, strongest).** Headline restates the ad/post promise. Email traffic converts 19.3%, paid social 12%, paid search 10.9%; SaaS: email 16.9%, search 4.1%, social 2.9%, display 0.3% (Unbounce, Q4 2024).
- **One goal (HARD for paid).** Google bans destinations "solely designed to send users elsewhere" and display/final URL mismatches (adspolicy/6368661).
- **Above the fold (HEUR).** 57% of viewing time is in screen one, 74% in two (NN/g 2018). Offer, audience, CTA, one proof item go there.
- **Speed (HARD).** LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 at p75 (web.dev 2024). 53% of mobile visits leave after 3 s; bounce 13% under 3 s, ~60% after 9 s (Google/SOASTA 2017).
- **Mobile first (HARD default).** 83% of visits are mobile (Unbounce). Design at 390 px, adapt up.
- **Readability (HEUR, strong).** Grade 5–7 copy converts 11.1% vs 7.1% (grade 8–9) and 5.3% ("professional"); SaaS 12.9% vs 2.1%; best SaaS length 250–725 words (Unbounce 2024).
- **Trust (HEUR).** Reported: client logo +69% (comScore); photo testimonials recalled better (CXL via Klientboost). 19% abandon over card trust (Baymard).

## 2. Page anatomy
- Order: hero (headline, subhead, CTA, proof strip) → problem in the reader's words → offer and promise → proof → how it works (3 steps) → objections/FAQ → price or terms → final CTA → legal footer. Proof never only at the bottom.
- Headline ≤ 10 words, benefit + audience, key noun in the first 2 words / 11 characters (NN/g 2009). Subhead 1–2 sentences: mechanism or proof.
- CTA: verb + value. "Submit" converts worse across 40k HubSpot customers (2025); "Order"→"Get" +38.26% (Aagaard 2012). Hero, after proof, end; sticky on mobile; friction reliever under the button.
- Form by intent: waitlist 1–2 fields; lead magnet 2–3; demo/quote 3–5; checkout ≤ 8 (Baymard: average 11.3, most need 8). Non-linear: 10-field pages beat 3-field ones at high intent (Unbounce via cobloom). No textareas or selects; hide optional fields.
- Images: real UI, product, people; illustration only for intangibles. Video optional (survey favourite, HubSpot 2023; test data thin, Wistia 2026).

## 3. Page types ranked, and when to use each
Editorial ranges (Leadpages 2026, on Unbounce data), highest first:
1. **Lead magnet / opt-in** 5–20%: 1–2 fields, deliverable named in the CTA.
2. **Event / webinar** 4–15% (Entertainment median 12.3%): date, speaker proof, deadline.
3. **Waitlist**: opt-in mechanics plus a reason now (position, early price).
4. **Book a call / quote** 2–10%: 3–5 fields or scheduler; show who takes the call.
5. **Free trial** 2–8%: no card; say what happens next.
6. **Demo** 1–5%: qualifying fields allowed; logos and one case number in the hero.
7. **Product sale**: full anatomy, price, guarantee, returns, payment seal (Norton/McAfee most recognised, Baymard 2013).
8. **Download**: one CTA to the store; ads may not "initiate a direct download" (Google).

## 4. Headlines and CTAs
- Works: outcome + timeframe ("Fill Tuesday nights without discounting"); audience + result ("For clinics with two chairs and no front desk"); named mechanism ("One weekly email, drafted from your reviews"); the ad's question, answered.
- CTAs: "Get [deliverable]", "Book my 20-min call", "See [product] on my data", "Start free, no card".
- Reads as AI/generic: unlock, elevate, seamless, empower, revolutionize, "in today's fast-paced world", "take X to the next level", adjective triads, rhetorical questions, em-dash chains, anything true of every competitor.
- Avoid: unsourced numbers, unsupported "#1"/"best", fake countdowns (FTC deception; EDPB dark patterns).

## 5. Writing and design rules
- Voice: the brand's, in the reader's words; grade 5–7; one idea per sentence; concrete nouns ("48 hours", not "fast").
- No-AI-tells: §4's words; triads; "not X, it's Y"; closing summaries; emoji; exclamation marks; hedges. Each paragraph carries a brief fact.
- Proof, by weight: named result with number → testimonial with photo, name, role → logos → ratings with count → certifications. One in the hero, one beside each CTA.
- Objections: 3–5 from the brief, answered in an FAQ before the last CTA.
- Pricing: show it or the rule that sets it; hidden extra cost is the top abandonment reason (40%, Baymard).
- **Accessibility (HARD).** WCAG 2.2 AA: contrast 4.5:1 (large text 3:1); targets ≥ 24×24 px; visible focus; alt text; labelled fields; keyboard-complete. EAA enforced since 2025-06-28 for e-commerce, banking, transport, media; microenterprises exempt; France fines to €75k; EN 301 549 = WCAG 2.1 AA now, 2.2 from v4.1.1 (2026-09-02).
- **Legal (HARD).** Footer: privacy, terms, entity, contact. Forms: Art. 13 notice (who, why, basis, retention, rights, withdrawal); unticked marketing box. Testimonials honest and typical, or expected results disclosed ("results not typical" fails); paid/insider endorsers disclosed; no fabricated or AI reviews (FTC 2023; rule 2024-08-14). California: "Do Not Sell or Share" link (CCPA).

## 6. Technical and publishing rules
- **Speed (HARD).** Pass CWV at p75. Hero `<img fetchpriority="high">`, never lazy, never CSS background (web.dev 2025); width/height on all images; fonts preloaded, `font-display: swap`.
- Images: AVIF (> 50% smaller than JPEG) with WebP fallback (25–35%); hero ≤ 200 KB; `srcset`; SVG logos.
- **Consent (HARD, EU/UK).** No non-essential tag before consent; first-layer "Reject all" as visible as "Accept all"; no pre-ticked boxes; withdraw link on every page (EDPB 2023, CNIL 2019); Google requires stored consent records. Consent is the only allowed full-cover interstitial; arrival pop-ups hurt search (Google).
- Meta/OG: unique title ≤ 60 chars, description; `og:title`, `og:type`, `og:image` 1200×630 with `og:image:alt`, `og:url` (ogp.me); canonical; `noindex` on previews.
- One CTA, no leaks: no menu, no footer sitemap, no outbound links except legal; logo unlinked.
- Tracking: one conversion event on the thank-you state; UTMs kept in a hidden field.
- A/B: one element; 95% significance, 80% power; 4%→5% needs 5,313 visits per variant (VWO 2025); whole weeks.

## 7. What varies by industry
| Segment | Proof | Form | Tone | Compliance / hard constraints |
|---|---|---|---|---|
| B2B SaaS | logos, one metric case; median 3.8%, good 11.6% | demo 3–5; trial ≤ 3, no card | plain, technical | Art. 13; badges only if real |
| Consumer / DTC | reviews with count, UGC, guarantee; median 4.2% | checkout ≤ 8, guest | warm, short | total cost up front; FTC review rule; EAA in EU |
| Local / hospitality | Google rating, photos, map; Travel 4.8% | ≤ 3 fields, sticky call | local, concrete | prices incl. VAT |
| Finance / regulated | licence, regulator, fees; median 8.3%, Ads CVR 2.6% | multi-step quote 5–8 | calm, no superlatives | FCA COBS 4.2.1R "fair, clear and not misleading", prominent risk warnings; legal sign-off |
| Creator / personal | audience numbers, named results | 1–2 fields | first person | FTC paid/affiliate disclosure |
| Agency | named client results, process | call 3–4 fields | direct, numeric | client consent to be named |

## 8. What to measure and benchmarks
- Conversion: median 6.6%, top quartile from 11.4% (Unbounce Q4 2024). Medians: Entertainment 12.3, Education 8.4, Financial 8.3, Legal 6.3, Professional services 6.1, Travel 4.8, Ecommerce 4.2, SaaS 3.8. Google Ads CVR 7.52% (2025), 8.18% (Apr 2025–Mar 2026); Finance 2.6% (WordStream).
- By channel: email 19.3%, paid social 12%, paid search 10.9% (Unbounce). Benchmark within channel only.
- Bounce: no large public benchmark beyond Google's speed curve; use the client baseline. Conversion fell 5.1% YoY across 99B sessions (Contentsquare 2026), so flat is not failure.
- Scroll: 57% of attention in screen one, 74% in two (NN/g); track 25/50/75/100% and CTA-in-view.
- Form: starts, completions, per-field drop; a field losing > 10% of starters is cut or moved to step two.
- Speed: p75 LCP/INP/CLS from CrUX or RUM, mobile.

## 9. Pre-delivery checklist
1. Headline restates the source's promise and names the audience.
2. One action; no nav or outbound links except legal.
3. Offer, CTA, one proof item inside a 390 px first screen.
4. Grade ≤ 7; no AI-tell words; every claim traced to the brief.
5. Proof beside every CTA; testimonials real, named, disclosed.
6. Fields within page-type limit; labels, errors, keyboard-complete.
7. LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 on mobile; hero image `fetchpriority="high"`, not lazy, AVIF/WebP, sized.
8. Contrast 4.5:1, targets ≥ 24 px, alt text, visible focus.
9. Equal "Reject all"; no tag fires pre-consent.
10. Privacy, terms, entity, contact in footer; Art. 13 notice at form.
11. Title, description, OG, canonical; preview `noindex`.
12. Price or price rule shown; total cost before the form.
13. Kit logo SVG, kit fonts and colours, one accent.
14. Thank-you state fires one event, source preserved.

## 10. Feedback for the developer integrating this
- **Brief intake:** require the source's promise line, page type, jurisdiction, regulated flag, proof inventory with consent, price rule, forbidden claims; reject briefs with no proof or numbers, never invent.
- **Copy:** readability check (grade ≤ 7); lint the AI-tell list; source tag on every number; three headline variants scored for message match.
- **Build:** template encodes §2 and §6; image pipeline emits AVIF+WebP with dimensions; consent layer and legal footer are components, not copy.
- **Preview/QA:** Lighthouse mobile, axe-core and §9 run automatically; pass/fail beside the preview; any HARD failure blocks "ready".
- **Hard vs default:** HARD = §5 accessibility and legal, §6 speed and consent, Google Ads policy, no fabricated proof. Client may override, with a reason: section order, field count in range, price visibility, video, headline pattern, CTA colour in the kit.
- **Learning loop:** log page type, industry, source, word count, grade, field count, proof types, CTA verb, CWV, outcome (conversion, completion, scroll-to-CTA); compare to §8 medians by channel, never the global 6.6%.
- **Feedback rounds:** 1 = message match and offer; 2 = anatomy and objections; 3 = polish. Each comment maps to a §9 line; a HARD failure reopens the round. Cap at three; then the client picks between the last two variants; log the pick.
