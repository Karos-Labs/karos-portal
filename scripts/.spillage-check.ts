/** Read-only forensics: find workspace docs whose text references ANOTHER client. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
function loadEnvFile(p: string) { try { for (const line of readFileSync(p, "utf-8").split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); if (i === -1) continue; const k = t.slice(0, i).trim(); let v = t.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[k]) process.env[k] = v; } } catch {} }
loadEnvFile(resolve(process.cwd(), ".env.local"));
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

async function main() {
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!)) });
  const db = getFirestore();
  const clientsSnap = await db.collection("clients").get();
  const clients = clientsSnap.docs.map((d) => ({ id: d.id, name: (d.data().name as string) ?? "" }));
  console.log("clients:", clients.map((c) => `${c.name} (${c.id.slice(0, 6)}…)`).join(", "));

  // Distinctive name tokens per client (skip generic words).
  const tokens = clients
    .map((c) => ({ id: c.id, name: c.name, token: c.name.toLowerCase() }))
    .filter((c) => c.token.length >= 4);

  const collections = ["clientTasks", "jobs", "assets", "clientActivityLogs"] as const;
  for (const coll of collections) {
    const snap = await db.collection(coll).get();
    let flagged = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      const docClientId = data.clientId as string | undefined;
      if (!docClientId) { console.log(`[${coll}] ${doc.id} has NO clientId (visible to nobody/everybody?) title=${JSON.stringify(data.title ?? data.name ?? "")}`); flagged++; continue; }
      const text = JSON.stringify({ t: data.title, d: data.description, c: typeof data.content === "string" ? (data.content as string).slice(0, 2000) : "" }).toLowerCase();
      for (const other of tokens) {
        if (other.id === docClientId) continue;
        if (text.includes(other.token)) {
          const owner = clients.find((c) => c.id === docClientId)?.name ?? docClientId;
          console.log(`[${coll}] doc ${doc.id} belongs to "${owner}" but mentions "${other.name}": ${JSON.stringify(data.title ?? "").slice(0, 90)}`);
          flagged++;
          break;
        }
      }
    }
    console.log(`${coll}: ${snap.size} docs scanned, ${flagged} flagged`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
