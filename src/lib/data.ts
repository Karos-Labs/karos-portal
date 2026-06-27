import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import type {
  AccessToken,
  ActionItemNotification,
  ActivityLog,
  Agent,
  AgentReviewNotification,
  AppUser,
  Asset,
  Client,
  ClientCompetitor,
  ClientContextDoc,
  ClientIntegration,
  ClientReport,
  ClientRequest,
  ContextDocTier,
  ContextItem,
  Job,
  LoginLog,
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
  clientContextDocs: () => adminDb().collection("clientContextDocs"),
  clientActivityLogs: () => adminDb().collection("clientActivityLogs"),
  clientIntegrations: () => adminDb().collection("clientIntegrations"),
  clientRequests: () => adminDb().collection("clientRequests"),
  loginLogs: () => adminDb().collection("loginLogs"),
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

/** Find a client by its join token (clientKeyId). Returns null when not found or key is falsy. */
export async function getClientByKeyId(clientKeyId: string): Promise<Client | null> {
  if (!clientKeyId) return null;
  const snap = await col.clients().where("clientKeyId", "==", clientKeyId).limit(1).get();
  return snap.empty ? null : withId<Client>(snap.docs[0]);
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

/**
 * All assets with status="scheduled" whose scheduledAt is at or before `before` (default: now).
 * Sorted oldest-first so the cron processes in chronological order.
 * Pass `limit` to cap the batch size and bound each cron tick's execution time.
 */
export async function listScheduledAssets(opts?: { before?: number; limit?: number }): Promise<Asset[]> {
  const before = opts?.before ?? Date.now();
  const snap = await col.assets().where("status", "==", "scheduled").get();
  const due = snap.docs
    .map((d) => withId<Asset>(d))
    .filter((a) => a.scheduledAt != null && a.scheduledAt <= before)
    .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
  return opts?.limit != null ? due.slice(0, opts.limit) : due;
}

/** Clear scheduledAt + scheduledPlatform and revert status to draft. */
export async function clearAssetSchedule(id: string): Promise<void> {
  const { FieldValue } = await import("firebase-admin/firestore");
  await col.assets().doc(id).update({
    status: "draft",
    scheduledAt: FieldValue.delete(),
    scheduledPlatform: FieldValue.delete(),
    updatedAt: Date.now(),
  });
}

/* --------------------------- transcripts --------------------------- */

export async function listTranscripts(opts?: {
  clientId?: string;
  /** When true, records with hiddenFromClient === true are excluded (use for client sessions). */
  excludeHiddenFromClient?: boolean;
}): Promise<Transcript[]> {
  let snap;
  if (opts?.clientId) {
    snap = await col.transcripts().where("clientId", "==", opts.clientId).get();
  } else {
    snap = await col.transcripts().get();
  }
  return snap.docs
    .map((d) => withId<Transcript>(d))
    .filter((t) => !opts?.excludeHiddenFromClient || !t.hiddenFromClient)
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

export async function getTranscriptByExternalId(externalId: string): Promise<Transcript | null> {
  const snap = await col.transcripts().where("externalId", "==", externalId).limit(1).get();
  return snap.empty ? null : withId<Transcript>(snap.docs[0]);
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

/* -------------------- client context documents ---------------------- */

export async function listClientContextDocs(
  clientId: string,
  tier?: ContextDocTier,
): Promise<ClientContextDoc[]> {
  let q = col.clientContextDocs().where("clientId", "==", clientId);
  if (tier) q = q.where("tier", "==", tier) as typeof q;
  const snap = await q.get();
  return snap.docs.map((d) => withId<ClientContextDoc>(d));
}

export async function getClientContextDoc(
  clientId: string,
  docType: string,
): Promise<ClientContextDoc | null> {
  const snap = await col
    .clientContextDocs()
    .where("clientId", "==", clientId)
    .where("docType", "==", docType)
    .limit(1)
    .get();
  return snap.empty ? null : withId<ClientContextDoc>(snap.docs[0]);
}

/** Create or overwrite one context document (keyed on clientId + docType + tier). */
export async function upsertClientContextDoc(
  doc: Omit<ClientContextDoc, "id">,
): Promise<void> {
  const snap = await col
    .clientContextDocs()
    .where("clientId", "==", doc.clientId)
    .where("docType", "==", doc.docType)
    .where("tier", "==", doc.tier)
    .limit(1)
    .get();
  if (snap.empty) {
    await col.clientContextDocs().add(doc);
  } else {
    await snap.docs[0].ref.set(doc);
  }
}

/**
 * Atomically replace all context documents for a client.
 * Deletes all existing docs for the client, then writes the new set in one batch.
 */
export async function replaceClientContextDocs(
  clientId: string,
  docs: Array<Omit<ClientContextDoc, "id">>,
): Promise<void> {
  const existing = await col.clientContextDocs().where("clientId", "==", clientId).get();
  const batch = adminDb().batch();
  for (const d of existing.docs) batch.delete(d.ref);
  for (const doc of docs) batch.set(col.clientContextDocs().doc(), doc);
  await batch.commit();
}

/* -------------------- client integrations --------------------------- */

/** List all social/channel integrations for a client. */
export async function listClientIntegrations(clientId: string): Promise<ClientIntegration[]> {
  const snap = await col.clientIntegrations().where("clientId", "==", clientId).get();
  return snap.docs
    .map((d) => withId<ClientIntegration>(d))
    .sort((a, b) => a.platform.localeCompare(b.platform));
}

/**
 * Create or overwrite one integration (keyed on clientId + platform).
 * Uses a deterministic doc ID so upserts are idempotent.
 */
export async function upsertClientIntegration(
  data: Omit<ClientIntegration, "id">,
): Promise<void> {
  const docId = `${data.clientId}_${data.platform}`;
  await col.clientIntegrations().doc(docId).set({ id: docId, ...data });
}

/**
 * Mark a platform integration as expired (token revoked / 401 from the platform API).
 * Uses merge so credentials are preserved — reconnect flow can overwrite them.
 */
export async function markIntegrationExpired(clientId: string, platform: string): Promise<void> {
  const docId = `${clientId}_${platform}`;
  await col.clientIntegrations().doc(docId).set(
    { status: "expired", expiredAt: Date.now() },
    { merge: true },
  );
}

/** Remove a platform's credentials for a client. */
export async function deleteClientIntegration(
  clientId: string,
  platform: string,
): Promise<void> {
  const docId = `${clientId}_${platform}`;
  await col.clientIntegrations().doc(docId).delete();
}

/* -------------------- client activity logs -------------------------- */

export async function createActivityLog(data: Omit<ActivityLog, "id">): Promise<string> {
  const ref = await col.clientActivityLogs().add(data);
  return ref.id;
}

export async function listClientActivityLogs(clientId: string): Promise<ActivityLog[]> {
  const snap = await col.clientActivityLogs().where("clientId", "==", clientId).get();
  return snap.docs
    .map((d) => withId<ActivityLog>(d))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/* -------------------- client access requests ------------------------ */

export async function createClientRequest(data: Omit<ClientRequest, "id">): Promise<string> {
  const ref = await col.clientRequests().add(data);
  return ref.id;
}

export async function listClientRequests(status?: ClientRequest["status"]): Promise<ClientRequest[]> {
  const q = status
    ? col.clientRequests().where("status", "==", status)
    : col.clientRequests();
  const snap = await q.get();
  return snap.docs
    .map((d) => withId<ClientRequest>(d))
    .sort((a, b) => b.submittedAt - a.submittedAt);
}

export async function updateClientRequest(id: string, data: Partial<ClientRequest>): Promise<void> {
  await col.clientRequests().doc(id).set(data, { merge: true });
}

export async function getClientRequest(id: string): Promise<ClientRequest | null> {
  const doc = await col.clientRequests().doc(id).get();
  return doc.exists ? withId<ClientRequest>(doc) : null;
}

/* ─────────────────── Notification Centre queries ────────────────────── */

/**
 * Returns all incomplete action items explicitly assigned (by userId) to `userId`
 * across non-archived transcripts. Uses the denormalised `assignedUserIds` array
 * for an efficient single Firestore query.
 */
export async function listAssignedActionItems(userId: string): Promise<ActionItemNotification[]> {
  const snap = await col.transcripts()
    .where("assignedUserIds", "array-contains", userId)
    .get();

  const notifications: ActionItemNotification[] = [];
  for (const doc of snap.docs) {
    const t = withId<Transcript>(doc);
    if (t.archived) continue;
    const items = t.actionItems ?? [];
    const assignedIds = t.actionItemAssignedUserIds ?? [];
    const completed = new Set(t.completedItems ?? []);
    items.forEach((text, i) => {
      if (assignedIds[i] === userId && !completed.has(i)) {
        notifications.push({
          transcriptId: t.id,
          transcriptTitle: t.title,
          itemIndex: i,
          text,
          meetingDate: t.meetingDate,
          clientId: t.clientId,
        });
      }
    });
  }
  return notifications;
}

/**
 * Returns jobs for a client that are in the `review` state — i.e. the AI has
 * finished generating content and the client needs to approve or reject it.
 */
export async function listReviewJobs(clientId: string): Promise<AgentReviewNotification[]> {
  const snap = await col.jobs()
    .where("clientId", "==", clientId)
    .where("status", "==", "review")
    .get();
  return snap.docs.map((d) => {
    const j = withId<Job>(d);
    return { jobId: j.id, title: j.title, agentName: j.agentName, updatedAt: j.updatedAt };
  });
}

/* ─────────────────────── Login audit logs ───────────────────────────── */

export async function listLoginLogs(opts?: { since?: number; limit?: number }): Promise<LoginLog[]> {
  const limit = opts?.limit ?? 500;
  let q = col.loginLogs().orderBy("timestamp", "desc") as FirebaseFirestore.Query;
  if (opts?.since) q = q.where("timestamp", ">=", opts.since);
  const snap = await q.limit(limit).get();
  return snap.docs.map((d) => withId<LoginLog>(d));
}
