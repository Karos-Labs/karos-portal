/**
 * READ-ONLY audit: which plannedScheduledRuns rows disagree with themselves
 * about who pays.
 *
 * WHY THIS EXISTS
 * `PlannedScheduledRun.billClientCredits` is now the single decision for whether
 * a scheduled fire spends the client's credits (/api/run-scheduled passes it to
 * the submit core as `bill`). Before that, the core charged on
 * `isBillableClientActor(actorFor(run))` — an actor resolved from `createdBy` —
 * while the configure action recomputed the FLAG on every save, create and edit
 * alike. `createdBy` is written once and never rewritten, so any row whose flag
 * and creator disagree was produced by an EDIT from a different party than the
 * creator, and that row has been billing the wrong way ever since.
 *
 * On a fresh create the two always agree (both are written from the same actor
 * in the same call), so DISAGREEMENT IS THE SIGNAL.
 *
 * WHAT CHANGES FOR EACH ROW once the flag governs:
 *   flag true  + non-billable creator → was FREE, now CHARGES the client.
 *   flag false + billable creator     → was CHARGED, now FIRES FREE.
 * Both directions need a human decision, which is why this script only REPORTS.
 *
 * WHY IT DOES NOT AUTO-CORRECT
 * `createdBy` cannot reconstruct the original intent on its own. An admin in
 * "View as Client" creates the row under the CLIENT's uid, so replaying
 * `isBillableClientActor(getUser(createdBy))` reads that stored client account as
 * billable and would "correct" a deliberately free schedule into a charging one.
 * For those rows the stored `false` is the truth and the creator is the
 * misleading field. Only someone who knows the commercial arrangement can tell
 * the two apart — so this prints the pair and the consequence, and writes
 * nothing.
 *
 * Writes nothing. No transactions, no batches, no `.set`/`.update`/`.delete`
 * anywhere in this file. Same env-loading + firebase-admin init pattern as
 * scripts/check-scheduled-runs.ts.
 *
 * Usage: npx tsx scripts/audit-schedule-billing-flags.ts
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
      initializeApp({ credential: cert(JSON.parse(raw)) });
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
      if (!projectId || !clientEmail || !privateKey) {
        throw new Error("No Firebase credentials found in .env.local");
      }
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    }
  }
  return getFirestore();
}

function fmt(at: number | null | undefined): string {
  if (at == null) return "-";
  return new Date(at).toLocaleString("en-US", { hour12: false });
}

async function main() {
  const db = initAdmin();

  const [runsSnap, usersSnap, clientsSnap] = await Promise.all([
    db.collection("plannedScheduledRuns").get(),
    db.collection("users").get(),
    db.collection("clients").get(),
  ]);

  const users = new Map(usersSnap.docs.map((d) => [d.id, d.data()]));
  const clientName = new Map(
    clientsSnap.docs.map((d) => [d.id, (d.data().name as string) ?? d.id]),
  );

  /** The charge decision the OLD code made: the resolved creator's own role. */
  function creatorWasBillable(createdBy: string): { billable: boolean; who: string } {
    const u = users.get(createdBy);
    if (!u) {
      // The account is gone, so the cron builds a synthetic actor whose role it
      // picks FROM THE FLAG — meaning the old code's answer for these rows was
      // the flag all along, and nothing about them changes.
      return { billable: false, who: `${createdBy || "(none)"} — account deleted` };
    }
    const billable = u.role === "CLIENT_USER" && !u.impersonatedBy;
    return { billable, who: `${u.name ?? createdBy} (${u.role})` };
  }

  const agree: string[] = [];
  const legacy: string[] = [];
  const startsCharging: string[] = [];
  const stopsCharging: string[] = [];
  const orphanCreator: string[] = [];

  for (const doc of runsSnap.docs) {
    const r = doc.data();
    const flag = r.billClientCredits;
    const { billable, who } = creatorWasBillable(r.createdBy);
    const outputs = r.outputsPerRun ?? 1;
    const label =
      `  [${doc.id}] ${clientName.get(r.clientId) ?? r.clientId} · ${r.agentName} (${r.cadence}, ${r.status})` +
      `\n      billClientCredits: ${flag === undefined ? "undefined (legacy row)" : flag}` +
      `\n      createdBy:         ${r.createdBy} — ${who}` +
      `\n      outputsPerRun:     ${outputs}` +
      `\n      created / updated: ${fmt(r.createdAt)} / ${fmt(r.updatedAt)}` +
      `\n      lastRunAt:         ${fmt(r.lastRunAt)}`;

    if (flag === undefined) {
      legacy.push(label);
      continue;
    }
    if (!users.has(r.createdBy)) {
      orphanCreator.push(label);
      continue;
    }
    if (flag === billable) {
      agree.push(label);
    } else if (flag === true) {
      startsCharging.push(label);
    } else {
      stopsCharging.push(label);
    }
  }

  console.log(`\n=== plannedScheduledRuns: ${runsSnap.size} rows ===`);

  console.log(
    `\n--- FLAG AND CREATOR AGREE: ${agree.length} — nothing changes for these ---`,
  );
  for (const l of agree) console.log(l);

  console.log(
    `\n--- LEGACY (flag undefined): ${legacy.length} — nothing changes; the cron falls back to the creator's role, exactly as today ---`,
  );
  for (const l of legacy) console.log(l);

  console.log(
    `\n--- CREATOR ACCOUNT DELETED: ${orphanCreator.length} — nothing changes; the cron's synthetic actor already took its role from the flag ---`,
  );
  for (const l of orphanCreator) console.log(l);

  console.log(
    `\n>>> STARTS CHARGING (flag true, creator not billable): ${startsCharging.length} <<<` +
      `\n    These fired FREE and will now charge the client. Correct if the client` +
      `\n    was quoted a weekly price on the pace dialog (the flag is their intent);` +
      `\n    wrong if the pace is agency overhead a client happened to re-save, in` +
      `\n    which case the flag should be set to false.`,
  );
  for (const l of startsCharging) console.log(l);

  console.log(
    `\n>>> STOPS CHARGING (flag false, creator billable): ${stopsCharging.length} <<<` +
      `\n    These charged the client and will now fire free. Two sources, and they` +
      `\n    want opposite corrections:` +
      `\n      · a client-created schedule that staff later edited — the flag was` +
      `\n        clobbered and should be set back to TRUE;` +
      `\n      · a schedule created by an admin in "View as Client" — createdBy is` +
      `\n        the client but the flag is right, so LEAVE IT. These rows were the` +
      `\n        ones being charged in error, and the fix already stops that.` +
      `\n    Check the credit ledger (operation=custom_agent_run, agentId) against` +
      `\n    the client's contract before deciding either way.`,
  );
  for (const l of stopsCharging) console.log(l);

  console.log(
    `\nNo writes were made. Any correction is a deliberate, per-row decision.\n`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
