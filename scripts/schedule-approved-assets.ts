/**
 * One-time backfill: put already-approved assets onto the content calendar.
 *
 * The app used to approve a post (status="approved") without scheduling it, so
 * approved posts never appeared on the calendar (which renders status="scheduled"
 * + scheduledAt). Approval now schedules in the same step, but posts approved
 * before that change are stranded. This script schedules each one:
 *
 *   - Uses the asset's recommendedAt when it's still in the future.
 *   - Otherwise picks the next optimal slot for its type, spreading a client's
 *     batch across successive windows (so 8 posts don't stack on one timestamp).
 *   - Sets status="scheduled", publishMode="manual" (on the calendar, never
 *     auto-posts — staff push it live).
 *   - Leaves non-schedulable types (e.g. notes) approved and untouched.
 *
 * Run with:
 *   npx tsx scripts/schedule-approved-assets.ts          # apply
 *   npx tsx scripts/schedule-approved-assets.ts --dry     # preview only
 *
 * Reads Firebase credentials from .env.local automatically.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { recommendPublishTime } from "../src/lib/scheduling";
import type { AssetType } from "../src/lib/types";

// ── Load .env.local before any Firebase imports ──────────────────────────────
// Handles multi-line quoted values (e.g. a pretty-printed service-account JSON):
// once a value opens with a quote, keep consuming lines until the matching quote.
function loadEnvFile(path: string) {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return; // .env.local may not exist in CI or Vercel — that's fine
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    const quote = val[0] === '"' || val[0] === "'" ? val[0] : "";
    if (quote) {
      // Accumulate lines until the closing quote (value may span many lines).
      while (!(val.length > 1 && val.endsWith(quote)) && i < lines.length - 1) {
        val += "\n" + lines[++i];
      }
      val = val.slice(1, val.endsWith(quote) ? -1 : undefined);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

// ── Firebase Admin SDK ───────────────────────────────────────────────────────
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length) return;
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  // A shell-exported value can arrive wrapped in surrounding quotes.
  if (raw && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) {
    raw = raw.slice(1, -1);
  }
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

initAdmin();
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

const DRY_RUN = process.argv.includes("--dry");
const SCHEDULE_LEAD_MS = 3 * 60 * 60 * 1000; // mirror scheduling.ts MIN_LEAD_MS

interface AssetRow {
  id: string;
  clientId: string;
  type: AssetType;
  title?: string;
  status: string;
  scheduledAt?: number | null;
  recommendedAt?: number | null;
  recommendedReason?: string;
  scheduledPlatform?: string;
  createdAt?: number;
}

async function main() {
  console.log(`🗓  Scheduling approved assets${DRY_RUN ? " (dry run)" : ""}…\n`);

  const snap = await db.collection("assets").where("status", "==", "approved").get();
  const rows: AssetRow[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AssetRow, "id">) }));

  // Only those not already on the calendar.
  const pending = rows.filter((a) => a.scheduledAt == null);
  console.log(`   ${rows.length} approved asset(s); ${pending.length} without a schedule.\n`);

  // Group by client so each client's batch spreads across successive slots.
  const byClient = new Map<string, AssetRow[]>();
  for (const a of pending) {
    const list = byClient.get(a.clientId) ?? [];
    list.push(a);
    byClient.set(a.clientId, list);
  }

  const summary = { scheduled: 0, skipped: 0, failed: 0 };

  for (const [clientId, list] of byClient) {
    // Oldest first so the earliest-created post takes the earliest slot.
    list.sort((a, b) => (a.recommendedAt ?? a.createdAt ?? 0) - (b.recommendedAt ?? b.createdAt ?? 0));
    // Spread each client's batch across successive optimal windows. We ignore the
    // stored recommendedAt here because the webhook stamps a whole batch with the
    // same index-0 slot — trusting it would stack every post on one timestamp.
    let index = 0;
    for (const a of list) {
      const label = `[${clientId}] ${a.type} "${(a.title ?? "").slice(0, 48)}"`;
      try {
        const rec = recommendPublishTime({ assetType: a.type, platform: a.scheduledPlatform, index });
        const at = rec?.at;
        const reason = rec?.reason;
        if (at == null) {
          console.log(`${label} — not schedulable, left approved`);
          summary.skipped++;
          continue;
        }
        index++; // only advance the batch cursor for schedulable types

        const when = new Date(at).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        if (DRY_RUN) {
          console.log(`${label} → ${when}`);
        } else {
          await db.collection("assets").doc(a.id).update({
            status: "scheduled",
            scheduledAt: at,
            publishMode: "manual",
            recommendedAt: at,
            ...(reason ? { recommendedReason: reason } : {}),
            updatedAt: Date.now(),
          });
          console.log(`${label} ✅ scheduled → ${when}`);
        }
        summary.scheduled++;
      } catch (err) {
        console.error(`${label} ❌ Failed:`, err);
        summary.failed++;
      }
    }
  }

  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log(`   Scheduled: ${summary.scheduled}${DRY_RUN ? " (would)" : ""}`);
  console.log(`   Skipped:   ${summary.skipped} (non-schedulable)`);
  console.log(`   Failed:    ${summary.failed}`);
  console.log("────────────────────────────────────────────────────────\n");
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
