# Reporting tab, round 6: "Things only you can do", "What we are doing", order, Seats

Read-only pass over the worktree at `claude/portal-flow-audit-recs` (1f7c6c4a). Inputs: Albert's round-6 brief, ux-deep-dive §1/N7/N10/N14/C2/C3, flow-audit F9/F11/F15, and the code named below. No em dashes anywhere in this document, because every string in it is a candidate for client copy.

Files this touches, all under `src/`: `lib/seo-geo.ts`, `components/seo-geo/client-suggestions.tsx`, `components/seo-geo/presenter.ts`, `components/seo-geo-panel.tsx`, `app/(app)/clients/[id]/settings/page.tsx`, `app/(app)/clients/[id]/agents/page.tsx` (extraction only), plus two new files and four test files.

---

## 1 · "Things only you can do": make it true

### Where it breaks

- `lib/seo-geo.ts:1556-1558` · `isClientOwnedGap` decides ownership from `actionKindFor(gap) === "guided_manual"`, which is derived from the registry BUCKET (`deliveryForBucket`, `:1058-1062`: `offsiteEntity` → advisory) and from a hardcoded `delivery: "advisory"` on every competitor-visibility gap (`computeVisibilityGaps`, `:1170`). Ownership is read off where a check sits in a scoring table, not off who can act on it. That is how three OUTCOMES (share of voice, named-mention rate, never cited) became client tasks.
- `lib/seo-geo.ts:1574-1609` · `CLIENT_SUGGESTION_COPY` holds seven entries. Four are outcomes our agents exist to move: GEO-04 ("Get named on sites you don't own"), GEO-27 ("Catch up with the competitor leading these answers"), GEO-35 ("Get your name in front of buyers"), GEO-11 ("Get quoted where the engines are already looking"). These are the three lines Albert quoted back as wrong.
- `lib/seo-geo.ts:1676-1680` · an advisory id with no client copy falls back to `REC_COPY` (title plus first sentence). `REC_COPY` was written for a row with an Approve button and a Karos owner, so a future advisory check leaks in wearing plan copy.
- `components/seo-geo/client-suggestions.tsx:38-44` · the empty state for `karosOwned` says "Everything this snapshot found is work your Karos team owns", which is a sentence about us. Albert wants a sentence about them.
- `app/(app)/clients/[id]/settings/page.tsx:646-649` · the section is mounted SECOND on the tab, directly under the scores. It goes last (see §3).

### The classification, every id in both registries

Legend: **A** = a Karos agent or Karos staff can fix it (who); **B** = genuinely client-owned structural (account, record, domain, relationship, site access); **C** = informational only. "Site access" means Karos staff with access to the client's site; note that no actuator in this repo writes to a client's website (presenter.ts:1604-1610, QA F4), so every on-site item is staff work behind an access grant, never an automatic fix.

| Check id | What it measures (registry label, shortened) | Class | Who fixes it |
|---|---|---|---|
| BOTH-01 | pages 200, no noindex/nosnippet | A | Karos staff, site access |
| BOTH-01b | robots meta clean | A | Karos staff, site access |
| BOTH-02 | main content crawlable, not auth/paywall/JS-only | A | Karos staff, site access (needs the client's developer for a JS-only build; still not a record the client "claims") |
| BOTH-09 | valid sitemap, referenced in robots.txt | A | Karos staff, site access (the `isClientOwnedGap` comment already names this one) |
| GEO-01 | robots.txt allows Googlebot and AI crawlers | A | Karos staff, site access |
| GEO-10 | entity/about pages open to AI crawlers | A | Karos staff, site access |
| GEO-08 | OAI-SearchBot allowed + indexed on Bing | A | Karos staff, site access + Bing Webmaster access |
| GEO-24 | indexed on Bing + IndexNow key | A | Karos staff, Bing Webmaster access |
| GEO-23 | indexed on Brave | A | Karos staff, submission |
| GEO-41 | indexed on Google, AI opt-out off | A | Karos staff, Search Console access + site access for the opt-out flag |
| SEO-04a/b/c | LCP / INP / CLS | A | Karos staff, site access (often the client's developer executes) |
| BOTH-19 | mobile parity, no horizontal scroll | A | Karos staff, site access |
| SEO-02 | title tags | A | Karos staff, site access (Landing Builder for its own pages) |
| SEO-06 | meta descriptions | A | Karos staff, site access (Landing Builder for its own pages) |
| GEO-17 | one H1, clean heading hierarchy | A | Karos staff, site access; Blog agent for its own pages |
| BOTH-05 | internal links per priority page | A | Karos staff, site access |
| BOTH-07 (REC_COPY only) | canonical | A | Karos staff, site access |
| BOTH-21 | one intent per URL, no stuffing | A | Blog agent (new pages), Karos staff (existing) |
| BOTH-03 | originality vs top-ranking pages | A | Blog agent |
| GEO-02 | answer capsules under H2s | A | Blog agent, Landing Builder |
| GEO-22 | question-form headings with short answers | A | Blog agent, Landing Builder |
| BOTH-16 | scannable section length | A | Blog agent, Landing Builder |
| GEO-03 | stats + cited sources per section | A | Blog agent |
| GEO-09 | bylines, inline citations, original numbers | A | Blog agent (the byline is a setup config, the numbers are the client's, still ours to place) |
| BOTH-11 | first-person experience markers | A | Blog agent |
| GEO-18 | entity density | A | Blog agent |
| GEO-19 | original media + alt text | A | Karos staff (alt text, site access); media is client-supplied but that is an input, not a record |
| GEO-20 | genuine dateModified freshness | A | Karos staff (sitemap dates), Blog agent (real freshness) |
| GEO-37 | about/pillar pages updated | A | Karos staff, site access |
| BOTH-13 | publishing cadence, no gap > 30 days | A | Blog agent |
| GEO-27:{engine} | share of voice vs top competitor | A (outcome) | LinkedIn, Reddit, Blog, Landing agents. This is the lever, not a task |
| GEO-35:{engine} | named-mention rate on category questions | A (outcome) | same |
| GEO-11:{engine} | site never cited as a source | A (outcome) | Blog agent, Landing Builder (the citable pages) |
| GEO-04 | ≥10 authoritative domains mentioning the brand in 90 days | A (outcome) / relationships | LinkedIn and Reddit put the brand on linkedin.com and reddit.com; the rest is press and partners. Its ask ("get named on sites you don't own") is the general advice Albert rejected. OUT, with a decision fork below |
| **GEO-25** | Wikipedia article + Wikidata entity | **B** | the public company record, created and confirmed in the business's name |
| **GEO-07** | Wikidata official website matches the client domain | **B** | the account that owns that record |
| **GEO-14** | review footprint: ≥3 platforms, ≥4.0, ≥25 each | **B** | listings on review platforms opened in the business's name; the asking comes from the client (the Reputation agent drafts, it cannot send) |
| (none) | | C | Every check already renders as a bucket row inside "What's behind this score" (presenter.ts:119-140, `checkBreakdown`). That disclosure is the informational surface; nothing needs a second one |

### What we change

**The allow-list.** Replace `isClientOwnedGap` (a bucket derivation) with an explicit set, and make it the only way in:

```
const CLIENT_OWNED_IDS: ReadonlySet<string> = new Set(["GEO-25", "GEO-07", "GEO-14"]);
function isClientOwnedGap(gap) { return CLIENT_OWNED_IDS.has(gap.id.split(":")[0]); }
```

Delete the `REC_COPY` fallback at `:1676-1680`: an id not in `CLIENT_SUGGESTION_COPY` is dropped, full stop (rule 6 already says "an id we cannot name is dropped"; today it names it with plan copy first). Keep rules 2 (MEASURED only), 3 (CONFIRMED by default, `minConfidence` for staff), 4 (dedupe by copy), 5 (cap 5, ordered by `scoreLift`). With three ids the cap is decorative but it stays as the contract.

**The copy**, replacing all seven entries with three. Title = imperative naming the account or record; why = one sentence; evidence = the producer's own measured line, unchanged (`evidenceNamingEngine`).

| id | title | why | evidence (what we measured; the producer's string) |
|---|---|---|---|
| GEO-25 | Claim your public company record | It is the entry the engines look your company up in, and it has to be created and confirmed in your business's name. | e.g. "No public reference entry found for {brand}." |
| GEO-07 | Point your public record at your own website | The official website on that entry is missing or points elsewhere, and changing it needs the account that owns the entry, which is yours. | e.g. "The public record lists {other domain} as the official site." |
| GEO-14 | Open your listings on the review platforms | Reviews on independent sites are one of the off-site checks in your AI readiness score; the listings have to be opened in your business's name, and the asking has to come from you. | e.g. "Found on 1 review platform." |

None of the three asserts how an engine will react (the existing `speculative` regex in `seo-geo-client-suggestions.test.ts:329-330` stays as the guard, now applied to these three).

**Section intro** (`client-suggestions.tsx:64-67`): "Confirmed on this snapshot, and yours rather than ours: each needs an account or a record only your business can act on." The per-row "Need a hand? · Support" affordance stays as is (R7).

**Empty state** (`client-suggestions.tsx:38-44`), keeping the three-way honesty the review wave added:

- `karosOwned` and `none` → **"Nothing on your side is holding you back right now."**
- `lowConfidence` → "Nothing to ask you for yet. We saw something on your side that we have not confirmed well enough to hand over."

The section renders even when empty. The absence is the finding Albert is paying for, and a heading that disappears reads as a section that failed to load.

**Tests.** `seo-geo-client-suggestions.test.ts` calls its rules "the product, not an implementation detail", and this is a product ruling, so the pins change on purpose: `:68-87` pins GEO-25/07/14 in and GEO-04 out; `:99-126` inverts to "the competitor-visibility gaps never appear"; `:166-185` re-fixtures without GEO-27/35/11; `:303-313` (GEO-27 wording) moves to `seo-geo.test.ts` where `REC_COPY["GEO-27"]` still lives for the cross-repo plan contract. `seo-geo.test.ts:848-852` (REC_COPY coverage) is untouched: the plan catalogue keeps every id.

### Why
Albert, round 6: "only structural things ... the client is doing wrong AND our agents cannot fix (accounts, records, relationships they own)". The bucket derivation cannot express "accounts and records"; a named set can.

### Effort · **S** (one set, three copy entries, one deleted fallback, one empty string, four test blocks).

---

## 2 · New section: "What we are doing for your SEO and GEO"

### Where it breaks

- `settings/page.tsx:550-571` · the only "what Karos does" pointer on the tab is a hand-built card for ONE agent (Reputation, "Beta" badge, a three-way label) placed after the report. Nothing on the tab connects the scores to the agents that move them.
- `presenter.ts:1611-1616` (`FIX_ROUTES`) and `:1654-1677` (`REC_PRODUCTS`) · the report's own doctrine refuses to name an agent because the panel is never handed the client's grants. The Reporting tab is built on a page that HAS the grants (`client.customAgentIds`, `clientAgents`, `spendUmbrellas`, `spendJobs` are all in hand at `:156-249`), so the honest place for agent rows is this page, not the panel.
- `agents/page.tsx:118-330` · the client roster's status derivation (grant OR delivered work, `rosterStatus` with the AF-5 upcoming-content rung, `buildAgentSetup` readiness) is page-local. Re-deriving it on Reporting would put a second opinion of "Live" in the product, which is the logic bug Albert flagged on the agent detail page ("we pre-created content ... yet the page says runs on request").
- `presenter.ts:1113` and `:1117` · `buildPresence().takeaway` says "That's the gap the work below closes" / "The work below protects that position". Home renders the same string (`home-standing.tsx:205-209`) with no work below it.

### What we change

**A. One derivation, two readers.** Extract the client-branch roster build out of `agents/page.tsx:118-330` into `lib/client-roster.ts` (`buildClientRosterEntries({ clientId, client, viewerIsClient, now })` returning `AgentRosterEntry[]` plus, per entry, `granted: boolean`). The agents page keeps rendering exactly what it renders; Reporting calls the same function. Reads it adds to `settings/page.tsx`: `listPlannedScheduledRuns` and `listAssets` (the agents page's own cost note at `:134-150` applies; pilot volume, fine).

**B. A pure lever table**, new `lib/visibility-levers.ts` (client-safe, no Firestore), keyed on the same identity predicates the rest of the product uses (`isLinkedInAgentIdentity`, `isRedditAgentIdentity`, `isBlogAgentIdentity`, `isNewsletterAgentIdentity`, `isReputationAgentIdentity`, `isXAgentIdentity`, and the `agent-blurbs.ts` regexes for instagram / tiktok / branded-shorts / landing). The sentences, in the fixed display order within a state band (pages that can be cited first, then places that get quoted, then brand signals, then audience):

| Order | Family (key match) | Agent name (Firestore `name`) | Lever it moves | The one sentence |
|---|---|---|---|---|
| 1 | Blog (`karos-blog-writer-v2`) | Blog Agent | the pages that get cited for category questions | Articles on your own site that answer the questions buyers ask about your category. These are the pages an engine can cite as a source, which is what your citation count measures. |
| 2 | Landing page (`landing-builder`, managed `landing_page`) | Landing Builder | the answer page for one buyer question | One page on your site built to answer one buyer question end to end. It is the page an engine can hand a buyer as the answer. |
| 3 | LinkedIn (`karos-linkedin-writer-v2`; e10 fallback keys) | LinkedIn Agent | a source the engines quote often | Posts for your company page and for each person you put forward, in their own voice, ready for you to post. LinkedIn is a site the engines quote often when they answer business questions. |
| 4 | Reddit (`karos-reddit-runner`) | Reddit Agent | replies in the threads the engines cite | One reply a day, drafted for a live thread your account is placed to answer, for you to post yourself. Reddit threads are a source the engines cite, so this is where a category answer can start to include you. |
| 5 | X (`karos-x-agent-v2`) | X Agent | your name in the public conversation | A post a day on X, in your voice, from what your industry is talking about right now. It keeps your name in the public conversation, where buyers and engines both look for what is current. |
| 6 | Instagram (`karos-instagram-agent`, `karos-instagram-tiktok-content-agent`) | Instagram Agent | a public, dated record of what you do | A daily post on your Instagram. Public posts from a professional account can be indexed by search, so it is a dated record of what you do that appears when someone looks you up. |
| 6b | TikTok / shorts (`karos-tiktok-agent`, `branded-shorts`) | (agent's own name) | the profile a buyer checks | Short clips for TikTok, where more buyers now search first. It builds the profile a buyer checks after an engine names you. |
| 7 | Reputation (`karos-reputation-runner`) | Reputation Agent | the review footprint | Drafts replies to your reviews and watches what is said about you. Reviews on independent sites are one of the off-site checks in your AI readiness score. |
| 8 | Newsletter (`karos-newsletter-writer-v2`) | Newsletter Agent | feeds the blog its topics | Goes to the people who already know you, not to the engines. Its issues are where the blog agent takes its next topics from, so it feeds the pages that can be cited. |
| (none) | `seo-geo-agent-v2`, intel agents, dynamic agents | | | Not rows. The SEO/GEO agent is the measurement (the stamp already says when it ran); dynamic agents have no lever and no status source (decision D4). Any agent key with no lever entry never renders here, which is also what keeps an "unreviewed" test agent out. |

**C. Row anatomy** (one row per agent, a list inside one `Card`, no per-row card):
- platform mark (same `identity` → mark as `roster-card.tsx`) · agent name · the sentence
- optional measured line, from data the snapshot already holds: when `insights.citationLeaderboard` contains `linkedin.com` / `reddit.com` / the client's own root domain, the row prints "Quoted {n} times in the answers we measured" (the same unit the "Who the engines quote" card uses, QA F133). This is the one thing that makes the section "what the analysis shows" rather than a brochure.
- status: the roster's `RosterStatus` rendered by the SAME `RosterStatusBadge` (export it from `roster-card.tsx:142-156`), so the word here is the word on the roster and on the detail page: Live · Setting up · Setup needs attention · Needs attention · Runs on request · Not set up yet · Coming Soon. One new word for the one state the client roster never has: **Not on your plan** (neutral badge).
- ONE control at the row end. Granted or delivered: a text link, "Open {agent name}" with the chevron, to `/clients/{id}/agents/{customAgentId}` (the same href `roster.tsx:80` and `agent-intake-links.ts:233` build; the detail page owns the run gesture, CD-I1). Not on your plan: the standard Support trigger (`FlagButton`, prefilled subject "Ask about the {agent name}"), introduced by the sentence "Not on your plan." (R7 keeps the one word; decision D3 if Albert wants "Ask about it" on the button itself).

**D. Ordering.** State band first: Live → Setting up / Setup needs attention / Needs attention → Runs on request → Not set up yet → Coming Soon → Not on your plan. Inside a band, the lever order above.

**E. Section copy.** Eyebrow: "What we are doing for your SEO and GEO". Standfirst: "These agents make the things the engines read. The scores above are the only measure of how it is going; nothing here is a promise." No-agent state (nothing granted, nothing delivered, nothing in the catalogue for this slug): "No agents are set up on this account yet." plus Support.

**F. The honest cap on claims**, written as a test over the lever table and the standfirst: no `\d+\s*%`, no "will", "guarantee", "boost", "rank", "double", "grow your", no comparative outcome; no ` - ` and no em dash (the `client-copy-boundary` sweep covers the rendered component, this pins the pure table too). Sentences describe what is MADE and WHERE it lands; the effect is the scores' job.

**G. Home vs Reporting, no duplication.** Home keeps exactly what it has: the Visibility KPI cell (`home-kpis.tsx:407`, links to `#visibility-scores`) and the two share numbers on "SEO & AI visibility" (`home-standing.tsx`, "See the breakdown" → the top of Reporting). Reporting shows what moves them. No agent rows on Home; the agents' home is the Agents page and the setup ladder already points at the picked agent. One copy fix so the shared takeaway is true in both places: `presenter.ts:1113` "That's the gap the work below closes." → "That's the gap our agents are working on."; `:1117` "The work below protects that position." → "Our agents' job now is to protect that position."

**H. Reputation bubble** (`settings/page.tsx:543-571`) is deleted; the Reputation agent is row 7. Its "Beta" badge (`Badge tone="neon"`, which renders success green per `ui.tsx:155`) does not carry over; a beta marker belongs on the agent page if anywhere.

**Parity.** Same rows for staff in client context. A staff-only extra (the grant control) already lives in the Settings tab's admin frame (`:738-781`); the `notGranted` marker the staff roster paints is NOT rendered here (Not on your plan is the client's own word for it).

**Tests.** `visibility-levers.test.ts`: every family key named in `custom-agent-launch.ts` and every custom-agent key in `agent-engine/product-mapping.ts` either has a lever or is in an explicit `NO_LEVER` list; the claims-cap regex; the dash rule. `seo-geo-mounting.test.ts`: the section is mounted between the scores and the panel. `client-roster.test.ts`: the extracted derivation returns the same entries `client-agent-rows.test.ts` expects.

### Why
Albert, round 6: "ADD above it a section ... list every relevant Karos agent with what it does for visibility ... each with a button that links DIRECTLY to that agent's page". F11 (one vocabulary per thing) and the agent-page status bug are why the status word must be the roster's own.

### Effort · **M** (two new lib modules, one component, one extraction from the agents page, two added reads, four tests). The extraction is the half that costs; the section itself is a list.

---

## 3 · Reporting tab order, final

Target: scores → measurement line → what we are doing → competitor comparison (where you stand) → deep report → things only you can do.

**Current order** (`settings/page.tsx:634-658`, snapshot present): `#visibility-scores` (`SeoGeoScores`: legacy banner, **measurement stamp ABOVE the tiles**, tiles) → `ClientSuggestions` → `visibilityPanel` (`SeoGeoPanel`: refresh/no-engines card if any → staff refresh schedule frame → "Do buyers find you?" → "You vs competitors on each AI engine" → "Also named by the engines" → "The N questions we asked" → "Who the engines quote as sources" → "Something look off? · Support") → `reputationBubble`. No snapshot: `visibilityPanel` (empty state) → `reputationBubble`.

**Exact moves**

1. `components/seo-geo-panel.tsx:393-424` (`SeoGeoScores`): move `<MeasurementStamp view={measurement} />` (`:417`) from above the tile grid (`:418`) to below it. The legacy banner stays above (it qualifies the numbers before they are read).
2. `settings/page.tsx:634-652`: insert `<VisibilityWork … />` (the §2 section) immediately after the `#visibility-scores` section.
3. `settings/page.tsx:646-649`: move `<ClientSuggestions … />` to after `{visibilityPanel}`, last on the tab.
4. `settings/page.tsx:543-571, 651, 656`: delete `reputationBubble` and both mounts.
5. `settings/page.tsx:653-658` (no snapshot): `visibilityPanel` (empty state) → `<VisibilityWork />`. The suggestions stay unrendered without a snapshot, as now.
6. Inside the panel nothing moves: cards 3, 4, 4b are the comparison and 6 plus the citations card are the deep report, already in that order. The panel's closing "Something look off? · Support" line then sits above "Things only you can do", which also ends in Support; same word, fine. Optional: drop the panel's line and let the suggestions card carry the one trigger.
7. Home's KPI deep link (`page.tsx:643`, `#visibility-scores`) still lands on the first section. Unchanged.
8. Pin the order in `seo-geo-mounting.test.ts` by source index: `<SeoGeoScores` < `<VisibilityWork` < `{visibilityPanel}` < `<ClientSuggestions`.

Resulting tab, top to bottom: **Visibility scores** (three tiles) · measurement line with engine marks · **What we are doing for your SEO and GEO** · Do buyers find you? · You vs competitors on each AI engine · Also named by the engines · The N questions we asked · Who the engines quote as sources · **Things only you can do**.

### Why
Albert: "Move 'Things only you can do' to the very bottom of Reporting" and "ADD above it a section". The stamp under the tiles is the parent's stated order and reads as the caption of the numbers rather than a preface to them.

### Effort · **S**.

---

## 4 · Account Center → Profile: remove the Seats card

### Where it breaks
`settings/page.tsx:405-437` (the card), `:347-364` (`seatSetupLinks`), `:199` + `:166` + `:211` (`listClientSeats(id)` read, the `seats` tuple slot, the `ClientSeat[]` type), `:17` (`listClientSeats` import), `:83` (`ClientSeat` import), `:66` and `:68` (`isLinkedInAgentIdentity`, `isXAgentIdentity`, used only by `seatSetupLinks`). Also the block comment at `:340-346` describing the "read-only seat roster".

### What we change
Delete all of the above. `relativeTime` (`:70`) stays (Meetings uses it, `:831`); `Link` stays; `isReputationAgentIdentity` goes with the bubble in §2 unless the lever module imports it.

**Nothing depends on the card**, checked:
- `lib/action-list.ts:86-91` (01 "Complete your profile") and `:158-163` (10 "Confirm your company's social channels") land on `?tab=profile`, the top of the tab. Row 11 "Add a seat for someone else on your team" (`:164-170`) already points at `/clients/{id}/agents`, not the card. Rows 21/22 (`:254, :261`) use `#documents`.
- `lib/setup-ladder.ts:584, :591` use `ctx.profileHref` (= action 01) and `ctx.documentsHref` (= `#documents`, `page.tsx:498-503`). No `#seats` anchor exists anywhere in `src`.
- `settings-nav.test.ts:292-316` pins the Profile order as `ClientProfilePanel` → `BrandColorsSection` → `#documents` → `StaffOnlySection`; Seats is not in the pin. Add one line to that test: the page contains no `<CardTitle …>Seats`.
- `client-copy-boundary.test.ts:2883-2891` reads the settings page only for the ledger redaction line.

**Where seat management still lives**, so nothing is orphaned: the X intake page (`/clients/{id}/x-agent`, "add a seat") and the LinkedIn intake page (`/clients/{id}/linkedin-agent`, seats plus "Build their voice"), both reached from the agent detail page's "What it runs on" band, which lists one row per seat with an anchor link into its own card (`lib/agent-detail-sections.ts:450-470`, `intakeSeatAnchorId`). Seats are a per-agent input and that is where they are edited. Not to be confused with the Settings tab's "Manage employee seats (n/limit)" (`integrations-tab.tsx:626`), which is the LinkedIn OAuth `EmployeeSeat`, a different object, untouched.

**Other Profile blocks that read staff-shaped rather than client-shaped** (noted, not changed here):
- `ClientProfilePanel` (`client-profile-panel.tsx:579, :587`) plus `BrandColorsSection` (`client-context-sections.tsx:655`): three editors in ~60px (F16), two pencils and a contact glyph opening three different modals for one company card. One "Edit profile" entry is the client-shaped version.
- `BrandingModal` behind the branding pencil holds "Generate with AI", a four-colour system, fonts, a style taxonomy and a markdown document behind one Save (F15). Whether a client edits brand guidelines after onboarding is Albert's standing open question; until answered, this block is staff-shaped by density alone.
- Documents: "Regenerate" is already admin-gated; "Correct Info" (page → tab → panel → modal, charges credits, closes both layers with no diff, F15) is client-reachable and four deep.

### Why
Albert: "Remove the Seats card from Profile (not useful)". The card was a read-only list that pointed at two other pages; the pages it pointed at are the editors.

### Effort · **S**.

---

## 5 · Parity, the one orange, no em dashes

- **Parity**: the new section and the reordered tab are identical for a client and for staff in client context; the only staff extras on the tab remain the panel's `StaffOnlySection` refresh-schedule frame (`seo-geo-panel.tsx:675`) and, nowhere near Reporting, the Settings tab's admin frame. No new `isStaff` branch is introduced.
- **One orange**: the new section adds no accent. Status badges use the judgment tones (`Badge` success/info/warning/neutral, `ui.tsx:153-160`; the "neon" tone already renders success green). The row control is the portal's existing text link (foreground, `hover:text-neon` is the established link hover, not a fill). The removed Reputation bubble takes its green "Beta" badge with it. Existing orange on the tab (score meters `var(--neon)`, `home-standing.tsx` icon chip) is out of scope but the ux-deep-dive's note stands: the chip is decoration.
- **No em dashes**: none in any proposed string above. `client-suggestions.tsx:77` and `seo-geo-panel.tsx:931` contain one each inside JSX comments only (not rendered, the sweep ignores them). The new lever table gets its own dash pin because it is a pure module, outside the component sweep.
- **F9 duplicate routes**: the section adds one route to each agent page from Reporting (the roster already has one, the ladder one, the copilot one). Same href builder, same label shape ("Open {name}"), so the reader can tell it is the same destination.

### Effort · **XS** (checks and two test lines).

---

## Decisions Albert must make

- **D1 · GEO-04 (named on other sites).** My call: OUT of "Things only you can do" (it is coverage, which LinkedIn and Reddit partly move, and its ask is the general advice you rejected). Alternative: keep it as the one "relationships" row, only when the audit's evidence names a concrete domain rather than a count.
- **D2 · Show agents the client does not have?** My call: yes, as "Not on your plan" rows at the bottom of the section with Support, because you asked for "every relevant Karos agent". Alternative: granted and delivered agents only, which turns the section from a catalogue into a status list.
- **D3 · The control word on a not-granted row.** My call: the sentence "Not on your plan." plus the standard "Support" trigger (R7: one word for every support trigger). Alternative: label the trigger "Ask about it".
- **D4 · Dynamic agents in the section.** My call: not in v1 (no lever, no status source, a different route shape). Alternative: a neutral row per spec available to the client, "Built for your account by the Karos team", linking to `/clients/{id}/dynamic-agents/{spec.id}`.
- **D5 · Status words.** My call: the roster's own words (Live / Runs on request / Not set up yet / Setting up), rendered by the roster's own badge, so three surfaces cannot disagree. Alternative: friendlier "Running for you / Set up", which would be a second label map for one fact.
- **D6 · Site access as a structural ask.** Most (A) rows are Karos staff work behind an access grant, and today nothing records whether Karos has site access or Search Console access. A stored per-client flag would let the report ask for access ONCE, as one structural row, when it is missing. New data field, so your call; without it the on-site checks stay inside the score breakdown only.
- **D7 · Keep the empty "Things only you can do" heading?** My call: yes, one line, "Nothing on your side is holding you back right now."; that sentence is the point of the section.

---

## Summary

1. "Things only you can do" is wrong because ownership is derived from a scoring bucket, not from who can act; three outcome gaps (share of voice, named-mention rate, never cited) and GEO-04 became client tasks.
2. Fix: an explicit allow-list of three ids (GEO-25 claim your public record, GEO-07 point it at your site, GEO-14 open your review listings), rewritten copy, the REC_COPY fallback closed, the confirmed and measured rules and the cap kept.
3. Empty state becomes "Nothing on your side is holding you back right now." and the section moves to the bottom of Reporting.
4. New section "What we are doing for your SEO and GEO" sits under the scores: one row per agent family with an honest mechanism sentence, the roster's own status word, and one control that opens that agent's page (or Support when it is not on the plan).
5. Its status comes from the same derivation the Agents page uses, extracted into `lib/client-roster.ts`, so "Live" cannot mean two things (the agent-page status bug).
6. Where the snapshot's citation leaderboard names linkedin.com, reddit.com or the client's domain, the row carries "Quoted N times in the answers we measured"; that is what makes it analysis rather than advice.
7. Claims cap is a test: no percentages, no promises, no dashes; the scores are the only measure.
8. Final order is scores → measurement line (moved under the tiles) → what we are doing → where you stand → deep report → things only you can do; the Reputation bubble folds into the section.
9. The Seats card leaves Profile; nothing links to it, and seats are still edited on the X and LinkedIn agent pages reachable from each agent's "What it runs on" band.
10. Effort: §1 S, §2 M, §3 S, §4 S, §5 XS; seven decisions listed, my recommendation given on each.

File: `/private/tmp/claude-501/-Users-albertkattan-Karos-Labs-CMO--claude-worktrees-instagram-post-ordering-5c8eaa/cdf3554f-eb4b-4145-babb-1262ff4f23f8/scratchpad/think-reporting.md`
