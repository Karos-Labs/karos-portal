/**
 * CD-G7 — per-client data COMPLETION refresh, step 1 of 2: READ-ONLY export.
 *
 * Dumps everything a local Claude refresh team needs to complete (not replace)
 * one client's portal data: the client profile fields the refresh may touch,
 * every context document at every tier, every competitor row, and the latest
 * SEO/GEO capture + intel report metadata so the team can see what the machine
 * already measured and must NOT re-author from imagination.
 *
 * This file performs ZERO Firestore writes. There is no `.set(`, `.update(`,
 * `.add(`, `.create(`, `.delete(` or batch/transaction anywhere in it, and that
 * is a hard invariant — the only write path in this pass is refresh-apply.ts.
 *
 * The output directory is REQUIRED and must live outside the repo (the
 * orchestrator points it at a scratchpad path). Exports contain full client
 * strategy documents; they never get committed.
 *
 *   npx tsx scripts/refresh-export.ts --out=/abs/path/to/scratchpad/refresh
 *   npx tsx scripts/refresh-export.ts --out=/abs/path --client=<clientId>
 *   npx tsx scripts/refresh-export.ts --out=/abs/path --include-report-markdown
 *
 * Writes <out>/index.json (fleet roster) plus <out>/<slug>__<clientId>.json.
 */
import path from "node:path";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = path.resolve(__dirname, "..");

function loadEnv() {
  for (const line of readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

/**
 * Client fields in scope for the refresh. Deliberately narrow: assignment,
 * status, credits, schedule state and every lock field are the app's business,
 * not a refresh team's. `customAgentIds` is exported for context only —
 * refresh-apply refuses to write it (scripts/grant-all-agents.ts owns grants).
 */
const CLIENT_EXPORT_FIELDS = [
  "name",
  "website",
  "industry",
  "category",
  "teamSize",
  "description",
  "brief",
  "brandVoice",
  "brandingGuidelines",
  "socialLinks",
  "customAgentIds",
  "contactEmail",
  "domains",
  "logoUrl",
  "accentColor",
  "status",
  "onboardingStatus",
  "agentsRepoSlug",
  "lastIntelReportAt",
] as const;

/** Canonical context-doc types the intel pipeline produces (src/lib/intel/pipeline.ts:885,893). */
const PIPELINE_DOC_TYPES = [
  "brand-voice",
  "market-strategy",
  "competitor-analysis",
  "product-information",
  "branding-guidelines",
  "target-audience",
  "client-guidelines",
  "action-plan",
] as const;

/** Public docs: written at tier "internal" AND condensed to tier "client". */
const PUBLIC_DOC_TYPES = PIPELINE_DOC_TYPES.slice(0, 6);
/** Never published: written at tier "internal-only" only. */
const INTERNAL_ONLY_DOC_TYPES = PIPELINE_DOC_TYPES.slice(6);

/** Snapshots captured before the 2026-07-23/24 redeploy are not trustworthy (src/lib/seo-geo.ts:1532). */
const SNAPSHOT_TRUST_CUTOFF = Date.UTC(2026, 6, 23);

type Row = Record<string, unknown>;

function pick(data: Row, fields: readonly string[]): Row {
  const out: Row = {};
  for (const f of fields) if (data[f] !== undefined) out[f] = data[f];
  return out;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "client"
  );
}

function iso(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Which (docType, tier) rows exist, and which the pipeline would normally have produced. */
function docCoverage(docs: Row[]): {
  present: string[];
  missing: string[];
  empty: string[];
  unexpected: string[];
} {
  const key = (d: Row) => `${String(d.docType)}@${String(d.tier)}`;
  const expected = [
    ...PUBLIC_DOC_TYPES.flatMap((t) => [`${t}@internal`, `${t}@client`]),
    ...INTERNAL_ONLY_DOC_TYPES.map((t) => `${t}@internal-only`),
  ];
  const present = docs.map(key);
  const empty = docs.filter((d) => !String(d.content ?? "").trim()).map(key);
  return {
    present,
    missing: expected.filter((e) => !present.includes(e)),
    empty,
    // meeting-notes rows are legitimate but transcript-owned — flagged, never a gap.
    unexpected: present.filter((p) => !expected.includes(p)),
  };
}

/** The measured numbers a refresh team must cite rather than re-derive. */
function seoGeoSummary(s: Row | null): Row | null {
  if (!s) return null;
  const capturedAt = typeof s.capturedAt === "number" ? s.capturedAt : null;
  return {
    capturedAt,
    capturedAtIso: iso(capturedAt),
    pipelineVersion: s.pipelineVersion ?? null,
    trusted: capturedAt != null && capturedAt >= SNAPSHOT_TRUST_CUTOFF,
    trustCutoffIso: new Date(SNAPSHOT_TRUST_CUTOFF).toISOString(),
    seoScore: s.seoScore ?? null,
    seoDataCoveragePct: s.seoDataCoveragePct ?? null,
    geoReadiness: s.geoReadiness ?? null,
    geoReadinessCoveragePct: s.geoReadinessCoveragePct ?? null,
    geoVisibilityIndex: s.geoVisibilityIndex ?? null,
    geoVisibilityCoveragePct: s.geoVisibilityCoveragePct ?? null,
    geoVisibilityEnginesMeasured: s.geoVisibilityEnginesMeasured ?? null,
    geoVisibilityEnginesTotal: s.geoVisibilityEnginesTotal ?? null,
    rosterSharePct: s.rosterSharePct ?? null,
    roster: s.roster ?? [],
    competitorsNamed: s.competitorsNamed ?? [],
    discoveredBrands: s.discoveredBrands ?? [],
    gapTitles: Array.isArray(s.gaps)
      ? (s.gaps as Row[]).map((g) => ({ id: g.id, lever: g.lever, severity: g.severity, title: g.title }))
      : [],
    recommendationTitles: Array.isArray(s.recommendations)
      ? (s.recommendations as Row[]).map((r) => ({ recId: r.recId, vertical: r.vertical, impact: r.impact, title: r.title }))
      : [],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  const outArg = flag("out") ?? argv.find((a) => !a.startsWith("--"));
  const onlyClient = flag("client");
  const includeReportMarkdown = argv.includes("--include-report-markdown");

  if (!outArg) {
    console.error(
      "Missing output directory.\n" +
        "  npx tsx scripts/refresh-export.ts --out=/abs/path/outside/the/repo\n" +
        "There is no default — exports carry full client strategy documents and must land in a scratchpad.",
    );
    process.exit(1);
    return;
  }

  const outDir = path.resolve(process.cwd(), outArg);
  if (outDir === ROOT || outDir.startsWith(ROOT + path.sep)) {
    console.error(
      `Refusing to export inside the repository (${outDir}).\n` +
        "Point --out at a scratchpad path outside the working tree.",
    );
    process.exit(1);
    return;
  }

  loadEnv();
  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!)) });
  const db = getFirestore();

  mkdirSync(outDir, { recursive: true });

  const clientSnap = await db.collection("clients").get();
  const clientDocs = clientSnap.docs.filter((d) => !onlyClient || d.id === onlyClient);

  if (onlyClient && clientDocs.length === 0) {
    console.error(`No client with id ${onlyClient}.`);
    process.exit(1);
    return;
  }

  console.log(`Exporting ${clientDocs.length} client(s) → ${outDir}\n`);

  const index: Row[] = [];

  for (const c of clientDocs) {
    const raw = c.data() as Row;
    const name = String(raw.name ?? c.id);

    const [docsSnap, compSnap, seoSnap, reportSnap] = await Promise.all([
      db.collection("clientContextDocs").where("clientId", "==", c.id).get(),
      db.collection("clientCompetitors").where("clientId", "==", c.id).get(),
      db.collection("clientSeoGeo").doc(c.id).get(),
      db.collection("clientReports").doc(c.id).get(),
    ]);

    const contextDocs: Row[] = docsSnap.docs
      .map((d) => {
        const v = d.data() as Row;
        return {
          id: d.id,
          docType: v.docType,
          tier: v.tier,
          version: v.version ?? null,
          contentChars: String(v.content ?? "").length,
          sectionCount: (String(v.content ?? "").match(/^## /gm) ?? []).length,
          sources: v.sources ?? null,
          summary: v.summary ?? null,
          createdAt: v.createdAt ?? null,
          updatedAt: v.updatedAt ?? null,
          updatedAtIso: iso(v.updatedAt),
          content: v.content ?? "",
        };
      })
      .sort((a, b) => `${a.docType}${a.tier}`.localeCompare(`${b.docType}${b.tier}`));

    const competitors: Row[] = compSnap.docs
      .map((d): Row => ({ id: d.id, ...(d.data() as Row) }))
      .sort((a, b) => String(a.company ?? "").localeCompare(String(b.company ?? "")));

    const seoGeo = seoSnap.exists ? (seoSnap.data() as Row) : null;
    const report = reportSnap.exists ? (reportSnap.data() as Row) : null;

    const coverage = docCoverage(contextDocs);

    const payload = {
      exportedAt: Date.now(),
      exportedAtIso: new Date().toISOString(),
      clientId: c.id,
      client: pick(raw, CLIENT_EXPORT_FIELDS),
      canonical: {
        pipelineDocTypes: PIPELINE_DOC_TYPES,
        publicDocTypes: PUBLIC_DOC_TYPES,
        internalOnlyDocTypes: INTERNAL_ONLY_DOC_TYPES,
        tiers: ["internal", "client", "internal-only"],
      },
      coverage,
      contextDocs,
      competitors,
      seoGeoSummary: seoGeoSummary(seoGeo),
      seoGeo,
      intelReport: report
        ? {
            reportDate: report.reportDate ?? null,
            overallScore: report.overallScore ?? null,
            overallGrade: report.overallGrade ?? null,
            reportStatus: report.reportStatus ?? null,
            businessType: report.businessType ?? null,
            founded: report.founded ?? null,
            updatedAt: report.updatedAt ?? null,
            updatedAtIso: iso(report.updatedAt),
            rawMarkdownChars: String(report.rawMarkdown ?? "").length,
            ...(includeReportMarkdown ? { rawMarkdown: report.rawMarkdown ?? "" } : {}),
          }
        : null,
    };

    const file = path.join(outDir, `${slugify(name)}__${c.id}.json`);
    writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");

    const colorCount = Array.isArray((raw.brandingGuidelines as Row | undefined)?.dominantColors)
      ? ((raw.brandingGuidelines as Row).dominantColors as unknown[]).length
      : 0;

    console.log(
      `  ${name} (${c.id})\n` +
        `      docs ${contextDocs.length} · missing ${coverage.missing.length} · empty ${coverage.empty.length}\n` +
        `      competitors ${competitors.length} · brand colors ${colorCount}\n` +
        `      seo/geo ${seoGeo ? (payload.seoGeoSummary?.trusted ? "trusted" : "STALE") : "none"}` +
        ` · report ${report ? report.reportDate ?? "yes" : "none"}\n` +
        `      → ${path.basename(file)}`,
    );

    index.push({
      clientId: c.id,
      name,
      website: raw.website ?? null,
      industry: raw.industry ?? null,
      file: path.basename(file),
      docCount: contextDocs.length,
      missingDocs: coverage.missing,
      emptyDocs: coverage.empty,
      competitorCount: competitors.length,
      brandColorCount: colorCount,
      seoGeoCapturedAtIso: payload.seoGeoSummary?.capturedAtIso ?? null,
      seoGeoTrusted: payload.seoGeoSummary?.trusted ?? false,
    });
  }

  const indexFile = path.join(outDir, "index.json");
  writeFileSync(
    indexFile,
    JSON.stringify({ exportedAtIso: new Date().toISOString(), clients: index }, null, 2) + "\n",
    "utf8",
  );

  console.log(`\nREAD-ONLY — nothing was written to Firestore.`);
  console.log(`Roster: ${indexFile}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
