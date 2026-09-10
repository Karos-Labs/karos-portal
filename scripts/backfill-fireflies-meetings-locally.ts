/**
 * Backfill the last N days of Fireflies meetings against two fixes:
 *
 *  1. `listFirefliesTranscripts` used to query with `mine: true`, which only
 *     surfaces meetings recorded under the API key's own Fireflies seat —
 *     meetings a teammate hosted/recorded (e.g. a recurring "Karos bi-weekly")
 *     were silently missing even though an @karoslabs.com participant was on
 *     the call. Now `mine: false`, scoped by the existing domain invariant.
 *  2. `fetchFirefliesTranscript`'s participant detection used to drop any
 *     attendee without a synced calendar email, and never looked at who
 *     actually spoke (`sentences[].speaker_name`) — that's fixed too.
 *
 * This script re-walks the last N days against both fixes:
 *  - Meetings missing from Firestore entirely are ingested (same path as the
 *    live sync/webhook: analysis, client match, action items, context doc).
 *  - Meetings already in Firestore get `participants` / `meetingDate` /
 *    `durationMin` refreshed from a fresh Fireflies fetch. Summary/action
 *    items are left untouched on purpose — re-running analysis would shift
 *    actionItems[] indices and orphan any completedItems/assignments staff
 *    already made against the existing meeting.
 *
 *   npx tsx scripts/backfill-fireflies-meetings-locally.ts                 # DRY RUN, last 7 days
 *   npx tsx scripts/backfill-fireflies-meetings-locally.ts --days 14       # DRY RUN, last 14 days
 *   npx tsx scripts/backfill-fireflies-meetings-locally.ts --apply         # writes
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. Read the printed plan first.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

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
    // .env.local may not exist in CI — that's fine
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

if (process.env.ANTHROPIC_BASE_URL === "https://api.anthropic.com") {
  console.log('Ignoring a stray ANTHROPIC_BASE_URL="https://api.anthropic.com" from the ambient shell (missing /v1 — would 404 every call).');
  delete process.env.ANTHROPIC_BASE_URL;
}

function installShims() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require("module");
  const originalLoad = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === "server-only") return {};
    if (request === "next/server") {
      return { after: (fn: () => unknown) => { pendingDeferred.push(Promise.resolve().then(fn)); } };
    }
    return originalLoad.call(this, request, ...rest);
  };
}

const pendingDeferred: Promise<unknown>[] = [];
async function flushDeferred() {
  await Promise.all(pendingDeferred.splice(0));
}

function sameSet(a: string[], b: string[]): boolean {
  const as = [...new Set(a)].sort();
  const bs = [...new Set(b)].sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const daysIdx = args.indexOf("--days");
  const days = daysIdx !== -1 && args[daysIdx + 1] ? Number(args[daysIdx + 1]) : 7;
  if (!Number.isFinite(days) || days <= 0) {
    console.error("--days must be a positive number");
    process.exit(1);
    return;
  }

  if (!process.env.FIREFLIES_API_KEY) {
    console.error("FIREFLIES_API_KEY is not set (.env.local / .env) — nothing to fetch.");
    process.exit(1);
    return;
  }

  installShims();
  const { listFirefliesTranscripts, fetchFirefliesTranscript } = await import("@/lib/transcripts/fireflies");
  const { getTranscriptByExternalId, getTranscript, updateTranscript } = await import("@/lib/data");
  const { ingestTranscript, appendMeetingSignalToContextDoc } = await import("@/lib/transcripts/ingest");

  console.log(apply ? "APPLY mode — this will write to Firestore.\n" : "DRY RUN — nothing will be written. Pass --apply to write.\n");
  console.log(`Fetching Fireflies transcripts (team-wide) and filtering to the last ${days} day(s)...`);

  const cutoff = Date.now() - days * 86_400_000;
  const headers = await listFirefliesTranscripts();
  const windowed = headers
    .filter((h) => (h.date ?? 0) >= cutoff)
    .sort((a, b) => (a.date ?? 0) - (b.date ?? 0));

  console.log(`${headers.length} transcript(s) visible total; ${windowed.length} within the last ${days} day(s).\n`);

  let ingested = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const h of windowed) {
    const when = h.date ? new Date(h.date).toLocaleString("en-US") : "unknown time";
    try {
      const existing = await getTranscriptByExternalId(h.externalId);
      const full = await fetchFirefliesTranscript(h.externalId);
      if (!full) {
        console.log(`  ⚠ "${h.title}" (${when}) — could not fetch full transcript, skipping.`);
        failed++;
        continue;
      }

      if (!existing) {
        console.log(`  + "${full.title}" (${when}) — missing from Firestore, ${full.participants.length} participant(s): ${full.participants.join(", ") || "none"}`);
        if (apply) {
          const result = await ingestTranscript(full, "fireflies");
          if (!result.duplicate) {
            ingested++;
            if (result.clientId) {
              try {
                const stored = await getTranscript(result.id);
                if (stored) {
                  await appendMeetingSignalToContextDoc(result.clientId, { ...stored, id: result.id });
                  await updateTranscript(result.id, { contextDocSignalAt: Date.now() });
                }
              } catch { /* non-fatal */ }
            }
          }
        } else {
          ingested++;
        }
        continue;
      }

      const participantsChanged = !sameSet(existing.participants ?? [], full.participants);
      const dateChanged = full.date != null && existing.meetingDate !== full.date;
      const durationChanged = full.durationMin != null && existing.durationMin !== full.durationMin;

      if (!participantsChanged && !dateChanged && !durationChanged) {
        unchanged++;
        continue;
      }

      console.log(`  ~ "${existing.title}" (${when})`);
      if (participantsChanged) {
        console.log(`      participants: [${(existing.participants ?? []).join(", ")}] -> [${full.participants.join(", ")}]`);
      }
      if (dateChanged) {
        console.log(`      meetingDate: ${existing.meetingDate} -> ${full.date}`);
      }
      if (durationChanged) {
        console.log(`      durationMin: ${existing.durationMin} -> ${full.durationMin}`);
      }

      if (apply) {
        await updateTranscript(existing.id, {
          participants: full.participants,
          ...(full.date != null ? { meetingDate: full.date } : {}),
          ...(full.durationMin != null ? { durationMin: full.durationMin } : {}),
        });
      }
      updated++;
    } catch (e) {
      console.error(`  ✗ "${h.title}" (${when}) failed:`, e instanceof Error ? e.message : e);
      failed++;
    }
  }

  await flushDeferred();

  console.log("\nSummary:");
  console.log(`  ${ingested} meeting(s) ${apply ? "ingested" : "would be ingested"} (missing from Firestore)`);
  console.log(`  ${updated} meeting(s) ${apply ? "updated" : "would be updated"} (participants/time correction)`);
  console.log(`  ${unchanged} meeting(s) already correct`);
  if (failed) console.log(`  ${failed} meeting(s) failed — see above`);
  if (!apply) console.log("\nRe-run with --apply to write these changes.");
}

// Only when invoked directly — importing this file must never open a Firestore connection.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
