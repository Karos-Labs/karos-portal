# Ops Import — landing locally-produced work in the live portal

`/admin/ops`, admin only. The UI equivalent of `scripts/refresh-apply.ts`, plus the
SEO/GEO and posts halves, for people who should not have to run a CLI against
production Firestore.

Both surfaces enforce the **same** rules: the validation, plan and write shapes
live in `src/lib/refresh-apply-core.ts`, which the script and the page both
import. There is no second implementation to drift.

---

## What the page imports, and from where

The page has two halves, on purpose, because the sources genuinely differ.

| What | Source | Mechanism |
|---|---|---|
| Docs · competitors · profile · palette | `OPS_IMPORT_DIR/<anything>.json` | `refresh-apply-core` (shared with the CLI) |
| SEO/GEO snapshots | `OPS_IMPORT_DIR/seo-geo/<clientId>.json` | `seo-geo-import` → `upsertClientSeoGeo` |
| **Posts / assets** | **the karos-agents repo, over GitHub** | **the existing lab-outputs importer** |

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
- **Any error refuses the whole bundle.** There is no partial apply.
- **A pipeline run blocks the import.** While `isAiProcessingLockActive` holds
  for that client, the buttons are disabled — a refresh interleaved with a
  pipeline run is how half of each survives.

Each applied bundle writes a `CONTEXT_DOC_UPDATED` activity entry naming the
file and the counts. The result panel reports applied / skipped / errors per
half, so a green refresh next to a refused snapshot reads as exactly that.

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
- Tests: `src/lib/__tests__/refresh-apply-core.test.ts` (refusal rules),
  `src/lib/__tests__/seo-geo-import.test.ts` (provenance).
