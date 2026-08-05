/**
 * Refresh a client's SEO/GEO snapshot (`clientSeoGeo`) — the real, unmodified
 * `runSeoGeoResearch` (src/lib/intel/seo-geo.ts), called standalone instead of
 * through `runIntelReportPipeline`.
 *
 * Two modes:
 *  - Default: ANTHROPIC_API_KEY is deliberately scrubbed from this process
 *    before anything runs, so only OpenAI + Gemini are measured. The site
 *    audit (seoScore/geoReadiness), question drafting, brand discovery, and
 *    the "claude" engine column are all Sonnet/Haiku-only today and degrade
 *    to their real, honest fallback — an UNAVAILABLE cell or a 0%-coverage
 *    score, never a fabricated number (presenter.ts buildScoreViews:
 *    `value: seoMeasured ? insights.seoScore : null`) — exactly like a live
 *    deployment missing that one key.
 *  - `--with-claude`: keeps ANTHROPIC_API_KEY, so the site audit, question
 *    drafting, brand discovery and the "claude" engine column all run for
 *    real too. Same function call either way — this flag only decides
 *    whether the key reaches the process.
 *
 * This script does NOT touch the Intel Report's prose (that's
 * `runIntelReportPipeline`/`scripts/regenerate-intel-report-locally.ts`) — only
 * the `clientSeoGeo` snapshot.
 *
 *   npx tsx scripts/refresh-seo-geo-locally.ts "<client name or id>"                       # DRY RUN (default)
 *   npx tsx scripts/refresh-seo-geo-locally.ts "<client name or id>" --apply                # writes + spends (OpenAI/Gemini only)
 *   npx tsx scripts/refresh-seo-geo-locally.ts "<client name or id>" --apply --with-claude   # writes + spends (all 3 engines + site audit)
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. Read the printed plan first.
 *
 * See scripts/regenerate-intel-report-locally.ts for the `server-only`/`next/server`
 * shim rationale — identical here.
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

// Default: scrub the key regardless of what .env.local carries, so the
// no-Claude mode is "never reaches the process", not merely "unused".
// --with-claude skips this and lets the real key through.
const withClaude = process.argv.includes("--with-claude");
const hadAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
if (!withClaude) delete process.env.ANTHROPIC_API_KEY;

// This sandbox's own shell sets ANTHROPIC_BASE_URL="https://api.anthropic.com"
// (missing /v1) for its own unrelated purposes. @ai-sdk/anthropic's
// createAnthropic() reads that env var and USES IT AS-IS whenever it's
// present, instead of its correct built-in default
// ("https://api.anthropic.com/v1") — so every request silently went to
// ".../messages" instead of ".../v1/messages" and 404'd at Cloudflare's edge
// before ever reaching Anthropic's app layer. Neither this project's
// .env.local/.env nor its source sets this var — it's purely an artifact of
// the ambient process environment this script inherits. Always scrub it,
// whether or not this run uses Claude, so a real, valid key actually works.
if (process.env.ANTHROPIC_BASE_URL === "https://api.anthropic.com") {
  console.log('Ignoring a stray ANTHROPIC_BASE_URL="https://api.anthropic.com" from the ambient shell (missing /v1 — would 404 every call).');
  delete process.env.ANTHROPIC_BASE_URL;
}

const pendingDeferred: Promise<unknown>[] = [];

function installShims() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require("module");
  const originalLoad = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === "server-only") return {};
    if (request === "next/server") {
      return {
        after: (fn: () => unknown) => {
          pendingDeferred.push(Promise.resolve().then(fn));
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
}

async function flushDeferred() {
  await Promise.all(pendingDeferred.splice(0));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const query = args.find((a) => !a.startsWith("--"));

  if (!query) {
    console.error('Usage: npx tsx scripts/refresh-seo-geo-locally.ts "<client name or id>" [--apply]');
    process.exit(1);
    return;
  }

  const openaiConfigured = !!process.env.OPENAI_API_KEY;
  const geminiConfigured = !!process.env.GEMINI_API_KEY;
  const claudeConfigured = !!process.env.ANTHROPIC_API_KEY;

  if (withClaude && !hadAnthropicKey) {
    console.error("--with-claude was passed but ANTHROPIC_API_KEY is not set in .env.local — nothing to use.");
    process.exit(1);
    return;
  }
  console.log(
    withClaude
      ? "ANTHROPIC_API_KEY will be used — the site audit, question drafting, brand discovery and the claude engine all run for real."
      : hadAnthropicKey
        ? "ANTHROPIC_API_KEY was present in the environment but is IGNORED by this script on purpose (pass --with-claude to use it) — no Anthropic call will be made."
        : "ANTHROPIC_API_KEY not set — fine, this run doesn't use it.",
  );
  console.log(
    `Engines this run: chatgpt ${openaiConfigured ? "(configured)" : "(NOT configured — will read UNAVAILABLE)"}, gemini ${geminiConfigured ? "(configured)" : "(NOT configured — will read UNAVAILABLE)"}, claude ${claudeConfigured ? "(configured)" : "(UNAVAILABLE — no Anthropic key this run)"}.`,
  );
  console.log(
    withClaude
      ? "Site audit (seoScore/geoReadiness): will run for real too."
      : "Site audit (seoScore/geoReadiness): will show as not-measured — Claude-only today, and this run has no Anthropic key.",
  );

  if (!openaiConfigured && !geminiConfigured && !claudeConfigured) {
    console.error("\nNone of OPENAI_API_KEY, GEMINI_API_KEY or (with --with-claude) ANTHROPIC_API_KEY is set — there would be nothing to measure.");
    process.exit(1);
    return;
  }

  installShims();
  const { getClient, listClients } = await import("@/lib/data");

  const byId = await getClient(query);
  let clientId: string;
  let clientName: string;
  let currentlyProcessing: boolean;

  if (byId) {
    clientId = byId.id;
    clientName = byId.name;
    currentlyProcessing = !!byId.isAiProcessing;
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
      console.error("Re-run with the exact client id.");
      process.exit(1);
      return;
    }
    clientId = matches[0].id;
    clientName = matches[0].name;
    currentlyProcessing = !!matches[0].isAiProcessing;
  }

  console.log(`\nClient: ${clientName} (${clientId})`);
  console.log(withClaude ? "Will run: full SEO/GEO capture (site audit + all 3 engines)" : "Will run: SEO/GEO visibility capture (site audit + question drafting will show as not-measured — no Anthropic key this run)");
  console.log(`isAiProcessing (current): ${currentlyProcessing}`);

  if (!apply) {
    console.log("\nDRY RUN — nothing was run and no OpenAI/Gemini calls were made. Pass --apply to actually run it.");
    process.exit(0);
    return;
  }

  const { tryAcquireAiProcessingLock, releaseAiProcessingLock, listClientCompetitors, upsertClientSeoGeo } =
    await import("@/lib/data");
  const { logGenerationFailure } = await import("@/lib/actions/_shared");

  if (!(await tryAcquireAiProcessingLock(clientId))) {
    console.error("AI generation is already running for this client (isAiProcessing lock is held). Aborting.");
    process.exit(1);
    return;
  }

  let failure: string | undefined;
  try {
    console.log("\n▸ Running SEO/GEO capture (live OpenAI/Gemini calls)...");
    const { runSeoGeoResearch } = await import("@/lib/intel/seo-geo");
    const { RESEARCH_ENGINE_RULES, METRICS_RULES } = await import("@/lib/intel/brain");
    const { computeTrackedCompetitors } = await import("@/lib/competitor-priority");

    const client = await getClient(clientId);
    if (!client) throw new Error(`Client not found: ${clientId}`);
    const existingCompetitors = await listClientCompetitors(clientId);
    const trackedCompetitors = computeTrackedCompetitors(existingCompetitors);
    const rules = [RESEARCH_ENGINE_RULES, METRICS_RULES].join("\n");

    const result = await runSeoGeoResearch(client, rules, trackedCompetitors);
    await upsertClientSeoGeo(result.insights);
    await flushDeferred();

    const measuredEngines = result.insights.perEngine
      .filter((e) => e.captureTier !== "UNAVAILABLE")
      .map((e) => e.engine);
    console.log(`\n✅ SEO/GEO snapshot updated for ${clientName} (${clientId}).`);
    console.log(`   Measured engines: ${measuredEngines.length ? measuredEngines.join(", ") : "none"}`);
    console.log(
      `   SEO score coverage: ${result.insights.seoDataCoveragePct}%${withClaude ? "" : " (0% is expected — no Anthropic key this run)"}`,
    );
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    console.error("\n❌ SEO/GEO capture failed:", e);
  } finally {
    await releaseAiProcessingLock(clientId, failure);
    await logGenerationFailure(clientId, failure);
    await flushDeferred();
  }

  if (failure) process.exit(1);
}

// Only when invoked directly — importing this file must never open a Firestore
// connection, let alone write to one.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
