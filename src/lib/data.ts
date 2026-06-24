import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import type {
  AccessToken,
  Agent,
  AppUser,
  Asset,
  Client,
  ClientCompetitor,
  ClientReport,
  ContextItem,
  Job,
  Role,
  Transcript,
} from "@/lib/types";

/* ----------------------------- helpers ----------------------------- */

function withId<T>(doc: FirebaseFirestore.DocumentSnapshot): T {
  return { id: doc.id, ...(doc.data() as object) } as T;
}

const col = {
  users: () => adminDb().collection("users"),
  clients: () => adminDb().collection("clients"),
  agents: () => adminDb().collection("agents"),
  jobs: () => adminDb().collection("jobs"),
  assets: () => adminDb().collection("assets"),
  transcripts: () => adminDb().collection("transcripts"),
  accessTokens: () => adminDb().collection("accessTokens"),
  contextItems: () => adminDb().collection("contextItems"),
  clientReports: () => adminDb().collection("clientReports"),
  clientCompetitors: () => adminDb().collection("clientCompetitors"),
};

/* ------------------------------ users ------------------------------ */

export async function getUser(uid: string): Promise<AppUser | null> {
  const doc = await col.users().doc(uid).get();
  return doc.exists ? (doc.data() as AppUser) : null;
}

export async function getUserByEmail(email: string): Promise<AppUser | null> {
  const snap = await col.users().where("email", "==", email.toLowerCase()).limit(1).get();
  return snap.empty ? null : (snap.docs[0].data() as AppUser);
}

export async function upsertUser(user: AppUser): Promise<void> {
  await col.users().doc(user.uid).set(user, { merge: true });
}

export async function deleteUser(uid: string): Promise<void> {
  await col.users().doc(uid).delete();
}

export async function listUsers(role?: Role): Promise<AppUser[]> {
  const q = role ? col.users().where("role", "==", role) : col.users();
  const snap = await q.get();
  return snap.docs
    .map((d) => d.data() as AppUser)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function countUsers(): Promise<number> {
  const snap = await col.users().count().get();
  return snap.data().count;
}

/* ----------------------------- clients ----------------------------- */

export async function listClients(opts?: { employeeId?: string }): Promise<Client[]> {
  let snap;
  if (opts?.employeeId) {
    snap = await col
      .clients()
      .where("assignedEmployeeIds", "array-contains", opts.employeeId)
      .get();
  } else {
    snap = await col.clients().get();
  }
  return snap.docs
    .map((d) => withId<Client>(d))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getClient(id: string): Promise<Client | null> {
  const doc = await col.clients().doc(id).get();
  return doc.exists ? withId<Client>(doc) : null;
}

export async function createClient(data: Omit<Client, "id">): Promise<string> {
  const ref = await col.clients().add(data);
  return ref.id;
}

export async function updateClient(id: string, data: Partial<Client>): Promise<void> {
  await col.clients().doc(id).set(data, { merge: true });
}

/** Find the best-matching client for a set of participant emails (by domain). */
export async function matchClientByDomains(domains: string[]): Promise<Client | null> {
  if (!domains.length) return null;
  const clients = await listClients();
  for (const c of clients) {
    const cd = (c.domains ?? []).map((d) => d.toLowerCase());
    if (domains.some((d) => cd.includes(d))) return c;
  }
  return null;
}

/* ------------------------------ agents ----------------------------- */

export async function listAgents(opts?: { status?: Agent["status"] }): Promise<Agent[]> {
  const snap = await col.agents().get();
  let agents = snap.docs.map((d) => withId<Agent>(d));
  // Default a missing status to "published" so any pre-existing/seeded agent stays live.
  if (opts?.status) agents = agents.filter((a) => (a.status ?? "published") === opts.status);
  return agents.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getAgent(id: string): Promise<Agent | null> {
  const doc = await col.agents().doc(id).get();
  return doc.exists ? withId<Agent>(doc) : null;
}

export async function createAgent(data: Omit<Agent, "id">): Promise<string> {
  const ref = await col.agents().add(data);
  return ref.id;
}

export async function updateAgent(id: string, data: Partial<Agent>): Promise<void> {
  await col.agents().doc(id).set(data, { merge: true });
}

export async function deleteAgent(id: string): Promise<void> {
  await col.agents().doc(id).delete();
}

/**
 * Fetch a system agent by its fixed document ID (e.g. "intel-report-agent").
 * Semantic alias for getAgent() — no extra filtering; the fixed doc ID is the contract.
 */
export async function getSystemAgent(id: string): Promise<Agent | null> {
  return getAgent(id);
}

/** Create or fully overwrite a system agent document (uses the provided id as doc key). */
export async function upsertSystemAgent(id: string, data: Omit<Agent, "id">): Promise<void> {
  await col.agents().doc(id).set({ id, ...data });
}

export async function bumpAgentRun(id: string): Promise<void> {
  const { FieldValue } = await import("firebase-admin/firestore");
  await col.agents().doc(id).set(
    { runCount: FieldValue.increment(1), updatedAt: Date.now() },
    { merge: true },
  );
}

/* ------------------------------- jobs ------------------------------ */

export async function listJobs(opts?: { clientId?: string }): Promise<Job[]> {
  let snap;
  if (opts?.clientId) {
    snap = await col.jobs().where("clientId", "==", opts.clientId).get();
  } else {
    snap = await col.jobs().get();
  }
  return snap.docs
    .map((d) => withId<Job>(d))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getJob(id: string): Promise<Job | null> {
  const doc = await col.jobs().doc(id).get();
  return doc.exists ? withId<Job>(doc) : null;
}

export async function createJob(data: Omit<Job, "id">): Promise<string> {
  const ref = await col.jobs().add(data);
  return ref.id;
}

export async function updateJob(id: string, data: Partial<Job>): Promise<void> {
  await col.jobs().doc(id).set(data, { merge: true });
}

/* ------------------------------ assets ----------------------------- */

export async function listAssets(opts?: { clientId?: string }): Promise<Asset[]> {
  let snap;
  if (opts?.clientId) {
    snap = await col.assets().where("clientId", "==", opts.clientId).get();
  } else {
    snap = await col.assets().get();
  }
  return snap.docs
    .map((d) => withId<Asset>(d))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getAsset(id: string): Promise<Asset | null> {
  const doc = await col.assets().doc(id).get();
  return doc.exists ? withId<Asset>(doc) : null;
}

export async function createAsset(data: Omit<Asset, "id">): Promise<string> {
  const ref = await col.assets().add(data);
  return ref.id;
}

export async function updateAsset(id: string, data: Partial<Asset>): Promise<void> {
  await col.assets().doc(id).set(data, { merge: true });
}

/* --------------------------- transcripts --------------------------- */

export async function listTranscripts(opts?: { clientId?: string }): Promise<Transcript[]> {
  let snap;
  if (opts?.clientId) {
    snap = await col.transcripts().where("clientId", "==", opts.clientId).get();
  } else {
    snap = await col.transcripts().get();
  }
  return snap.docs
    .map((d) => withId<Transcript>(d))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getTranscript(id: string): Promise<Transcript | null> {
  const doc = await col.transcripts().doc(id).get();
  return doc.exists ? withId<Transcript>(doc) : null;
}

export async function createTranscript(data: Omit<Transcript, "id">): Promise<string> {
  const ref = await col.transcripts().add(data);
  return ref.id;
}

export async function updateTranscript(id: string, data: Partial<Transcript>): Promise<void> {
  await col.transcripts().doc(id).set(data, { merge: true });
}

/* -------------------------- context items -------------------------- */

export async function listContextItems(opts: { clientId: string }): Promise<ContextItem[]> {
  const snap = await col.contextItems().where("clientId", "==", opts.clientId).get();
  return snap.docs
    .map((d) => withId<ContextItem>(d))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getContextItem(id: string): Promise<ContextItem | null> {
  const doc = await col.contextItems().doc(id).get();
  return doc.exists ? withId<ContextItem>(doc) : null;
}

export async function createContextItem(data: Omit<ContextItem, "id">): Promise<string> {
  const ref = await col.contextItems().add(data);
  return ref.id;
}

export async function updateContextItem(id: string, data: Partial<ContextItem>): Promise<void> {
  await col.contextItems().doc(id).set(data, { merge: true });
}

export async function deleteContextItem(id: string): Promise<void> {
  await col.contextItems().doc(id).delete();
}

/* -------------------------- access tokens -------------------------- */

export async function createAccessToken(data: Omit<AccessToken, "id">): Promise<string> {
  const ref = await col.accessTokens().add(data);
  return ref.id;
}

export async function listAccessTokens(uid: string): Promise<AccessToken[]> {
  const snap = await col.accessTokens().where("uid", "==", uid).get();
  return snap.docs
    .map((d) => withId<AccessToken>(d))
    .filter((t) => !t.revoked)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function findAccessTokenByHash(tokenHash: string): Promise<AccessToken | null> {
  const snap = await col.accessTokens().where("tokenHash", "==", tokenHash).limit(1).get();
  return snap.empty ? null : withId<AccessToken>(snap.docs[0]);
}

export async function updateAccessToken(id: string, data: Partial<AccessToken>): Promise<void> {
  await col.accessTokens().doc(id).set(data, { merge: true });
}

/* ----------------------- intelligence reports ----------------------- */

/** Uses clientId as the document ID (1:1 relationship). */
export async function getClientReport(clientId: string): Promise<ClientReport | null> {
  const doc = await col.clientReports().doc(clientId).get();
  return doc.exists ? ({ id: doc.id, ...doc.data() } as ClientReport) : null;
}

/** Save (or overwrite) the report; document ID = clientId. */
export async function upsertClientReport(data: Omit<ClientReport, "id">): Promise<void> {
  await col.clientReports().doc(data.clientId).set({ id: data.clientId, ...data });
}

/* --------------------- client competitors -------------------------- */

export async function listClientCompetitors(clientId: string): Promise<ClientCompetitor[]> {
  const snap = await col.clientCompetitors().where("clientId", "==", clientId).get();
  return snap.docs
    .map((d) => withId<ClientCompetitor>(d))
    .sort((a, b) => (a.company ?? "").localeCompare(b.company ?? ""));
}

export async function createClientCompetitor(data: Omit<ClientCompetitor, "id">): Promise<string> {
  const ref = await col.clientCompetitors().add(data);
  return ref.id;
}

export async function updateClientCompetitor(id: string, data: Partial<ClientCompetitor>): Promise<void> {
  await col.clientCompetitors().doc(id).set(data, { merge: true });
}

export async function deleteClientCompetitor(id: string): Promise<void> {
  await col.clientCompetitors().doc(id).delete();
}

/** Delete all report-imported competitors for a client (used before re-import to prevent duplicates). */
export async function deleteReportCompetitors(clientId: string): Promise<void> {
  const snap = await col
    .clientCompetitors()
    .where("clientId", "==", clientId)
    .where("source", "==", "report")
    .get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

/**
 * Atomically replace all report-imported competitors for a client.
 * Uses a single Firestore write batch so a partial failure cannot leave a mix
 * of old and new rows — either all rows are replaced or none are changed.
 */
export async function replaceReportCompetitors(
  clientId: string,
  rows: Array<Omit<ClientCompetitor, "id">>,
): Promise<void> {
  const existing = await col
    .clientCompetitors()
    .where("clientId", "==", clientId)
    .where("source", "==", "report")
    .get();

  const batch = adminDb().batch();
  for (const doc of existing.docs) {
    batch.delete(doc.ref);
  }
  for (const row of rows) {
    batch.set(col.clientCompetitors().doc(), row);
  }
  await batch.commit();
}
