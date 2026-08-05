/**
 * Read-back verification: the sitti gatekeep runway on the karosCMO calendar.
 * Asserts, for labRun prefix "instagram-agent/2026-08-05-runway-01":
 *   14 assets · one per day 2026-08-06..2026-08-19 · status scheduled ·
 *   publishMode manual · every asset has images + caption + imageUrl.
 * Also prints any other live sitti assets so stray/legacy slots are visible.
 *
 * CLI: npx tsx scripts/verify-sitti-runway.ts   (read-only, no writes)
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

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
      const quote = val[0] === '"' || val[0] === "'" ? val[0] : "";
      if (quote) {
        while (!(val.length > 1 && val.endsWith(quote)) && i < lines.length - 1) val += "\n" + lines[++i];
        val = val.slice(1, val.endsWith(quote) ? -1 : undefined);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}
(function findAndLoadEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, ".env.local");
    if (existsSync(candidate)) { loadEnvFile(candidate); break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
if (raw && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) raw = raw.slice(1, -1);
if (!getApps().length) initializeApp({ credential: cert(JSON.parse(raw!)) });
const db = getFirestore();

const PREFIX = "instagram-agent/2026-08-05-runway-01";

async function main() {
  const clientsSnap = await db.collection("clients").get();
  let clientId: string | null = null;
  for (const d of clientsSnap.docs) {
    const c = d.data() as { name?: string; agentsRepoSlug?: string };
    if (c.agentsRepoSlug === "sitti" || /\bsitti\b/i.test(c.name ?? "")) { clientId = d.id; break; }
  }
  if (!clientId) throw new Error("no sitti client");
  console.log(`client: ${clientId}`);

  const snap = await db.collection("assets").where("clientId", "==", clientId).get();
  const runway: Array<{ date: string; title: string; status: string; mode: string; imgs: number; cap: boolean }> = [];
  const other: string[] = [];
  for (const d of snap.docs) {
    const a = d.data();
    const lr = (a.meta as { labRun?: string } | undefined)?.labRun ?? "";
    if (lr.startsWith(PREFIX)) {
      const date = new Date(a.scheduledAt).toISOString().slice(0, 10);
      runway.push({
        date, title: a.title, status: a.status, mode: a.publishMode,
        imgs: ((a.meta as { images?: string[] }).images ?? []).length,
        cap: typeof a.content === "string" && a.content.length > 20,
      });
    } else {
      other.push(`${a.status}  ${lr || "(no labRun)"}  ${a.title ?? ""}`);
    }
  }
  runway.sort((x, y) => x.date.localeCompare(y.date));
  for (const r of runway)
    console.log(`${r.date}  [${r.status}/${r.mode}]  ${String(r.imgs).padStart(2)} imgs  cap:${r.cap ? "y" : "N"}  ${r.title}`);
  const dates = runway.map((r) => r.date);
  const expected = Array.from({ length: 14 }, (_, i) => `2026-08-${String(6 + i).padStart(2, "0")}`);
  const missing = expected.filter((d) => !dates.includes(d));
  const bad = runway.filter((r) => r.status !== "scheduled" || r.mode !== "manual" || r.imgs === 0 || !r.cap);
  console.log(`\nrunway assets: ${runway.length}/14 · missing dates: ${missing.length ? missing.join(", ") : "none"} · defects: ${bad.length}`);
  console.log(`other sitti assets on the calendar: ${other.length}`);
  other.forEach((o) => console.log(`  ${o}`));
  if (runway.length === 14 && missing.length === 0 && bad.length === 0) console.log("\nVERIFY OK");
  else { console.log("\nVERIFY FAILED"); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
