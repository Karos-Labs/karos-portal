/**
 * Persist a hand-authored (or externally-generated) Intel Report markdown file
 * for one client, using the app's REAL, unmodified parser
 * (`parseMarkdownReport`/`buildClientReport` in `@/lib/report-parser`) and the
 * same persistence calls `runIntelReportPipeline` makes
 * (`replaceReportCompetitors` + `upsertClientReport`).
 *
 * This exists for the case where the report's CONTENT was produced without
 * calling the app's own Claude integration — e.g. authored directly in a
 * Claude Code session instead of via ANTHROPIC_API_KEY — but should still land
 * in Firestore in exactly the shape the real pipeline produces. The markdown
 * MUST follow the exact heading structure `DEFAULT_INTEL_PROMPT` requires
 * (src/lib/intel/brain.ts) — the parser matches on those headings verbatim.
 *
 * Does NOT touch: SEO/GEO (see refresh-seo-geo-locally.ts), the context-doc
 * pipeline (runOnboardPipeline — 8 additional documents, out of scope here),
 * or branding (applyBrandingForClient). Only the ClientReport + its
 * report-sourced competitors.
 *
 *   npx tsx scripts/persist-intel-report-locally.ts "<client name or id>" <path-to-markdown>              # DRY RUN (default)
 *   npx tsx scripts/persist-intel-report-locally.ts "<client name or id>" <path-to-markdown> --apply        # writes
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE — it parses the file and prints exactly
 * what would be written (score, grade, section lengths, competitor count) so
 * a malformed heading can be caught before anything touches Firestore.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnvFile(path: string) {
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env.local may not exist in CI — that's fine
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

function installShims() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require("module");
  const originalLoad = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === "server-only") return {};
    if (request === "next/server") return { after: (fn: () => unknown) => fn() };
    return originalLoad.call(this, request, ...rest);
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [query, mdPath] = positional;

  if (!query || !mdPath) {
    console.error('Usage: npx tsx scripts/persist-intel-report-locally.ts "<client name or id>" <path-to-markdown> [--apply]');
    process.exit(1);
    return;
  }

  const rawMarkdown = readFileSync(resolve(mdPath), "utf-8");

  installShims();
  const { getClient, listClients } = await import("@/lib/data");
  const { parseMarkdownReport, buildClientReport } = await import("@/lib/report-parser");

  const byId = await getClient(query);
  let clientId: string;
  let clientName: string;

  if (byId) {
    clientId = byId.id;
    clientName = byId.name;
  } else {
    const all = await listClients();
    const matches = all.filter((c) => c.name?.toLowerCase().includes(query.toLowerCase()));
    if (matches.length === 0) {
      console.error(`No client found matching "${query}"`);
      process.exit(1);
      return;
    }
    if (matches.length > 1) {
      console.error(`Multiple clients match "${query}": ${matches.map((c) => `${c.name} (${c.id})`).join(", ")}`);
      process.exit(1);
      return;
    }
    clientId = matches[0].id;
    clientName = matches[0].name;
  }

  const parsed = parseMarkdownReport(rawMarkdown);
  const report = buildClientReport(clientId, parsed, rawMarkdown);

  console.log(`Client: ${clientName} (${clientId})`);
  console.log(`Markdown file: ${resolve(mdPath)} (${rawMarkdown.length} chars)`);
  console.log(`Parsed overall score: ${parsed.overallScore}/100 (${parsed.overallGrade})`);
  console.log(`Competitor rows parsed: ${parsed.competitorRows.length}`);
  console.log(
    `Section lengths: content=${parsed.contentAnalysis.length} conversion=${parsed.conversionAnalysis.length} seo=${parsed.seoAnalysis.length} geo=${parsed.geoAnalysis.length} positioning=${parsed.positioningAnalysis.length} brand=${parsed.brandAnalysis.length} growth=${parsed.growthAnalysis.length}`,
  );
  console.log(
    `SWOT: strengths=${parsed.swot.strengths.length} weaknesses=${parsed.swot.weaknesses.length} opportunities=${parsed.swot.opportunities.length} threats=${parsed.swot.threats.length}`,
  );
  console.log(`Recommendations parsed: ${parsed.recommendations.length}`);
  console.log(`Brand voice rows: ${parsed.brandVoiceRows.length}, archetypes: ${parsed.brandVoiceArchetypes.length}`);

  if (!apply) {
    console.log("\nDRY RUN — nothing was written. Pass --apply to write.");
    process.exit(0);
    return;
  }

  const { tryAcquireAiProcessingLock, releaseAiProcessingLock, replaceReportCompetitors, upsertClientReport } =
    await import("@/lib/data");
  const { logGenerationFailure } = await import("@/lib/actions/_shared");

  if (!(await tryAcquireAiProcessingLock(clientId))) {
    console.error("AI generation is already running for this client (isAiProcessing lock is held). Aborting.");
    process.exit(1);
    return;
  }

  let failure: string | undefined;
  try {
    const now = Date.now();
    await replaceReportCompetitors(
      clientId,
      parsed.competitorRows.map((row) => ({
        clientId,
        ...row,
        source: "report" as const,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await upsertClientReport(report);
    console.log(`\n✅ Intel Report written for ${clientName} (${clientId}).`);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    console.error("\n❌ Persisting the report failed:", e);
  } finally {
    await releaseAiProcessingLock(clientId, failure);
    await logGenerationFailure(clientId, failure);
  }

  if (failure) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
