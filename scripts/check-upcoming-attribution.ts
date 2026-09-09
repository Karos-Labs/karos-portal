/**
 * ROUND 6 OPS PRE-CHECK: WHO FLIPS TO "LIVE", AND WHOSE UPCOMING POSTS BELONG
 * TO NO GRANTED AGENT.
 *
 * Round 6 made the agent roster's "upcoming content" predicate count drafts
 * (`isUpcomingCalendarItem` in `src/lib/agent-detail-archetypes.ts` now asks
 * `isUpcomingPost`, plus the launch/test exclusions and a 14-day ceiling). Every
 * client with imported, chained future drafts therefore turns "Live" for that
 * agent the moment the change ships. The risk review (docs/portal-round6/
 * risk-review.md §F) and think-agents §0 ask for one query against real data
 * BEFORE that lands on prep, for two reasons:
 *
 *   1. FLIPS. Which client/agent pairs change status word, so nobody is surprised.
 *   2. ORPHANS. Attribution is strict slug equality (F147): a client whose card is
 *      the combined `karos-instagram-tiktok-content-agent` but whose posts were
 *      imported from the plain `instagram-agent` lab folder attributes NOTHING
 *      to that card, so the card keeps reading "Not set up yet" while the posts
 *      sit in the Workspace. This prints every upcoming post that no candidate
 *      agent claims, with the folder it came from.
 *
 * READ-ONLY. Nothing here writes, deletes or updates a document; it prints a
 * report. It does NOT opt into `allowDefaultProduction`, so production has to be
 * said out loud (scripts/lib/firestore-db.ts). It calls the roster's OWN
 * functions (`buildAgentAssetIndex`, `agentsWithUpcomingContent`,
 * `groupAssetsByAgent`) rather than a hand copy of the rungs, which is the whole
 * point: what it prints is what the roster will say.
 *
 * `agent-detail-archetypes.ts` imports the `server-only` marker, which throws
 * under plain `tsx`; run with Node's `react-server` condition, under which that
 * package resolves to a no-op:
 *
 *   NODE_OPTIONS=--conditions=react-server FIRESTORE_DATABASE_ID=prep \
 *     npx tsx scripts/check-upcoming-attribution.ts
 *   NODE_OPTIONS=--conditions=react-server FIRESTORE_DATABASE_ID="(default)" \
 *     npx tsx scripts/check-upcoming-attribution.ts [client-name-substring]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path: string) {
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    // fine — env may come from the shell
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, cert, getApps, applicationDefault, type App } from "firebase-admin/app";
import { getScriptFirestore, resolveScriptDatabaseId } from "./lib/firestore-db";
import {
  agentsWithUpcomingContent,
  buildAgentAssetIndex,
  groupAssetsByAgent,
  UPCOMING_WINDOW_DAYS,
} from "../src/lib/agent-detail-archetypes";
import { agentKeyMatchesClientSlug, isUnlistedAgent } from "../src/lib/custom-agent-launch";
import { isLaunchDeliverable, isTestRunAsset } from "../src/lib/asset-visibility";
import { postKind } from "../src/lib/calendar-kind";
import type { Asset, Client, ClientAgent, CustomAgent, Job } from "../src/lib/types";

const CLIENT_NEEDLE = (process.argv[2] ?? "").toLowerCase();

function initAdmin(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) return initializeApp({ credential: cert(JSON.parse(raw)) });
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("Set FIREBASE_SERVICE_ACCOUNT_KEY or FIREBASE_PROJECT_ID.");
  return initializeApp({ credential: applicationDefault(), projectId });
}

const iso = (ms: number | undefined) =>
  typeof ms === "number" ? new Date(ms).toISOString().slice(0, 10) : "—";

/** The same normalisation `attributionSlug` applies, for the hint column only. */
function slug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value
    .toLowerCase()
    .replace(/[-_\s]+/g, "-")
    .replace(/^karos-/, "")
    .replace(/^-+|-+$/g, "");
  return s || null;
}

/**
 * What the PRE-round-6 predicate admitted: a future `scheduled` or `placeholder`
 * chip, drafts refused, no ceiling. Kept here only to name the flips; the live
 * rule is the one inside `buildAgentAssetIndex`.
 */
function wasUpcomingBefore(asset: Asset, now: number): boolean {
  if (isLaunchDeliverable(asset) || isTestRunAsset(asset)) return false;
  if ((asset.scheduledAt ?? 0) <= now) return false;
  const kind = postKind(asset);
  return kind === "scheduled" || kind === "placeholder";
}

type WithId<T> = T & { id: string };
const withId = <T,>(d: FirebaseFirestore.QueryDocumentSnapshot): WithId<T> =>
  ({ id: d.id, ...(d.data() as T) }) as WithId<T>;

async function main() {
  const dbId = resolveScriptDatabaseId();
  const db = getScriptFirestore(initAdmin());
  const now = Date.now();
  console.log(`database: ${dbId}   now: ${new Date(now).toISOString()}   window: ${UPCOMING_WINDOW_DAYS} days\n`);

  const allAgents = (await db.collection("customAgents").get()).docs.map((d) => withId<CustomAgent>(d));
  const agentById = new Map(allAgents.map((a) => [a.id, a]));
  const clientsSnap = await db.collection("clients").get();
  const clients = clientsSnap.docs
    .map((d) => withId<Client>(d))
    .filter((c) => !CLIENT_NEEDLE || String(c.name ?? "").toLowerCase().includes(CLIENT_NEEDLE))
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

  let quiet = 0;
  const flipsSummary: string[] = [];
  const orphanSummary: string[] = [];

  for (const client of clients) {
    const [assetsSnap, jobsSnap, umbrellasSnap] = await Promise.all([
      db.collection("assets").where("clientId", "==", client.id).get(),
      db.collection("jobs").where("clientId", "==", client.id).get(),
      db.collection("clientAgents").where("clientId", "==", client.id).get(),
    ]);
    const assets = assetsSnap.docs.map((d) => withId<Asset>(d));
    const jobs = jobsSnap.docs.map((d) => withId<Job>(d));
    const umbrellas = umbrellasSnap.docs.map((d) => withId<ClientAgent>(d));

    // Exactly the roster's candidate set (src/lib/client-roster.ts).
    const candidateAgents = allAgents.filter(
      (agent) =>
        agent.enabled &&
        !isUnlistedAgent(agent) &&
        agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug),
    );
    const granted = new Set(client.customAgentIds ?? []);

    const index = buildAgentAssetIndex({ assets, jobs, viewerIsClient: true, now });
    const upcoming = index.upcoming;
    if (upcoming.length === 0) {
      quiet += 1;
      continue;
    }

    const producingNow = agentsWithUpcomingContent({
      assets,
      jobs,
      agents: candidateAgents,
      umbrellas,
      clientSlug: client.agentsRepoSlug,
      now,
      index,
    });
    const upcomingBefore = assets.filter((a) => wasUpcomingBefore(a, now));
    const producingBefore = agentsWithUpcomingContent({
      assets,
      jobs,
      agents: candidateAgents,
      umbrellas,
      clientSlug: client.agentsRepoSlug,
      now,
      index: { jobById: index.jobById, upcoming: upcomingBefore },
    });

    const grouped = groupAssetsByAgent({
      assets: upcoming,
      jobById: index.jobById,
      agents: candidateAgents,
      umbrellas,
    });
    const claimed = new Set<string>();
    for (const list of grouped.values()) for (const a of list) claimed.add(a.id);
    const orphans = upcoming.filter((a) => !claimed.has(a.id));

    console.log(`── ${client.name} (${client.id})  slug=${client.agentsRepoSlug ?? "—"} ──`);
    console.log(
      `  assets ${assets.length} · upcoming now ${upcoming.length} (before: ${upcomingBefore.length}) · candidates ${candidateAgents.length} · granted ${granted.size}`,
    );

    const byStatus = new Map<string, number>();
    for (const a of upcoming) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
    console.log(`  upcoming by status: ${[...byStatus].map(([s, n]) => `${s}=${n}`).join(" ")}`);

    for (const agent of candidateAgents) {
      const nowLive = producingNow.has(agent.id);
      const wasLive = producingBefore.has(agent.id);
      if (!nowLive && !wasLive) continue;
      const n = grouped.get(agent.id)?.length ?? 0;
      const flip = nowLive && !wasLive ? "FLIPS → Live" : nowLive ? "Live (unchanged)" : "drops";
      const grant = granted.has(agent.id) ? "granted" : "not granted (staff sees, client only if delivered)";
      console.log(`  ${flip.padEnd(18)} ${agent.key}  ${n} upcoming  [${grant}]`);
      if (nowLive && !wasLive) flipsSummary.push(`${client.name}: ${agent.key}${granted.has(agent.id) ? "" : " (not granted)"}`);
    }

    if (orphans.length > 0) {
      const folders = new Map<string, number>();
      let withJob = 0;
      for (const a of orphans) {
        const folder = typeof a.meta?.["agentFolder"] === "string" ? String(a.meta["agentFolder"]) : "(no folder)";
        folders.set(folder, (folders.get(folder) ?? 0) + 1);
        if (a.jobId) withJob += 1;
      }
      console.log(`  ORPHANS ${orphans.length}: upcoming posts no candidate agent claims (${withJob} with a job, ${orphans.length - withJob} lab imports)`);
      for (const [folder, n] of folders) {
        const fs = slug(folder);
        const near = candidateAgents
          .filter((ag) => {
            const ks = slug(ag.key);
            return fs && ks && fs !== ks && (ks.includes(fs) || fs.includes(ks));
          })
          .map((ag) => `${ag.key}${granted.has(ag.id) ? " [granted]" : ""}`);
        console.log(
          `    folder ${folder}: ${n}  first ${iso(Math.min(...orphans.filter((a) => (a.meta?.["agentFolder"] ?? "(no folder)") === folder).map((a) => a.scheduledAt ?? 0)))}` +
            (near.length ? `  ← would only unify by looser matching with: ${near.join(", ")}` : "  (no similarly named candidate)"),
        );
      }
      const grantedKeys = [...granted].map((id) => agentById.get(id)?.key ?? id).join(", ") || "(none)";
      console.log(`    granted agents: ${grantedKeys}`);
      orphanSummary.push(`${client.name}: ${orphans.length} (${[...folders.keys()].join(", ")})`);
    }
    console.log();
  }

  console.log("════════ summary ════════");
  console.log(`clients scanned: ${clients.length}   nothing upcoming: ${quiet}`);
  console.log(`status flips to Live (${flipsSummary.length}):`);
  for (const line of flipsSummary) console.log(`  ${line}`);
  if (flipsSummary.length === 0) console.log("  none");
  console.log(`clients with unclaimed upcoming posts (${orphanSummary.length}):`);
  for (const line of orphanSummary) console.log(`  ${line}`);
  if (orphanSummary.length === 0) console.log("  none");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
