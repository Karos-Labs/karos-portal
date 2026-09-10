# CD-G7 — fleet completion refresh: run plan

Owner: the orchestrator. This is the only document that describes *running*
anything. Teams work from `BRIEF-TEMPLATE.md`; the architect does not touch
Firestore at all.

Runs **last**, after CD-G1..G6 have merged.

---

## What this pass is, in one paragraph

All portal clients get their data completed — not regenerated. Local Claude
teams read a read-only export, research the gaps with live web access, and hand
back a proposal JSON per client. The orchestrator dry-runs each proposal, then
applies them one client at a time. Nothing goes through the app's Anthropic
path, so no API key top-up is needed and no `isAiProcessing` lock is taken.

Two scripts, both `tsx`-run, both loading `.env.local` the way
`scripts/grant-all-agents.ts` does:

| Script | Direction | Default |
|---|---|---|
| `scripts/refresh-export.ts` | read-only | writes JSON to a scratchpad dir |
| `scripts/refresh-apply.ts` | the only write path | dry run; `--apply` commits |

---

## 0. Prerequisites

- `.env.local` present in the worktree with `FIREBASE_SERVICE_ACCOUNT_KEY`.
- `node_modules` present. Worktrees do not inherit it — clone it rather than
  symlink (`cp -Rc ../../node_modules .`) so `tsx` and `next dev` both work.
- A scratchpad directory **outside the repo** for exports and proposals. The
  export script refuses any `--out` inside the working tree; exports contain
  full client strategy documents and must never be committed.
- `npx tsc --noEmit` clean on the branch before starting.

```
SCRATCH={{/private/tmp/.../scratchpad}}/refresh
mkdir -p "$SCRATCH/proposals"
```

---

## 1. Export (orchestrator, once)

```
npx tsx scripts/refresh-export.ts --out="$SCRATCH"
```

Produces `index.json` plus one `<slug>__<clientId>.json` per client. Add
`--include-report-markdown` if teams want the last Digital Intelligence report
body inline; it is omitted by default because it is large.

Read `index.json` and fill the roster table in section 2. It reports, per
client: `docCount`, `missingDocs`, `emptyDocs`, `competitorCount`,
`brandColorCount`, `seoGeoCapturedAtIso`, `seoGeoTrusted`.

**Sanity gates before proceeding:**
- The client count matches the 7 portal clients. If it does not, stop and
  reconcile — a stray or archived client changes the scope of the pass.
- Every export file is non-trivial in size. A near-empty file means the client
  was never onboarded, which is a different job (`runOnboardPipeline`), not a
  completion pass.

---

## 2. Roster

The 7 clients are Firestore data, not code — the ids below are filled from
`index.json` at run time. Names carried in from prior work: Geektime
(`QwQFkfsCXQdwJIKjfeg9`), Karos Labs, Pitch by Deel. Confirm all seven against
the export rather than trusting this list.

| # | Client | clientId | docs (of 14) | missing | competitors | colors | seo/geo trusted | team | proposal | dry-run | applied | Albert |
|---|--------|----------|--------------|---------|-------------|--------|-----------------|------|----------|---------|---------|--------|
| 1 | {{pilot}} | | / 14 | | | | | | ☐ | ☐ | ☐ | ☐ |
| 2 | | | / 14 | | | | | | ☐ | ☐ | ☐ | ☐ |
| 3 | | | / 14 | | | | | | ☐ | ☐ | ☐ | ☐ |
| 4 | | | / 14 | | | | | | ☐ | ☐ | ☐ | ☐ |
| 5 | | | / 14 | | | | | | ☐ | ☐ | ☐ | ☐ |
| 6 | | | / 14 | | | | | | ☐ | ☐ | ☐ | ☐ |
| 7 | | | / 14 | | | | | | ☐ | ☐ | ☐ | ☐ |

A complete client has 14 context-doc rows: 6 `internal` + 6 `client` +
2 `internal-only`. Anything less is a gap the team must close.

**Pick the pilot** as the client with the *most* to do (most `missingDocs`, or a
stale SEO/GEO capture). The pilot is what Albert reviews before the other six
are touched, so it should exercise the most surfaces. Prefer a client Albert
knows well by eye.

---

## 3. Teams

One team per client. Copy `BRIEF-TEMPLATE.md`, fill the four header slots
(`CLIENT NAME`, `CLIENT ID`, `EXPORT FILE`, `PROPOSAL OUT`), and hand it over
with the export file path.

**Concurrency: 3-4 teams at a time.** The constraint is not compute, it is
review bandwidth and web-research quality. Every team fetches the client site,
3-5 competitor sites, and review platforms; running all seven at once produces
more output than one reviewer can hold in their head, and the failure mode is a
proposal that passes validation while being subtly wrong. Run the pilot alone
first, then two waves of three.

Teams write **only** their proposal file. They never run `refresh-apply.ts` and
they never touch Firestore. Say so in the handoff.

**Per-team acceptance before the orchestrator dry-runs it:**
- The proposal parses and names the right `clientId` / `clientName`.
- The team reported its `[VERIFY]` count and what it left alone and why.
- Every `missingDocs` entry from the export is either supplied or explained.

---

## 4. Dry run (orchestrator, per client)

```
npx tsx scripts/refresh-apply.ts \
  --file="$SCRATCH/proposals/<slug>.proposal.json" \
  --client=<clientId>
```

The script prints a field-by-field plan: documents created/updated with char
and section deltas and version bumps, competitor rows with per-field before →
after, client profile fills, and the color palette before → after. Warnings
(Change Log sections, `---` rules in a body) print separately and do not block.

Rejections are all-or-nothing and list every problem at once. Common ones and
what they mean:

| Rejection | Read it as |
|---|---|
| `docs[n].tier` illegal for docType | The team tried to publish an internal-only document. Never override. |
| drops N section(s) | The team rewrote instead of completing. Send it back. |
| shrinks to X% | Same, or a genuine restructure — then they must supply `shrinkApproved` with a reason. |
| `[VERIFY]` at tier client | An unverified claim reached the client-facing twin. Resolve or move it to internal. |
| usagePct must sum to 100 | CD-E2 gate. |
| palette changed without the branding-guidelines document | Colors and document must move together. |
| `competitors.create` duplicates an existing row | Use `update` with that row's id. |

Dry-run **all seven** before applying **any**. A systemic mistake (a team
misreading the tier matrix, say) shows up cheaply across the batch.

---

## 5. The review gate — stated honestly

There is no staging environment. `refresh-apply.ts --apply` writes to the same
production Firestore that localhost reads. **Albert's review is therefore
post-apply, not pre-apply.** The dry run is a machine review of shape and
safety; it cannot tell you whether the prose is right.

So the gate is sequencing, not staging:

1. **Apply the pilot client only.**
   ```
   npx tsx scripts/refresh-apply.ts --file=… --client=<pilotId> --apply
   ```
   The write is a single atomic batch, so a client is never half-updated.

2. **Albert reviews the pilot on localhost** (`npm run dev`):
   - `/clients/<id>` — dashboard, brand colors, competitor track in the sidebar.
   - The documents surface — every tab present, every tab opening onto real
     content, no empty panel.
   - The same pages **viewed as a client** — usage percentages must not appear,
     and no `[VERIFY]` token may be visible anywhere.
   - The competitor track — every row has a favicon (that is the working-domain
     check made visible) and the names read as brands, not URLs.
   - The SEO/GEO panel — unchanged by this pass, which is correct. Nothing in it
     should have moved.

3. **Only after Albert signs off**, apply the remaining six, one invocation
   each. `--client` is mandatory precisely so a slip cannot fan out.

4. Re-review the fleet at a glance: each client's documents tab and competitor
   track.

### Rollback, honestly

The pre-apply export **is** the backup: it carries every document body,
competitor row and color at full fidelity. But restoring is not symmetric —
`refresh-apply.ts` refuses to drop a section and refuses to shrink past its
floor, so replaying an older, shorter document back through it needs an explicit
`shrinkApproved`, and a section-count reduction cannot be expressed at all.
That is the intended trade: the write path is one-directional by design.

Practically: the pass is additive, so a bad *outcome* is a document that says
something wrong, not data that is gone. Fix it with a corrective proposal
(usually easy — it grows or stays the same size). Reserve a hand-written restore
script for the case where a document must genuinely shrink, and keep
`$SCRATCH` intact until Albert has signed off on all seven.

**Do not delete the export directory until the pass is closed out.**

---

## 6. After

- Record in `docs/qa-sweep-2026-07/rescopes.md` (or the ledger) which clients
  were applied, when, and the total `[VERIFY]` count carried forward.
- Every unresolved `[VERIFY]` is an open question for Albert or the client. They
  live in internal-tier documents and are invisible to clients, so they are safe
  to leave — but they are not free. List them.
- `TOMER-HANDOVER.md` gets the new seam: refresh proposals are a hand-authored
  data path into `clientContextDocs` / `clientCompetitors` / `clients`, distinct
  from the intel pipeline, with `scripts/refresh-apply.ts` as its only door.
- If a client's `seoGeoSummary.trusted` was `false`, a real SEO/GEO capture is
  still owed. That needs the app's pipeline and an API key — out of scope here,
  and it should be logged as OPS-PENDING rather than quietly forgotten.

---

## Command reference

```
# Export everything (read-only, nothing written to Firestore)
npx tsx scripts/refresh-export.ts --out="$SCRATCH"

# Export one client, with the last intel report body inline
npx tsx scripts/refresh-export.ts --out="$SCRATCH" --client=<id> --include-report-markdown

# Dry run a proposal (default; prints the diff, writes nothing)
npx tsx scripts/refresh-apply.ts --file="$SCRATCH/proposals/x.json" --client=<id>

# Apply it (single atomic batch for that one client)
npx tsx scripts/refresh-apply.ts --file="$SCRATCH/proposals/x.json" --client=<id> --apply
```
