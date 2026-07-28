/**
 * Grant every enabled custom agent to every client.
 *
 * Albert, 2026-07-28: "All the agents that we have right now should be granted
 * to all the clients. However, there could be an option when we create a new
 * agent in the future that we make it available only to a certain set of
 * clients." So this is a one-off levelling of the CURRENT roster — it does not
 * change the model: `client.customAgentIds` stays the per-client grant list, and
 * a future agent can still be handed to a subset by simply not running this for
 * it.
 *
 * Additive only: existing grants are preserved, ids are de-duplicated, and no
 * client loses an agent. Disabled agents are skipped (an agent is disabled when
 * we don't want it runnable anywhere).
 *
 * Dry run by default. Reversible: `--revoke-ids a,b` removes specific ids again.
 *
 *   npx tsx scripts/grant-all-agents.ts            # plan only, writes nothing
 *   npx tsx scripts/grant-all-agents.ts --apply    # perform the writes
 */
import path from "node:path";
import { readFileSync } from "node:fs";

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

async function main() {
  const apply = process.argv.includes("--apply");
  const revokeArg = process.argv.find((a) => a.startsWith("--revoke-ids="));
  const revokeIds = revokeArg ? revokeArg.split("=")[1].split(",").filter(Boolean) : [];

  console.log(
    apply ? "APPLYING agent grants\n" : "DRY RUN — nothing is written. Pass --apply to write.\n",
  );

  loadEnv();
  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!)) });
  const db = getFirestore();

  const agentSnap = await db.collection("customAgents").get();
  const enabled = agentSnap.docs.filter((d) => d.data().enabled !== false);
  const grantIds = enabled.map((d) => d.id);

  console.log(`Agents: ${agentSnap.size} total, ${enabled.length} enabled`);
  for (const d of enabled) console.log(`  · ${d.data().name}  (${d.id})`);
  if (agentSnap.size !== enabled.length) {
    for (const d of agentSnap.docs.filter((x) => x.data().enabled === false)) {
      console.log(`  ✗ SKIPPED (disabled): ${d.data().name}  (${d.id})`);
    }
  }

  const clientSnap = await db.collection("clients").get();
  console.log(`\nClients: ${clientSnap.size}\n`);

  let writes = 0;
  for (const c of clientSnap.docs) {
    const name = c.data().name ?? c.id;
    const current: string[] = c.data().customAgentIds ?? [];

    if (revokeIds.length) {
      const next = current.filter((id) => !revokeIds.includes(id));
      if (next.length !== current.length) {
        console.log(`  ${name}: revoking ${current.length - next.length} → ${next.length} granted`);
        if (apply) await c.ref.update({ customAgentIds: next, updatedAt: Date.now() });
        writes++;
      }
      continue;
    }

    const missing = grantIds.filter((id) => !current.includes(id));
    if (missing.length === 0) {
      console.log(`  ${name}: already has all ${current.length} — no change`);
      continue;
    }
    const next = [...new Set([...current, ...grantIds])];
    console.log(`  ${name}: ${current.length} → ${next.length} granted (+${missing.length})`);
    if (apply) await c.ref.update({ customAgentIds: next, updatedAt: Date.now() });
    writes++;
  }

  console.log(
    apply
      ? `\nAPPLIED — ${writes} client document(s) updated.`
      : `\nDRY RUN — ${writes} client document(s) would be updated. Re-run with --apply.`,
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
