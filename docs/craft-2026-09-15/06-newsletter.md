# Newsletter best practices (researched 2026-09-15)

Governs the Newsletter agent. These are the base rules: the client's sector adjusts them, and what performs on the client's own account overrides both. See 11 Best practices as a system.

HARD = deliverability/legal. HEUR = default the client layer may override.

## Sources reviewed
URLs sit inline beside each number. Primary: Google sender guidelines/FAQ/Postmaster (2024-02; ramp 2025-11); Yahoo hub/FAQ (2024); Microsoft (2025-05, via Mailgun — Microsoft's post is JS-gated); FTC CAN-SPAM; GDPR Art. 7, 21; ICO PECR (2023-02-01, via Geldards; ICO 403); CASL statute; FINRA 2210; SEC Marketing FAQ (2026-01-15); FCA COBS 4; FTC Health guidance (2022-12); Apple (2021-06). Data: Litmus, beehiiv, MailerLite, Mailchimp, Klaviyo, GetResponse, Campaign Monitor, Omnisend, HubSpot, Email Markup Consortium, Google, Attentive, Wikipedia (2019–2026, dated inline). Not reached: ACMA, HHS HIPAA.

## 1. What decides whether it is read
- HARD — ≈5,000 msgs/day to Gmail = bulk sender, permanently: SPF + DKIM, DMARC ≥ p=none, From aligned with SPF or DKIM, PTR, TLS, RFC 5322 (https://support.google.com/a/answer/81126, 2024-02-01). Since 2025-11 violations get "temporary and permanent rejections" (https://support.google.com/a/answer/14229414).
- HARD — Postmaster spam rate <0.30%, target <0.10%; measured as inbox-delivered mail the user marks spam (https://support.google.com/a/answer/14668346). Yahoo: 0.3%, SPF and DKIM both, DMARC must pass (https://senders.yahooinc.com/best-practices/, 2024-02).
- HARD — `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) on marketing mail; honour within 2 days (Google, Yahoo; Yahoo exempts transactional: https://senders.yahooinc.com/faqs/).
- HARD — Outlook.com ≥5,000/day: SPF, DKIM, aligned DMARC p=none; junked from 2025-05-05, later rejected `550 5.7.515` (https://www.mailgun.com/blog/deliverability/microsoft-sender-requirements/).
- Client share 2026-07: Apple 62.26%, Gmail 27.03%, Outlook 5.83%, Yahoo 2.59% (https://www.litmus.com/email-client-market-share). MPP "stops senders from using invisible pixels" (Apple, 2021-06); Litmus: ≈55–60% of opens; one beehiiv title jumped 28%→55% (https://www.beehiiv.com/blog/apple-mpp-open-rate); HubSpot: "up 18 points" (https://blog.hubspot.com/sales/average-email-open-rate-benchmark, 2025). Opens measure delivery, not attention.
- HEUR — One stable From name; personal sender names +3.81% opens (https://www.mailerlite.com/blog/compare-your-email-performance-metrics-industry-benchmarks, 2025).- Gmail's Manage subscriptions (2025-07-08) ranks senders by frequency with one-click unsubscribe (https://blog.google/products-and-platforms/products/gmail/new-manage-subscriptions-unsubscribe/); iOS 18.2 files newsletters under Updates/Promotions (https://www.getresponse.com/blog/ios-mail-tabs).
- Spam-word lists are a myth; reputation, authentication, engagement decide (https://www.litmus.com/blog/why-spam-trigger-words-are-a-thing-of-the-past, 2021-01). Read time 8.97 s in 2022 vs 13.4 s in 2018 (https://www.litmus.com/blog/trends-in-email-engagement).

## 2. Issue anatomy
- Subject: 0–20 chars 37.6% open vs 80+ chars 28.68% (https://www.beehiiv.com/blog/2025-state-of-email-newsletters-by-beehiiv, 2025-01-29); MailerLite top campaigns 45% likelier at 20–40 chars (2025). Conflict: GetResponse 61–70 chars best, 43.38% (https://www.getresponse.com/resources/reports/email-marketing-benchmarks, 2023 data). Default 30–50 chars, meaning in the first 33.
- Preview: 40–90 chars, payload in the first 40; short hidden preheaders get body text appended (https://www.litmus.com/blog/the-ultimate-guide-to-preview-text-support, 2024-11-08). Never the subject again.
- Opener: the lead's fact in the first 100–200 characters — Gemini summary cards read from the top (https://www.attentive.com/blog/email-marketing-strategy-google-gemini-2025); NN/g: front-load value (https://www.nngroup.com/articles/e-mail-newsletters-usability/).
- Structure: lead (150–350 words) + 2–4 briefs (40–80 words) + one CTA. Bands: update 150–300; educate 300–600; convert 150–250. ≈200 words / 20 lines peaked CTR (https://www.omnisend.com/blog/email-newsletter-length/, 2024-12-09).
- Links: 1 link 1.74% click, 2–5 links 2.08%, 20+ links lowest opens 29.9% vs 34.17%; single-link mail 37.5% more orders per click (https://www.mailerlite.com/blog/how-many-links-in-email, 2026-02-12). Default 3–6 links, one primary CTA; convert = one link.
- HARD — Plain-text part: "HTML-only emails are a red flag for spam filters" (https://www.litmus.com/blog/best-practices-for-plain-text-emails-a-look-at-why-theyre-important, 2022-08-31).
- Dark/light: `<meta name="color-scheme" content="light dark">`, `prefers-color-scheme`, `[data-ogsc]`; outlined transparent PNG logo; no pure #FFF on #000; Gmail iOS and Outlook Windows fully invert, Apple Mail honours CSS (https://www.litmus.com/blog/the-ultimate-guide-to-dark-mode-for-email-marketers; share 35% in 2022 vs ">25%" on Litmus's 2026 page — conflicting).
- HARD — Footer: legal name, physical postal address, opt-out needing no fee or extra data, honoured within 10 business days and working 30 days after send; up to $53,088 per violating email (https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business). EU/UK: consent or soft opt-in, opt-out in every message, withdrawal "as easy as" consent (https://gdpr-info.eu/art-7-gdpr/ · https://gdpr-info.eu/art-21-gdpr/ · ICO via https://www.geldards.com/insights/ico-updated-guidance-on-electronic-marketing-consent-and-the-soft-opt-in-exemption/, 2023-02-01). Canada: unsubscribe valid 60 days, effected within 10 business days (https://laws-lois.justice.gc.ca/eng/acts/E-1.6/FullText.html). Plus a why-you-got-this line and reply-capable From.

## 3. Formats ranked, and which goal each serves
1. Curated roundup (lead + briefs) — educate/update. Media/creator CTR ~6.17% vs SaaS/B2B ~1.67% (https://www.beehiiv.com/blog/email-click-through-rate-benchmarks, 2026-08-23).
2. Single essay — educate; one link; creator/agency authority.
3. Founder note — update; 150–300 words, first person, one ask.
4. Product update — update/convert; changelog voice, dated facts.
5. Case-study issue — convert; number-led; testimonial rules (§5).
- HEUR — Monthly mix 2 educate : 1 update : 1 convert; Klaviyo campaign placed-order rate is 0.16% (https://www.klaviyo.com/uk/blog/email-marketing-benchmarks-open-click-and-conversion-rates, 2026-02-24), so convert issues stay rare.

## 4. Subject lines and openers
- Works: noun + number ("3 pricing changes in EU SaaS this week"); the reader's problem as a question; dated fact; contrast ("What 48 cold leads taught us").
- Emoji: 37.5% open with vs 42.23% without (GetResponse 2023) yet 21% likelier in MailerLite's top campaigns (2025). Conflict; A/B per client.
- First name in subject: 35.78% vs 41.87% without (GetResponse 2023). Default off.
- HARD — Subject "must accurately reflect the content" (FTC); no fake "Re:/Fwd:", no false urgency.
- Spam/AI tells to block: ALL CAPS, "!!!", "Free", "Act now"; "Unlock/Elevate/Delve/Game-changer"; "In today's fast-paced world"; colon + tagline; triplets; em-dash flourishes (https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).
- Opener: no "Hope this finds you well", no "In this issue", no restated subject. Sentence one = the lead's fact.

## 5. Writing rules
- Voice from profile: sentence length, person, banned words, sign-off; 3–4 pillars.
- No-AI-tells: no delve/tapestry/testament/underscore/pivotal/landscape/leverage; no "not just X, but Y"; no reflexive triplets; ≤1 em dash per issue; no bold-every-noun; no "In conclusion"; no "experts say" (list: https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).
- Numbers: source + date inline; no "studies show".
- HARD — Health: "competent and reliable scientific evidence"; "results not typical" does not cure a testimonial (https://www.ftc.gov/business-guidance/resources/health-products-compliance-guidance, 2022-12). Finance: no "promissory or misleading" statements or performance predictions; >25 retail investors in 30 days = retail communication needing principal pre-approval; testimonial disclosures incl. compensation >$100 (https://www.finra.org/rules-guidance/rulebooks/finra-rules/2210). Advisers: net returns at equal prominence to gross, 1/5/10-year (https://www.sec.gov/investment/marketing-faq, 2026-01-15). UK: "fair, clear and not misleading"; no "guaranteed/protected/secure" without prominence (COBS 4.2.1R/4.2.5G, https://www.handbook.fca.org.uk/handbook/COBS/4/2.html). HIPAA: PHI-based marketing needs written authorisation (HHS page blocked this session; unverified).
- Personalisation: segment, don't merge-field; body personalisation 44.3% vs 39.13% open, lower CTR (GetResponse 2023).
- Images: with graphics 43.12%/4.84% vs 35.79%/1.64% open/CTR (GetResponse 2023); message must survive images-off.
- HARD — Accessibility (EMC 2026, 376,348 emails, 99.88% fail): `lang` and `dir` on body (95.66% / 97.41% missing), `role="presentation"` on layout tables (83.78%), descriptive link text (71.23%), ≥4.5:1 contrast (58.48% fail), alt text (47.88%), `<title>` (https://emailmarkup.org/en/reports/accessibility/2026/).

## 6. Sending mechanics
- Day: Tuesday wins by little — beehiiv 38.25% vs Saturday 35.48% (2024 data); Omnisend 31.27% vs Monday 29.67%, Friday best conversion 0.081% (https://www.omnisend.com/blog/best-time-to-send-email/, 2026-05-04); 27% of HubSpot's marketers pick Tuesday (https://blog.hubspot.com/marketing/best-time-to-send-email, 2023). ≈3 points.
- Hour conflicts: beehiiv 11:00 UTC 42.87% vs 05:00 27.33%; Omnisend opens 9–11 local, clicks 7–8 and 16:00; MailerLite 15:00–19:00 (2025). Default recipient-local 09:00–11:00 Tue–Thu.
- Decay: 21.2% of opens and 44.14% of clicks in hour one; ~70%/85% within 24 h (GetResponse 2023).
- Cadence (MailerLite 2025, 12B emails): unsubscribe <1/month 0.87%, weekly 0.38%, 2×/week 0.33%, daily 0.36%; clicks weekly 4.87%, 2×/week 5.31%; irregular senders unsubscribe at double weekly (https://www.mailerlite.com/blog/email-cadence-and-frequency-best-practices). Default weekly, fixed day.
- Hygiene: suppress complainers instantly, sunset 90-day no-clickers; beehiiv delivery 98.90%, complaints 0.02% (https://newsletter.supply/blog/good-newsletter-open-rate-2026, 2026-05-12).
- Re-sends: to "did not click", never "did not open" (https://mailchimp.com/help/apple-privacy-faq/); one re-send, new subject, 48 h later, not on convert issues.
- A/B worth running: subject length and number-vs-question, preview text, From name, send hour, lead-first vs briefs-first. Judge on clicks and replies.

## 7. What varies by industry
| Sector | Structure | Tone | Cadence | Compliance | Hard constraints / benchmark |
|---|---|---|---|---|---|
| B2B SaaS | lead + 3 briefs + changelog | plain, numeric | weekly | CAN-SPAM/PECR; B2B needs opt-out | open 38.14%, click 1.19%, unsub 0.14% (HubSpot 2025) |
| Consumer & DTC | product-led, 1–2 offers | warm, short | 1–2×/week | GDPR consent; price accuracy | open 31%, click 1.69%, order 0.16% (Klaviyo 2026-02) |
| Local & hospitality | founder note + offer | local, specific | 2×/month | address, hours; age rules if alcohol | open 45.21%, click 2.43% (HubSpot 2025) |
| Finance & regulated | update + disclaimer block | measured | monthly | FINRA 2210 pre-approval; SEC net-of-fees; COBS 4 | open 31.35%, click 2.78% (Mailchimp 2023-12); no predictions |
| Creator & personal | essay or roundup | first person | weekly | disclose sponsors | CTR ~6.17% (beehiiv 2025 data) |
| Agency | case study + 2 briefs | proof-led | biweekly | client-approved numbers only | open 39.48%, click 2.21% (HubSpot 2025) |

## 8. What to measure and benchmarks
- Opens: report, never optimise (§1). MailerLite 43.46% (2024-12→2025-11), beehiiv 41.24% (2025), Mailchimp 35.63% (2023-12), Klaviyo 31% (2026-02), Campaign Monitor 21.5% (2021, pre-MPP).
- Click: MailerLite 2.09%; Mailchimp 2.62%; Klaviyo 1.69% (top 10% 3.38%); beehiiv 4.59% (2024) / 3.23% (2025); GetResponse 3.25% (2023).
- CTOR: MailerLite 6.81% (2025); Campaign Monitor 10.5% (2021). MPP deflates it; compare within a client only.
- Unsubscribe: MailerLite 0.22% (0.08% in 2024); Mailchimp 0.22%; Campaign Monitor 0.1%. Alarm above 0.5% per issue.
- HARD — Complaints: <0.10% target, 0.30% ceiling (Google/Yahoo); beehiiv network 0.02%.
- Replies: Litmus lists responses among positive filter signals; target ≥0.1% of delivered on educate issues.
- Substack "44%" is a third-party aggregate, not Substack data (https://bestwriting.com/substack-statistics, 2026-05-02).

## 9. Pre-delivery checklist
1. Subject 30–50 chars, no caps/!!!, describes the lead.
2. Preview 40–90 chars, not the subject, no body pull.
3. First 200 characters state the lead's fact.
4. One lead + 2–4 briefs; word count inside goal band.
5. 3–6 links, one primary CTA (one link total on convert).
6. Plain-text part generated and readable.
7. `lang`, `dir`, `role="presentation"`, alt on images, ≥4.5:1 contrast, descriptive link text, `<title>`.
8. Renders dark and light; logo legible on both.
9. Footer: legal name, postal address, unsubscribe placeholder, reason line.
10. Platform headers present or flagged: SPF/DKIM/DMARC, `List-Unsubscribe` + `-Post`.
11. Every body number has source + date.
12. No sector-prohibited claim — refuse, don't rewrite.
13. No AI-tell vocabulary or structure (§5).
14. Voice matches profile.
15. Brief facts dated inside the 7-day window.

## 10. Feedback for the developer integrating this
- Scan: store source URL + publish date per item; score by recency and source quality; drop >14-day items unless evergreen.
- Plan: enforce 2:1:1 goal ratio and pillar rotation; emit `goal`, `format`, `wordBand`, `linkBudget`, `ctaCount`; convert ⇒ `linkBudget: 1`.
- Write: lead fact first; 3 subject + 2 preview candidates with char counts; block AI-tells at generation.
- Compliance (refuse, never rewrite): HARD fails = missing address/unsubscribe, deceptive subject, sector-prohibited claim, unsourced number, structural accessibility miss; return failing line + rule URL. Sector packs: health (FTC 2022-12), finance (FINRA 2210 / SEC 206(4)-1 / COBS 4).
- Render: multipart/alternative with plain text; dark + light via `prefers-color-scheme` + `[data-ogsc]`; outlined logo; accessibility attributes in the template.
- HARD = §1 auth/complaint/unsubscribe (client platform owns it — warn if headers unknown), footer, claims, accessibility. DEFAULT = cadence, send window, subject band, emoji, first name, link budget, format weights, word bands.
- Client may override: voice, cadence, send window, pillar weights, sector pack, banned words, disclaimer text, CTA target — never HARD rules or refusal.
- Log per issue: goal, format, pillar, chosen + rejected subjects, char/word/link counts, send day/hour (recipient local), clicks, CTOR, unsubscribes, complaints, replies, top link, re-send flag, refusals with rule id. Opens are a delivery-health series, never an objective.
