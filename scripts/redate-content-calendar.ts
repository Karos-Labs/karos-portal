/**
 * One-off content-calendar re-date migration (acceptance D; legacy half of B/E).
 *
 * Re-dates every ACTIVE client's not-yet-posted content-chain posts one-per-day
 * from a start date (default 2026-07-14) in internal lab-generation order, and
 * backfills the fields the runtime chain now relies on:
 *   • orderKey        — deriveOrderKey (stored → meta.labRun `runName#itemKey` → createdAt+id)
 *   • templateKey/Name — templateFromItemKey on the lab item key (managed-product name for
 *                        agent-service posts); longest-known-prefix collapse so one-off run
 *                        slugs land on the client's existing template
 *   • title           — strips the legacy ` — <runName>` suffix (runName parsed from
 *                        meta.labRun, EXACT match only — never a blind split on " — ")
 *   • scheduledAt + recommendedAt (chain slot) + recommendedReason + publishMode (candidates)
 *
 * ORDERING IS NOT REIMPLEMENTED HERE. The pure planner `planClientChain`
 * (src/lib/post-chain.ts) is the single source of truth for who lands on which
 * day; this script only classifies, logs, backs up, and persists its output.
 *
 * ── SAFETY (cron can never fire on a re-dated post) ────────────────────────────
 * The /api/publish cron drains assets where status ∈ [scheduled, approved] AND
 * scheduledAt ≤ now AND publishMode ∈ {auto, absent}. This script:
 *   1. NEVER writes `status` (a draft stays a draft — cron-inert — with a planned slot).
 *   2. NEVER writes publishMode "auto"; it stamps "manual" on every asset it DATES
 *      that lacks a publishMode (so a later bare approval can't inherit absent=auto).
 *   3. Runs a hard post-plan assertion: zero written assets may match the cron
 *      predicate. It aborts (exit 1) and writes nothing otherwise.
 *
 * ── MODE ──────────────────────────────────────────────────────────────────────
 * migrate-mode pinning (post-chain.ts): pinned = published OR publishedAt set OR
 * scheduledAt-day strictly before the start day. Everything else that is
 * chain-eligible (family-scoped, provenance-guarded: meta.source "lab-import" OR
 * a managed meta.taskType OR a stored orderKey) and not --skip'd is a candidate,
 * regardless of status — so the 2/day staff-stacked posts get spread out too.
 * Legacy assets (e.g. meta.source "content-engine") are never re-dated but their
 * dated instances still occupy their family's days, so the chain never double-books.
 *
 * ── CLI ───────────────────────────────────────────────────────────────────────
 *   npx tsx scripts/redate-content-calendar.ts                 # DRY RUN (default) — writes nothing
 *   npx tsx scripts/redate-content-calendar.ts --apply         # perform the writes (backup first)
 *   --client <id>        limit to a single client
 *   --start YYYY-MM-DD   chain start day (default 2026-07-14), interpreted server-local
 *   --family <f>         chain family to plan: social | email | article (default social)
 *   --skip <assetId>     exclude an asset from candidacy (repeatable). Dates untouched,
 *                        but the asset still occupies its day. Use for posts the data
 *                        thinks are unposted but a human knows went out.
 *
 * Recommended validated invocation (matches scratchpad/expected-chain-mapping.md) — the
 * Karos launch post OICDymlXPAAjJh92oQHo (labRun instagram-agent/2026-07-06-launch-post-kairos#run)
 * was posted in reality, so pass it as --skip:
 *   npx tsx scripts/redate-content-calendar.ts --skip OICDymlXPAAjJh92oQHo
 *
 * ── RECOMMENDED ROLLOUT ───────────────────────────────────────────────────────
 *   1. dry-run ALL clients, review the PINNED + REASSIGNED tables (one row per day,
 *      monotone dates, the 2026-07-13 posts + launch post appear in PINNED).
 *   2. --apply --client <one>, verify in the staff calendar UI.
 *   3. --apply for the rest.
 *
 * ── HAND-RESTORE ──────────────────────────────────────────────────────────────
 * --apply writes scripts/backups/redate-backup-<ISO>.json (gitignored; contains client
 * data) with { id, clientId, before, after } for every touched asset BEFORE the first
 * Firestore write. To revert: for each entry replay its `before` object as an asset
 * update — e.g. db.collection("assets").doc(id).set(before, { merge: true }) — which
 * restores title/scheduledAt/publishMode/recommendedAt/orderKey/templateKey/templateName.
 *
 * ── TIMEZONE (accepted architect choice, plan amendment A9) ────────────────────
 * All day math is SERVER-LOCAL (matches scheduling.ts + the staff datetime-local form).
 * Run this on the intended host: on a UTC+3 machine the 11:00 slot = 08:00Z, identical
 * to the existing manually-scheduled production pattern. The date SEQUENCE (which post
 * lands on which YYYY-MM-DD) is invariant across host timezones; only the stored hour
 * shifts. Do not run it on a host whose local day differs from the intended calendar day.
 *
 * ── SCRIPT-CONVENTION NOTE ─────────────────────────────────────────────────────
 * Bootstrap (env-before-Firebase, direct Admin SDK init) follows scripts/migrate-legacy-roles.ts
 * and scripts/backfill-branding.ts. Those scripts — and this one — do NOT import src/lib/data.ts:
 * data.ts begins with `import "server-only"`, which is unresolvable under `npx tsx`
 * (it has no Next.js bundler alias). Reads/writes here use the Admin SDK directly with the
 * SAME semantics as data.ts's listClients/listAssets/updateAsset (updateAsset === doc.set(patch,
 * { merge: true })). Ordering/template/gating logic is imported from the client-safe,
 * server-only-free src/lib/post-chain.ts so there is a single source of truth.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, fsyncSync, openSync, closeSync } from "fs";
import { resolve, dirname, join } from "path";

/* ── CLI ─────────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
function flagValues(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === name) out.push(argv[i + 1]);
  }
  return out;
}

const ONLY_CLIENT = flagValue("--client");
const START_ARG = flagValue("--start") ?? "2026-07-14";
const FAMILY_ARG = (flagValue("--family") ?? "social").toLowerCase();
/**
 * Karos launch post: Albert confirmed it was already posted, but the data
 * cannot know (status "approved", no scheduledAt/publishedAt) — without this
 * default skip it would be re-dated into the chain.
 */
const DEFAULT_SKIP = ["OICDymlXPAAjJh92oQHo"];
const SKIP_IDS = [...new Set([...DEFAULT_SKIP, ...flagValues("--skip")])];

if (!/^\d{4}-\d{2}-\d{2}$/.test(START_ARG)) {
  console.error(`Invalid --start "${START_ARG}"; expected YYYY-MM-DD.`);
  process.exit(1);
}
if (FAMILY_ARG !== "social" && FAMILY_ARG !== "email" && FAMILY_ARG !== "article") {
  console.error(`Invalid --family "${FAMILY_ARG}"; expected social | email | article.`);
  process.exit(1);
}

// Day boundaries and slot times are server-local (see post-chain.ts). This run
// is calibrated for a UTC+3 machine: 11:00 local = 08:00Z, matching every
// existing scheduled post in production data.
if (new Date().getTimezoneOffset() !== -180 && !process.argv.includes("--any-tz")) {
  console.error(
    `Refusing to run: process UTC offset is ${-new Date().getTimezoneOffset() / 60}h, expected +3h. ` +
      `Slot times and day boundaries would differ from the reviewed plan. Pass --any-tz to override deliberately.`,
  );
  process.exit(1);
}

/** Server-local midnight of the --start day. */
const [SY, SM, SD] = START_ARG.split("-").map(Number);
const startDay = new Date(SY, SM - 1, SD);
startDay.setHours(0, 0, 0, 0);
const START_DAY_MS = startDay.getTime();

/* ── Load .env.local before any Firebase import (migrate-legacy-roles.ts pattern) ── */

function loadEnvFile(path: string) {
  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      const quote = val.startsWith('"') ? '"' : val.startsWith("'") ? "'" : "";
      if (quote) {
        val = val.slice(1);
        while (!val.endsWith(quote) && i + 1 < lines.length) {
          i++;
          val += "\n" + lines[i].trimEnd();
        }
        if (val.endsWith(quote)) val = val.slice(0, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // ignore missing files
  }
}

/** Walk up from cwd so the script works from a git worktree whose checkout has no .env.local. */
function findAndLoadEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, ".env.local");
    if (existsSync(candidate)) {
      loadEnvFile(candidate);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  loadEnvFile(resolve(process.cwd(), ".env"));
}

findAndLoadEnv();

/* ── Firebase Admin SDK (backfill-branding.ts pattern) ─────────────────────────── */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) {
    initializeApp({ credential: cert(JSON.parse(raw)) });
    return;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    return;
  }
  throw new Error(
    "No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_KEY or " +
      "FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY in .env.local",
  );
}

/** Assigned by main() — never at module scope, so importing opens no connection. */
let db: Firestore;

/* ── Pure chain logic — single source of truth (server-only-free, tsx-safe) ────── */

import {
  planClientChain,
  deriveOrderKey,
  templateFromItemKey,
  startOfDayMs,
  chainFamilyFor,
  isReferenceDocAsset,
  type ChainFamily,
} from "../src/lib/post-chain";
import { MANAGED_PRODUCTS, getManagedProduct } from "../src/lib/agent-service/products";
import type { Asset, Client, ManagedTaskType } from "../src/lib/types";

const FAMILY = FAMILY_ARG as ChainFamily;
const CHAIN_REASON = "One post per day — assigned by the content chain";
const MANAGED_SET = new Set<string>(MANAGED_PRODUCTS.map((p) => p.taskType));

/* ── small helpers ─────────────────────────────────────────────────────────────── */

function withId<T>(doc: FirebaseFirestore.QueryDocumentSnapshot): T {
  return { id: doc.id, ...(doc.data() as object) } as T;
}

function metaStr(a: Asset, key: string): string | null {
  const v = a.meta?.[key];
  return typeof v === "string" ? v : null;
}

/** Mirrors post-chain.ts hasChainProvenance — for CLASSIFICATION/logging only (planner owns dates). */
function hasChainProvenance(a: Asset): boolean {
  if (metaStr(a, "source") === "lab-import") return true;
  const tt = metaStr(a, "taskType");
  if (tt !== null && MANAGED_SET.has(tt)) return true;
  return typeof a.orderKey === "string" && a.orderKey.length > 0;
}

/** runName segment of a meta.labRun value shaped `${agentFolder}/${runName}#${itemKey}`. */
function labRunName(labRun: string): string | null {
  const slash = labRun.indexOf("/");
  const hash = labRun.indexOf("#");
  if (slash < 0 || hash < 0 || hash <= slash + 1) return null;
  return labRun.slice(slash + 1, hash);
}

/** item-key segment (after "#") of a meta.labRun value. */
function labRunItemKey(labRun: string): string | null {
  const hash = labRun.indexOf("#");
  return hash >= 0 ? labRun.slice(hash + 1) : null;
}

/** Legacy title cleanup: strip an EXACT trailing ` — <runName>` (A7). No-op without meta.labRun. */
function cleanTitle(a: Asset): string {
  const labRun = metaStr(a, "labRun");
  if (!labRun) return a.title;
  const runName = labRunName(labRun);
  if (!runName) return a.title;
  const suffix = ` — ${runName}`;
  return a.title.endsWith(suffix) ? a.title.slice(0, a.title.length - suffix.length) : a.title;
}

function iso(t: number | null | undefined): string {
  return t == null ? "—" : new Date(t).toISOString();
}
function ymd(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function short(s: string, n: number): string {
  return s.length <= n ? s.padEnd(n) : s.slice(0, n - 1) + "…";
}

/* ── per-asset backfill (orderKey / template / title) ──────────────────────────── */

interface Backfill {
  orderKey: string; // deriveOrderKey (== stored when present)
  template: { key: string; name: string } | null;
  cleanedTitle: string;
}

/**
 * Template for an asset, matching runtime templateForAsset semantics but with a
 * pre-computed template map for lab items so the longest-known-prefix collapse is
 * deterministic. Falls back to the managed-product name for agent-service posts.
 */
function templateFor(a: Asset, labTemplateById: Map<string, { key: string; name: string } | null>): { key: string; name: string } | null {
  if (metaStr(a, "labRun") !== null) {
    return labTemplateById.get(a.id) ?? null;
  }
  const tt = metaStr(a, "taskType");
  if (tt !== null && MANAGED_SET.has(tt)) {
    return { key: tt, name: getManagedProduct(tt as ManagedTaskType).name };
  }
  return null;
}

/**
 * Build lab-item templates for a client's chosen family, accumulating known keys in
 * internal-generation (deriveOrderKey) order so a later one-off run slug collapses onto
 * an earlier established template (e.g. XO's voce-sabia-renda-fixa-risco → "voce-sabia").
 */
function buildLabTemplates(assets: Asset[]): Map<string, { key: string; name: string } | null> {
  const labAssets = assets
    .filter((a) => chainFamilyFor(a.type) === FAMILY && metaStr(a, "labRun") !== null)
    .sort((a, b) => {
      const c = deriveOrderKey(a).localeCompare(deriveOrderKey(b));
      return c !== 0 ? c : a.id.localeCompare(b.id);
    });
  const knownKeys: string[] = [];
  const out = new Map<string, { key: string; name: string } | null>();
  for (const a of labAssets) {
    const itemKey = labRunItemKey(metaStr(a, "labRun")!);
    const t = itemKey ? templateFromItemKey(itemKey, knownKeys) : null;
    out.set(a.id, t);
    if (t && !knownKeys.includes(t.key)) knownKeys.push(t.key);
  }
  return out;
}

/* ── the planned write for one asset ───────────────────────────────────────────── */

type Role =
  | "reassigned"
  | "pinned-posted"
  | "pinned-before-start"
  | "skipped"
  | "legacy-occupies"
  | "placeholder"
  | "reference-doc";

interface PlannedWrite {
  id: string;
  clientId: string;
  role: Role;
  patch: Record<string, unknown>; // fields to persist (excluding the updatedAt stamp added at write time)
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  // resulting state for the cron-eligibility assertion:
  resStatus: Asset["status"];
  resScheduledAt: number | null;
  resPublishMode: Asset["publishMode"] | null;
  titleChanged: boolean;
}

const BACKUP_KEYS = [
  "title",
  "scheduledAt",
  "publishMode",
  "status",
  "recommendedAt",
  "recommendedReason",
  "orderKey",
  "templateKey",
  "templateName",
] as const;

function snapshotKeys(a: Asset): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of BACKUP_KEYS) o[k] = (a as unknown as Record<string, unknown>)[k] ?? null;
  return o;
}

/* ── per-client processing ─────────────────────────────────────────────────────── */

interface ClientReport {
  writes: PlannedWrite[];
  pinnedRows: Array<{ id: string; title: string; status: string; date: string; reason: string }>;
  reassignedRows: Array<{
    id: string;
    newDate: string;
    newSched: number;
    oldSched: number | null;
    orderKey: string;
    template: string;
    oldTitle: string;
    newTitle: string;
  }>;
  warnings: string[];
  otherFamilyCount: number;
  titlesCleaned: number;
  chipBackfills: number;
}

function processClient(client: Client, assets: Asset[], now: number): ClientReport {
  const skipSet = new Set(SKIP_IDS);
  const labTemplateById = buildLabTemplates(assets);

  // DATES come exclusively from the pure planner (single source of truth).
  const assignments = planClientChain(assets, {
    now,
    mode: "migrate",
    startDayMs: START_DAY_MS,
    skipIds: SKIP_IDS,
    families: [FAMILY],
  });
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));

  const report: ClientReport = {
    writes: [],
    pinnedRows: [],
    reassignedRows: [],
    warnings: [],
    otherFamilyCount: 0,
    titlesCleaned: 0,
    chipBackfills: 0,
  };

  const familyAssets = assets.filter((a) => chainFamilyFor(a.type) === FAMILY);

  for (const a of familyAssets) {
    const isLab = metaStr(a, "source") === "lab-import";
    const bf: Backfill = {
      orderKey: deriveOrderKey(a),
      template: templateFor(a, labTemplateById),
      cleanedTitle: cleanTitle(a),
    };
    const noOrderSignal =
      !(typeof a.orderKey === "string" && a.orderKey.length > 0) &&
      !(metaStr(a, "labRun")?.includes("#") ?? false);

    const assignment = assignmentById.get(a.id);

    /* 1) CANDIDATE re-dated by the planner ---------------------------------------- */
    if (assignment) {
      const patch: Record<string, unknown> = {
        scheduledAt: assignment.scheduledAt,
        recommendedAt: assignment.scheduledAt,
        recommendedReason: CHAIN_REASON,
      };
      if (a.orderKey !== bf.orderKey) patch.orderKey = bf.orderKey;
      if (!a.templateKey && bf.template) {
        patch.templateKey = bf.template.key;
        patch.templateName = bf.template.name;
      }
      if (bf.cleanedTitle !== a.title) patch.title = bf.cleanedTitle;
      // Cron-safety: force "manual" unless already manual/placeholder — this also
      // downgrades a stale explicit "auto"; the script never writes "auto".
      if (a.publishMode !== "manual" && a.publishMode !== "placeholder") patch.publishMode = "manual";

      const after = snapshotKeys(a);
      after.scheduledAt = assignment.scheduledAt;
      after.recommendedAt = assignment.scheduledAt;
      after.recommendedReason = CHAIN_REASON;
      if ("orderKey" in patch) after.orderKey = patch.orderKey;
      if ("templateKey" in patch) {
        after.templateKey = patch.templateKey;
        after.templateName = patch.templateName;
      }
      if ("title" in patch) after.title = patch.title;
      if ("publishMode" in patch) after.publishMode = patch.publishMode;

      const titleChanged = bf.cleanedTitle !== a.title;
      report.writes.push({
        id: a.id,
        clientId: client.id,
        role: "reassigned",
        patch,
        before: snapshotKeys(a),
        after,
        resStatus: a.status,
        resScheduledAt: assignment.scheduledAt,
        resPublishMode: a.publishMode ?? "manual",
        titleChanged,
      });
      report.reassignedRows.push({
        id: a.id,
        newDate: ymd(assignment.scheduledAt),
        newSched: assignment.scheduledAt,
        oldSched: a.scheduledAt ?? null,
        orderKey: bf.orderKey,
        template: bf.template?.name ?? "—",
        oldTitle: a.title,
        newTitle: bf.cleanedTitle,
      });
      if (titleChanged) report.titlesCleaned++;
      if (noOrderSignal) {
        report.warnings.push(
          `NO ORDER SIGNAL: ${a.id} ("${a.title}") has no orderKey/labRun — sorted by createdAt+id (${iso(a.createdAt)}). Eyeball its slot.`,
        );
      }
      continue;
    }

    /* 2) NON-CANDIDATE — classify for reporting, and chip-backfill lab-import posts. */
    const isPublished = a.status === "published" || a.publishedAt != null;
    const pinnedBeforeStart = a.scheduledAt != null && startOfDayMs(a.scheduledAt) < START_DAY_MS;
    const isPlaceholder = a.publishMode === "placeholder";
    const isSkipped = skipSet.has(a.id);

    // Precedence mirrors the planner's own exclusion order: placeholders are removed
    // from the family entirely (never candidate, never occupancy), so they must be
    // classified FIRST — even when a stale scheduledAt sits before the start day.
    let role: Role;
    let reason: string;
    if (isPlaceholder) {
      role = "placeholder";
      reason = "placeholder roadmap item";
    } else if (isSkipped) {
      role = "skipped";
      reason = "skipped (--skip)";
    } else if (isPublished) {
      role = "pinned-posted";
      reason = "posted";
    } else if (pinnedBeforeStart) {
      role = "pinned-before-start";
      reason = "dated before start";
    } else if (isLab && a.status === "draft" && isReferenceDocAsset(a)) {
      // Overview/explainer item ("template-ideas"): documentation, not a post.
      // Undate it so it leaves the calendar and lives in the library instead.
      const patch: Record<string, unknown> = {};
      if (a.scheduledAt != null) patch.scheduledAt = FieldValue.delete();
      if (a.recommendedAt != null) patch.recommendedAt = FieldValue.delete();
      if (a.recommendedReason != null) patch.recommendedReason = FieldValue.delete();
      if (a.orderKey !== bf.orderKey) patch.orderKey = bf.orderKey;
      if (!a.templateKey && bf.template) {
        patch.templateKey = bf.template.key;
        patch.templateName = bf.template.name;
      }
      if (bf.cleanedTitle !== a.title) patch.title = bf.cleanedTitle;
      if (Object.keys(patch).length > 0) {
        const after = snapshotKeys(a);
        after.scheduledAt = null;
        after.recommendedAt = null;
        after.recommendedReason = null;
        if ("orderKey" in patch) after.orderKey = bf.orderKey;
        if ("templateKey" in patch) {
          after.templateKey = patch.templateKey;
          after.templateName = patch.templateName;
        }
        if ("title" in patch) after.title = patch.title;
        report.writes.push({
          id: a.id,
          clientId: client.id,
          role: "reference-doc",
          patch,
          before: snapshotKeys(a),
          after,
          resStatus: a.status,
          resScheduledAt: null,
          resPublishMode: a.publishMode ?? null,
          titleChanged: bf.cleanedTitle !== a.title,
        });
        if (bf.cleanedTitle !== a.title) report.titlesCleaned++;
      }
      report.warnings.push(
        `REFERENCE DOC undated: ${a.id} ("${bf.cleanedTitle}") — overview/explainer, removed from the posting chain (still in the library).`,
      );
      continue;
    } else if (!hasChainProvenance(a)) {
      role = "legacy-occupies";
      reason = `legacy/no-provenance (source=${metaStr(a, "source") ?? "?"})`;
    } else {
      // Chain-eligible, non-pinned, but the planner emitted no assignment → already on
      // its correct computed day. Report as pinned-in-place; no date write.
      role = "pinned-before-start";
      reason = "already on correct day";
    }

    // Chip-backfill (orderKey/template/title) — ONLY lab-import posts, ONLY when dated
    // (pinned) or explicitly skipped, and NEVER for placeholder decorations. Never dates.
    const eligibleForChip =
      isLab && role !== "placeholder" && role !== "legacy-occupies";
    let wroteChip = false;
    if (eligibleForChip) {
      const patch: Record<string, unknown> = {};
      if (a.orderKey !== bf.orderKey) patch.orderKey = bf.orderKey;
      if (!a.templateKey && bf.template) {
        patch.templateKey = bf.template.key;
        patch.templateName = bf.template.name;
      }
      if (bf.cleanedTitle !== a.title) patch.title = bf.cleanedTitle;
      if (Object.keys(patch).length > 0) {
        const after = snapshotKeys(a);
        if ("orderKey" in patch) after.orderKey = patch.orderKey;
        if ("templateKey" in patch) {
          after.templateKey = patch.templateKey;
          after.templateName = patch.templateName;
        }
        if ("title" in patch) after.title = patch.title;
        report.writes.push({
          id: a.id,
          clientId: client.id,
          role,
          patch,
          before: snapshotKeys(a),
          after,
          resStatus: a.status,
          resScheduledAt: a.scheduledAt ?? null,
          resPublishMode: a.publishMode ?? null,
          titleChanged: bf.cleanedTitle !== a.title,
        });
        if (bf.cleanedTitle !== a.title) report.titlesCleaned++;
        report.chipBackfills++;
        wroteChip = true;
      }
    }

    // Reporting rows / warnings by role.
    if (role === "pinned-posted" || role === "pinned-before-start" || role === "skipped") {
      report.pinnedRows.push({
        id: a.id,
        title: cleanTitle(a),
        status: a.status,
        date: iso(a.publishedAt ?? a.scheduledAt),
        reason: reason + (wroteChip ? " · chips backfilled" : ""),
      });
    } else if (role === "placeholder") {
      report.warnings.push(`PLACEHOLDER ignored: ${a.id} ("${a.title}") — calendar decoration, not chained.`);
    } else if (role === "legacy-occupies") {
      const occ = a.scheduledAt ?? a.publishedAt;
      report.warnings.push(
        `LEGACY not re-dated: ${a.id} ("${a.title}") ${reason}` +
          (occ != null ? ` — OCCUPIES ${ymd(occ)}, so the chain skips that day.` : " — undated, no occupancy."),
      );
    }
  }

  // Report other-family assets (out of --family scope) so nothing silently disappears (A7).
  report.otherFamilyCount = assets.filter(
    (a) => chainFamilyFor(a.type) !== null && chainFamilyFor(a.type) !== FAMILY,
  ).length;

  // Stable sort for human eyeballing.
  report.reassignedRows.sort((x, y) => x.newSched - y.newSched || x.orderKey.localeCompare(y.orderKey));
  report.pinnedRows.sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id));

  return report;
}

/* ── logging ───────────────────────────────────────────────────────────────────── */

function printClientReport(client: Client, r: ClientReport) {
  console.log(`\n${"═".repeat(90)}`);
  console.log(`Client ${client.name} (${client.id})   status=${client.status}`);
  console.log("═".repeat(90));

  console.log(`\nPINNED / UNTOUCHED DATES (${r.pinnedRows.length}):`);
  if (r.pinnedRows.length === 0) {
    console.log("  (none)");
  } else {
    console.log(`  ${"ID".padEnd(22)}${"STATUS".padEnd(11)}${"DATE".padEnd(26)}TITLE / REASON`);
    for (const p of r.pinnedRows) {
      console.log(`  ${p.id.padEnd(22)}${p.status.padEnd(11)}${p.date.padEnd(26)}${short(p.title, 34)} · ${p.reason}`);
    }
  }

  console.log(`\nREASSIGNED — one per day from ${START_ARG} (${r.reassignedRows.length}):`);
  if (r.reassignedRows.length === 0) {
    console.log("  (none)");
  } else {
    console.log(`  ${"NEW DATE".padEnd(12)}${"ID".padEnd(22)}${"TEMPLATE".padEnd(18)}OLD → NEW scheduledAt`);
    for (const row of r.reassignedRows) {
      console.log(
        `  ${row.newDate.padEnd(12)}${row.id.padEnd(22)}${short(row.template, 18)}${iso(row.oldSched)} → ${iso(row.newSched)}`,
      );
      console.log(`  ${" ".repeat(12)}order: ${row.orderKey}`);
      if (row.oldTitle !== row.newTitle) {
        console.log(`  ${" ".repeat(12)}title: "${row.oldTitle}" → "${row.newTitle}"`);
      }
    }
  }

  if (r.warnings.length > 0) {
    console.log(`\nWARNINGS (${r.warnings.length}):`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  }
  if (r.otherFamilyCount > 0) {
    console.log(
      `\n  Note: ${r.otherFamilyCount} chain-type asset(s) in other families left untouched (--family ${FAMILY}).`,
    );
  }

  console.log(
    `\n  Totals — pinned/untouched: ${r.pinnedRows.length} · reassigned: ${r.reassignedRows.length} · titles cleaned: ${r.titlesCleaned} · chip backfills: ${r.chipBackfills} · warnings: ${r.warnings.length}`,
  );
}

/* ── backup ────────────────────────────────────────────────────────────────────── */

function writeBackup(writes: PlannedWrite[]): string {
  const dir = join(process.cwd(), "scripts", "backups");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `redate-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const payload = {
    meta: { startDate: START_ARG, family: FAMILY, apply: APPLY, skipIds: SKIP_IDS, generatedAt: Date.now() },
    entries: writes.map((w) => ({ id: w.id, clientId: w.clientId, before: w.before, after: w.after })),
  };
  const fd = openSync(path, "w");
  try {
    writeFileSync(fd, JSON.stringify(payload, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return path;
}

/* ── main ──────────────────────────────────────────────────────────────────────── */

async function main() {
  initAdmin();
  db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  const now = Date.now();
  console.log(
    `Mode: ${APPLY ? "APPLY — writes will be executed" : "DRY RUN — no writes"} · start=${START_ARG} · family=${FAMILY}` +
      `${ONLY_CLIENT ? ` · client=${ONLY_CLIENT}` : ""}${SKIP_IDS.length ? ` · skip=[${SKIP_IDS.join(", ")}]` : ""}`,
  );
  console.log(`Start day (server-local): ${iso(START_DAY_MS)}  ·  chain slot hour resolves to that day + 11:00 local`);

  const clientSnap = await db.collection("clients").get();
  let clients = clientSnap.docs
    .map((d) => withId<Client>(d))
    .filter((c) => c.status === "active")
    .sort((a, b) => a.name.localeCompare(b.name));
  if (ONLY_CLIENT) clients = clients.filter((c) => c.id === ONLY_CLIENT);

  console.log(`Active clients in scope: ${clients.length}${ONLY_CLIENT ? ` (filtered to ${ONLY_CLIENT})` : ""}`);

  const allWrites: PlannedWrite[] = [];
  const grand = { pinned: 0, reassigned: 0, titlesCleaned: 0, chipBackfills: 0, warnings: 0 };

  for (const client of clients) {
    const snap = await db.collection("assets").where("clientId", "==", client.id).get();
    const assets = snap.docs
      .map((d) => withId<Asset>(d))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const r = processClient(client, assets, now);
    printClientReport(client, r);
    allWrites.push(...r.writes);
    grand.pinned += r.pinnedRows.length;
    grand.reassigned += r.reassignedRows.length;
    grand.titlesCleaned += r.titlesCleaned;
    grand.chipBackfills += r.chipBackfills;
    grand.warnings += r.warnings.length;
  }

  console.log(`\n${"═".repeat(90)}`);
  console.log("GRAND TOTALS");
  console.log("═".repeat(90));
  console.log(
    `  clients: ${clients.length} · pinned/untouched: ${grand.pinned} · reassigned: ${grand.reassigned} · ` +
      `titles cleaned: ${grand.titlesCleaned} · chip backfills: ${grand.chipBackfills} · warnings: ${grand.warnings}`,
  );
  console.log(`  total assets to be written: ${allWrites.length}`);

  /* ── CRON-SAFETY ASSERTIONS (never write status; never arm /api/publish) ──────── */
  const statusWrites = allWrites.filter((w) => "status" in w.patch);
  const autoWrites = allWrites.filter((w) => w.patch.publishMode === "auto");
  const cronMatches = allWrites.filter(
    (w) =>
      (w.resStatus === "scheduled" || w.resStatus === "approved") &&
      w.resScheduledAt != null &&
      w.resScheduledAt <= now &&
      (w.resPublishMode === "auto" || w.resPublishMode == null),
  );

  console.log(`\n${"─".repeat(90)}`);
  let ok = true;
  if (statusWrites.length > 0) {
    ok = false;
    console.error(`ASSERTION FAILED: ${statusWrites.length} write(s) would set "status" — chain code must NEVER write status.`);
    for (const w of statusWrites) console.error(`  • ${w.id}`);
  }
  if (autoWrites.length > 0) {
    ok = false;
    console.error(`ASSERTION FAILED: ${autoWrites.length} write(s) would set publishMode "auto" — never allowed.`);
    for (const w of autoWrites) console.error(`  • ${w.id}`);
  }
  if (cronMatches.length > 0) {
    ok = false;
    console.error(
      `ASSERTION FAILED: ${cronMatches.length} written asset(s) would match the /api/publish cron predicate ` +
        `(status ∈ [scheduled,approved] AND scheduledAt ≤ now AND publishMode ∈ {auto, absent}):`,
    );
    for (const w of cronMatches) {
      console.error(
        `  • ${w.id} status=${w.resStatus} scheduledAt=${iso(w.resScheduledAt)} publishMode=${w.resPublishMode ?? "absent"}`,
      );
    }
  }
  if (ok) {
    console.log("cron-eligibility check: PASS (0 assets match the /api/publish predicate)");
    console.log('safety check: PASS (0 status writes, 0 publishMode "auto" writes)');
  } else {
    console.error("\nAborting — no writes performed. Resolve the above before re-running.");
    process.exit(1);
  }

  /* ── writes ────────────────────────────────────────────────────────────────────── */
  if (!APPLY) {
    console.log(`\nDRY RUN complete — nothing written. Re-run with --apply to persist ${allWrites.length} update(s).`);
    console.log("Reminder: a backup is written before the first write in --apply mode.");
    return;
  }

  if (allWrites.length === 0) {
    console.log("\nNothing to write.");
    return;
  }

  const backupPath = writeBackup(allWrites); // BEFORE the first Firestore write, fsync'd.
  console.log(`\nBackup written (before/after for ${allWrites.length} asset(s)): ${backupPath}`);

  console.log(`Applying ${allWrites.length} update(s)…`);
  let written = 0;
  for (const w of allWrites) {
    // Same semantics as data.ts updateAsset: doc.set(patch, { merge: true }). Never deletes fields.
    await db.collection("assets").doc(w.id).set({ ...w.patch, updatedAt: Date.now() }, { merge: true });
    written++;
  }
  console.log(`Done: ${written} asset(s) updated. Backup: ${backupPath}`);
}

// Only when invoked directly — importing this file must never open a Firestore
// connection, let alone write to one.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
