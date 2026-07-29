# Ops Import — landing locally-produced work in the live portal

`/admin/ops`, admin only. The UI equivalent of `scripts/refresh-apply.ts`, plus the
SEO/GEO and posts halves, for people who should not have to run a CLI against
production Firestore.

Both surfaces enforce the **same** rules: the validation, plan and write shapes
live in `src/lib/refresh-apply-core.ts`, which the script and the page both
import. There is no second implementation to drift.

---

## What the page imports, and from where

| What | Source | Mechanism |
|---|---|---|
| Docs · competitors · profile · palette | **lab repo** `clients/<slug>/refresh/*.json` | `refresh-apply-core` (shared with the CLI) |
| Docs · competitors · profile · palette | **inbox** `OPS_IMPORT_DIR/<anything>.json` | the same core, the same cards |
| SEO/GEO snapshots | `OPS_IMPORT_DIR/seo-geo/<clientId>.json` | `seo-geo-import` → `upsertClientSeoGeo` |
| **Posts / assets** | **the karos-agents repo, over GitHub** | **the existing lab-outputs importer** |

Proposals have **two** discovery sources and **one** write path. Both render
identical plan cards through the same validator; each card carries a `lab repo`
or `inbox` badge so you always know which file you are looking at.

**Posts are not read from the inbox.** The portal already had a first-class
importer for locally-run agent output — the lab-outputs flow
(`src/lib/lab-outputs.ts` → `importLabRunAction`) that reads a client's committed
`clients/<slug>/outputs/<agent>/<run>/client/` deliverables and creates draft
assets through the same `createAsset` path the agent-service webhook uses, with
per-item idempotency (`meta.labRun`) and the one-post/day chain reflow. The Ops
Import page **mounts that existing flow** per client rather than reimplementing
it. A second posts writer would have forked the asset path — which is exactly
the failure this whole extraction exists to prevent.

Requires `AGENTS_REPO_GITHUB_TOKEN`, and the client needs a **Lab repo slug**
(set in its Edit dialog). Imported posts land as **drafts** — a client sees
nothing until staff approve them, so the churn rules (A3/A4) still hold.

---

## "Check for updates" — the one-click answer

The button at the top of the page scans the lab repo for every client that has
a lab slug and answers *"is there anything new anywhere?"*:

- **committed refresh proposals** at `clients/<slug>/refresh/*.json`, listed as
  ordinary bundle cards you can review and import;
- **output runs that have never been imported**, each with the same
  "Import lab outputs" button the client pages use.

A run counts as new when no asset carries its `meta.labRun` key — the exact key
`importLabRunAction` writes and de-duplicates against, so the scan and the
importer can never disagree about what "already imported" means. Clients with
nothing new are counted, not listed.

The scan is **read-only** and writes nothing. It reuses the same GitHub client,
repo and token as the posts importer (`src/lib/lab-outputs.ts`) — there is no
second fetch layer to get auth, timeouts or 404-handling wrong.

### The `clients/<slug>/refresh/` convention

Mirrors the existing outputs convention, one level up from the run tree:

```
clients/<slug>/outputs/<agent>/<run>/client/   deliverables (posts)
clients/<slug>/refresh/<anything>.json         refresh proposals
```

The filename is free; **the client is taken from the file's `clientId`**, never
from its name or its folder. Paths round-trip the browser, so the reader
enforces the convention with an anchored pattern (`isLabProposalPath`): one
path segment each for slug and filename, both starting with an alphanumeric,
`.json` only. That last rule is load-bearing — a slug class that allowed a bare
`..` would let `clients/../refresh/x.json` escape the folder and pull an
arbitrary file out of the private repo through the portal's token.

SEO/GEO snapshots are **inbox-only**; the lab convention covers proposals. With
no inbox configured there is simply no snapshot half, which is not an error.

---

## Setting up the inbox

Set `OPS_IMPORT_DIR` to an absolute path on the server and restart. With it
unset the page renders a setup notice instead of an importer.

```
<inbox>/geektime.proposal.json        one refresh proposal per client
<inbox>/sitti.proposal.json
<inbox>/seo-geo/QwQFkfsCXQdwJIKjfeg9.json    one capture per client, named by clientId
```

Filenames in the root may be anything ending `.json`; the **client is taken from
the file's `clientId`**, never from its name. Only `[A-Za-z0-9][\w.-]*\.json` is
listed, and every path is re-resolved inside the inbox on each request, so a
name that escapes the folder is refused rather than read.

The importer is **read-only**: it never writes to, moves, or empties the inbox.
Re-importing is always possible, and an operator's files stay theirs.

### Proposal format

Exactly the schema `scripts/refresh-apply.ts` has always validated — see
[BRIEF-TEMPLATE.md](./BRIEF-TEMPLATE.md). Unchanged, because it is the same
validator.

---

## The config strip

The top of the page names both env vars and says plainly what is unreachable
without each one. This exists because a missing capability used to be
*invisible*: the AI Agents tab simply hides its "Import lab outputs" button when
`AGENTS_REPO_GITHUB_TOKEN` is unset, which is indistinguishable from a feature
that was never built. Nobody should debug that blind again.

- `AGENTS_REPO_GITHUB_TOKEN` unset → no scan, and the per-client import button
  is hidden app-wide.
- `OPS_IMPORT_DIR` unset → server-dropped proposals are not read and SEO/GEO
  snapshots cannot be imported. **The lab-repo source still works.**

---

## Reviewing and picking

### Picking what lands

Every write in the plan has a checkbox, all ticked by default. Untick anything
you do not want and Import writes only the rest; the confirm dialog lists the
ticked subset, not the whole bundle.

One dependency exists. **The palette cannot be imported without its branding
document** — the app rebuilds that document from the palette on save, so taking
one without the other leaves every agent reading stale hex codes. The palette's
tick disables itself, with that reason, when the document is unticked, and
unticking the document drops the palette with it. The server re-checks the
selection on apply: a disabled checkbox is an explanation, not a guarantee.

(No dependency is declared when the stored branding document already states the
palette — it is "unchanged", so there is no document write to keep in step with.)

### When a refusal happens

Refusals are grouped into plain sentences — what happened, and what to do —
with the validator's exact wording one disclosure down, under
**Technical detail**. Nothing is discarded; a message with no written copy yet
still appears under a generic heading.

### Already-imported bundles

A bundle that has been imported renders as a quiet **applied** card carrying the
date and who did it, rather than looking like one nobody has touched. This is
read back from the activity log — every apply writes a row with the bundle's
`origin`, `ref` and a fingerprint — so there is no second source of truth to
drift from the timeline.

If the file has changed since that import it is badged **changed** and offers
**Review again**. A bundle imported before fingerprinting shipped has no
recorded fingerprint and is treated as changed: a needless re-import is
recoverable, a silently skipped one is not.

---

## What the buttons do

**Review changes** — dry run. Reads Firestore, writes nothing, and renders the
plan: documents created/updated with char and section deltas and version bumps,
competitor rows touched with the changed field names, profile fills, skipped
fill-only fields *with the reason they were skipped*, palette before → after,
`[VERIFY]` counts, and every warning.

**Import** — opens a confirm naming, in nouns, each thing that will be written,
then applies. The whole refresh half commits in **one atomic batch per client**,
the same ops the CLI builds.

**Import all reviewed** — the same, for every bundle whose plan is on screen,
applied one client at a time. Sequential on purpose: each apply re-reads the
state it validates against.

Three things worth knowing:

- **The plan authorizes nothing.** Apply re-reads the file from disk and
  re-validates it from scratch. A bundle edited between preview and click is
  re-judged, not trusted.
- **Any error refuses the whole bundle.** Ticking a subset is a choice you make;
  a validation failure is not, and it stops everything.
- **A pipeline run blocks the import.** While `isAiProcessingLockActive` holds
  for that client, the buttons are disabled — a refresh interleaved with a
  pipeline run is how half of each survives.

Each applied bundle writes a `CONTEXT_DOC_UPDATED` activity entry naming the
file and the counts (and marked `(selected items only)` when a subset was
taken). The result panel reports applied / skipped / errors per half, so a
green refresh next to a refused snapshot reads as exactly that.

---

## Competitors that already exist

A proposal is written against an export taken days earlier, and the roster moves
underneath it. So a `create` for a competitor that has since landed is a **stale
export, not an error**.

When a `create` matches exactly one roster row — by company name or by domain —
the plan folds it onto that row as an update. The fields merge; `company` is
dropped as the join key (it is what matched on a name hit, and renaming a row on
the strength of a URL hit is not this pass's call). The row says
*"Already in the roster (matched by name) — will update the existing row"*, so
the fold is visible in the diff, never silent.

Two cases still refuse, because intent is genuinely unclear:

- the create matches **two or more** rows — guessing would silently merge the
  wrong one;
- the create resolves onto a row the **same proposal already updates** — two
  plans for one row is a double write.

This replaced a hard refusal of the entire bundle, which turned a routine
refresh into a hand-editing job.

---

## The SEO/GEO provenance rule

**Read this before importing a snapshot.**

The refresh harness deliberately gave `refresh-apply.ts` *no* write path to
`clientSeoGeo`: those numbers are machine-measured, and a portal reporting a
position nobody measured is worse than one reporting nothing. Albert's directive
overrides that ban — so the ban became a provenance obligation.

An imported snapshot **must not be able to masquerade as a fresh machine
capture**. Four rules make that structural:

1. **It validates against the stored capture shape** (`SeoGeoInsights`), unknown
   keys included. A bundle from a different pipeline is refused, not coerced —
   importing its recognised half would mix two schemas in one document.
2. **`capturedAt` comes from the bundle, never the clock.** Import a three-month
   old capture and it reads as three months old, staleness notice and all.
   A capture dated in the future is refused.
3. **`pipelineVersion` is carried through exactly as declared** — never
   invented, upgraded, or defaulted. `buildSnapshotTrust` compares it strictly
   against `SEO_GEO_PIPELINE_VERSION`, so a bundle without a stamp still renders
   the legacy banner. That is the honest outcome, and the importer will not
   silence it.
4. **`importedFrom` is stamped by the importer, never accepted from the
   bundle.** A file cannot declare its own provenance.

`SeoGeoInsights.importedFrom` is the new optional field — `{ source:
"local-import", importedAt, importedBy?, file? }`. It is optional because
**absent means machine-measured**: every snapshot written before this page
existed is a genuine capture and must keep reading as one. It is *not* named
`source` because `PerEngineVisibility.source` already means `ProviderSource`
one level down.

It does **not** participate in the trust verdict. Legacy still means "measured
under superseded rules"; provenance answers the separate question of where the
run happened. The next real pipeline capture overwrites the doc and drops the
field — correct, since a machine capture must not inherit an import's
provenance.

The provenance note is shown on **this page only** (`Currently stored: …`),
not in the client-facing SEO/GEO panel. `SeoGeoScores` is mounted for clients
too, and "imported by hand" is an operations detail, not a client-facing caveat
about their numbers.

One honest edge: `upsertClientSeoGeo` drops a write whose `capturedAt` is older
than what is stored, to protect a fresher capture. The page checks first and
reports "kept the newer one" rather than claiming a write that never happened.

---

## Related

- `scripts/refresh-export.ts` — produces the dump a proposal is written against.
- `scripts/refresh-apply.ts` — the CLI path; same core, same fences.
- `src/lib/refresh-apply-core.ts` — where the rules actually live.
- `src/lib/refusal-copy.ts` — the plain-language refusal grouping.
- `src/lib/ops-import-history.ts` — "have I already imported this?", from the
  activity log.
- Tests: `src/lib/__tests__/refresh-apply-core.test.ts` (refusal rules,
  reconciliation, selection), `src/lib/__tests__/seo-geo-import.test.ts`
  (provenance), `src/lib/__tests__/lab-refresh-proposals.test.ts` (the repo path
  fence), `src/lib/__tests__/refusal-copy.test.ts` (the copy, checked against
  the real validator), `src/lib/__tests__/bundle-fingerprint.test.ts`.
