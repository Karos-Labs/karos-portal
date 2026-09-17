/**
 * Make the client-facing roster EXACTLY the agents agent-engine runs.
 *
 * Albert, 2026-09-07: "all the agents from the agent engine should be the ones
 * that are displayed and the client needs that if he tries to run it so it will
 * be ran from the agent engine ... old agents that aren't working and don't
 * exist on the agent engine should be deleted."
 *
 * Three writes, idempotent, in this order:
 *
 *   1. UPSERT every engine-routed `customAgents` doc (the ROSTER below — one row
 *      per key in `ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY`, seeded from prep's docs
 *      so the SAME document ids exist in prep and production) and set it
 *      `enabled: true` with `source.status: "ready"` — the engine workflow is the
 *      implementation, so the lab manifest's "blocked"/"unreviewed" no longer
 *      describes anything a client would run. Fields an operator may have
 *      edited are filled only when empty; script-created docs get the roster's
 *      current name/blurb/icon/colour.
 *   2. DELETE every other `customAgents` doc. A key with no engine product has
 *      had no executor since agent-service was deleted (2026-09-02): pressing
 *      Run on it was a guaranteed 404. Each doomed doc is snapshotted to
 *      `_backup/<date>/customAgents/<id>` first (there is no undo in Firestore),
 *      and every client's `customAgentIds` is stripped of its id — a dangling
 *      grant is read by every roster.
 *   3. GRANT every roster agent to every client (`customAgentIds`, additive,
 *      de-duplicated). Per-agent visibility on the client's roster is then the
 *      portal's own rules: `parentKey` steps (the setup agents) stay hidden
 *      behind their parent, everything else is a card.
 *
 * Dry run by default; `--apply` writes. `FIRESTORE_DATABASE_ID` MUST be set
 * (`prep` or `(default)`, production) — unset used to mean production silently,
 * which is the one mistake this repo's scripts refuse to make.
 *
 *   FIRESTORE_DATABASE_ID=prep        NODE_PATH=./node_modules npx tsx --env-file=.env.local scripts/sync-engine-agent-roster.ts [--apply]
 *   FIRESTORE_DATABASE_ID="(default)" NODE_PATH=./node_modules npx tsx --env-file=.env.local scripts/sync-engine-agent-roster.ts [--apply]
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { resolveScriptDatabaseId } from "./lib/firestore-db";
import { resolveAgentEngineProductIdForCustomAgent } from "../src/lib/agent-engine/product-mapping";
import { perClientAgentSlug } from "../src/lib/custom-agent-launch";

const APPLY = process.argv.includes("--apply");

interface RosterDoc {
  id: string;
  key: string;
  name: string;
  description: string;
  clientBlurb: string | null;
  icon: string;
  color: string;
  entrySkillDir: string;
  parentKey?: string;
  creditCost?: string | null;
  launchCreditCost?: string | null;
}

/** What a doc created here says in the field agent-service used to read. Nothing reads it on the engine path. */
const ENGINE_INSTRUCTIONS =
  "Runs on agent-engine. The run dialog's brief reaches the engine as run input (toEngineRunInput); no agent-service prompt is read.";

/**
 * Seeded from prep's `customAgents` on 2026-09-07 — same ids in both databases
 * on purpose (the two were synced once and every grant list names ids). The
 * campaign row is new: agent-engine's campaign-orchestrator had a materializer
 * and no key a client could ask for it by.
 */
const ROSTER: RosterDoc[] = [
  {
    id: "Ji7p4nLTzDcbcKgDhtee",
    key: "karos-x-agent-v2",
    name: "X Agent",
    description: "Drafts one X post per run — build-in-public, knowledge, POV, news-reaction or quote lane — from the client's research and X agent data, with a picture attached or sourced.",
    clientBlurb: "Drafts an X post on demand, any time, spanning your build-in-public, knowledge, POV, news-reaction and quote lanes.",
    icon: "Zap",
    color: "#FDE047",
    entrySkillDir: "products/building/x-agent-v2",
    creditCost: "15",
    launchCreditCost: "25",
  },
  {
    id: "w2SnN4Pn0T2xjkdU2ZQ9",
    key: "karos-linkedin-writer-v2",
    name: "LinkedIn Agent",
    description: "Drafts one LinkedIn post per run for the company page or one executive's seat, in that identity's voice, with a picture attached or sourced.",
    clientBlurb: "Drafts a LinkedIn post for your company page or one of your executives, in their voice, ready for review.",
    icon: "Bot",
    color: "#FBBF24",
    entrySkillDir: "products/building/linkedin-agent-v2",
    creditCost: "15",
  },
  {
    id: "n9dB3L5ryKsUiYEHIFtr",
    key: "karos-linkedin-setup-v2",
    name: "LinkedIn Setup",
    description: "The LinkedIn agent's run-once client setup: the voice card, lanes, mix, cadence and compliance block the writer reads. Runs inline as the writer's own pre-flight on agent-engine.",
    clientBlurb: null,
    icon: "Bot",
    color: "#FBBF24",
    entrySkillDir: "products/building/linkedin-agent-v2/setup",
    parentKey: "karos-linkedin-writer-v2",
  },
  {
    id: "axbzuZtCz6U8WPNctcDq",
    key: "karos-reddit-runner",
    name: "Reddit Agent",
    description: "Finds live Reddit threads worth answering in the client's target subreddits, checks each subreddit's rules, and drafts replies in the account's voice. Comments only, never publishes.",
    clientBlurb: "Finds live Reddit threads your buyers are in and drafts replies in your voice, checked against each subreddit's rules.",
    icon: "Bot",
    color: "#FBBF24",
    entrySkillDir: "products/building/reddit-agent-v2",
  },
  {
    id: "oWMx7dwlsDqp1UKZ1x31",
    key: "karos-reddit-setup",
    name: "Reddit Setup",
    description: "The Reddit agent's run-once client setup: which subreddits the buyers talk in and each one's rules. Runs inline as the runner's own pre-flight on agent-engine.",
    clientBlurb: null,
    icon: "Bot",
    color: "#FBBF24",
    entrySkillDir: "products/building/reddit-agent-v2/setup",
    parentKey: "karos-reddit-runner",
  },
  {
    id: "EJVZENVXvWgIo9aoiheI",
    key: "karos-instagram-agent",
    name: "Instagram Agent",
    description: "Drafts one on-brand Instagram carousel per run: research, copy, imagery (the client's own uploads first, then sourced or generated), branded render and visual QA.",
    clientBlurb: "Creates a ready-to-post Instagram carousel in your brand, from your own photos or sourced imagery.",
    icon: "Zap",
    color: "#A3E635",
    entrySkillDir: "products/live/instagram-agent",
  },
  {
    id: "RVVdf4vHPFw1fnkDOn0X",
    key: "landing-builder",
    name: "Landing Builder",
    description: "Builds one premium, feedback-ready landing page from the client's brand, context documents and brief, and publishes a preview to review.",
    clientBlurb: "Builds a premium landing page from your brand and brief, published as a preview for your review.",
    icon: "Zap",
    color: "#A3E635",
    entrySkillDir: "products/live/landing-page/landing-builder",
  },
  {
    id: "ZjZe2DsCDCmayOPtt8Zo",
    key: "branded-shorts",
    name: "Branded Shorts",
    description: "Turns one talking-head video into a finished vertical short: filler-cut edit, camera-true colour, brand captions and graphics, gated by the render QA.",
    clientBlurb: "Turns a talking-head video you upload into a finished, branded vertical short.",
    icon: "Bot",
    color: "#FBBF24",
    entrySkillDir: "products/building/branded-shorts",
  },
  {
    id: "IMHKWQ6j8UEF4QAHwIAv",
    key: "karos-blog-writer-v2",
    name: "Blog Agent",
    description: "Writes one longform article per run from the client's content pillars and keywords, in the distilled voice, with sources cited.",
    clientBlurb: "Writes a longform, sourced blog article in your voice on the subject you choose or the next one in your plan.",
    icon: "PenLine",
    color: "#34D399",
    entrySkillDir: "products/building/blog-agent-v2",
  },
  {
    id: "78LJ0UJNFari8UmXmHZW",
    key: "karos-newsletter-writer-v2",
    name: "Newsletter Agent",
    description: "Prepares one newsletter issue per run: claims the issue number, plans the edition, drafts in the client's voice and renders the email (light and dark).",
    clientBlurb: "Drafts your next newsletter issue in your voice and renders the email, ready to review and send.",
    icon: "Mail",
    color: "#60A5FA",
    entrySkillDir: "products/building/newsletter-agent-v2",
  },
  {
    id: "a53dyzeYT0IkbpmWRq3B",
    key: "karos-reputation-runner",
    name: "Reputation Agent",
    description: "One review pulse per run: captures new reviews on the client's rostered surfaces, triages them and drafts a reply for each one worth answering.",
    clientBlurb: "Reads your new reviews, sorts what needs a reply, and drafts the replies for your approval.",
    icon: "MessageSquare",
    color: "#F472B6",
    entrySkillDir: "products/building/reputation-agent-v2",
  },
  {
    id: "Xwk94qwUQGeR9caXWkir",
    key: "karos-reputation-setup",
    name: "Reputation Setup",
    description: "The reputation agent's run-once client setup: resolves where the client is reviewed into real listings. Runs inline as the pulse's own pre-flight on agent-engine.",
    clientBlurb: null,
    icon: "MessageSquare",
    color: "#F472B6",
    entrySkillDir: "products/building/reputation-agent-v2/setup",
    parentKey: "karos-reputation-runner",
  },
  {
    id: "DpoSLPDI6jbalCc7xzGc",
    key: "seo-geo-agent-v2",
    name: "SEO & GEO Agent",
    description: "Measures where the client stands in classic search and inside AI answers, scores it, and turns the result into one prioritised plan.",
    clientBlurb: "Measures your visibility in search and in AI answers, and turns it into one prioritised plan.",
    icon: "Bot",
    color: "#FBBF24",
    entrySkillDir: "products/building/seo-geo-agent-v2",
  },
  {
    id: "wczZml1diYtXIL28Q4VT",
    key: "karos-tiktok-agent",
    name: "TikTok Agent",
    description: "The short-video system: clips a moment out of footage the client attaches or owns and lays the client's commentary on it, or scripts an original short when nothing is attached.",
    clientBlurb: "Cuts a captioned, branded short from footage you upload, or scripts an original one from your topics.",
    icon: "Bot",
    color: "#FBBF24",
    entrySkillDir: "products/building/tiktok-agent",
  },
  {
    id: "karosCampaignOrchestrator",
    key: "karos-campaign-orchestrator",
    name: "Campaign",
    description: "agent-engine campaign-orchestrator: one brief becomes X, LinkedIn, Instagram, Reddit and blog drafts, reviewed together at a single campaign gate.",
    clientBlurb: "Plans one campaign across X, LinkedIn, Instagram, Reddit and your blog from a single brief, drafts every channel, and brings the whole bundle to one review.",
    icon: "Layers",
    color: "#F97316",
    entrySkillDir: "agent-engine/campaign-orchestrator",
  },
];

function keyIsEngineRouted(key: string): boolean {
  if (resolveAgentEngineProductIdForCustomAgent(key) !== undefined) return true;
  // A per-client instance (`<prefix><client-slug>`) routes by its base key.
  const bound = perClientAgentSlug(key);
  if (!bound) return false;
  const base = key.slice(0, key.length - bound.length).replace(/-+$/, "");
  return resolveAgentEngineProductIdForCustomAgent(base) !== undefined;
}

async function main() {
  const databaseId = resolveScriptDatabaseId();
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!);
  if (getApps().length === 0) initializeApp({ credential: cert(sa), projectId: sa.project_id });
  const db = getFirestore(databaseId);
  const now = Date.now();
  const stamp = new Date(now).toISOString().slice(0, 10);

  console.log(`project: ${sa.project_id} · database: ${databaseId}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: dry run (pass --apply to write)\n");

  // Every roster key must route, or this script would enable a card that 404s.
  for (const row of ROSTER) {
    if (!resolveAgentEngineProductIdForCustomAgent(row.key)) {
      throw new Error(`ROSTER key "${row.key}" has no engine product in ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY — refusing to enable it`);
    }
  }

  const snap = await db.collection("customAgents").get();
  const byKey = new Map<string, { id: string; data: Record<string, unknown> }>();
  for (const d of snap.docs) {
    const data = d.data();
    const key = typeof data.key === "string" ? data.key : "";
    if (key && !byKey.has(key)) byKey.set(key, { id: d.id, data });
  }

  // ── 1. upsert + enable ──
  console.log("ROSTER (engine-routed, enabled):");
  const rosterIds = new Set<string>();
  for (const row of ROSTER) {
    const productId = resolveAgentEngineProductIdForCustomAgent(row.key)!;
    const existing = byKey.get(row.key);
    const id = existing?.id ?? row.id;
    rosterIds.add(id);
    const ref = db.collection("customAgents").doc(id);

    if (existing) {
      const scriptOwned = typeof existing.data.createdBy === "string" && existing.data.createdBy.startsWith("script:");
      const patch: Record<string, unknown> = { enabled: true, updatedAt: now, updatedBy: "script:sync-engine-agent-roster" };
      // Presentation fields: refreshed on a script-created doc, filled only when
      // empty on one a person may have edited.
      for (const field of ["name", "description", "clientBlurb", "icon", "color"] as const) {
        const current = existing.data[field];
        const empty = current === undefined || current === null || current === "";
        if ((scriptOwned || empty) && row[field] !== undefined && row[field] !== null && current !== row[field]) patch[field] = row[field];
      }
      if (!existing.data.entrySkillDir) patch.entrySkillDir = row.entrySkillDir;
      if (row.parentKey && existing.data.parentKey !== row.parentKey) patch.parentKey = row.parentKey;
      if (!existing.data.instructions) patch.instructions = ENGINE_INSTRUCTIONS;
      if (!Array.isArray(existing.data.skillRoots)) patch.skillRoots = [];
      if (typeof existing.data.includeClientSkills !== "boolean") patch.includeClientSkills = true;
      const source = (existing.data.source as Record<string, unknown> | undefined) ?? { path: row.entrySkillDir };
      patch.source = { ...source, status: "ready", engineProductId: productId };
      const changed = Object.keys(patch).filter((k) => k !== "updatedAt" && k !== "updatedBy" && k !== "source");
      console.log(`  ✓ ${row.key.padEnd(30)} → ${productId.padEnd(22)} ${existing.data.enabled === true ? "enabled" : "ENABLE "}  (${id})${changed.length > 1 ? `  sets ${changed.filter((k) => k !== "enabled").join(", ")}` : ""}`);
      if (APPLY) await ref.set(patch, { merge: true });
    } else {
      const doc = {
        key: row.key,
        name: row.name,
        description: row.description,
        clientBlurb: row.clientBlurb,
        icon: row.icon,
        color: row.color,
        entrySkillDir: row.entrySkillDir,
        parentKey: row.parentKey ?? null,
        skillRoots: [] as string[],
        includeClientSkills: true,
        instructions: ENGINE_INSTRUCTIONS,
        source: { path: row.entrySkillDir, status: "ready", engineProductId: productId },
        creditCost: row.creditCost ?? null,
        launchCreditCost: row.launchCreditCost ?? null,
        enabled: true,
        createdAt: now,
        createdBy: "script:sync-engine-agent-roster",
        updatedAt: now,
        updatedBy: "script:sync-engine-agent-roster",
      };
      console.log(`  + ${row.key.padEnd(30)} → ${productId.padEnd(22)} CREATE   (${id})`);
      if (APPLY) await ref.set(doc);
    }
  }

  // ── 2. delete everything that has no engine behind it ──
  const doomed = snap.docs.filter((d) => !rosterIds.has(d.id) && !keyIsEngineRouted(String(d.data().key ?? "")));
  const keptUnlisted = snap.docs.filter((d) => !rosterIds.has(d.id) && keyIsEngineRouted(String(d.data().key ?? "")));
  console.log(`\nDELETE (no engine product — a Run here has been a 404 since 2026-09-02): ${doomed.length}`);
  for (const d of doomed) {
    console.log(`  ✗ ${String(d.data().key).padEnd(30)} ${String(d.data().name)}  (${d.id})`);
    if (APPLY) {
      await db.collection("_backup").doc(stamp).collection("customAgents").doc(d.id).set({ ...d.data(), _deletedAt: now, _deletedBy: "script:sync-engine-agent-roster" });
      await d.ref.delete();
    }
  }
  for (const d of keptUnlisted) console.log(`  · kept (engine-routed, not in ROSTER): ${String(d.data().key)} (${d.id})`);
  const doomedIds = new Set(doomed.map((d) => d.id));

  // ── 3. grants: strip deleted ids, add every roster id ──
  const clients = await db.collection("clients").get();
  console.log(`\nCLIENT GRANTS (${clients.size} clients):`);
  let clientWrites = 0;
  for (const c of clients.docs) {
    const name = String(c.data().name ?? c.id);
    const current: string[] = Array.isArray(c.data().customAgentIds) ? (c.data().customAgentIds as string[]) : [];
    const stripped = current.filter((id) => !doomedIds.has(id));
    const next = [...new Set([...stripped, ...rosterIds])];
    const removed = current.length - stripped.length;
    const added = next.length - stripped.length;
    if (removed === 0 && added === 0) {
      console.log(`  = ${name}: ${current.length} grants, unchanged`);
      continue;
    }
    console.log(`  ~ ${name}: -${removed} dangling, +${added} engine agents → ${next.length} grants`);
    clientWrites += 1;
    if (APPLY) await c.ref.set({ customAgentIds: next, updatedAt: now }, { merge: true });
  }

  console.log(
    APPLY
      ? `\nDone: ${ROSTER.length} roster docs upserted, ${doomed.length} deleted (backup: _backup/${stamp}/customAgents), ${clientWrites} client grant lists rewritten.`
      : `\nDry run: ${ROSTER.length} roster docs would be upserted, ${doomed.length} deleted, ${clientWrites} client grant lists rewritten. Re-run with --apply.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
