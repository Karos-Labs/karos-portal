/**
 * Manually re-run the Intel Report + SEO/GEO pipeline for one client, from a
 * local machine — exactly what `generateIntelReportAction` ("Regenerate"
 * button, admin-only) does, called directly instead of through the admin
 * UI/session cookie, so it can be scripted and re-run without a browser.
 *
 * Deliberately does NOT touch the Task Map swarm ("Refresh Task Map" is a
 * separate action/button, `buildSwarmContext` + `runSwarmToCompletion` in
 * `@/lib/agent-swarm` — out of scope here).
 *
 * SEO/GEO is already included, not a separate step: `runIntelReportPipeline`
 * calls `runOnboardPipeline` (pipeline.ts), which runs `runSeoGeoResearch` and
 * persists it via `upsertClientSeoGeo` (pipeline.ts ~L830/L870) alongside the
 * report and context docs.
 *
 * NOT A MOCK. It makes REAL Claude API calls billed to ANTHROPIC_API_KEY (no
 * mock/dry-run mode exists for this pipeline — see seo-geo-providers.ts /
 * seo-geo.ts: "ANTHROPIC_API_KEY is required platform-wide") and WRITES the
 * real Intel Report + SEO/GEO snapshot for the resolved client, against
 * whatever Firestore project .env.local points at (production, unless
 * FIREBASE_* is overridden).
 *
 *   npx tsx scripts/regenerate-intel-report-locally.ts "<client name or id>"                # DRY RUN (default)
 *   npx tsx scripts/regenerate-intel-report-locally.ts "<client name or id>" --apply         # writes + spends
 *   --context "..."   run-specific directive threaded into the Intel Report prompt (Layer C)
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. Read the printed plan first.
 *
 * ── THE TWO SHIMS BELOW, AND WHY THEY ARE SAFE ───────────────────────────────
 * The library code this script calls (`@/lib/data`, `@/lib/intel/report`) is
 * marked `import "server-only"`, which assumes a live Next.js request. It does
 * not actually need one: `server-only` is a marker package that THROWS when
 * required directly in plain Node (node_modules/server-only/index.js) — its
 * only job is to stop a *client* bundle from pulling in server code; a bare
 * Node process was never its target, so no-op'ing it changes no behavior.
 * (The `next/server` `after()` shim is kept even though this script's own call
 * graph doesn't currently hit it, in case that changes — harmless either way.)
 * Verified against this repo's actual modules before relying on it — see the
 * chat transcript that produced this script.
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

  const contextIdx = args.indexOf("--context");
  const runSpecificContext = contextIdx !== -1 ? args[contextIdx + 1] : undefined;

  const consumedFlagValues = new Set(contextIdx !== -1 ? [contextIdx + 1] : []);
  const query = args.find((a, i) => !a.startsWith("--") && !consumedFlagValues.has(i));

  if (!query) {
    console.error(
      'Usage: npx tsx scripts/regenerate-intel-report-locally.ts "<client name or id>" [--apply] [--context "..."]',
    );
    process.exit(1);
    return;
  }

  // Everything below goes through @/lib/data so its Firestore singleton is the
  // FIRST thing to touch Firestore (it calls .settings() once, before any
  // read) — a raw firebase-admin call here first would make that throw.
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

  console.log(`Client: ${clientName} (${clientId})`);
  console.log("Will run: Intel Report + SEO/GEO (same as the Regenerate button)");
  if (runSpecificContext) console.log(`Run-specific context: "${runSpecificContext}"`);
  console.log(`isAiProcessing (current): ${currentlyProcessing}`);

  if (!apply) {
    console.log("\nDRY RUN — nothing was run and no Anthropic calls were made. Pass --apply to actually run it.");
    process.exit(0);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "\nANTHROPIC_API_KEY is not set. This pipeline calls Claude live (the report itself and the SEO/GEO " +
        "Claude column both require it) and has no mock mode. Set a real key from console.anthropic.com in " +
        ".env.local — a claude.ai Pro/Max login or a Claude Code session authenticates to a different " +
        "product (consumer chat / Code usage) and carries no API credits, so it cannot substitute for this.",
    );
    process.exit(1);
    return;
  }

  // This sandbox's own shell sets ANTHROPIC_BASE_URL="https://api.anthropic.com"
  // (missing /v1) for its own unrelated purposes. @ai-sdk/anthropic reads that
  // env var and uses it AS-IS whenever present, instead of its correct
  // built-in default ("https://api.anthropic.com/v1") — so every call would
  // silently hit ".../messages" instead of ".../v1/messages" and 404 at
  // Cloudflare's edge. Neither this project's .env.local/.env nor its source
  // sets this var — always scrub it so a real key actually authenticates.
  if (process.env.ANTHROPIC_BASE_URL === "https://api.anthropic.com") {
    console.log('Ignoring a stray ANTHROPIC_BASE_URL="https://api.anthropic.com" from the ambient shell (missing /v1 — would 404 every call).');
    delete process.env.ANTHROPIC_BASE_URL;
  }

  const { tryAcquireAiProcessingLock, releaseAiProcessingLock, updateClient } = await import("@/lib/data");
  const { logGenerationFailure } = await import("@/lib/actions/_shared");

  if (!(await tryAcquireAiProcessingLock(clientId))) {
    console.error("AI generation is already running for this client (isAiProcessing lock is held). Aborting.");
    process.exit(1);
    return;
  }

  let failure: string | undefined;
  try {
    console.log("\n▸ Running Intel Report + SEO/GEO pipeline (live Claude calls)...");
    const { runIntelReportPipeline } = await import("@/lib/intel/report");
    await runIntelReportPipeline(clientId, runSpecificContext);
    await updateClient(clientId, { lastIntelReportAt: Date.now() });
    await flushDeferred();

    console.log(`\n✅ Intel Report + SEO/GEO regenerated for ${clientName} (${clientId}).`);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    console.error("\n❌ Pipeline failed:", e);
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
