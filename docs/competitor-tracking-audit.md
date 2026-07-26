# Competitor tracking — audit + rework (2026-07-24)

Why the sidebar Competitor Track and the SEO/GEO "You vs competitors" panel showed
different competitors, how competitors are actually selected at onboarding, and what
changed on branch `claude/competitor-tracking-audit-1cee56`.

## How the system works

1. **Seeding (onboarding).** `createClientAction` fires `runIntelReportPipeline`
   ([report.ts](../src/lib/intel/report.ts)). The Intel Report's *Wide Scan* table
   (8–15 competitors, Sonnet + live web search/fetch) is parsed and written to the
   `clientCompetitors` collection via `replaceReportCompetitors` (source `"report"`;
   every intel re-run replaces these rows). Staff/clients can add `"manual"` rows from
   the sidebar; manual rows are never auto-replaced.
2. **Tracked-5.** [competitor-priority.ts](../src/lib/competitor-priority.ts)
   (`computeTrackedCompetitors`) picks exactly 5 for every surface: manual rows first
   (newest-first), remaining slots backfilled by score.
3. **SEO/GEO capture.** The onboarding pipeline passes that same tracked-5 as the
   share-of-voice roster ("QA Fix 1"), asks up to 20 buyer-intent questions to each
   wired engine (OpenAI / Gemini / Anthropic), and freezes everything into one
   `clientSeoGeo` snapshot per client.

## What the audit found

- **The panel rendered the frozen snapshot roster, not the live tracker.** Sitti's
  stored snapshot predates QA Fix 1 — its roster (Cafés To Work From, Google Maps,
  Gumroad, LaptopFriendly, Mapstr, Muggerino) is an *alphabetical slice* of the old
  pool. The sidebar meanwhile showed Mapstr, Whop (manual) + Google Maps, Yelp,
  Patreon. Any add/remove after a capture desynced the two views; a stale-roster
  warning had been computed in the panel but never rendered.
- **No LLM signal in selection.** The capture only counted brands already on the
  roster (gazetteer matching), so an engine-dominant brand the intel report missed
  could never surface, and selection ranked purely on analyst guesses
  (threat/tier/overlap). "Most relevant + ranks best on LLMs" was not achievable.
- **Favicons.** Competitor favicons derive from `competitor.url` (Google s2), but the
  Wide Scan prompt never required domains, so most report-seeded rows had no URL →
  generic building icon (Sitti: Google Maps/Yelp/Patreon). Client avatars fell back
  to initials with no website-favicon step.
- **Subtitle off-by-one.** The panel's "N buyer questions / M brand questions" used a
  different brand-prompt classifier than the engine cards (alias match vs
  `classifyIntent`), so the two could disagree on the same screen.

## What changed

- **Side-by-side by construction.** The panel now builds its comparison rows from the
  *current* tracked-5 (`buildEngineViews(insights, tracked, clientWebsite)` in
  [presenter.ts](../src/components/seo-geo/presenter.ts)): measured counts come from
  the snapshot roster or the discovery pass; tracked-but-unmeasured competitors render
  an explicit "measured on the next snapshot" placeholder (never invented numbers);
  no-longer-tracked snapshot brands are dropped and disclosed in a drift banner.
  Roster chips + methodology follow the same list. Favicons on every row.
- **Brand discovery.** After each capture, one extraction pass proposes brands the
  engines named that aren't tracked; every count is re-verified deterministically with
  the same word-boundary matcher used for roster brands
  (`discoverAnswerBrands` in [intel/seo-geo.ts](../src/lib/intel/seo-geo.ts), stored as
  `insights.discoveredBrands`). The panel lists them under "Also named by the engines".
- **LLM-aware selection.** [competitor-sync.ts](../src/lib/intel/competitor-sync.ts)
  runs after every capture: roster rows get measured `llmMentions` written back
  (including zeros), and the top discovered brands are created as auto-seed rows.
  `computeTrackedCompetitors` now weighs `llmMentions` above threat/tier/overlap, so
  the tracked-5 converges on rivals that actually win the AI conversation. Manual rows
  keep their slots.
- **URLs everywhere.** The Wide Scan prompt now requires `Name (domain.com)` per row
  and the competitor-analysis schemas demand a domain for any recognizable company —
  future seeds carry favicons and better gazetteer aliases.
- **Client favicons.** New [BrandFavicon](../src/components/brand-favicon.tsx)
  (logo → website favicon → initials/building) used by the client switcher, clients
  grid, client profile panel, competitor track, and all panel rows. A client that
  gives us their website at onboarding gets their favicon everywhere with no upload.
- **Presence split aligned** with the intent classifier (subtitle and engine cards can
  no longer disagree), plus pluralization fix, and the previously-dead citation
  leaderboard now renders ("Who the engines quote as sources").
- **Lab client import.** `npx tsx scripts/import-lab-client.ts <slug> [--dry-run]`
  imports a karos-agents client from a local checkout: client record + brand colors +
  logo, profile docs → internal context docs, `competitor-tracking.json` → competitor
  pool (tier-mapped so direct rivals win the tracked-5), and every
  `outputs/*/*/client/` deliverable → draft assets with the same `meta.labRun` keys as
  the in-app importer (idempotent both ways). Geektime imported 2026-07-24 as client
  `QwQFkfsCXQdwJIKjfeg9`: 7 docs, 9 competitors (tracked-5: Calcalist, CTech, Globes,
  People & Computers, TheMarker), 3 assets, logo + palette.

## Operational notes

- Existing snapshots (e.g. Sitti's) stay stale until the next Regenerate — the panel
  now *says so* instead of silently showing the old roster. A regenerate re-runs the
  capture against the current tracked-5, records `llmMentions`, and discovers
  non-roster brands.
- Sitti's Yelp/Patreon rows predate the URL requirement and have no domain (building
  icon until the next intel run replaces report rows, or staff edit them).
- Discovered-brand counts label honestly: totals span all prompts; per-engine counts
  are category-prompts-only, matching the comparison denominators.

## Post-review hardening (same day)

An adversarial alignment review of the first commit surfaced four defects, all fixed:

- **Name↔URL key asymmetry (blocking):** snapshot rosters key by display name while
  tracked refs keyed by URL domain, so competitors whose name ≠ domain label
  ("CTech by Calcalist" / calcalistech.com) rendered as pending and double-appeared
  in the drift banner. All cross-surface matching now probes every identity key via
  `brandKeys(name, url)` (presenter, drift, chips, competitor-sync, data layer).
- **Subdomain label keys:** `tech.walla.co.il` no longer keys/aliases as "tech" —
  `brandLabelFromDomain` picks the last meaningful label before the public suffix
  ("walla"), which also prevents false mention matches on the word "tech".
- **LLM signal durability:** `replaceReportCompetitors` now carries
  `llmMentions`/`llmMentionsAt` (and missing URLs) onto matching new rows and retains
  measured AI-visible rivals the new report dropped, so a standalone competitor
  re-analysis can no longer silently reset LLM-aware selection.
- **Subtitle count fallback** when the tracked list is empty but a legacy snapshot
  still renders roster rows.

Known limitation: "5 competitors per client" is guaranteed only when the pool has ≥5
rows (intel seeding produces 8–15; sparse hand-created clients can run
`backfillCompetitorsAction` from the dashboard, and Geektime was seeded with 9).

## Quick-add duplicate fix (2026-07-26, post-merge)

Adding a competitor by pasted URL created the classic duplicate: a raw
"https://speedrun.a16z.com" manual row (no favicon) beside the AI-resolved
"Speedrun by a16z" report row — manual rows are never replaced, so both stayed.
Fixed at three levels: quick-add now parses URL input into `{company: host, url}`
(favicon + identity keys from the first render) and promotes an existing pool row
instead of creating a twin (`upsertManualCompetitor`); `replaceReportCompetitors`
merges any analysis/report row that brand-key-matches a MANUAL row into that row
in place (canonical name replaces URL-ish names, url + analysis fields fill) and
never mints a report twin; and `competitorBrandKeys` makes all row matching
tolerate legacy raw-URL rows. `scripts/dedupe-competitors.ts` (dry-run default)
collapsed the existing duplicate — Pitch by Deel's Speedrun pair merged into one
manual "Speedrun by a16z" row.
