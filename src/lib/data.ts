import "server-only";

import { cache } from "react";
import { adminDb } from "@/lib/firebase/admin";
import type {
  AccessToken,
  ActionItem,
  ActionItemNotification,
  ActivityLog,
  Agent,
  Feedback,
  AgentReviewNotification,
  AppUser,
  Asset,
  Client,
  ClientCompetitor,
  ClientContextDoc,
  ClientIntegration,
  ClientReport,
  ClientRequest,
  ClientSettings,
  ClientTask,
  ContextDocTier,
  ContextItem,
  Job,
  JobStatus,
  LoginLog,
  Role,
  TaskComment,
  TaskStatus,
  Transcript,
} from "@/lib/types";
import type { ContentCatalog, ContentEngineConfig, LedgerEntry } from "@/lib/content-engine/types";
import type { NewsletterConfig } from "@/lib/newsletter/types";

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
  // Content Engine (native e12 port). Catalog + config are keyed by clientId
  // (one doc per client); the ledger is an append-only collection.
  contentCatalogs: () => adminDb().collection("contentCatalogs"),
  contentEngineConfigs: () => adminDb().collection("contentEngineConfigs"),
  contentLedger: () => adminDb().collection("contentLedger"),
  // Newsletter + Blog Engine (native e11 port). Brand + content-foundation, one doc per client.
  newsletterConfigs: () => adminDb().collection("newsletterConfigs"),
  clientTasks: () => adminDb().collection("clientTasks"),
  taskComments: () => adminDb().collection("taskComments"),
  clientSettings: () => adminDb().collection("clientSettings"),
  feedbacks: () => adminDb().collection("feedbacks"),
  // Managed meeting action items (status / assignee / comments / audit history).
  actionItems: () => adminDb().collection("actionItems"),
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

export const getClient = cache(async (id: string): Promise<Client | null> => {
  const doc = await col.clients().doc(id).get();
  return doc.exists ? withId<Client>(doc) : null;
});

export async function createClient(data: Omit<Client, "id">): Promise<string> {
  const ref = await col.clients().add(data);
  return ref.id;
}

export async function updateClient(id: string, data: Partial<Client>): Promise<void> {
  await col.clients().doc(id).set(data, { merge: true });
}

export async function deleteClient(id: string): Promise<void> {
  await col.clients().doc(id).delete();
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

/** Resolve an imported karos-labs agent by its provenance key (e.g. "karos-intel"). */
export async function getAgentByLabsSkillId(labsSkillId: string): Promise<Agent | null> {
  const snap = await col.agents().where("labsSkillId", "==", labsSkillId).limit(1).get();
  return snap.empty ? null : withId<Agent>(snap.docs[0]);
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

/** Deletes the job record only — assets created by the job keep living on /assets. */
export async function deleteJob(id: string): Promise<void> {
  await col.jobs().doc(id).delete();
}

/**
 * Managed (agent-service) jobs still non-terminal and last updated before
 * `staleBefore` — candidates for webhook-miss reconciliation.
 */
export async function listStuckManagedJobs(staleBefore: number, limit = 25): Promise<Job[]> {
  const snap = await col
    .jobs()
    .where("agentId", "==", "agent-service")
    .where("status", "in", ["queued", "running"])
    .get();
  return snap.docs
    .map((d) => withId<Job>(d))
    .filter((j) => j.external?.serviceJobId && (j.updatedAt ?? j.createdAt) < staleBefore)
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
    .slice(0, limit);
}

/** Look up the platform job that mirrors an external agent-service job. */
export async function getJobByExternalServiceId(serviceJobId: string): Promise<Job | null> {
  const snap = await col.jobs().where("external.serviceJobId", "==", serviceJobId).limit(1).get();
  const doc = snap.docs[0];
  return doc ? withId<Job>(doc) : null;
}

/**
 * Atomically claims a webhook completion for an external job: flips the job
 * out of queued/running exactly once. Returns false when another delivery
 * already claimed it — the caller must then skip all side effects.
 */
export async function claimExternalJobCompletion(jobId: string, status: JobStatus): Promise<boolean> {
  const ref = col.jobs().doc(jobId);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const job = snap.data() as Job;
    if (job.status !== "queued" && job.status !== "running") return false;
    tx.update(ref, { status, updatedAt: Date.now() });
    return true;
  });
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
 * All calendar-booked assets (status "scheduled" OR "approved") whose scheduledAt is
 * at or before `before` (default: now). Approval places an asset on the calendar at a
 * designated time, so approved auto-mode assets are auto-published just like scheduled
 * ones. Sorted oldest-first so the cron processes in chronological order.
 * Pass `limit` to cap the batch size and bound each cron tick's execution time.
 * Pass `autoOnly` (the cron does) to exclude manual-push and placeholder items —
 * those live on the calendar but must never be auto-posted. Legacy assets with no
 * publishMode predate the three-tier flow and keep their original auto behavior.
 */
export async function listScheduledAssets(opts?: {
  before?: number;
  limit?: number;
  autoOnly?: boolean;
}): Promise<Asset[]> {
  const before = opts?.before ?? Date.now();
  const snap = await col.assets().where("status", "in", ["scheduled", "approved"]).get();
  const due = snap.docs
    .map((d) => withId<Asset>(d))
    .filter((a) => a.scheduledAt != null && a.scheduledAt <= before)
    .filter((a) => !opts?.autoOnly || a.publishMode === "auto" || a.publishMode == null)
    .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
  return opts?.limit != null ? due.slice(0, opts.limit) : due;
}

/** Record a successful platform push: status → published, stamp publishedAt, clear any stale error. */
export async function markAssetPublished(id: string): Promise<void> {
  const { FieldValue } = await import("firebase-admin/firestore");
  await col.assets().doc(id).update({
    status: "published",
    publishedAt: Date.now(),
    publishError: FieldValue.delete(),
    updatedAt: Date.now(),
  });
}

/** Clear the schedule (time, platform, mode, last error) and revert status to draft. */
export async function clearAssetSchedule(id: string): Promise<void> {
  const { FieldValue } = await import("firebase-admin/firestore");
  await col.assets().doc(id).update({
    status: "draft",
    scheduledAt: FieldValue.delete(),
    scheduledPlatform: FieldValue.delete(),
    publishMode: FieldValue.delete(),
    publishError: FieldValue.delete(),
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

/** Normalize a meeting title for duplicate comparison (case/whitespace-insensitive). */
export function normalizeMeetingTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Find an already-ingested transcript that is the SAME meeting as the given one.
 *
 * Duplicate rule: a meeting is a duplicate only when
 *   (a) the provider externalId matches — same Fireflies recording, always the
 *       same meeting; or
 *   (b) BOTH the normalized title AND the meeting timestamp match.
 * Title alone is never enough: recurring meetings ("Weekly Sync") share a title
 * but have different timestamps and must each be ingested.
 */
export async function findDuplicateTranscript(input: {
  externalId?: string;
  title: string;
  meetingDate?: number;
}): Promise<Transcript | null> {
  if (input.externalId) {
    const byExternalId = await getTranscriptByExternalId(input.externalId);
    if (byExternalId) return byExternalId;
  }
  // Without a timestamp we cannot confirm it's the same occurrence — not a duplicate.
  if (input.meetingDate == null) return null;

  const snap = await col.transcripts().where("meetingDate", "==", input.meetingDate).get();
  const wanted = normalizeMeetingTitle(input.title);
  for (const doc of snap.docs) {
    const t = withId<Transcript>(doc);
    if (normalizeMeetingTitle(t.title) === wanted) return t;
  }
  return null;
}

/* ---------------------- managed action items ----------------------- */

/** Deterministic doc id — makes ingestion/webhook retries idempotent. */
export function actionItemDocId(transcriptId: string, sourceIndex: number): string {
  return `${transcriptId}_${sourceIndex}`;
}

export async function getActionItem(id: string): Promise<ActionItem | null> {
  const doc = await col.actionItems().doc(id).get();
  return doc.exists ? withId<ActionItem>(doc) : null;
}

/** Create (or overwrite-merge) an action item at its deterministic id. */
export async function setActionItem(id: string, data: Omit<ActionItem, "id">): Promise<void> {
  await col.actionItems().doc(id).set(data, { merge: true });
}

export async function updateActionItem(id: string, data: Partial<ActionItem>): Promise<void> {
  await col.actionItems().doc(id).set(data, { merge: true });
}

/** All managed action items currently assigned to a user, newest meeting first. */
export async function listActionItemsByAssignee(userId: string): Promise<ActionItem[]> {
  const snap = await col.actionItems().where("assigneeUserId", "==", userId).get();
  return snap.docs
    .map((d) => withId<ActionItem>(d))
    .sort((a, b) => (b.meetingDate ?? b.createdAt) - (a.meetingDate ?? a.createdAt));
}

export async function listActionItemsForTranscript(transcriptId: string): Promise<ActionItem[]> {
  const snap = await col.actionItems().where("transcriptId", "==", transcriptId).get();
  return snap.docs
    .map((d) => withId<ActionItem>(d))
    .sort((a, b) => a.sourceIndex - b.sourceIndex);
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

/* ------------------------- content engine -------------------------- */

/** A client's topic catalog (one doc, keyed by clientId). */
export async function getContentCatalog(clientId: string): Promise<ContentCatalog | null> {
  const doc = await col.contentCatalogs().doc(clientId).get();
  return doc.exists ? (doc.data() as ContentCatalog) : null;
}

export async function upsertContentCatalog(catalog: ContentCatalog): Promise<void> {
  await col.contentCatalogs().doc(catalog.clientId).set(catalog, { merge: true });
}

/** A client's content-engine config (voice/qa rules + picker selection; keyed by clientId). */
export async function getContentEngineConfig(clientId: string): Promise<ContentEngineConfig | null> {
  const doc = await col.contentEngineConfigs().doc(clientId).get();
  return doc.exists ? (doc.data() as ContentEngineConfig) : null;
}

export async function upsertContentEngineConfig(config: ContentEngineConfig): Promise<void> {
  await col.contentEngineConfigs().doc(config.clientId).set(config, { merge: true });
}

/** The client's ledger, oldest→newest (order matters: the picker reads the last entry's format). */
export async function listLedger(opts: { clientId: string }): Promise<LedgerEntry[]> {
  const snap = await col.contentLedger().where("clientId", "==", opts.clientId).get();
  return snap.docs
    .map((d) => d.data() as LedgerEntry & { clientId: string })
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.vol ?? 0) - (b.vol ?? 0));
}

export async function appendLedger(entry: LedgerEntry & { clientId: string }): Promise<string> {
  const ref = await col.contentLedger().add(entry);
  return ref.id;
}

/* ------------------------ newsletter + blog ------------------------ */

/** A client's newsletter/blog config (brand + content foundation; keyed by clientId). */
export async function getNewsletterConfig(clientId: string): Promise<NewsletterConfig | null> {
  const doc = await col.newsletterConfigs().doc(clientId).get();
  return doc.exists ? (doc.data() as NewsletterConfig) : null;
}

export async function upsertNewsletterConfig(config: Partial<NewsletterConfig> & { clientId: string }): Promise<void> {
  await col.newsletterConfigs().doc(config.clientId).set(config, { merge: true });
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

export async function getClientCompetitor(id: string): Promise<ClientCompetitor | null> {
  const doc = await col.clientCompetitors().doc(id).get();
  return doc.exists ? withId<ClientCompetitor>(doc) : null;
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

/** Get a single context doc by clientId + docType + tier. */
export async function getClientContextDocByTier(
  clientId: string,
  docType: string,
  tier: ContextDocTier,
): Promise<ClientContextDoc | null> {
  const snap = await col
    .clientContextDocs()
    .where("clientId", "==", clientId)
    .where("docType", "==", docType)
    .where("tier", "==", tier)
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

/** Fetch a single context doc by its Firestore document ID. */
export async function getClientContextDocById(
  id: string,
): Promise<ClientContextDoc | null> {
  const snap = await col.clientContextDocs().doc(id).get();
  return snap.exists ? withId<ClientContextDoc>(snap) : null;
}

/** Update the content of a context doc in-place and increment its version. Invalidates cached summary. */
export async function updateContextDocContent(
  id: string,
  content: string,
): Promise<void> {
  const snap = await col.clientContextDocs().doc(id).get();
  if (!snap.exists) throw new Error("Context doc not found");
  const current = snap.data() as ClientContextDoc;
  await col.clientContextDocs().doc(id).update({
    content,
    version: (current.version ?? 1) + 1,
    updatedAt: Date.now(),
    summary: [],
    summaryVersion: 0,
  });
}

/** Patch the cached summary on an existing context doc without touching content or version. */
export async function updateContextDocSummary(
  id: string,
  summary: string[],
  summaryVersion: number,
): Promise<void> {
  await col.clientContextDocs().doc(id).update({ summary, summaryVersion });
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

/** Toggle whether the publish cron may auto-post to this platform (Publish Now always works). */
export async function setIntegrationAutoPublish(
  clientId: string,
  platform: string,
  enabled: boolean,
): Promise<void> {
  const docId = `${clientId}_${platform}`;
  await col.clientIntegrations().doc(docId).set(
    { autoPublish: enabled, updatedAt: Date.now() },
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

/* -------------------- agent feedback store -------------------------- */

export async function logFeedback(data: Omit<Feedback, "id">): Promise<string> {
  const ref = await col.feedbacks().add(data);
  return ref.id;
}

/**
 * List feedback entries, optionally filtered by agent.
 * Results are sorted newest-first. Pass limit to cap result size (default 200).
 */
export async function listFeedbacks(agentId?: string, limit = 200): Promise<Feedback[]> {
  const q = agentId
    ? col.feedbacks().where("agentId", "==", agentId).orderBy("createdAt", "desc")
    : col.feedbacks().orderBy("createdAt", "desc");
  const snap = await q.limit(limit).get();
  return snap.docs.map((d) => withId<Feedback>(d));
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

/* ─────────────────────── Proactive Task Board ───────────────────────── */

export async function listClientTasks(opts: {
  clientId?: string;
  /** Single status or array of statuses — filtered in JS to avoid composite indexes. */
  status?: TaskStatus | TaskStatus[];
  limit?: number;
}): Promise<ClientTask[]> {
  // Avoid composite-index requirement by filtering in JS after a simple query.
  let q = col.clientTasks() as FirebaseFirestore.Query;
  if (opts.clientId) q = q.where("clientId", "==", opts.clientId);
  // Single-status Firestore filter for efficiency; multi-status done in JS below.
  if (typeof opts.status === "string") q = q.where("status", "==", opts.status);
  const snap = await q.get();
  let results = snap.docs.map((d) => withId<ClientTask>(d));
  if (Array.isArray(opts.status) && opts.status.length > 0) {
    const allowed = new Set<TaskStatus>(opts.status);
    results = results.filter((t) => allowed.has(t.status));
  }
  return results
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, opts.limit ?? 200);
}

/**
 * Delete ALL tasks for a client in batched Firestore writes.
 * Used by the Scan & Refresh flow to clear stale tasks before generating a fresh map.
 * Returns the number of documents deleted.
 */
export async function deleteAllClientTasks(clientId: string): Promise<number> {
  const snap = await col.clientTasks().where("clientId", "==", clientId).get();
  if (snap.empty) return 0;

  const db = adminDb();
  const CHUNK = 400; // stay well under Firestore's 500-write limit
  const docs = snap.docs;

  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db.batch();
    docs.slice(i, i + CHUNK).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  return docs.length;
}

export async function getClientTask(id: string): Promise<ClientTask | null> {
  const doc = await col.clientTasks().doc(id).get();
  return doc.exists ? withId<ClientTask>(doc) : null;
}

export async function createClientTask(data: Omit<ClientTask, "id">): Promise<string> {
  const ref = await col.clientTasks().add(data);
  return ref.id;
}

export async function updateClientTask(id: string, data: Partial<ClientTask>): Promise<void> {
  await col.clientTasks().doc(id).set(data, { merge: true });
}

export async function deleteClientTask(id: string): Promise<void> {
  await col.clientTasks().doc(id).delete();
}

/* ─────────────────────── Task Comments ─────────────────────────── */

export async function listTaskComments(taskId: string): Promise<TaskComment[]> {
  const snap = await col.taskComments().where("taskId", "==", taskId).get();
  return snap.docs
    .map((d) => withId<TaskComment>(d))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function createTaskComment(data: Omit<TaskComment, "id">): Promise<string> {
  const ref = await col.taskComments().add(data);
  return ref.id;
}

/* ─────────────────────── Client Settings ───────────────────────── */

export async function getClientSettings(clientId: string): Promise<ClientSettings | null> {
  const doc = await col.clientSettings().doc(clientId).get();
  return doc.exists ? (doc.data() as ClientSettings) : null;
}

export async function upsertClientSettings(
  clientId: string,
  patch: Partial<Omit<ClientSettings, "clientId">>,
): Promise<void> {
  await col.clientSettings().doc(clientId).set(
    { clientId, ...patch },
    { merge: true },
  );
}

/* ─────────────────────── Task capacity helper ───────────────────── */

/** Statuses that count against the per-client active-task cap. */
export const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  "pending",
  "in_progress",
  "review_pending",
];

/**
 * One fetch that powers both task-creation guards: how many KAROS-MANAGED
 * tasks are still active (for the MAX_ACTIVE_TASKS cap — client_managed tasks
 * are exempt and uncapped) and the normalized titles of every existing task —
 * completed included — for deduplication.
 */
export async function getTaskBoardCapacity(clientId: string): Promise<{
  activeCount: number;
  existingTitles: Set<string>;
}> {
  const existing = await listClientTasks({ clientId, limit: 500 });
  const active = new Set<TaskStatus>(ACTIVE_TASK_STATUSES);
  // Owner inference mirrors inferOwnerEngine (execution-engine.ts) — kept
  // inline because data.ts sits below the engine in the import graph.
  const isKarosManaged = (t: ClientTask) =>
    (t.owner ?? (t.source === "manual" ? "client_managed" : "karos_managed")) === "karos_managed";
  return {
    activeCount: existing.filter((t) => active.has(t.status) && isKarosManaged(t)).length,
    existingTitles: new Set(existing.map((t) => normalizeTitleForDedup(t.title))),
  };
}

/* ─────────────────────── Deduplication helper ───────────────────── */

/** Normalize a task title to a canonical form for dedup comparison. */
export function normalizeTitleForDedup(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns true when an existing task for this client has a normalized title
 * that exactly matches the given normalized title.
 */
export async function taskTitleExists(
  clientId: string,
  normalizedTitle: string,
): Promise<boolean> {
  const existing = await listClientTasks({ clientId, limit: 500 });
  return existing.some((t) => normalizeTitleForDedup(t.title) === normalizedTitle);
}
