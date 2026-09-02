/**
 * WHY IS HOME'S CALENDAR PREVIEW EMPTY WHEN THE CALENDAR PAGE IS NOT?
 *
 * Reported 2026-09 against XO Digital in production: the client dashboard's
 * "Calendar" widget shows its empty state ("Nothing scheduled yet") while the
 * Calendar page for the same client has upcoming posts on it.
 *
 * READ-ONLY. Nothing in this file writes, deletes or updates a document; it
 * prints a table. Run it against either database — it names which one it
 * opened, and it does NOT opt into `allowDefaultProduction`, so production
 * needs FIRESTORE_DATABASE_ID="(default)" said out loud (scripts/lib/firestore-db.ts).
 *
 *   FIRESTORE_DATABASE_ID=prep       npx tsx scripts/diagnose-home-calendar-preview.ts
 *   FIRESTORE_DATABASE_ID="(default)" npx tsx scripts/diagnose-home-calendar-preview.ts "XO Digital"
 *
 * WHAT IT COMPARES. Two predicates over the same asset set:
 *
 *   HOME PREVIEW   status === "scheduled" && scheduledAt > now
 *   CALENDAR PAGE  postKind(asset) !== null, then future-dated
 *
 * `postKind` also admits `approved` + dated (as "scheduled"), `draft` + dated
 * (as "draft"), and anything carrying a publishError (as "failed"/"held"). So a
 * client whose upcoming posts are APPROVED rather than SCHEDULED has a full
 * calendar and an empty preview, and this script is what tells the two apart on
 * real data instead of from the code alone.
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
import { postKind } from "../src/lib/calendar-kind";

const CLIENT_NEEDLE = (process.argv[2] ?? "XO Digital").toLowerCase();

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
  typeof ms === "number" ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—";

async function main() {
  const dbId = resolveScriptDatabaseId();
  const db = getScriptFirestore(initAdmin());
  const now = Date.now();
  console.log(`database: ${dbId}   now: ${iso(now)}\n`);

  const clients = await db.collection("clients").get();
  const matches = clients.docs.filter((d) =>
    String(d.data().name ?? "").toLowerCase().includes(CLIENT_NEEDLE),
  );
  if (matches.length === 0) {
    console.log(`No client whose name contains ${JSON.stringify(CLIENT_NEEDLE)}.`);
    console.log("Clients present:", clients.docs.map((d) => d.data().name).join(", "));
    return;
  }

  for (const client of matches) {
    const assets = await db.collection("assets").where("clientId", "==", client.id).get();
    const rows = assets.docs.map((d) => {
      const a = d.data() as {
        status: "draft" | "approved" | "delivered" | "published" | "scheduled";
        scheduledAt?: number;
        publishedAt?: number;
        publishMode?: string;
        publishError?: string;
        title?: string;
        meta?: Record<string, unknown>;
        personalSeatId?: string;
      };
      const future = (a.scheduledAt ?? 0) > now;
      return {
        id: d.id,
        title: String(a.title ?? "").slice(0, 34),
        status: a.status,
        scheduledAt: a.scheduledAt,
        future,
        publishMode: a.publishMode ?? "",
        hasError: Boolean(a.publishError),
        kind: postKind(a),
        // The two exclusions the client projection applies on top, so a row
        // that passes both predicates and STILL does not render is visible
        // here rather than mysterious.
        metaKeys: Object.keys(a.meta ?? {}).join("|"),
        personalSeatId: a.personalSeatId ?? "",
        // What Home's widget actually tests.
        inHomePreview: a.status === "scheduled" && future,
        // What the calendar page admits, restricted to future days.
        onCalendarFuture: postKind(a) !== null && future,
      };
    });

    const futureRows = rows.filter((r) => r.future).sort((x, y) => (x.scheduledAt ?? 0) - (y.scheduledAt ?? 0));

    console.log(`── ${client.data().name} (${client.id}) ─────────────────────────`);
    console.log(`assets total: ${rows.length}   future-dated: ${futureRows.length}`);
    console.log(`  Home preview would show : ${rows.filter((r) => r.inHomePreview).length}`);
    console.log(`  Calendar page would show: ${rows.filter((r) => r.onCalendarFuture).length}\n`);

    const byStatus = new Map<string, number>();
    for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    console.log("  status histogram (all assets):", [...byStatus].map(([s, n]) => `${s}=${n}`).join(" "));

    const futureByStatus = new Map<string, number>();
    for (const r of futureRows) futureByStatus.set(r.status, (futureByStatus.get(r.status) ?? 0) + 1);
    console.log("  status histogram (future-dated):", [...futureByStatus].map(([s, n]) => `${s}=${n}`).join(" ") || "(none)");
    console.log();

    for (const r of futureRows.slice(0, 40)) {
      console.log(
        [
          iso(r.scheduledAt),
          r.status.padEnd(9),
          `kind=${String(r.kind).padEnd(11)}`,
          `home=${r.inHomePreview ? "Y" : "n"}`,
          `cal=${r.onCalendarFuture ? "Y" : "n"}`,
          r.publishMode ? `mode=${r.publishMode}` : "",
          r.hasError ? "hasPublishError" : "",
          r.metaKeys ? `meta=${r.metaKeys}` : "",
          r.personalSeatId ? `seat=${r.personalSeatId}` : "",
          r.title,
        ]
          .filter(Boolean)
          .join("  "),
      );
    }
    if (futureRows.length > 40) console.log(`  … ${futureRows.length - 40} more`);
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
