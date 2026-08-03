import "server-only";

import { cache } from "react";
import { adminDb } from "@/lib/firebase/admin";
import type {
  AccessToken,
  ActionItem,
  ActionItemNotification,
  ActivityLog,
  Feedback,
  AgentReviewNotification,
  AppUser,
  Asset,
  Client,
  ClientCompetitor,
  ClientContextDoc,
  ClientCredits,
  Campaign,
  ClientInsightsCache,
  ClientIntegration,
  ClientMarketingAnalytics,
  ClientReport,
  EmployeeSeat,
  ClientRequest,
  ClientSettings,
  ClientTask,
  ContextDocTier,
  ContextItem,
  CreditLedgerEntry,
  CreditOperation,
  CustomAgent,
  Job,
  JobStatus,
  LoginLog,
  PerformanceBenchmarks,
  PlannedScheduledRun,
  Role,
  ScheduledRun,
  TaskComment,
  TaskStatus,
  Transcript,
  ClientSeat,
  AgentIntake,
  XNewsUpdate,
  XTake,
  XDraftFeedback,
  LiDraftFeedback,
  RedditDraftFeedback,
} from "@/lib/types";
import {
  CreditError,
  applyCredit,
  assessCharge,
  defaultClientCredits,
  rollCreditWindows,
} from "@/lib/credits";
import { canViewClient } from "@/lib/client-visibility";
import { resolveContentIdentity } from "@/lib/agent-identity-map";
import { listClientAgents } from "@/lib/data-client-agents";
import { engagementScore, rankByEngagement } from "@/lib/analytics";
import { isAiProcessingLockActive } from "@/lib/constants";
import { shouldReconcilePublished } from "@/lib/asset-lifecycle";
import { computeBoardCapacity } from "@/lib/task-dedup";
import {
  encryptCredentials,
  decryptCredentials,
  decryptCredentialsAvailable,
} from "@/lib/crypto/token-cipher";
import { randomUUID } from "node:crypto";
import type { SeoGeoInsights } from "@/lib/seo-geo";
import { competitorBrandKeys, looksLikeUrlInput } from "@/lib/competitor-input";

/* ----------------------------- helpers ----------------------------- */

function withId<T>(doc: FirebaseFirestore.DocumentSnapshot): T {
  return { id: doc.id, ...(doc.data() as object) } as T;
}

const col = {
  users: () => adminDb().collection("users"),
  clients: () => adminDb().collection("clients"),
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
  clientTasks: () => adminDb().collection("clientTasks"),
  taskComments: () => adminDb().collection("taskComments"),
  clientSettings: () => adminDb().collection("clientSettings"),
  feedbacks: () => adminDb().collection("feedbacks"),
  // Client usage credits: balance doc per client (doc ID = clientId) + append-only ledger.
  clientCredits: () => adminDb().collection("clientCredits"),
  creditLedger: () => adminDb().collection("creditLedger"),
  // Managed meeting action items (status / assignee / comments / audit history).
  actionItems: () => adminDb().collection("actionItems"),
  // Platform-defined agents runnable via the agent service's "custom" task type.
  customAgents: () => adminDb().collection("customAgents"),
  // Recurring generator runs fired on a cadence by /api/scheduler.
  scheduledRuns: () => adminDb().collection("scheduledRuns"),
  // SEO & GEO insights: one doc per client (doc ID = clientId), written by the onboarding pipeline.
  clientSeoGeo: () => adminDb().collection("clientSeoGeo"),
  // Marketing performance analytics: one doc per (client, asset, platform),
  // doc ID = `${clientId}_${platform}_${assetId}`, written by /api/analytics/sync.
  clientMarketingAnalytics: () => adminDb().collection("clientMarketingAnalytics"),
  // Omnichannel campaigns: themed bundles of dependent tasks/assets per client.
  campaigns: () => adminDb().collection("campaigns"),
  // Cached AI Insights briefing — one doc per client (doc ID = clientId), keyed
  // by a snapshot of the digest that produced it so the LLM only reruns when
  // there's actually something new to report (see /api/clients/[id]/insights).
  clientInsightsCache: () => adminDb().collection("clientInsightsCache"),
  // Agent intake & seats (X e13 · LinkedIn e10 · Reddit e15) — per-agent client
  // data on top of onboarding. clientSeats + agentIntake are shared across
  // agents. xNewsUpdates is the SHARED company news drop (SCRUM-51): one client
  // input fanned out to both the X and LinkedIn agents — the collection keeps
  // its historical name to avoid a data migration. Reddit shares no news drop
  // (it answers questions, it does not broadcast news).
  clientSeats: () => adminDb().collection("clientSeats"),
  agentIntake: () => adminDb().collection("agentIntake"),
  xNewsUpdates: () => adminDb().collection("xNewsUpdates"),
  xTakes: () => adminDb().collection("xTakes"),
  xDraftFeedback: () => adminDb().collection("xDraftFeedback"),
  liDraftFeedback: () => adminDb().collection("liDraftFeedback"),
  redditDraftFeedback: () => adminDb().collection("redditDraftFeedback"),
  // Planned agent runs shown on the unified calendar. Kept separate from the
  // recurring generator scheduler because the two records have different schemas.
  plannedScheduledRuns: () => adminDb().collection("plannedScheduledRuns"),
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

/**
 * THE PERSON BEHIND A CLIENT ACCOUNT — the address the Brand Profile sheet
 * offers when nobody has filled in a contact email (CD-L P1).
 *
 * The relationship is `AppUser.clientId`, the same join `/team` and the team
 * manager already read; this states it once, server-side, so the panel can have
 * the answer without the user collection crossing to a browser.
 *
 * WHICH user, when a workspace has several: the GROUP ADMIN first — that is the
 * seat that manages the others, so it is the account's owner in the only sense
 * this app records — then the oldest account, which is the one that opened the
 * workspace. Sorted in memory rather than by `orderBy`, which would need a
 * composite index for a query that returns a handful of rows.
 *
 * Pending and disabled seats are skipped: an unapproved registration is not
 * somebody to hand a client's mail to.
 */
export async function getClientOwnerEmail(clientId: string): Promise<string> {
  if (!clientId) return "";
  const snap = await col
    .users()
    .where("clientId", "==", clientId)
    .where("role", "==", "CLIENT_USER")
    .get();
  const seats = snap.docs
    .map((d) => d.data() as AppUser)
    .filter((u) => !!u.email && !u.disabled)
    .sort(
      (a, b) =>
        Number(b.isGroupAdmin === true) - Number(a.isGroupAdmin === true) ||
        (a.createdAt ?? 0) - (b.createdAt ?? 0),
    );
  return seats[0]?.email ?? "";
}

/** `impersonatedBy` marks a session, never the stored user: callers routinely spread a
 * session user in here, and persisting it would exempt that client from credit billing
 * for good. Deleted rather than omitted, so a doc corrupted by an earlier write heals. */
export async function upsertUser(user: AppUser): Promise<void> {
  const { FieldValue } = await import("firebase-admin/firestore");
  const stored: Record<string, unknown> = { ...user };
  delete stored.impersonatedBy;
  await col
    .users()
    .doc(user.uid)
    .set({ ...stored, impersonatedBy: FieldValue.delete() }, { merge: true });
}

export async function deleteUser(uid: string): Promise<void> {
  await col.users().doc(uid).delete();
}

/** Actually clears the field (unlike `upsertUser({ ...user, photoURL: undefined })`,
 * which ignoreUndefinedProperties silently no-ops on). */
export async function clearUserAvatar(uid: string): Promise<void> {
  const { FieldValue } = await import("firebase-admin/firestore");
  await col.users().doc(uid).set({ photoURL: FieldValue.delete() }, { merge: true });
}

export async function clearUserResume(uid: string): Promise<void> {
  const { FieldValue } = await import("firebase-admin/firestore");
  await col.users().doc(uid).set({ resumeUrl: FieldValue.delete() }, { merge: true });
}

export async function clearUserPhone(uid: string): Promise<void> {
  const { FieldValue } = await import("firebase-admin/firestore");
  await col.users().doc(uid).set({ phone: FieldValue.delete() }, { merge: true });
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

const byNewestFirst = (a: Client, b: Client) => (b.createdAt ?? 0) - (a.createdAt ?? 0);

/**
 * The clients a staff surface lists. `employeeId` scopes it to what that
 * EMPLOYEE may see — the same rule `canViewClient` states, asked as a query.
 *
 * TWO FIELDS EXPRESS ONE RELATIONSHIP and this reads BOTH, because reading one
 * hid every assignment an admin has actually made. `Client.assignedEmployeeIds`
 * holds the client's side; `AppUser.assignedClientIds` holds the user's, and
 * both of the admin's assignment UIs (`createTeamMemberAction`,
 * `approveRegistrationAction`) write only the user's. This query read the client
 * side alone, so an employee assigned the normal way could OPEN a client by URL
 * — `canViewClient` accepts either field — and saw NO clients in any of the
 * eight staff lists that feed off this call. Reachable but unlisted is worse
 * than fenced out: nothing tells them where to go.
 *
 * The shape is awkward and worth stating: `assignedClientIds` lives on the USER
 * document, so a clients-collection query cannot `array-contains` it. Hence a
 * UNION of two sources rather than one query — the array-contains, plus a
 * batched fetch of the ids the user document names. Deduplicated by document id
 * (an employee recorded on both sides appears once), and an id whose client has
 * since been deleted is dropped rather than surfaced as a hole (`d.exists`).
 *
 * READ COST, since this replaced one query: 1 collection query (billed per
 * matching document, minimum one) + 1 user document + one batched `getAll` of
 * however many ids the user document names that the query did not already
 * return. Single-digit reads per call at pilot volume, and unchanged for the
 * unscoped (admin) path, which still reads the collection once.
 *
 * ONE HOME, and exactly how far that goes. `canViewClient` is the single
 * authority on "may this actor see this client" and is applied here as the
 * FINAL gate, so this query can never be WIDER than the predicate — a predicate
 * that grows a restriction narrows this list with it, for free. What the gate
 * cannot do is make the union COMPLETE: a predicate that grows a new WAY to be
 * assigned would need a third source here, and would silently under-list until
 * it got one. That is the residual, it is pinned by a test that derives its
 * expectation from `canViewClient` itself over an assignment matrix
 * (`client-list-visibility.test.ts`), and the thing that actually retires it is the
 * data migration onto one field — which is Daniel's call, not this file's.
 */
export async function listClients(opts?: { employeeId?: string }): Promise<Client[]> {
  const employeeId = opts?.employeeId;
  if (!employeeId) {
    const snap = await col.clients().get();
    return snap.docs.map((d) => withId<Client>(d)).sort(byNewestFirst);
  }

  const [namedOnClient, user] = await Promise.all([
    col.clients().where("assignedEmployeeIds", "array-contains", employeeId).get(),
    // A missing user document contributes nothing rather than voiding the query
    // above: the client side of the relationship is a legitimate signal on its
    // own, and losing it would be a second lockout.
    getUser(employeeId),
  ]);

  const byId = new Map<string, Client>();
  for (const d of namedOnClient.docs) byId.set(d.id, withId<Client>(d));

  const assignedClientIds = user?.assignedClientIds ?? [];
  const missing = [...new Set(assignedClientIds.filter((id) => !!id && !byId.has(id)))];
  if (missing.length > 0) {
    const docs = await adminDb().getAll(...missing.map((id) => col.clients().doc(id)));
    for (const d of docs) if (d.exists) byId.set(d.id, withId<Client>(d));
  }

  // The predicate has the last word — see ONE HOME above. Built as an employee
  // viewer because that is what the option means; `assignedClientIds` comes from
  // the user document just read, so the answer here matches the one the
  // `/clients/[id]` guard gives for the same person.
  const viewer: Pick<AppUser, "role" | "uid" | "clientId" | "assignedClientIds"> = {
    role: "KAROS_EMPLOYEE",
    uid: employeeId,
    clientId: null,
    assignedClientIds,
  };
  return [...byId.values()].filter((c) => canViewClient(viewer, c)).sort(byNewestFirst);
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

/**
 * Finish the onboarding wizard: flip `hasCompletedOnboarding` on the user doc and
 * apply the workspace patch to the client doc in ONE transaction, so a mid-flight
 * failure never leaves a user marked "done" with an unsaved workspace (or vice
 * versa). Verifies the user actually belongs to clientId before writing anything.
 */
export async function completeOnboarding(
  uid: string,
  clientId: string,
  clientPatch: Partial<Pick<Client, "name" | "industry" | "brandVoice">>,
): Promise<void> {
  const userRef = col.users().doc(uid);
  const clientRef = col.clients().doc(clientId);
  await adminDb().runTransaction(async (tx) => {
    // All reads before any writes (Firestore transaction requirement).
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("User not found");
    const user = userSnap.data() as AppUser;
    if (user.clientId !== clientId) throw new Error("Forbidden - not this user's workspace");

    tx.set(userRef, { hasCompletedOnboarding: true }, { merge: true });
    tx.set(clientRef, clientPatch, { merge: true });
  });
}

/**
 * Atomically claim the client-level AI-processing lock: returns false (no write)
 * if a generation cycle is already running, otherwise flips `isAiProcessing` to
 * true (stamping `aiProcessingStartedAt`) in the same transaction and returns
 * true. Callers MUST release the lock (releaseAiProcessingLock) in a finally
 * block — this is the guard that stops a manual Regenerate / Refresh Task Map
 * click from overlapping the onboarding pipeline's own background run (or a
 * second concurrent click of its own).
 *
 * A lock older than AI_PROCESSING_LOCK_STALE_MS is treated as abandoned (the
 * background run that held it died without reaching its finally — a dev-server
 * restart, an HMR-killed `after()`, a serverless timeout) and is silently
 * reclaimed rather than blocking every future action forever.
 */
export async function tryAcquireAiProcessingLock(clientId: string): Promise<boolean> {
  const ref = col.clients().doc(clientId);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const client = withId<Client>(snap);
    if (isAiProcessingLockActive(client)) return false;
    // Starting a fresh run — clear any error left over from the previous one.
    tx.set(
      ref,
      { isAiProcessing: true, aiProcessingStartedAt: Date.now(), aiProcessingError: null },
      { merge: true },
    );
    return true;
  });
}

/**
 * Release the client-level AI-processing lock. Safe to call even if never
 * acquired. Pass `errorMessage` when the run failed so the UI can tell the
 * user what went wrong (e.g. out of credits) instead of the lock just
 * silently clearing with no explanation.
 */
export async function releaseAiProcessingLock(clientId: string, errorMessage?: string): Promise<void> {
  await col.clients().doc(clientId).set(
    {
      isAiProcessing: false,
      aiProcessingStartedAt: null,
      aiProcessingError: errorMessage ? errorMessage.slice(0, 500) : null,
    },
    { merge: true },
  );
}

/**
 * Collections whose docs carry a `clientId` field — swept by deleteClientCascade
 * so a deleted client's data can never resurface in cross-client staff views
 * (task board, assets, calendar). The credit LEDGER is deliberately retained as
 * a financial audit trail; usage logs likewise.
 */
const CLIENT_SCOPED_COLLECTIONS: Array<keyof typeof col> = [
  "jobs",
  "assets",
  "transcripts",
  "contextItems",
  "clientCompetitors",
  "clientContextDocs",
  "clientActivityLogs",
  "clientIntegrations",
  "clientTasks",
  "taskComments",
  "actionItems",
  "scheduledRuns",
  "clientMarketingAnalytics",
  "campaigns",
  "clientSeats",
  "agentIntake",
  "xNewsUpdates",
  "xTakes",
  "xDraftFeedback",
  // Keep this list and the mirror in scripts/purge-orphaned-client-docs.ts in
  // step — the type is Array<keyof typeof col>, so an omission here is not a
  // compile error and no test covers the contents.
  "redditDraftFeedback",
  "plannedScheduledRuns",
];

/** Per-client singleton docs (doc ID = clientId) removed alongside the cascade. */
const CLIENT_DOC_COLLECTIONS: Array<keyof typeof col> = [
  "clientReports",
  "clientSeoGeo",
  "clientInsightsCache",
  "clientCredits",
  "clientSettings",
];

/**
 * Permanently delete a client AND all of its scoped sub-documents. Batched
 * (400/commit) so arbitrarily large clients don't blow the batch limit. The
 * client doc itself is deleted last, so a partial failure leaves the client
 * visible (and the delete retryable) rather than orphaning its data silently.
 */
export async function deleteClientCascade(clientId: string): Promise<{ deleted: number }> {
  // Defensive: an empty id would turn the scoped where() sweeps into no-ops but
  // could still delete singleton docs at a garbage path — refuse outright.
  if (!clientId.trim()) throw new Error("deleteClientCascade: clientId is required");
  let deleted = 0;
  for (const name of CLIENT_SCOPED_COLLECTIONS) {
    for (;;) {
      const snap = await col[name]().where("clientId", "==", clientId).limit(400).get();
      if (snap.empty) break;
      const batch = adminDb().batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
      if (snap.size < 400) break;
    }
  }
  const docBatch = adminDb().batch();
  for (const name of CLIENT_DOC_COLLECTIONS) docBatch.delete(col[name]().doc(clientId));
  await docBatch.commit();
  await col.clients().doc(clientId).delete();
  return { deleted };
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
    .where("status", "in", IN_FLIGHT_JOB_STATUSES)
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
 * The non-terminal job statuses — the single home for this set.
 *
 * It answers one question in two shapes: the array feeds Firestore
 * `where("status", "in", ...)` queries, `isJobInFlight` answers the same
 * question about a job already in memory.
 *
 * SCOPE, stated rather than claimed as a universal. Four call sites read this:
 * `claimExternalJobCompletion` below, `listStuckManagedJobs`,
 * `listStuckLocalJobs` / `reconcileStuckJob` in credit-reconcile, and the
 * runway in-flight filter. It is NOT every in-flight comparison in the repo —
 * roughly a dozen others still hand-roll `status !== "queued" && !== "running"`
 * (external-job-actions, agent-health, client-agent-rows, jobs-list and
 * others). Converting one of those is welcome; asserting here that none exist
 * would be a claim this file cannot verify, and an earlier draft of this
 * comment made exactly that claim while a counterexample sat inside the very
 * sweep it named.
 */
export const IN_FLIGHT_JOB_STATUSES: readonly JobStatus[] = ["queued", "running"];

/** True while a job has not reached a terminal status (IN_FLIGHT_JOB_STATUSES). */
export function isJobInFlight(status: JobStatus): boolean {
  return IN_FLIGHT_JOB_STATUSES.includes(status);
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
    if (!isJobInFlight(job.status)) return false;
    tx.update(ref, { status, updatedAt: Date.now() });
    return true;
  });
}

/* -------------------------- scheduled runs ------------------------- */

export async function listPlannedScheduledRuns(opts?: { clientId?: string }): Promise<PlannedScheduledRun[]> {
  let snap;
  if (opts?.clientId) {
    snap = await col.plannedScheduledRuns().where("clientId", "==", opts.clientId).get();
  } else {
    snap = await col.plannedScheduledRuns().get();
  }
  return snap.docs
    .map((d) => withId<PlannedScheduledRun>(d))
    .sort((a, b) => a.nextRunAt - b.nextRunAt);
}

export async function getPlannedScheduledRun(id: string): Promise<PlannedScheduledRun | null> {
  const doc = await col.plannedScheduledRuns().doc(id).get();
  return doc.exists ? withId<PlannedScheduledRun>(doc) : null;
}

export async function createPlannedScheduledRun(data: Omit<PlannedScheduledRun, "id">): Promise<string> {
  const ref = await col.plannedScheduledRuns().add(data);
  return ref.id;
}

export async function updatePlannedScheduledRun(id: string, data: Partial<PlannedScheduledRun>): Promise<void> {
  await col.plannedScheduledRuns().doc(id).set(data, { merge: true });
}

export async function deletePlannedScheduledRun(id: string): Promise<void> {
  await col.plannedScheduledRuns().doc(id).delete();
}

/**
 * Active scheduled runs whose nextRunAt is at or before `before` (default: now),
 * oldest-first. The cron drains these each tick; `limit` bounds a tick's work.
 */
export async function listDuePlannedScheduledRuns(before?: number, limit = 25): Promise<PlannedScheduledRun[]> {
  const cutoff = before ?? Date.now();
  const snap = await col.plannedScheduledRuns().where("status", "==", "active").get();
  return snap.docs
    .map((d) => withId<PlannedScheduledRun>(d))
    .filter((r) => r.nextRunAt <= cutoff)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)
    .slice(0, limit);
}

/**
 * Atomically claim a due PlannedScheduledRun so overlapping cron ticks (a
 * retried invocation, a manual replay, a slow prior tick still mid-batch)
 * never double-fire it — the same compare-and-set shape as
 * `claimScheduledRun`, extended for this row's `"once"` vs recurring cadence.
 * Succeeds only when the row is still `"active"` AND its `nextRunAt` still
 * equals the value the cron read; on success it advances the cursor (or
 * completes a one-off) and stamps `lastRunAt` in the same transaction.
 * Returns false if another tick already claimed it, it was paused/completed,
 * or the cadence moved on — the caller should skip the run, not retry.
 *
 * It also opens the fire's IN-FLIGHT window (`fireInFlightSince`), which the
 * caller closes once the fire settles. Stamped here rather than by the caller
 * immediately afterwards on purpose: a marker written after the claim has its
 * own unobserved window, and that window is the whole defect it exists to make
 * visible.
 */
export async function claimPlannedScheduledRun(
  id: string,
  expectedNextRunAt: number,
  advance: { nextRunAt: number } | { completed: true },
): Promise<boolean> {
  const ref = col.plannedScheduledRuns().doc(id);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const run = snap.data() as PlannedScheduledRun;
    if (run.status !== "active") return false;
    if (run.nextRunAt !== expectedNextRunAt) return false;
    tx.update(ref, {
      lastRunAt: Date.now(),
      fireInFlightSince: Date.now(),
      updatedAt: Date.now(),
      ...("completed" in advance ? { status: "completed" as const } : { nextRunAt: advance.nextRunAt }),
    });
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
 * Persist content-chain assignments (see lib/post-chain.ts planClientChain).
 *
 * CRON-SAFETY INVARIANT: only DRAFT assets are ever written — each target doc
 * is re-read and skipped (with a warning) if its live status is anything else,
 * so a race with staff approval can never re-date a calendar-armed asset.
 * NEVER writes status; forces publishMode "manual" unless already
 * manual/placeholder — absent = legacy auto, and a stale explicit "auto" on a
 * draft must be downgraded too, or either would arm the /api/publish cron the
 * moment the draft is approved with a past date. recommendedAt mirrors the
 * chain slot so the calendar's draft bucketing and the approve form agree
 * with the chain date.
 */
import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import { integrationIsUsable } from "@/lib/integration-status";

export async function applyChainAssignments(
  assignments: Array<{ id: string; scheduledAt: number; orderKey?: string }>,
): Promise<void> {
  if (assignments.length === 0) return;
  const db = adminDb();
  const CHUNK = 300; // getAll + batch limits are 500; stay comfortably under.
  for (let i = 0; i < assignments.length; i += CHUNK) {
    const chunk = assignments.slice(i, i + CHUNK);
    const snaps = await db.getAll(...chunk.map((a) => col.assets().doc(a.id)));
    const batch = db.batch();
    let writes = 0;
    for (let j = 0; j < chunk.length; j++) {
      const assignment = chunk[j];
      const snap = snaps[j];
      const doc = snap.exists ? (snap.data() as Asset) : null;
      if (!doc || doc.status !== "draft") {
        console.warn(
          `[chain] skipping assignment for asset ${assignment.id}: status is ${doc?.status ?? "missing"}, not draft`,
        );
        continue;
      }

      // Decide a preferred platform for this asset (explicit scheduledPlatform wins,
      // else the first agent channel compatible with the asset type).
      const compatible = PUBLISHABLE_PLATFORMS[doc.type] ?? [];
      const preferredPlatform = doc.scheduledPlatform ?? (doc.channels ?? []).find((c) => compatible.includes(c));

      // Check if the client has an active integration for this preferred platform.
      const integrations = await listClientIntegrations(doc.clientId);
      const settings = await getClientSettings(doc.clientId);
      const allowAuto = settings?.autoScheduleEnabled === true;
      const activeIntegration =
        allowAuto && preferredPlatform
          ? integrations.find((i) => i.platform === preferredPlatform && integrationIsUsable(i))
          : undefined;

      batch.set(
        snap.ref,
        {
          scheduledAt: assignment.scheduledAt,
          ...(assignment.orderKey ? { orderKey: assignment.orderKey } : {}),
          // If an active integration exists for the preferred platform AND the client
          // opted in to auto-scheduling, allow auto. Otherwise keep safety: mark
          // manual so nothing auto-posts without a connection or explicit opt-in.
          ...(activeIntegration
            ? { publishMode: "auto" as const }
            : { publishMode: doc.publishMode !== "manual" && doc.publishMode !== "placeholder" ? "manual" as const : doc.publishMode }),
          ...(preferredPlatform ? { scheduledPlatform: preferredPlatform } : {}),
          recommendedAt: assignment.scheduledAt,
          // Client-visible: asset-card renders recommendedReason as text and as a
          // tooltip, and redactLockedAsset withholds it only for locked future-dated
          // assets — so an unlocked draft carries it to the client. Em dash, per F71.
          recommendedReason: "One post per day. Assigned by the content chain",
          updatedAt: Date.now(),
        },
        { merge: true },
      );
      writes++;
    }
    if (writes > 0) await batch.commit();
  }
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

/**
 * Record a successful platform push: status → published, stamp publishedAt,
 * clear any stale error, and (when the platform returned one) store the
 * platform's post id so the analytics sync can fetch this post's metrics later.
 */
export async function markAssetPublished(id: string, platformPostId?: string | null): Promise<void> {
  const { FieldValue } = await import("firebase-admin/firestore");
  await col.assets().doc(id).update({
    status: "published",
    publishedAt: Date.now(),
    ...(platformPostId ? { platformPostId } : {}),
    publishError: FieldValue.delete(),
    publishClaimedAt: FieldValue.delete(),
    updatedAt: Date.now(),
  });
}

/**
 * Reconcile a single asset (and its parent task) to "published" when it has
 * demonstrably gone live — its auto-publish slot passed, or a platform post id
 * was captured/verified. Transactional: re-reads the asset inside the tx (guard
 * against a racing publish), flips the asset to published, and completes the
 * parent task (asset.meta.taskId) in the SAME transaction so the client never
 * sees a published asset whose task is still "in progress". Idempotent —
 * returns { changed:false } when the asset is already published or no longer
 * qualifies. `verifiedPostId` (from live ingestion) is stored when provided.
 *
 * `opts.force` skips the shouldReconcilePublished eligibility test for a user
 * who is ATTESTING they posted the asset by hand. That evidence can't be
 * derived — a manual-mode asset never qualifies on its own — but it's the only
 * evidence that exists when there's no integration in the loop. The caller owns
 * authorization; everything else about the write stays identical.
 */
export async function reconcileAssetPublished(
  assetId: string,
  now: number = Date.now(),
  verifiedPostId?: string | null,
  opts?: { force?: boolean },
): Promise<{ changed: boolean; taskCompleted: boolean }> {
  const assetRef = col.assets().doc(assetId);
  return adminDb().runTransaction(async (tx) => {
    // Firestore requires ALL reads before ANY writes — read asset (and its
    // parent task) first, then decide, then write.
    const snap = await tx.get(assetRef);
    if (!snap.exists) return { changed: false, taskCompleted: false };
    const asset = withId<Asset>(snap);

    const withPostId: Asset = verifiedPostId ? { ...asset, platformPostId: verifiedPostId } : asset;
    if (asset.status === "published") return { changed: false, taskCompleted: false };
    if (!opts?.force && !shouldReconcilePublished(withPostId, now)) {
      return { changed: false, taskCompleted: false };
    }

    const taskId = asset.meta?.taskId as string | undefined;
    const taskRef = taskId ? col.clientTasks().doc(taskId) : null;
    const taskSnap = taskRef ? await tx.get(taskRef) : null;

    const { FieldValue } = await import("firebase-admin/firestore");
    tx.set(
      assetRef,
      {
        status: "published",
        publishedAt: asset.publishedAt ?? now,
        ...(verifiedPostId ? { platformPostId: verifiedPostId } : {}),
        // The asset is live; a lingering publishError would keep rendering it
        // as "needs attention", and a lingering claim is meaningless once
        // published. markAssetPublished clears both — match it.
        publishError: FieldValue.delete(),
        publishClaimedAt: FieldValue.delete(),
        updatedAt: now,
      },
      { merge: true },
    );

    if (taskRef && taskSnap?.exists) {
      const task = taskSnap.data() as ClientTask;
      if (task.status !== "completed" && task.status !== "archived") {
        tx.set(taskRef, { status: "completed", completedAt: now, updatedAt: now }, { merge: true });
        return { changed: true, taskCompleted: true };
      }
    }
    return { changed: true, taskCompleted: false };
  });
}

/**
 * How long a publish claim is honored before it's considered stale and re-claimable.
 * Longer than any single platform push, shorter than the cron interval, so a run that
 * crashes mid-publish never permanently wedges an asset.
 */
export const PUBLISH_CLAIM_TTL_MS = 5 * 60 * 1000;

/**
 * Atomically claim an asset for a single publish attempt. Returns true ONLY for the
 * caller that wins the claim; concurrent callers (a manual "Publish Now" racing the
 * auto-cron, or two overlapping cron ticks) get false and must not publish. Prevents
 * duplicate posts to a client's real social accounts. Uses a transaction so the
 * check-and-set is atomic. Callers must release the claim on failure (or it self-heals
 * after PUBLISH_CLAIM_TTL_MS).
 */
export async function claimAssetForPublish(id: string): Promise<boolean> {
  const ref = col.assets().doc(id);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const asset = snap.data() as Asset;
    if (asset.status === "published") return false;
    const now = Date.now();
    const claimedAt = asset.publishClaimedAt;
    if (claimedAt != null && now - claimedAt < PUBLISH_CLAIM_TTL_MS) return false;
    tx.update(ref, { publishClaimedAt: now, updatedAt: now });
    return true;
  });
}

/** Release a publish claim after a failed attempt so a later run can retry. */
export async function releaseAssetPublishClaim(id: string): Promise<void> {
  const { FieldValue } = await import("firebase-admin/firestore");
  await col.assets().doc(id).update({
    publishClaimedAt: FieldValue.delete(),
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
    // Sort by when the meeting HAPPENED, not when Fireflies synced it — a
    // backfill otherwise drops old meetings at the top of the list (QA F146).
    // Matches the row's own displayed date (meetingDate ?? createdAt).
    .sort((a, b) => (b.meetingDate ?? b.createdAt ?? 0) - (a.meetingDate ?? a.createdAt ?? 0));
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

/* ----------------------- SEO & GEO insights ------------------------ */

/** Latest SEO/GEO insight set for a client (doc ID = clientId, 1:1). */
export async function getClientSeoGeo(clientId: string): Promise<SeoGeoInsights | null> {
  const doc = await col.clientSeoGeo().doc(clientId).get();
  return doc.exists ? (doc.data() as SeoGeoInsights) : null;
}

/**
 * Save the SEO/GEO insight set (document ID = clientId). Guarded by a transaction so a
 * slower or degraded intel run can't clobber a fresher capture: when two runs overlap,
 * last-writer-wins would silently downgrade coverage. We keep whichever capture started
 * later (higher capturedAt), regardless of which one finishes writing last.
 */
export async function upsertClientSeoGeo(data: SeoGeoInsights): Promise<void> {
  const ref = col.clientSeoGeo().doc(data.clientId);
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let priorSeries: number[] = [];
    if (snap.exists) {
      const existing = snap.data() as SeoGeoInsights;
      if (existing.capturedAt > data.capturedAt) return; // a newer capture already landed
      // Carry the visibility trend forward (seed from the prior series, or its last score).
      priorSeries = existing.visibilityHistory ?? [existing.geoVisibilityIndex];
    }
    const visibilityHistory = [...priorSeries, data.geoVisibilityIndex].slice(-12);
    // Preserve approvals across re-captures — a regenerate must not silently un-approve.
    const approvedRecIds = snap.exists ? (snap.data() as SeoGeoInsights).approvedRecIds ?? [] : [];
    tx.set(ref, { ...data, visibilityHistory, approvedRecIds });
  });
}

/**
 * Record client/staff approval of one SEO/GEO recommendation (QA Fix 6). Appends the
 * recId to the client's clientSeoGeo doc (idempotent) so the action plan can show it as
 * approved and the team can act on it. Returns the full approved set.
 */
export async function approveSeoGeoRecommendation(clientId: string, recId: string): Promise<string[]> {
  const ref = col.clientSeoGeo().doc(clientId);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("No SEO/GEO capture to approve against");
    const doc = snap.data() as SeoGeoInsights;
    const approved = new Set(doc.approvedRecIds ?? []);
    approved.add(recId);
    const approvedRecIds = [...approved];
    tx.set(ref, { approvedRecIds }, { merge: true });
    return approvedRecIds;
  });
}

/* ----------------- marketing performance analytics ----------------- */

/** Deterministic doc id so a re-sync upserts one asset+platform row in place. */
function analyticsDocId(clientId: string, platform: string, assetId: string): string {
  return `${clientId}_${platform}_${assetId}`;
}

/** All performance records for a client, newest capture first. */
export async function listClientMarketingAnalytics(
  clientId: string,
): Promise<ClientMarketingAnalytics[]> {
  const snap = await col
    .clientMarketingAnalytics()
    .where("clientId", "==", clientId)
    .get();
  return snap.docs
    .map((d) => withId<ClientMarketingAnalytics>(d))
    .sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));
}

/**
 * Upsert one asset+platform metrics row. Idempotent on the deterministic doc id
 * and last-writer-wins guarded by `capturedAt` (mirrors `upsertClientSeoGeo`) so
 * an out-of-order or replayed sync can't overwrite fresher metrics with stale
 * ones. The 0–100 `engagementScore` is (re)derived from the metrics here so the
 * denormalized ranking field can never drift from the numbers it summarizes.
 */
export async function upsertClientMarketingAnalytics(
  input: Omit<ClientMarketingAnalytics, "id" | "engagementScore" | "createdAt" | "updatedAt">,
): Promise<void> {
  const id = analyticsDocId(input.clientId, input.platform, input.assetId);
  const ref = col.clientMarketingAnalytics().doc(id);
  const score = engagementScore(input.metrics);
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    if (snap.exists) {
      const existing = snap.data() as ClientMarketingAnalytics;
      if ((existing.capturedAt ?? 0) > input.capturedAt) return; // a newer capture already landed
      tx.set(
        ref,
        { ...input, id, engagementScore: score, updatedAt: now },
        { merge: true },
      );
    } else {
      tx.set(ref, {
        ...input,
        id,
        engagementScore: score,
        createdAt: now,
        updatedAt: now,
      } satisfies ClientMarketingAnalytics);
    }
  });
}

/**
 * Top-N and bottom-N performers for a client, ranked by `engagementScore`.
 * Reads the whole per-client history with a single indexed `clientId` query and
 * ranks in JS (see the "avoid composite indexes" convention) — cheap because the
 * score is stored, not recomputed. Fed into the Task Map prompt so the model
 * doubles down on proven winners and phases out failing structures.
 */
/* ─────────────────────── AI Insights cache ──────────────────────────── */

export async function getClientInsightsCache(clientId: string): Promise<ClientInsightsCache | null> {
  const doc = await col.clientInsightsCache().doc(clientId).get();
  return doc.exists ? (doc.data() as ClientInsightsCache) : null;
}

export async function upsertClientInsightsCache(
  clientId: string,
  patch: Omit<ClientInsightsCache, "clientId">,
): Promise<void> {
  await col.clientInsightsCache().doc(clientId).set({ clientId, ...patch }, { merge: true });
}

export async function getClientPerformanceBenchmarks(
  clientId: string,
  count = 5,
): Promise<PerformanceBenchmarks> {
  const records = await listClientMarketingAnalytics(clientId);
  const { top, bottom } = rankByEngagement(records, count);
  return { clientId, top, bottom, sampleSize: records.length };
}

/* ------------------------------ campaigns --------------------------- */

/** All campaigns for a client, newest first. */
export async function listCampaigns(clientId: string): Promise<Campaign[]> {
  const snap = await col.campaigns().where("clientId", "==", clientId).get();
  return snap.docs
    .map((d) => withId<Campaign>(d))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const doc = await col.campaigns().doc(id).get();
  return doc.exists ? withId<Campaign>(doc) : null;
}

export async function createCampaign(data: Omit<Campaign, "id">): Promise<string> {
  const ref = await col.campaigns().add(data);
  return ref.id;
}

export async function updateCampaign(id: string, data: Partial<Campaign>): Promise<void> {
  await col.campaigns().doc(id).set(data, { merge: true });
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
 *
 * Two merge rules keep the pool duplicate-free and measurement-stable:
 *
 * 1. **Manual rows absorb their analysis twin.** An incoming row whose brand
 *    keys match an existing MANUAL row enriches that row in place (canonical
 *    company name when the manual one is a pasted URL/domain, url fill, fresh
 *    analysis fields) and is NOT created as a report row — previously every
 *    analysis/report run minted a "Speedrun by a16z" twin next to the user's
 *    raw "https://speedrun.a16z.com" manual row.
 * 2. **The measured AI-visibility signal survives.** Incoming rows inherit
 *    `llmMentions`/`llmMentionsAt` (and a missing `url`) from the old report
 *    row for the same brand, and old report rows the engines actually named
 *    (llmMentions > 0) that the new report dropped are retained — a standalone
 *    re-analysis must never silently reset LLM-aware competitor selection.
 *
 * Brand identity is matched across ALL name/url keys (brandKeys) so renamed
 * spellings and domain-vs-name variants still merge.
 */
export async function replaceReportCompetitors(
  clientId: string,
  rows: Array<Omit<ClientCompetitor, "id">>,
): Promise<void> {
  const existingAll = await col
    .clientCompetitors()
    .where("clientId", "==", clientId)
    .get();
  const reportDocs = existingAll.docs.filter(
    (d) => (d.data() as ClientCompetitor).source === "report",
  );
  const manualDocs = existingAll.docs.filter(
    (d) => (d.data() as ClientCompetitor).source === "manual",
  );

  const oldRows = reportDocs.map((d) => d.data() as Omit<ClientCompetitor, "id">);
  const oldByKey = new Map<string, Omit<ClientCompetitor, "id">>();
  for (const r of oldRows) {
    for (const k of competitorBrandKeys(r.company, r.url)) if (!oldByKey.has(k)) oldByKey.set(k, r);
  }
  const manualByKey = new Map<string, (typeof manualDocs)[number]>();
  for (const d of manualDocs) {
    const m = d.data() as ClientCompetitor;
    for (const k of competitorBrandKeys(m.company, m.url)) if (!manualByKey.has(k)) manualByKey.set(k, d);
  }
  const manualKeyOf = (name: string, url?: string) =>
    competitorBrandKeys(name, url).map((k) => manualByKey.get(k)).find(Boolean);

  const batch = adminDb().batch();

  const carriedOld = new Set<Omit<ClientCompetitor, "id">>();
  const merged: Array<Omit<ClientCompetitor, "id">> = [];
  for (const row of rows) {
    const manualDoc = manualKeyOf(row.company, row.url);
    if (manualDoc) {
      // Enrich the manual row in place; never mint a report twin beside it.
      const m = manualDoc.data() as ClientCompetitor;
      batch.set(
        manualDoc.ref,
        {
          company: looksLikeUrlInput(m.company) && row.company ? row.company : m.company,
          ...(m.url || !row.url ? {} : { url: row.url }),
          ...(row.positioning ? { positioning: row.positioning } : {}),
          ...(row.keyStrengths?.length ? { keyStrengths: row.keyStrengths } : {}),
          ...(row.keyWeaknesses?.length ? { keyWeaknesses: row.keyWeaknesses } : {}),
          ...(row.threatLevel ? { threatLevel: row.threatLevel } : {}),
          marketTier: row.marketTier,
          overlap: row.overlap,
          updatedAt: Date.now(),
        },
        { merge: true },
      );
      continue;
    }
    const old = competitorBrandKeys(row.company, row.url)
      .map((k) => oldByKey.get(k))
      .find(Boolean);
    if (!old) {
      merged.push(row);
      continue;
    }
    carriedOld.add(old);
    merged.push({
      ...row,
      ...(!row.url && old.url ? { url: old.url } : {}),
      ...(old.llmMentions !== undefined
        ? { llmMentions: old.llmMentions, ...(old.llmMentionsAt !== undefined ? { llmMentionsAt: old.llmMentionsAt } : {}) }
        : {}),
    });
  }
  // Measured survivors also skip re-creation when a manual row now covers them.
  const survivors = oldRows.filter(
    (r) =>
      !carriedOld.has(r) &&
      (r.llmMentions ?? 0) > 0 &&
      !manualKeyOf(r.company, r.url),
  );

  for (const doc of reportDocs) {
    batch.delete(doc.ref);
  }
  for (const row of [...merged, ...survivors]) {
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

/**
 * Get a single context doc. The tier is REQUIRED: a client-facing document and
 * its internal twin share a docType, and this used to be a bare .limit(1) on an
 * unordered query — so callers silently drew whichever row Firestore happened to
 * return first, which is how a corrected document and an uncorrected one could
 * both be "the" document depending on the caller.
 */
export async function getClientContextDoc(
  clientId: string,
  docType: string,
  tier: ContextDocTier,
): Promise<ClientContextDoc | null> {
  return getClientContextDocByTier(clientId, docType, tier);
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

/**
 * Read one context doc, accepting an ORDERED list of tiers and returning the
 * first of them that exists.
 *
 * The tier list is an argument rather than a fallback baked into
 * `getClientContextDocByTier`, and that is the whole design: a cross-tier
 * fallback is WRONG at most of the places a context doc is read, so it may only
 * exist where a caller has asked for it by name.
 *
 *  - `src/lib/branding.ts` and `src/lib/actions/branding-actions.ts` read a doc
 *    and then write back at `doc.tier` (`tier: brandingDoc?.tier ?? "internal"`).
 *    A read that quietly resolved to the client tier would publish internal
 *    branding copy into the client-facing document.
 *  - `src/lib/actions/intel-actions.ts` refuses cross-tier fallback outright for
 *    anything a CLIENT_USER can trigger, so internal analyst copy can never
 *    reach a client through a model. Its two comments say so in those words.
 *
 * So: only a caller reading for CONTEXT — never to target a write — may name
 * more than one tier, and it names which ones. An ALLOWLIST in preference
 * order, not "try the other one": a tier absent from the list is never read,
 * which is what keeps `internal-only` (client-guidelines, action-plan — the
 * never-published tier) out of every caller that does not spell it.
 *
 * One parallel round trip, not a chain: the preference order decides which
 * result wins, not which query runs.
 */
export async function getClientContextDocInTierOrder(
  clientId: string,
  docType: string,
  tiers: readonly ContextDocTier[],
): Promise<ClientContextDoc | null> {
  const found = await Promise.all(
    tiers.map((tier) => getClientContextDocByTier(clientId, docType, tier)),
  );
  return found.find((doc) => doc !== null) ?? null;
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

/**
 * List all social/channel integrations for a client. Credentials are decrypted
 * for the caller — leniently: a value this environment cannot decrypt (no
 * TOKEN_ENCRYPTION_KEY, e.g. local dev reading production-written blobs) is
 * dropped and the row flagged `credentialsUnavailable`, because every page that
 * lists a client rides this and none of them render a token. The strict decrypt
 * stays on the paths that consume the plaintext (publish, analytics sync).
 */
export async function listClientIntegrations(clientId: string): Promise<ClientIntegration[]> {
  const snap = await col.clientIntegrations().where("clientId", "==", clientId).get();
  return snap.docs
    .map((d) => withId<ClientIntegration>(d))
    .map((i) => {
      if (!i.credentials) return i;
      const { credentials, unavailable } = decryptCredentialsAvailable(i.credentials);
      return { ...i, credentials, ...(unavailable ? { credentialsUnavailable: true } : {}) };
    })
    .sort((a, b) => a.platform.localeCompare(b.platform));
}

/**
 * Create or overwrite one integration (keyed on clientId + platform).
 * Uses a deterministic doc ID so upserts are idempotent.
 *
 * The client's auto-publish opt-out SURVIVES reconnects: a full overwrite
 * would silently re-enable posting (absent flag ⇒ enabled everywhere), so the
 * previous `autoPublish` is carried over unless the caller sets it
 * explicitly. `status`/`expiredAt` are deliberately NOT carried — a fresh
 * connect clears the expired state.
 *
 * Credentials are encrypted at rest (AES-256-GCM, same scheme as employee-seat
 * tokens) — callers always pass/receive plaintext, encryption is transparent here.
 */
export async function upsertClientIntegration(
  data: Omit<ClientIntegration, "id">,
): Promise<void> {
  const docId = `${data.clientId}_${data.platform}`;
  const ref = col.clientIntegrations().doc(docId);
  const existing = await ref.get();
  const previousAutoPublish = existing.exists
    ? (existing.data() as ClientIntegration).autoPublish
    : undefined;
  await ref.set({
    id: docId,
    ...(data.autoPublish === undefined && previousAutoPublish !== undefined
      ? { autoPublish: previousAutoPublish }
      : {}),
    ...data,
    ...(data.credentials ? { credentials: encryptCredentials(data.credentials) } : {}),
  });
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

/**
 * Mark a platform integration as needing re-authentication (401/403 seen by the
 * analytics sync). Same operational meaning as expired — the integration-status
 * helpers treat both as "needs reconnect" — but recorded distinctly so we can
 * trace which subsystem detected the dead token.
 */
export async function markIntegrationForReauth(clientId: string, platform: string): Promise<void> {
  const docId = `${clientId}_${platform}`;
  await col.clientIntegrations().doc(docId).set(
    { status: "reauthenticate", expiredAt: Date.now() },
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

/* ---------------- LinkedIn employee-advocacy seats ------------------ */
/*
 * Seats live as an array on the client's `${clientId}_linkedin` integration doc.
 * All mutations are transactional read-modify-write so concurrent adds/edits
 * can't clobber the array. Seat OAuth tokens are ENCRYPTED at rest via the token
 * cipher on the way in and DECRYPTED only by getEmployeeSeatsForSync.
 */

const linkedinDocId = (clientId: string) => `${clientId}_linkedin`;

/** All seats for a client's LinkedIn integration, tokens left encrypted. */
export async function listEmployeeSeats(clientId: string): Promise<EmployeeSeat[]> {
  const doc = await col.clientIntegrations().doc(linkedinDocId(clientId)).get();
  if (!doc.exists) return [];
  return (doc.data() as ClientIntegration).employeeSeats ?? [];
}

/** Active seats with DECRYPTED tokens — for the analytics sync only (server-side). */
export async function getEmployeeSeatsForSync(clientId: string): Promise<EmployeeSeat[]> {
  const seats = await listEmployeeSeats(clientId);
  return seats
    .filter((s) => s.status === "active")
    .map((s) => ({ ...s, credentials: decryptCredentials(s.credentials) }));
}

/**
 * Append an employee seat to the LinkedIn integration (tokens encrypted).
 * Requires the LinkedIn integration to exist. Transactional so parallel adds
 * don't drop each other.
 */
export async function addEmployeeSeat(
  clientId: string,
  input: Omit<EmployeeSeat, "id" | "addedAt" | "updatedAt">,
): Promise<EmployeeSeat> {
  const ref = col.clientIntegrations().doc(linkedinDocId(clientId));
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new Error("Connect the client's LinkedIn account before adding employee seats.");
    }
    const seats = (snap.data() as ClientIntegration).employeeSeats ?? [];
    const now = Date.now();
    const seat: EmployeeSeat = {
      ...input,
      id: randomUUID(),
      credentials: encryptCredentials(input.credentials ?? {}),
      addedAt: now,
      updatedAt: now,
    };
    tx.set(ref, { employeeSeats: [...seats, seat], updatedAt: now }, { merge: true });
    return seat;
  });
}

/** Patch one seat (status/resume/background, or re-encrypt new credentials). */
export async function updateEmployeeSeat(
  clientId: string,
  seatId: string,
  patch: Partial<Pick<EmployeeSeat, "status" | "resumeUrl" | "backgroundContext" | "employeeName" | "employeeEmail" | "credentials">>,
): Promise<void> {
  const ref = col.clientIntegrations().doc(linkedinDocId(clientId));
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const seats = (snap.data() as ClientIntegration).employeeSeats ?? [];
    const now = Date.now();
    const next = seats.map((s) =>
      s.id === seatId
        ? {
            ...s,
            ...patch,
            ...(patch.credentials ? { credentials: encryptCredentials(patch.credentials) } : {}),
            updatedAt: now,
          }
        : s,
    );
    tx.set(ref, { employeeSeats: next, updatedAt: now }, { merge: true });
  });
}

/** Remove a seat from the LinkedIn integration. */
export async function removeEmployeeSeat(clientId: string, seatId: string): Promise<void> {
  const ref = col.clientIntegrations().doc(linkedinDocId(clientId));
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const seats = (snap.data() as ClientIntegration).employeeSeats ?? [];
    tx.set(ref, { employeeSeats: seats.filter((s) => s.id !== seatId), updatedAt: Date.now() }, { merge: true });
  });
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

/**
 * Corrections a client (or staff on their behalf) has applied to this client's
 * context documents, newest first. Read back by the intel pipeline so a
 * regeneration — which replaces every document wholesale — does not restore
 * facts the client has already told us are wrong.
 *
 * Sorted in memory rather than with orderBy so no composite index is required.
 */
export async function listClientDocCorrections(
  clientId: string,
  limit = 100,
): Promise<Feedback[]> {
  const snap = await col.feedbacks().where("clientId", "==", clientId).get();
  return snap.docs
    .map((d) => withId<Feedback>(d))
    .filter((f) => f.scope === "single_doc" || f.scope === "global")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
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
export async function listAssignedActionItems(
  userId: string,
  opts?: {
    /**
     * Scope for CLIENT_USER sessions: only items from this client's transcripts,
     * excluding hidden-from-client and Karos-internal meetings.
     */
    forClientId?: string;
  },
): Promise<ActionItemNotification[]> {
  const snap = await col.transcripts()
    .where("assignedUserIds", "array-contains", userId)
    .get();

  const notifications: ActionItemNotification[] = [];
  for (const doc of snap.docs) {
    const t = withId<Transcript>(doc);
    if (t.archived) continue;
    if (
      opts?.forClientId &&
      (t.clientId !== opts.forClientId || t.hiddenFromClient || t.isKarosInternal)
    ) {
      continue;
    }
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
 *
 * `agentName` here is the §7.3 identity, not the stored name: a managed run is
 * RECORDED as "Social posts (IG/TikTok)", and the client's bell was the last
 * surface still printing that second identity next to the umbrella's own name
 * (F147 residual). One scoped umbrella read per client shell render buys the
 * resolution; it stays in this function so only the finished label crosses
 * into AgentReviewNotification, which is serialized to a client component.
 * The staff cross-client feed below keeps the stored name — its readers hold
 * the forensic /jobs link, and resolving there would cost a whole-collection
 * umbrella read on every staff page load.
 */
export async function listReviewJobs(
  clientId: string,
  opts?: { limit?: number },
): Promise<AgentReviewNotification[]> {
  const [snap, umbrellas] = await Promise.all([
    col.jobs()
      .where("clientId", "==", clientId)
      .where("status", "==", "review")
      .get(),
    listClientAgents({ clientId }),
  ]);
  return snap.docs
    .map((d) => withId<Job>(d))
    // Newest first and bounded, exactly like the staff feed below — this half
    // was neither. Firestore hands back document order, so the bell's rows sat
    // in whatever sequence the collection happened to be in, and every review
    // in the queue crossed into the payload. The cap is the same 15 the staff
    // feed uses, and it is a PAYLOAD BOUND: it keeps an unbounded review queue
    // out of the RSC payload, and nothing more.
    //
    // IT IS NOT THE A3/A4 REMEDY, and this comment used to say it was. A runway
    // sweep tops a client up with up to RUNWAY_MAX_JOBS_PER_CLIENT jobs in one
    // minute (default 14, runway.ts) — fourteen is under fifteen, so the cap
    // never bites on the very scenario it was written for, and a cap that did
    // bite would still hand the bell several rows carrying one stamp. What
    // closes it is the GRAIN the rows are told at: reviewFeedRows in
    // notification-rows.ts collapses a client's whole review queue to one
    // stampless row, whatever length this array is. Guarded by
    // src/lib/__tests__/client-review-feed-grain.test.ts.
    //
    // STATED RESIDUAL: what the client SEES is one row, but this array still
    // crosses the RSC boundary intact, so a client's browser holds up to 15 job
    // titles and their same-minute stamps for a feed that prints none of them.
    // Narrowing it to what the summary row needs means changing
    // AgentReviewNotification, which the staff feed below shares — out of scope
    // here, and named rather than half-done.
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, opts?.limit ?? 15)
    .map((j) => ({
      jobId: j.id,
      title: j.title,
      agentName: resolveContentIdentity({ job: j }, umbrellas).label,
      updatedAt: j.updatedAt,
      clientId: j.clientId,
    }));
}

/**
 * Review-queue jobs across several clients — the staff notification bell, which
 * could never show a review because the layout only ever built this feed for
 * CLIENT_USER (QA F68). One query, filtered to the caller's scoped client ids
 * (an employee only sees their assigned clients), newest first.
 */
export async function listReviewJobsForClients(
  clientIds: string[],
  opts?: { limit?: number },
): Promise<AgentReviewNotification[]> {
  if (clientIds.length === 0) return [];
  const allowed = new Set(clientIds);
  const snap = await col.jobs().where("status", "==", "review").get();
  return snap.docs
    .map((d) => withId<Job>(d))
    .filter((j) => allowed.has(j.clientId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, opts?.limit ?? 15)
    .map((j) => ({
      jobId: j.id,
      title: j.title,
      agentName: j.agentName,
      updatedAt: j.updatedAt,
      clientId: j.clientId,
    }));
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
  /** Archived tasks are hidden unless requested (or explicitly asked for via status). */
  includeArchived?: boolean;
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
  // Archived is a storage state, not a board state — exclude it unless the
  // caller opted in or explicitly filtered for it. Tasks completed past the
  // archive threshold are treated as archived AT QUERY TIME, so the active
  // view is clean immediately — the physical sweep (cron) merely catches the
  // documents up to what this filter already decided.
  const askedForArchived =
    opts.status === "archived" ||
    (Array.isArray(opts.status) && opts.status.includes("archived"));
  if (!opts.includeArchived && !askedForArchived) {
    const archiveCutoff = Date.now() - TASK_ARCHIVE_AFTER_MS;
    results = results.filter(
      (t) =>
        t.status !== "archived" &&
        !(t.status === "completed" && (t.completedAt ?? t.updatedAt ?? 0) < archiveCutoff),
    );
  }
  return results
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, opts.limit ?? 200);
}

/** Tasks marked Done stay on the board this long before the sweep archives them. */
export const TASK_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Archiving pipeline: move tasks that have been completed for ≥7 days into the
 * "archived" state so the active board stays clean. Batched; safe to call
 * lazily on page load (after()) or from a cron. Returns the number archived.
 */
export async function archiveStaleCompletedTasks(clientId?: string): Promise<number> {
  const cutoff = Date.now() - TASK_ARCHIVE_AFTER_MS;
  let q = col.clientTasks().where("status", "==", "completed") as FirebaseFirestore.Query;
  if (clientId) q = q.where("clientId", "==", clientId);
  const snap = await q.get();
  const stale = snap.docs.filter((d) => {
    const t = d.data() as ClientTask;
    return (t.completedAt ?? t.updatedAt ?? 0) < cutoff;
  });
  if (stale.length === 0) return 0;

  const db = adminDb();
  const CHUNK = 400;
  const now = Date.now();
  for (let i = 0; i < stale.length; i += CHUNK) {
    const batch = db.batch();
    stale.slice(i, i + CHUNK).forEach((d) =>
      batch.update(d.ref, { status: "archived", updatedAt: now }),
    );
    await batch.commit();
  }
  return stale.length;
}

/** Resolve the task that dispatched a given agent-service run (metadata.externalJobId). */
export async function findTaskByExternalJobId(jobId: string): Promise<ClientTask | null> {
  const snap = await col
    .clientTasks()
    .where("metadata.externalJobId", "==", jobId)
    .limit(1)
    .get();
  return snap.empty ? null : withId<ClientTask>(snap.docs[0]);
}

export async function getClientTask(id: string): Promise<ClientTask | null> {
  const doc = await col.clientTasks().doc(id).get();
  return doc.exists ? withId<ClientTask>(doc) : null;
}

/**
 * Atomically claim a task for execution: verifies it belongs to `clientId`,
 * is in one of `fromStatuses`, and isn't already executing, then flips it to
 * in_progress + executing in the same transaction. Returns the task as it was
 * BEFORE the claim (so callers can revert), or null when the claim loses.
 * This is the idempotency gate that stops double-charged duplicate executions.
 */
export async function claimTaskForExecution(
  taskId: string,
  clientId: string,
  fromStatuses: TaskStatus[],
): Promise<ClientTask | null> {
  const ref = col.clientTasks().doc(taskId);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const task = withId<ClientTask>(snap);
    if (task.clientId !== clientId) return null;
    if (!fromStatuses.includes(task.status)) return null;
    if (task.metadata?.executing === true) return null;
    tx.update(ref, {
      status: "in_progress",
      metadata: {
        ...(task.metadata ?? {}),
        executing: true,
        executionError: null,
        // Clear the previous dispatch's link at claim time: a stale id would
        // exempt this claim from the stuck-execution sweep (which skips
        // externalJobId tasks) if the deferred run dies before re-dispatching.
        externalJobId: null,
      },
      updatedAt: Date.now(),
    });
    return task;
  });
}

/**
 * Atomically claim a review_pending task for its terminal transition
 * (approve / publish): verifies ownership, review_pending status, and that no
 * re-run is executing, then flips to completed in the same transaction.
 * Returns the task as it was BEFORE the claim, or null when the claim loses —
 * this is what stops approve racing a charged Re-run (or a second approve tab)
 * into double side effects.
 */
export async function claimTaskCompletion(
  taskId: string,
  clientId: string,
): Promise<ClientTask | null> {
  const ref = col.clientTasks().doc(taskId);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const task = withId<ClientTask>(snap);
    if (task.clientId !== clientId) return null;
    if (task.status !== "review_pending") return null;
    if (task.metadata?.executing === true) return null;
    tx.update(ref, {
      status: "completed",
      completedAt: Date.now(),
      metadata: { ...(task.metadata ?? {}), failedUpload: null },
      updatedAt: Date.now(),
    });
    return task;
  });
}

/** Undo a claimTaskForExecution (e.g. the credit charge was denied). */
export async function releaseTaskClaim(taskId: string, previousStatus: TaskStatus): Promise<void> {
  const doc = await col.clientTasks().doc(taskId).get();
  if (!doc.exists) return;
  const task = withId<ClientTask>(doc);
  await col.clientTasks().doc(taskId).set(
    {
      status: previousStatus,
      metadata: { ...(task.metadata ?? {}), executing: false },
      updatedAt: Date.now(),
    },
    { merge: true },
  );
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

/* ─────────────────────── Custom Agents ──────────────────────────── */

export async function listCustomAgents(): Promise<CustomAgent[]> {
  const snap = await col.customAgents().get();
  return snap.docs
    .map((d) => withId<CustomAgent>(d))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCustomAgent(id: string): Promise<CustomAgent | null> {
  const doc = await col.customAgents().doc(id).get();
  return doc.exists ? withId<CustomAgent>(doc) : null;
}

export async function getCustomAgentByKey(key: string): Promise<CustomAgent | null> {
  const snap = await col.customAgents().where("key", "==", key).limit(1).get();
  return snap.empty ? null : withId<CustomAgent>(snap.docs[0]);
}

export async function createCustomAgent(data: Omit<CustomAgent, "id">): Promise<string> {
  const ref = await col.customAgents().add(data);
  return ref.id;
}

export async function updateCustomAgent(id: string, data: Partial<CustomAgent>): Promise<void> {
  await col.customAgents().doc(id).update(data);
}

export async function deleteCustomAgent(id: string): Promise<void> {
  await col.customAgents().doc(id).delete();
}

/** Drop a deleted agent's id from every client allowlist (hygiene on delete). */
export async function removeCustomAgentFromClients(agentId: string): Promise<void> {
  const snap = await col.clients().where("customAgentIds", "array-contains", agentId).get();
  await Promise.all(
    snap.docs.map((doc) => {
      const ids = ((doc.data() as Client).customAgentIds ?? []).filter((id) => id !== agentId);
      return doc.ref.update({ customAgentIds: ids });
    }),
  );
}

/* ─────────────────────── Scheduled Runs ─────────────────────────── */

export async function createScheduledRun(data: Omit<ScheduledRun, "id">): Promise<string> {
  const ref = await col.scheduledRuns().add(data);
  return ref.id;
}

export async function getScheduledRun(id: string): Promise<ScheduledRun | null> {
  const doc = await col.scheduledRuns().doc(id).get();
  return doc.exists ? withId<ScheduledRun>(doc) : null;
}

export async function listScheduledRuns(opts?: { clientId?: string }): Promise<ScheduledRun[]> {
  const snap = opts?.clientId
    ? await col.scheduledRuns().where("clientId", "==", opts.clientId).get()
    : await col.scheduledRuns().get();
  return snap.docs
    .map((d) => withId<ScheduledRun>(d))
    .sort((a, b) => a.nextRunAt - b.nextRunAt);
}

export async function updateScheduledRun(id: string, data: Partial<ScheduledRun>): Promise<void> {
  await col.scheduledRuns().doc(id).set(data, { merge: true });
}

export async function deleteScheduledRun(id: string): Promise<void> {
  await col.scheduledRuns().doc(id).delete();
}

/**
 * Enabled runs whose nextRunAt is at or before `before` (default now).
 * Filtered + sorted in memory (mirrors listScheduledAssets) so no composite
 * index is required; capped by `limit` to bound each cron tick.
 */
export async function listDueScheduledRuns(opts?: {
  before?: number;
  limit?: number;
}): Promise<ScheduledRun[]> {
  const before = opts?.before ?? Date.now();
  const snap = await col.scheduledRuns().where("enabled", "==", true).get();
  const due = snap.docs
    .map((d) => withId<ScheduledRun>(d))
    .filter((r) => r.nextRunAt <= before)
    .sort((a, b) => a.nextRunAt - b.nextRunAt);
  return opts?.limit != null ? due.slice(0, opts.limit) : due;
}

/**
 * Atomically claim a due run so overlapping cron ticks never double-fire it.
 * Succeeds only when the row is still enabled AND its nextRunAt still equals
 * the value the cron read (compare-and-set); on success it advances nextRunAt
 * and stamps lastRunAt in the same transaction. Returns false if another tick
 * already claimed it, it was disabled/deleted, or the cadence moved on.
 */
export async function claimScheduledRun(
  id: string,
  expectedNextRunAt: number,
  newNextRunAt: number,
): Promise<boolean> {
  const ref = col.scheduledRuns().doc(id);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const run = snap.data() as ScheduledRun;
    if (!run.enabled) return false;
    if (run.nextRunAt !== expectedNextRunAt) return false;
    tx.update(ref, { nextRunAt: newNextRunAt, lastRunAt: Date.now(), updatedAt: Date.now() });
    return true;
  });
}

/* ─────────────────────── Client Credits ─────────────────────────── */

/**
 * A client's credit state with spend windows rolled to `now` for display.
 * Returns the default (unpersisted) doc for clients that were never charged
 * or granted — the doc is created lazily by the first mutation.
 */
export async function getClientCredits(clientId: string): Promise<ClientCredits> {
  const doc = await col.clientCredits().doc(clientId).get();
  const now = Date.now();
  if (!doc.exists) return defaultClientCredits(clientId, now);
  return rollCreditWindows(doc.data() as ClientCredits, now);
}

type CreditEntryMeta = {
  clientId: string;
  operation: CreditOperation;
  reason: string;
  agentId?: string | null;
  jobId?: string | null;
  actorUid: string;
  actorName?: string;
};

/**
 * Atomically charge a client's balance and append the ledger entry.
 * Enforces the balance and the weekly/monthly caps inside one transaction;
 * throws CreditError (client-readable message) when the charge is denied.
 * A zero/negative amount is a no-op that returns the current balance.
 */
export async function chargeClientCredits(
  args: CreditEntryMeta & { amount: number },
): Promise<{ balance: number }> {
  const ref = col.clientCredits().doc(args.clientId);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const current = snap.exists
      ? (snap.data() as ClientCredits)
      : defaultClientCredits(args.clientId, now);

    const assessed = assessCharge(current, args.amount, now);
    if (!assessed.ok) throw new CreditError(assessed.code, assessed.message);
    if (args.amount <= 0) return { balance: assessed.next.balance };

    tx.set(ref, assessed.next);
    const entryRef = col.creditLedger().doc();
    tx.set(entryRef, {
      id: entryRef.id,
      clientId: args.clientId,
      delta: -args.amount,
      balanceAfter: assessed.next.balance,
      kind: "charge",
      operation: args.operation,
      reason: args.reason,
      agentId: args.agentId ?? null,
      jobId: args.jobId ?? null,
      actorUid: args.actorUid,
      actorName: args.actorName,
      createdAt: now,
    } satisfies CreditLedgerEntry);
    return { balance: assessed.next.balance };
  });
}

/**
 * Atomically add credits (grant / refund / admin adjustment) and append the
 * ledger entry. Refunds also hand back weekly/monthly window spend. Negative
 * amounts are allowed only for kind="adjustment" (admin deduction).
 */
export async function creditClientCredits(
  args: CreditEntryMeta & {
    amount: number;
    kind: "grant" | "refund" | "adjustment";
    /** Refunds: when the original charge happened — scopes window-spend hand-back. */
    chargedAt?: number;
  },
): Promise<{ balance: number }> {
  if (args.amount === 0) throw new Error("Amount must be non-zero");
  if (args.amount < 0 && args.kind !== "adjustment") {
    throw new Error("Only adjustments may deduct credits");
  }
  const ref = col.clientCredits().doc(args.clientId);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const current = snap.exists
      ? (snap.data() as ClientCredits)
      : defaultClientCredits(args.clientId, now);

    const next = applyCredit(current, args.amount, args.kind, now, args.chargedAt);
    tx.set(ref, next);
    const entryRef = col.creditLedger().doc();
    tx.set(entryRef, {
      id: entryRef.id,
      clientId: args.clientId,
      delta: args.amount,
      balanceAfter: next.balance,
      kind: args.kind,
      operation: args.operation,
      reason: args.reason,
      agentId: args.agentId ?? null,
      jobId: args.jobId ?? null,
      actorUid: args.actorUid,
      actorName: args.actorName,
      createdAt: now,
    } satisfies CreditLedgerEntry);
    return { balance: next.balance };
  });
}

/** Set the weekly/monthly spend caps (null = uncapped). Creates the doc with defaults if missing. */
export async function setClientCreditLimits(
  clientId: string,
  limits: { weeklyLimit: number | null; monthlyLimit: number | null },
): Promise<void> {
  const ref = col.clientCredits().doc(clientId);
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const current = snap.exists
      ? (snap.data() as ClientCredits)
      : defaultClientCredits(clientId, now);
    tx.set(ref, {
      ...rollCreditWindows(current, now),
      weeklyLimit: limits.weeklyLimit,
      monthlyLimit: limits.monthlyLimit,
      updatedAt: now,
    });
  });
}

/** Ledger entries for a client, newest first. */
export async function listCreditLedger(clientId: string, limit = 50): Promise<CreditLedgerEntry[]> {
  const snap = await col.creditLedger().where("clientId", "==", clientId).get();
  return snap.docs
    .map((d) => withId<CreditLedgerEntry>(d))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/* ─────────────────────── Task capacity / dedup ──────────────────── */

// The rules are pure and unit-tested in src/lib/task-dedup.ts; data.ts only
// owns the fetch. ACTIVE_TASK_STATUSES + normalizeTitleForDedup re-exported
// for existing consumers.
export { ACTIVE_TASK_STATUSES, normalizeTitleForDedup } from "@/lib/task-dedup";

/**
 * One fetch that powers the task-creation guards: how many KAROS-MANAGED
 * tasks are still active (for the MAX_ACTIVE_TASKS cap — client_managed tasks
 * are exempt and uncapped), the normalized titles of every existing task for
 * the exact-match dedup tier, and the raw task list for the similarity /
 * product-scope dedup tiers (findDuplicateReason).
 */
export async function getTaskBoardCapacity(clientId: string): Promise<{
  activeCount: number;
  existingTitles: Set<string>;
  tasks: ClientTask[];
}> {
  const existing = await listClientTasks({ clientId, limit: 500 });
  return { ...computeBoardCapacity(existing), tasks: existing };
}

/* ─────────────────── X agent (e13) intake & seats ─────────────────── */

export async function createClientSeat(data: Omit<ClientSeat, "id">): Promise<string> {
  const ref = await col.clientSeats().add(data);
  return ref.id;
}

export async function getClientSeat(id: string): Promise<ClientSeat | null> {
  const doc = await col.clientSeats().doc(id).get();
  return doc.exists ? withId<ClientSeat>(doc) : null;
}

export async function listClientSeats(clientId: string): Promise<ClientSeat[]> {
  const snap = await col.clientSeats().where("clientId", "==", clientId).get();
  return snap.docs.map((d) => withId<ClientSeat>(d)).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Drop the seat row itself. A HARD delete, not a flag: `addXSeatAction` and
 * `addLinkedInSeatAction` both reuse an existing seat by matching on `slug`, so
 * a hidden-but-stored seat would be found by the re-add of the same name and
 * silently resurrect the removed person's answers — while a second seat with
 * that slug would break the per-seat agent file keys the slug exists to be.
 *
 * The documents that hang off a seat are NOT removed here (see
 * removeClientSeatAction, which owns that order); this is the last step of it.
 */
export async function deleteClientSeat(id: string): Promise<void> {
  await col.clientSeats().doc(id).delete();
}

/** One intake doc per (clientId, agent, seatId); seatId null = the company page. */
export async function getAgentIntake(
  clientId: string,
  agent: AgentIntake["agent"],
  seatId: string | null,
): Promise<AgentIntake | null> {
  const snap = await col
    .agentIntake()
    .where("clientId", "==", clientId)
    .where("agent", "==", agent)
    .where("seatId", "==", seatId)
    .limit(1)
    .get();
  return snap.empty ? null : withId<AgentIntake>(snap.docs[0]);
}

export async function listAgentIntake(
  clientId: string,
  agent: AgentIntake["agent"],
): Promise<AgentIntake[]> {
  const snap = await col
    .agentIntake()
    .where("clientId", "==", clientId)
    .where("agent", "==", agent)
    .get();
  return snap.docs.map((d) => withId<AgentIntake>(d));
}

/** Create-or-update the single intake doc for the account (form edits are expected). */
export async function upsertAgentIntake(
  data: Omit<AgentIntake, "id" | "createdAt" | "updatedAt">,
): Promise<string> {
  const existing = await getAgentIntake(data.clientId, data.agent, data.seatId);
  const now = Date.now();
  if (existing) {
    await col.agentIntake().doc(existing.id).set({ ...data, updatedAt: now }, { merge: true });
    return existing.id;
  }
  const ref = await col.agentIntake().add({ ...data, createdAt: now, updatedAt: now });
  return ref.id;
}

/** Targeted field update on an existing intake doc (e.g. attaching a CV upload). */
export async function patchAgentIntake(
  id: string,
  patch: Partial<Omit<AgentIntake, "id" | "clientId" | "agent" | "seatId" | "createdAt">>,
): Promise<void> {
  await col.agentIntake().doc(id).set({ ...patch, updatedAt: Date.now() }, { merge: true });
}

/**
 * Remove fields from an intake doc. Needed because upserts merge: a form that
 * clears its focus or voice-fallback must actually delete the old values, or
 * stale text keeps steering the agent's voice on every future run.
 */
export async function clearAgentIntakeFields(
  id: string,
  fields: Array<keyof Omit<AgentIntake, "id" | "clientId" | "agent" | "seatId" | "createdAt">>,
): Promise<void> {
  if (fields.length === 0) return;
  const { FieldValue } = await import("firebase-admin/firestore");
  const deletions = Object.fromEntries(fields.map((f) => [f, FieldValue.delete()]));
  await col.agentIntake().doc(id).update({ ...deletions, updatedAt: Date.now() });
}

/**
 * Drop one intake document whole — the seat-removal path only.
 *
 * The form paths never call this: they upsert, because an empty answer is a
 * saved answer. What this is for is a seat that no longer exists, whose intake
 * doc would otherwise be unreachable from every surface (all of them list by
 * seat) while `listAgentIntake` kept returning it.
 */
export async function deleteAgentIntake(id: string): Promise<void> {
  await col.agentIntake().doc(id).delete();
}

export async function addXNewsUpdate(data: Omit<XNewsUpdate, "id">): Promise<string> {
  const ref = await col.xNewsUpdates().add(data);
  return ref.id;
}

export async function listXNewsUpdates(clientId: string): Promise<XNewsUpdate[]> {
  const snap = await col.xNewsUpdates().where("clientId", "==", clientId).get();
  return snap.docs.map((d) => withId<XNewsUpdate>(d)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function addXTake(data: Omit<XTake, "id">): Promise<string> {
  const ref = await col.xTakes().add(data);
  return ref.id;
}

export async function listXTakes(clientId: string, seatId?: string): Promise<XTake[]> {
  let q = col.xTakes().where("clientId", "==", clientId);
  if (seatId) q = q.where("seatId", "==", seatId);
  const snap = await q.get();
  return snap.docs.map((d) => withId<XTake>(d)).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Delete every take belonging to one seat, and report how many went.
 *
 * A take is that person's own one-liner and the input a run drafts their posts
 * from, so it goes with the seat. Leaving them behind is not neutral: nothing
 * lists a removed seat's takes, so they become unreachable text that still
 * counts — the agent page's "Takes & topics" row reads `listXTakes(clientId)`
 * with no seat filter, and would keep telling the client "4 takes on file"
 * about a person they had just removed.
 *
 * Returns how many went. NO CALLER READS IT TODAY — removeClientSeatAction
 * discards it — so this is a convenience for a future caller and not a fact any
 * surface currently reports.
 */
export async function deleteXTakesForSeat(clientId: string, seatId: string): Promise<number> {
  const takes = await listXTakes(clientId, seatId);
  // Chunked at 400 like deleteClientCascade above: a write batch caps at 500,
  // and the take box has no ceiling — one seat dropping a take a day for two
  // years would exceed it and throw mid-removal.
  for (let i = 0; i < takes.length; i += 400) {
    const batch = adminDb().batch();
    for (const take of takes.slice(i, i + 400)) batch.delete(col.xTakes().doc(take.id));
    await batch.commit();
  }
  return takes.length;
}

export async function addXDraftFeedback(data: Omit<XDraftFeedback, "id">): Promise<string> {
  const ref = await col.xDraftFeedback().add(data);
  return ref.id;
}

export async function listXDraftFeedback(
  clientId: string,
  account?: string,
): Promise<XDraftFeedback[]> {
  let q = col.xDraftFeedback().where("clientId", "==", clientId);
  if (account) q = q.where("account", "==", account);
  const snap = await q.get();
  return snap.docs.map((d) => withId<XDraftFeedback>(d)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function addLiDraftFeedback(data: Omit<LiDraftFeedback, "id">): Promise<string> {
  const ref = await col.liDraftFeedback().add(data);
  return ref.id;
}

export async function listLiDraftFeedback(
  clientId: string,
  account?: string,
): Promise<LiDraftFeedback[]> {
  let q = col.liDraftFeedback().where("clientId", "==", clientId);
  if (account) q = q.where("account", "==", account);
  const snap = await q.get();
  return snap.docs.map((d) => withId<LiDraftFeedback>(d)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function addRedditDraftFeedback(
  data: Omit<RedditDraftFeedback, "id">,
): Promise<string> {
  const ref = await col.redditDraftFeedback().add(data);
  return ref.id;
}

export async function listRedditDraftFeedback(
  clientId: string,
  account?: string,
): Promise<RedditDraftFeedback[]> {
  let q = col.redditDraftFeedback().where("clientId", "==", clientId);
  if (account) q = q.where("account", "==", account);
  const snap = await q.get();
  return snap.docs
    .map((d) => withId<RedditDraftFeedback>(d))
    .sort((a, b) => b.createdAt - a.createdAt);
}
