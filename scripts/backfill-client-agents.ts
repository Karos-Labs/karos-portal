/**
 * Phase 3 §9 — backfill the `clientAgents` umbrellas for existing clients.
 *
 * Every Phase 3 client surface hangs off an umbrella doc: templates, the slot
 * plan, the week strip, two-level feedback, the daily options picker. No client
 * predating Phase 3 has one, so all of it is dark fleet-wide and the detail page
 * falls back to its legacy panel (CD-H8). This script creates the umbrellas from
 * what is already true in Firestore — it invents nothing.
 *
 *   npx tsx scripts/backfill-client-agents.ts                      # plan only
 *   npx tsx scripts/backfill-client-agents.ts --client=<id>        # one client
 *   npx tsx scripts/backfill-client-agents.ts --client=<id> --apply
 *   npx tsx scripts/backfill-client-agents.ts --client=<id> --apply --stamp-jobs
 *   npx tsx scripts/backfill-client-agents.ts --client=<id> --apply --delete
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed plan, confirm every umbrella and every
 * seeded template is what you expect for that client, then re-run with --apply.
 *
 * IT REUSES THE PRODUCTION LOGIC, it does not restate it. Identity mapping,
 * template derivation, chain families, day-key bucketing and the deterministic
 * doc ids are all imported from the same pure modules the portal renders from
 * (`tsx` resolves the `@/` alias via tsconfig paths). A backfill that decided
 * "which template is this asset" differently from the app would produce a
 * registry the app then disagreed with — the one failure mode that would be
 * worse than not running at all.
 *
 * WHAT IT NEVER TOUCHES: assets, schedules' cadence/zone/status, jobs (except
 * the opt-in `--stamp-jobs` pass, which writes ONE grouping field), and any
 * umbrella that already exists. It re-dates nothing — §9 step 4 is explicit
 * that slots are fitted to the dates assets already have.
 *
 * CONSERVATIVE CHOICES where §9 is silent, all reversible:
 *  · An umbrella whose doc already exists is SKIPPED WHOLE — not topped up with
 *    missing templates or slots. A doc that exists has been curated or edited by
 *    someone, and a backfill that half-merges into it would be unexplainable.
 *    Re-running after --delete is the supported way to redo one.
 *  · `platform` is the FIRST platform the identity maps to, which is what every
 *    mark in the UI already renders for that agent.
 *  · Templates are seeded ACTIVE. A registry of paused templates would generate
 *    no slots and read to the client as an agent that does nothing.
 *  · Rotation is the seeded template keys in first-seen chain order (§9 step 2).
 *  · Slots are derived only for FUTURE-dated assets, and only when the umbrella
 *    is being created live — a not_launched umbrella has no plan yet by
 *    definition.
 *  · Assets whose template cannot be derived are reported as anomalies and left
 *    alone. Guessing a stream for them would put an invented name on a client's
 *    real post.
 */
import path from "node:path";
import { readFileSync } from "node:fs";

import { socialPlatformsFor } from "@/components/agent-identity";
import {
  agentSlotDocId,
  clientAgentDocId,
  dateKeyInZone,
} from "@/lib/client-agents";
import {
  chainFamilyFor,
  deriveOrderKey,
  isReferenceDocAsset,
  templateForAsset,
} from "@/lib/post-chain";
import { isXAgentIdentity } from "@/lib/custom-agent-launch";
import type {
  Asset,
  ClientAgentTemplate,
  CustomAgent,
  Job,
  PlannedScheduledRun,
} from "@/lib/types";

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

/** Job statuses that prove an agent has actually delivered for this client. */
const SUCCESSFUL = new Set(["review", "approved", "delivered"]);

interface PlannedTemplate {
  key: string;
  name: string;
  firstSeen: string;
}

interface PlannedSlot {
  docId: string;
  dateKey: string;
  templateKey: string;
  assetId: string;
}

export interface PlannedUmbrella {
  docId: string;
  agentKey: string;
  agentName: string;
  customAgentId: string;
  platform: string;
  chainFamily: ReturnType<typeof chainFamilyFor>;
  optionsMode: boolean;
  launchState: "live" | "not_launched";
  liveBecause: string;
  templates: PlannedTemplate[];
  slots: PlannedSlot[];
  scheduleRunId: string | null;
  /** Set when a doc already exists — the whole umbrella is then skipped. */
  existing?: string;
}

export interface ClientPlan {
  clientId: string;
  clientName: string;
  umbrellas: PlannedUmbrella[];
  anomalies: string[];
  jobStamps: number;
}

/* ────────────────────────────── planning ────────────────────────────────── */

/**
 * The whole decision, as a pure function of what Firestore already holds.
 *
 * Exported so it can be unit-tested against fixtures: this is the part that
 * decides what gets written to production, and it must be checkable without a
 * database. The caller does the reads and the writes; this decides nothing else.
 */
export function planClient(input: {
  clientId: string;
  clientName: string;
  grantedAgentIds: string[];
  agents: Map<string, CustomAgent>;
  assets: Asset[];
  jobs: Job[];
  schedules: PlannedScheduledRun[];
  existingUmbrellaIds: Set<string>;
  now: number;
}): ClientPlan {
  const { clientId, clientName, agents, assets, jobs, schedules, now } = input;
  const plan: ClientPlan = { clientId, clientName, umbrellas: [], anomalies: [], jobStamps: 0 };

  // §9 step 1: the grant union the agents page itself computes — explicitly
  // granted, PLUS any agent that has already delivered successfully here.
  const granted = new Set(input.grantedAgentIds);
  const agentIdByName = new Map([...agents.values()].map((a) => [a.name, a.id]));
  for (const job of jobs) {
    if (job.external?.taskType !== "custom" || !SUCCESSFUL.has(job.status)) continue;
    const id = job.customAgentId ?? agentIdByName.get(job.agentName);
    if (id) granted.add(id);
  }

  for (const agentId of [...granted].sort()) {
    const agent = agents.get(agentId);
    if (!agent || agent.enabled === false) continue;

    // §9 step 1: only agents whose identity maps to a content platform get an
    // umbrella. An SEO or research agent produces no calendar content, so a
    // plan, a template registry and a week strip would all be empty theatre.
    const identity = `${agent.key} ${agent.name}`;
    const platforms = socialPlatformsFor(identity);
    if (platforms.length === 0) continue;

    const docId = clientAgentDocId(clientId, agent.key);
    const optionsMode = isXAgentIdentity(agent.key);

    // §9 step 5: the X umbrella carries no chainFamily — options slots never
    // re-date chain assets, they present choices.
    const chainFamily = optionsMode ? null : chainFamilyFor("social_post");

    const agentJobs = jobs.filter(
      (j) => j.customAgentId === agent.id || (!j.customAgentId && j.agentName === agent.name),
    );
    const hasSuccessfulRun = agentJobs.some((j) => SUCCESSFUL.has(j.status));

    // Assets attributable to this agent: its own jobs first, then — for agents
    // that predate job linkage entirely — the client's assets in its family.
    const jobIds = new Set(agentJobs.map((j) => j.id));
    const familyAssets = assets.filter((a) => {
      if (a.jobId && jobIds.has(a.jobId)) return true;
      if (optionsMode || !chainFamily) return false;
      return chainFamilyFor(a.type) === chainFamily && !isReferenceDocAsset(a);
    });

    const schedule =
      schedules.find(
        (s) =>
          s.customAgentId === agent.id && s.cadence === "weekly" && s.status !== "completed",
      ) ?? null;

    // §9 step 1: grandfathered live when it has demonstrably produced.
    const live = hasSuccessfulRun || familyAssets.length > 0;
    const liveBecause = hasSuccessfulRun
      ? `${agentJobs.filter((j) => SUCCESSFUL.has(j.status)).length} successful run(s)`
      : familyAssets.length > 0
        ? `${familyAssets.length} existing asset(s)`
        : "never produced";

    const umbrella: PlannedUmbrella = {
      docId,
      agentKey: agent.key,
      agentName: agent.name,
      customAgentId: agent.id,
      platform: platforms[0],
      chainFamily,
      optionsMode,
      launchState: live ? "live" : "not_launched",
      liveBecause,
      templates: [],
      slots: [],
      scheduleRunId: schedule?.id ?? null,
    };

    if (input.existingUmbrellaIds.has(docId)) {
      umbrella.existing = "already has an umbrella";
      plan.umbrellas.push(umbrella);
      continue;
    }

    // §9 step 2 — template seeding. Skipped entirely for options mode (§9 step
    // 5: the daily-pick product has no template streams).
    if (!optionsMode) {
      const seen = new Map<string, PlannedTemplate>();
      const ordered = [...familyAssets].sort((a, b) =>
        deriveOrderKey(a).localeCompare(deriveOrderKey(b)),
      );
      for (const asset of ordered) {
        const template = templateForAsset(asset);
        if (!template) {
          plan.anomalies.push(
            `${agent.name}: asset ${asset.id} ("${(asset.title ?? "untitled").slice(0, 40)}") has no derivable template — left untouched`,
          );
          continue;
        }
        if (!seen.has(template.key)) {
          seen.set(template.key, {
            key: template.key,
            name: template.name,
            firstSeen: asset.id,
          });
        }
      }
      umbrella.templates = [...seen.values()];
    }

    // §9 step 4 — slot derivation with ZERO movement. Only future-dated assets,
    // each keeping the day it already has, bucketed in the schedule's zone when
    // it has one (the F108 contract) and the runtime zone otherwise, exactly as
    // the asset was bucketed before.
    if (live && !optionsMode) {
      const zone = schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const todayKey = dateKeyInZone(now, zone);
      const byDay = new Map<string, PlannedSlot>();
      for (const asset of familyAssets) {
        const at = asset.scheduledAt;
        if (at == null) continue;
        const dateKey = dateKeyInZone(at, zone);
        if (dateKey <= todayKey) continue;
        const template = templateForAsset(asset);
        if (!template) continue;
        // One slot per day per umbrella — the chain's own invariant. If two
        // assets somehow share a day, the earlier in chain order wins and the
        // other is reported rather than silently dropped.
        if (byDay.has(dateKey)) {
          plan.anomalies.push(
            `${agent.name}: ${dateKey} has more than one future asset — slot kept for ${byDay.get(dateKey)!.assetId}, ${asset.id} left unlinked`,
          );
          continue;
        }
        byDay.set(dateKey, {
          docId: agentSlotDocId(docId, dateKey),
          dateKey,
          templateKey: template.key,
          assetId: asset.id,
        });
      }
      umbrella.slots = [...byDay.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    }

    plan.umbrellas.push(umbrella);
  }

  // §9 step 6 — optional grouping stamp only. Never a runType: heuristic
  // launch-detection on legacy jobs is unreliable, and analytics already has an
  // honest "before run-type tracking" bucket for them.
  const byCustomAgent = new Map(
    plan.umbrellas.filter((u) => !u.existing).map((u) => [u.customAgentId, u.docId]),
  );
  plan.jobStamps = jobs.filter(
    (j) => j.customAgentId && byCustomAgent.has(j.customAgentId) && !j.clientAgentId,
  ).length;

  return plan;
}

/* ────────────────────────────── reporting ───────────────────────────────── */

/** Exported alongside planClient so the printed plan can be exercised too. */
export function printPlan(plan: ClientPlan, stampJobs: boolean) {
  console.log(`\n═══ ${plan.clientName} (${plan.clientId}) ═══\n`);

  if (plan.umbrellas.length === 0) {
    console.log("  (no platform agents granted — nothing to back-fill)");
    return;
  }

  console.log("UMBRELLAS");
  for (const u of plan.umbrellas) {
    if (u.existing) {
      console.log(`  skip    ${u.agentName} — ${u.existing} (${u.docId})`);
      continue;
    }
    const mode = u.optionsMode ? "options" : "single";
    console.log(`  CREATE  ${u.agentName}  [${u.platform} · ${mode}]`);
    console.log(`          id ${u.docId}`);
    console.log(`          state ${u.launchState} — ${u.liveBecause}`);
    console.log(
      `          schedule ${u.scheduleRunId ? `link ${u.scheduleRunId}` : "none found — stays unlinked"}`,
    );
    if (u.optionsMode) {
      console.log("          templates: none (daily-pick product has no streams)");
    } else if (u.templates.length === 0) {
      console.log("          templates: NONE DERIVABLE — flagged for staff curation");
    } else {
      console.log(`          templates (${u.templates.length}):`);
      for (const t of u.templates) console.log(`            · ${t.name}  [${t.key}]`);
    }
    if (u.slots.length > 0) {
      console.log(`          slots (${u.slots.length}, no asset re-dated):`);
      for (const s of u.slots) console.log(`            · ${s.dateKey}  ${s.templateKey}  ${s.assetId}`);
    } else if (!u.optionsMode) {
      console.log("          slots: none (no future-dated assets)");
    } else {
      console.log("          slots: none — options generate forward-only after go-live");
    }
  }

  if (stampJobs) {
    console.log(`\nJOB STAMPS\n  ${plan.jobStamps} job(s) would get clientAgentId (grouping only)`);
  }

  if (plan.anomalies.length > 0) {
    console.log(`\nANOMALIES (${plan.anomalies.length}) — nothing written, read them:`);
    for (const a of plan.anomalies) console.log(`  ! ${a}`);
  }
}

/* ─────────────────────────────── writing ────────────────────────────────── */

async function applyPlan(
  db: FirebaseFirestore.Firestore,
  plan: ClientPlan,
  stampJobs: boolean,
  now: number,
): Promise<{ umbrellas: number; slots: number; schedules: number; jobs: number }> {
  let umbrellas = 0;
  let slots = 0;
  let schedules = 0;
  let jobs = 0;

  for (const u of plan.umbrellas) {
    if (u.existing) continue;

    const templates: ClientAgentTemplate[] = u.templates.map((t, i) => ({
      key: t.key,
      name: t.name,
      status: "active",
      position: i,
      source: "backfill",
      addedAt: now,
    }));

    await db
      .collection("clientAgents")
      .doc(u.docId)
      .create({
        clientId: plan.clientId,
        agentKey: u.agentKey,
        customAgentId: u.customAgentId,
        displayName: u.agentName,
        platform: u.platform,
        ...(u.chainFamily ? { chainFamily: u.chainFamily } : {}),
        slotMode: u.optionsMode ? "options" : "single",
        launchState: u.launchState,
        launchJobId: null,
        templates,
        rotation: templates.map((t) => t.key),
        ...(u.scheduleRunId ? { scheduleRunId: u.scheduleRunId } : {}),
        createdBy: "backfill",
        createdAt: now,
        updatedAt: now,
      });
    umbrellas++;

    // §9 step 3 — link both directions. The schedule stays the single clock;
    // the umbrella just learns which clock is its own. No cadence/zone change.
    if (u.scheduleRunId) {
      await db
        .collection("plannedScheduledRuns")
        .doc(u.scheduleRunId)
        .update({ clientAgentId: u.docId, updatedAt: now });
      schedules++;
    }

    for (const s of u.slots) {
      await db
        .collection("agentSlots")
        .doc(s.docId)
        .create({
          clientId: plan.clientId,
          clientAgentId: u.docId,
          dateKey: s.dateKey,
          kind: "single",
          templateKey: s.templateKey,
          status: "planned",
          assetId: s.assetId,
          createdBy: "backfill",
          createdAt: now,
          updatedAt: now,
        });
      slots++;
    }
  }

  if (stampJobs) {
    const byCustomAgent = new Map(
      plan.umbrellas.filter((u) => !u.existing).map((u) => [u.customAgentId, u.docId]),
    );
    const snap = await db.collection("jobs").where("clientId", "==", plan.clientId).get();
    for (const doc of snap.docs) {
      const job = doc.data() as Job;
      const target = job.customAgentId ? byCustomAgent.get(job.customAgentId) : undefined;
      if (!target || job.clientAgentId) continue;
      await doc.ref.update({ clientAgentId: target });
      jobs++;
    }
  }

  return { umbrellas, slots, schedules, jobs };
}

/**
 * Rollback (§9). Additive collections come out cleanly; the only fields this
 * script ever wrote on an EXISTING doc are the two nullable linkage fields, and
 * both are cleared here.
 */
async function deleteForClient(
  db: FirebaseFirestore.Firestore,
  clientId: string,
  apply: boolean,
): Promise<void> {
  const umbrellas = await db.collection("clientAgents").where("clientId", "==", clientId).get();
  const slots = await db.collection("agentSlots").where("clientId", "==", clientId).get();
  const backfilled = umbrellas.docs.filter((d) => d.data().createdBy === "backfill");

  console.log(`\n═══ DELETE ${clientId} ═══\n`);
  console.log(`  umbrellas created by backfill: ${backfilled.length} of ${umbrellas.size}`);
  console.log(`  slots: ${slots.size}`);
  if (!apply) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --apply --delete.");
    return;
  }

  for (const doc of slots.docs) await doc.ref.delete();
  for (const doc of backfilled) {
    const scheduleRunId = doc.data().scheduleRunId;
    if (scheduleRunId) {
      await db
        .collection("plannedScheduledRuns")
        .doc(scheduleRunId)
        .update({ clientAgentId: null, updatedAt: Date.now() })
        .catch(() => undefined);
    }
    await doc.ref.delete();
  }
  console.log(`\nDELETED — ${backfilled.length} umbrella(s), ${slots.size} slot(s).`);
}

/* ──────────────────────────────── main ──────────────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const stampJobs = argv.includes("--stamp-jobs");
  const wantsDelete = argv.includes("--delete");
  const clientArg = argv.find((a) => a.startsWith("--client="))?.split("=")[1] ?? null;

  if (wantsDelete && !clientArg) {
    console.error("--delete requires --client=<id>. Refusing to roll back the whole fleet at once.");
    process.exit(1);
  }

  loadEnv();
  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!)) });
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  if (wantsDelete) {
    await deleteForClient(db, clientArg!, apply);
    return;
  }

  console.log(
    apply
      ? "APPLYING clientAgents backfill\n"
      : "DRY RUN — nothing is written. Pass --apply to write.\n",
  );

  const agentSnap = await db.collection("customAgents").get();
  const agents = new Map<string, CustomAgent>(
    agentSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() } as CustomAgent]),
  );

  const clientSnap = clientArg
    ? await db.collection("clients").where("__name__", "==", clientArg).get()
    : await db.collection("clients").get();
  if (clientSnap.empty) {
    console.error(clientArg ? `No client "${clientArg}".` : "No clients.");
    process.exit(1);
  }

  const now = Date.now();
  const totals = { umbrellas: 0, slots: 0, schedules: 0, jobs: 0, skipped: 0, anomalies: 0 };

  for (const clientDoc of clientSnap.docs) {
    const clientId = clientDoc.id;
    const data = clientDoc.data();

    const [assetSnap, jobSnap, scheduleSnap, umbrellaSnap] = await Promise.all([
      db.collection("assets").where("clientId", "==", clientId).get(),
      db.collection("jobs").where("clientId", "==", clientId).get(),
      db.collection("plannedScheduledRuns").where("clientId", "==", clientId).get(),
      db.collection("clientAgents").where("clientId", "==", clientId).get(),
    ]);

    const plan = planClient({
      clientId,
      clientName: data.name ?? clientId,
      grantedAgentIds: data.customAgentIds ?? [],
      agents,
      assets: assetSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Asset),
      jobs: jobSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Job),
      schedules: scheduleSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as PlannedScheduledRun),
      existingUmbrellaIds: new Set(umbrellaSnap.docs.map((d) => d.id)),
      now,
    });

    printPlan(plan, stampJobs);

    totals.skipped += plan.umbrellas.filter((u) => u.existing).length;
    totals.anomalies += plan.anomalies.length;
    if (apply) {
      const written = await applyPlan(db, plan, stampJobs, now);
      totals.umbrellas += written.umbrellas;
      totals.slots += written.slots;
      totals.schedules += written.schedules;
      totals.jobs += written.jobs;
    } else {
      const fresh = plan.umbrellas.filter((u) => !u.existing);
      totals.umbrellas += fresh.length;
      totals.slots += fresh.reduce((n, u) => n + u.slots.length, 0);
      totals.schedules += fresh.filter((u) => u.scheduleRunId).length;
      totals.jobs += stampJobs ? plan.jobStamps : 0;
    }
  }

  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log(`   Umbrellas:  ${totals.umbrellas}`);
  console.log(`   Templates:  seeded with each umbrella (see plan above)`);
  console.log(`   Slots:      ${totals.slots}   (no asset re-dated)`);
  console.log(`   Schedules:  ${totals.schedules} linked`);
  if (stampJobs) console.log(`   Jobs:       ${totals.jobs} stamped with clientAgentId`);
  console.log(`   Skipped:    ${totals.skipped} (umbrella already exists)`);
  console.log(`   Anomalies:  ${totals.anomalies}`);
  console.log("────────────────────────────────────────────────────────");
  console.log(
    apply
      ? "\nAPPLIED. Review on localhost — the portal reads the same Firestore this just wrote."
      : "\nDRY RUN — nothing was written. Re-run with --apply once the plan reads right.",
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
