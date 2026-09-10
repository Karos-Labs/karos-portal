/**
 * One-time backfill for the X agent's onboarding-profile move (blocker 1 of
 * the x-agent-v2 storage plan): `handle` / `offLimits` / `comeAcross` used to
 * live directly on `agentIntake` docs (agent === "x"); they now live in a
 * `clientContextDocs` row of type `x-agent-profile` (see
 * upsertAgentProfileScope / getAgentProfileDocData in src/lib/data.ts).
 *
 * This copies the live values out of every existing X `agentIntake` doc
 * (company + every seat) into that new profile doc, then clears the three
 * fields off the `agentIntake` doc so the two stores never disagree
 * afterwards. `roster` and `premium` are untouched — they stay on
 * `agentIntake`.
 *
 *   npx tsx scripts/backfill-x-agent-profile-docs.ts            # dry run — prints the plan
 *   npx tsx scripts/backfill-x-agent-profile-docs.ts --apply    # writes
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed plan, confirm every client's handle/
 * off-limits/come-across values are what you expect, then re-run with --apply.
 *
 * Safe to re-run: idempotent per client — overwrites its own scope's fields
 * on the profile doc, and clearing agentIntake fields is a no-op once gone.
 *
 * RAW FIRESTORE, NOT `@/lib/data`: `src/lib/data.ts` imports the `server-only`
 * marker package, which throws unconditionally outside Next's own server
 * bundling (it only becomes a no-op under Next's "react-server" resolution
 * condition — plain `tsx` never sets that). Every other backfill script in
 * this directory that touches Firestore directly (see
 * purge-orphaned-client-docs.ts, backfill-agent-blurbs.ts) uses raw
 * firebase-admin for the same reason. The read/write shapes here are hand-kept
 * twins of getClientContextDocByTier / upsertClientContextDoc /
 * upsertAgentProfileScope / clearAgentIntakeFields in src/lib/data.ts — see the
 * AGENT_PROFILE_MARKER comment below for exactly which part must stay in sync.
 */

import path from "node:path";
import { readFileSync } from "node:fs";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(path.resolve(process.cwd(), file), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!(m[1] in process.env)) process.env[m[1]] = v;
      }
    } catch {
      // fine — a missing env file is expected in CI
    }
  }
}
loadEnv();

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

interface AgentIntakeDoc {
  clientId: string;
  agent: string;
  seatId: string | null;
  handle?: string | null;
  offLimits?: string;
  comeAcross?: string;
}

interface ClientSeatDoc {
  id: string;
  name: string;
  slug: string;
}

interface AgentProfileScopeFields {
  handle: string | null;
  offLimits: string;
  comeAcross?: string;
}

interface AgentProfileDocData {
  company: AgentProfileScopeFields | null;
  seats: Record<string, AgentProfileScopeFields & { name: string; slug: string }>;
}

// Twin of AGENT_PROFILE_MARKER / parseAgentProfileDoc / renderAgentProfileDoc
// in src/lib/data.ts — keep the marker strings and JSON shape identical, or
// the app's own read path (getAgentProfileDocData) won't parse what this
// script writes.
const AGENT_PROFILE_MARKER = "<!-- STRUCTURED:";
const AGENT_PROFILE_MARKER_END = " -->";

function parseAgentProfileDoc(content: string): AgentProfileDocData {
  const start = content.indexOf(AGENT_PROFILE_MARKER);
  const end = start === -1 ? -1 : content.indexOf(AGENT_PROFILE_MARKER_END, start);
  if (start === -1 || end === -1) return { company: null, seats: {} };
  try {
    const parsed = JSON.parse(
      content.slice(start + AGENT_PROFILE_MARKER.length, end),
    ) as Partial<AgentProfileDocData>;
    return { company: parsed.company ?? null, seats: parsed.seats ?? {} };
  } catch {
    return { company: null, seats: {} };
  }
}

function renderAgentProfileDoc(agentLabel: string, data: AgentProfileDocData): string {
  const lines: string[] = [
    `${AGENT_PROFILE_MARKER}${JSON.stringify({ company: data.company, seats: data.seats })}${AGENT_PROFILE_MARKER_END}`,
    "",
    `# ${agentLabel} agent — onboarding profile`,
    "",
    "_Portal-collected identity answers. Voice, pillars and cadence are built by the agent elsewhere and never stored here._",
  ];
  if (data.company) {
    lines.push("", "## Company page");
    lines.push(`- Handle: ${data.company.handle ?? "none yet"}`);
    if (data.company.comeAcross) lines.push(`- How they want to come across: ${data.company.comeAcross}`);
    lines.push(`- Off-limits: ${data.company.offLimits || "(none given)"}`);
  }
  for (const seat of Object.values(data.seats)) {
    lines.push("", `## Seat — ${seat.name}`);
    lines.push(`- Handle: ${seat.handle ?? "pending"}`);
    lines.push(`- Off-limits: ${seat.offLimits || "(none given)"}`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLYING x-agent-profile backfill\n" : "DRY RUN — nothing is written. Pass --apply to write.\n");

  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (raw) {
      initializeApp({ credential: cert(JSON.parse(raw)) });
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
      if (!(projectId && clientEmail && privateKey)) {
        throw new Error(
          "No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_KEY or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY in .env.local",
        );
      }
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    }
  }
  const db = getFirestore();
  console.log(`project: ${(await import("firebase-admin/app")).getApp().options.projectId ?? "(unknown)"}\n`);

  const clientsSnap = await db.collection("clients").get();
  let clientsTouched = 0;
  let scopesWritten = 0;

  for (const clientDoc of clientsSnap.docs) {
    const clientId = clientDoc.id;
    const clientName = String(clientDoc.data().name ?? clientId);

    const intakeSnap = await db
      .collection("agentIntake")
      .where("clientId", "==", clientId)
      .where("agent", "==", "x")
      .get();
    const allIntake = intakeSnap.docs.map((d) => ({ id: d.id, ...(d.data() as AgentIntakeDoc) }));
    // Only docs that still carry an identity field are worth moving — a doc
    // whose fields were already cleared (e.g. a prior --apply run) is skipped.
    const withFields = allIntake.filter(
      (i) => i.handle !== undefined || i.offLimits !== undefined || i.comeAcross !== undefined,
    );
    if (withFields.length === 0) continue;

    const seatsSnap = await db.collection("clientSeats").where("clientId", "==", clientId).get();
    const seatById = new Map<string, ClientSeatDoc>(
      seatsSnap.docs.map((d) => [d.id, { id: d.id, name: String(d.data().name), slug: String(d.data().slug) }]),
    );

    clientsTouched++;
    console.log(`\n${clientName} (${clientId}): ${withFields.length} intake doc(s) to move`);

    // clientContextDocs is keyed on (clientId, docType, tier) with docType
    // "x-agent-profile" and tier "internal-only" — read once per client, patch
    // in memory per scope below, write back once at the end (mirrors
    // upsertAgentProfileScope's read-modify-write, batched across scopes
    // instead of one round-trip per scope since we're touching every scope
    // for this client in the same pass anyway).
    const existingDocSnap = await db
      .collection("clientContextDocs")
      .where("clientId", "==", clientId)
      .where("docType", "==", "x-agent-profile")
      .where("tier", "==", "internal-only")
      .limit(1)
      .get();
    const existingDoc = existingDocSnap.empty ? null : existingDocSnap.docs[0];
    const data: AgentProfileDocData = existingDoc
      ? parseAgentProfileDoc((existingDoc.data().content as string) ?? "")
      : { company: null, seats: {} };

    for (const intake of withFields) {
      const fields: AgentProfileScopeFields = {
        handle: intake.handle ?? null,
        offLimits: intake.offLimits ?? "",
        ...(intake.comeAcross ? { comeAcross: intake.comeAcross } : {}),
      };
      if (intake.seatId === null) {
        console.log(`  company page → ${JSON.stringify(fields)}`);
        data.company = fields;
      } else {
        const seat = seatById.get(intake.seatId);
        if (!seat) {
          console.log(`  ! seat ${intake.seatId} not found — skipping (orphaned intake doc?)`);
          continue;
        }
        console.log(`  seat "${seat.name}" → ${JSON.stringify(fields)}`);
        data.seats[seat.id] = { ...fields, name: seat.name, slug: seat.slug };
      }
      scopesWritten++;
      if (apply) {
        await db.collection("agentIntake").doc(intake.id).update({
          handle: FieldValueDelete(),
          offLimits: FieldValueDelete(),
          comeAcross: FieldValueDelete(),
          updatedAt: Date.now(),
        });
      }
    }

    if (apply) {
      const now = Date.now();
      const content = renderAgentProfileDoc("X", data);
      if (existingDoc) {
        await existingDoc.ref.set(
          { content, version: ((existingDoc.data().version as number) ?? 0) + 1, updatedAt: now },
          { merge: true },
        );
      } else {
        await db.collection("clientContextDocs").add({
          clientId,
          docType: "x-agent-profile",
          tier: "internal-only",
          content,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  console.log(
    `\n${apply ? "wrote" : "would write"} ${scopesWritten} scope(s) across ${clientsTouched} client(s).`,
  );
}

// Lazily imported so the FieldValue helper doesn't need a top-level
// firebase-admin/firestore import beyond getFirestore above.
function FieldValueDelete() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("firebase-admin/firestore").FieldValue.delete();
}

// Only when invoked directly — importing this file must never open a
// Firestore connection, let alone write to one.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
