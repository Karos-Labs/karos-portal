/**
 * READ-ONLY: dumps all-time per-agent token/cost stats (same aggregation as
 * the Agent Leaderboard, src/lib/data-analytics.ts::getAllTimeAgentStats)
 * plus per-agent model breakdown, so a report table can be built from real
 * usageLogs data instead of guesses.
 *
 * Same env-loading + firebase-admin init pattern as scripts/check-scheduled-runs.ts.
 *
 * Usage: npx tsx scripts/dump-agent-cost-report.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    // .env.local may not exist — credentials can come from the environment.
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (raw) {
      const parsed = JSON.parse(raw);
      console.log(`>>> Firebase project: ${parsed.project_id}`);
      initializeApp({ credential: cert(parsed) });
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
      if (!projectId || !clientEmail || !privateKey) {
        throw new Error("No Firebase credentials found in .env.local");
      }
      console.log(`>>> Firebase project: ${projectId}`);
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    }
  }
  return getFirestore();
}

/** The fields this report actually reads off a usageLogs doc — everything else is ignored. */
interface UsageLogDoc {
  agentId?: string | null;
  agentName?: string;
  operation?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  status?: string;
  webSearchCount?: number;
  durationMs?: number;
  modelName?: string;
}

const AGENT_SERVICE_AGENT_ID = "agent-service";
const SEO_GEO_OPERATIONS = new Set(["seo_audit", "geo_capture", "geo_promptset"]);
const ONBOARDING_OPERATIONS = new Set([
  "intel_research", "intel_doc_generation", "intel_report",
  "doc_condense", "doc_correction", "client_brief", "doc_summary",
]);
const COPILOT_OPERATIONS = new Set(["chat_copilot", "operational_signal_extraction"]);

function slug(s: string): string {
  const cleaned = s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

function resolveAgentAttribution(input: { agentId: string | null; agentName: string; operation: string }) {
  if (input.agentId === AGENT_SERVICE_AGENT_ID) {
    return { agentKey: `agent:${slug(input.agentName)}`, agentDisplayName: input.agentName };
  }
  if (COPILOT_OPERATIONS.has(input.operation)) return { agentKey: "copilot", agentDisplayName: "Copilot" };
  if (SEO_GEO_OPERATIONS.has(input.operation)) return { agentKey: "feature:seo_geo", agentDisplayName: "SEO/GEO Agent" };
  if (ONBOARDING_OPERATIONS.has(input.operation)) return { agentKey: "feature:onboarding_pipeline", agentDisplayName: "Onboarding Pipeline" };
  return { agentKey: "other", agentDisplayName: `Other (op: ${input.operation})` };
}

async function main() {
  const db = initAdmin();

  const snap = await db.collection("usageLogs").orderBy("timestamp", "desc").limit(5000).get();
  console.log(`>>> Fetched ${snap.size} usageLogs docs (limit 5000)`);
  if (snap.size > 0) {
    const oldest = snap.docs[snap.docs.length - 1].data().timestamp;
    const newest = snap.docs[0].data().timestamp;
    console.log(`>>> Time range: ${new Date(oldest).toISOString()} -> ${new Date(newest).toISOString()}`);
  }

  type Agg = {
    agentKey: string; agentDisplayName: string;
    runs: number; inputTokens: number; outputTokens: number; costUsd: number;
    failedRuns: number; failedCostUsd: number;
    models: Map<string, { runs: number; inputTokens: number; outputTokens: number; costUsd: number }>;
    operations: Map<string, number>;
    webSearchCount: number;
    durationMsSum: number; durationCount: number;
  };
  const agg = new Map<string, Agg>();
  let grandCost = 0, grandIn = 0, grandOut = 0;

  for (const doc of snap.docs) {
    const log = doc.data() as UsageLogDoc;
    const { agentKey, agentDisplayName } = resolveAgentAttribution({
      agentId: log.agentId ?? null,
      agentName: log.agentName ?? "unknown",
      operation: log.operation ?? "unknown",
    });
    let a = agg.get(agentKey);
    if (!a) {
      a = { agentKey, agentDisplayName, runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
        failedRuns: 0, failedCostUsd: 0, models: new Map(), operations: new Map(),
        webSearchCount: 0, durationMsSum: 0, durationCount: 0 };
      agg.set(agentKey, a);
    }
    const inTok = log.inputTokens ?? 0;
    const outTok = log.outputTokens ?? 0;
    const cost = log.estimatedCostUsd ?? 0;
    a.runs += 1;
    a.inputTokens += inTok;
    a.outputTokens += outTok;
    a.costUsd += cost;
    grandCost += cost; grandIn += inTok; grandOut += outTok;
    if (log.status === "failed") { a.failedRuns += 1; a.failedCostUsd += cost; }
    if (typeof log.webSearchCount === "number") a.webSearchCount += log.webSearchCount;
    if (typeof log.durationMs === "number") { a.durationMsSum += log.durationMs; a.durationCount += 1; }

    const mk = log.modelName ?? "unknown";
    const ms = a.models.get(mk) ?? { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    ms.runs += 1; ms.inputTokens += inTok; ms.outputTokens += outTok; ms.costUsd += cost;
    a.models.set(mk, ms);

    const op = log.operation ?? "unknown";
    a.operations.set(op, (a.operations.get(op) ?? 0) + 1);
  }

  const rows = [...agg.values()].sort((x, y) => y.costUsd - x.costUsd);

  console.log(`\n=== GRAND TOTAL: ${snap.size} runs, ${grandIn.toLocaleString()} in-tok, ${grandOut.toLocaleString()} out-tok, $${grandCost.toFixed(4)} ===\n`);

  for (const r of rows) {
    const avgCost = r.runs > 0 ? r.costUsd / r.runs : 0;
    const avgIn = r.runs > 0 ? Math.round(r.inputTokens / r.runs) : 0;
    const avgOut = r.runs > 0 ? Math.round(r.outputTokens / r.runs) : 0;
    const avgDur = r.durationCount > 0 ? Math.round(r.durationMsSum / r.durationCount / 1000) : null;
    console.log(`--- ${r.agentDisplayName}  [key=${r.agentKey}] ---`);
    console.log(`  runs=${r.runs} (failed=${r.failedRuns})  cost=$${r.costUsd.toFixed(4)} (${((r.costUsd/grandCost)*100).toFixed(1)}%)  avgCost/run=$${avgCost.toFixed(4)}`);
    console.log(`  inTok=${r.inputTokens.toLocaleString()} (avg ${avgIn}/run)  outTok=${r.outputTokens.toLocaleString()} (avg ${avgOut}/run)  webSearches=${r.webSearchCount}`);
    if (avgDur != null) console.log(`  avgDurationSec=${avgDur}`);
    console.log(`  models: ${[...r.models.entries()].map(([m, s]) => `${m}(${s.runs} runs, $${s.costUsd.toFixed(4)})`).join(", ")}`);
    console.log(`  operations: ${[...r.operations.entries()].map(([o, c]) => `${o}:${c}`).join(", ")}`);
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
