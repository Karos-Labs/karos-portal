import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { agentSlotDocId, clientAgentDocId, canSubmitLaunch } from "@/lib/client-agents";
import type {
  AgentSlot,
  ClientAgent,
  ClientAgentFeedback,
  ClientAgentLaunchState,
} from "@/lib/types";
import type { PlannedSlotDraft } from "@/lib/slot-plan";

/**
 * Admin-SDK data layer for the Phase-3 client-agent collections
 * (`clientAgents`, `agentSlots`, `clientAgentFeedback`).
 *
 * A sibling module rather than more lines in data.ts — the same split
 * data-analytics.ts already uses — so a large in-flight file stays out of the
 * merge path while the CLAUDE.md rule holds: all Firestore access is
 * server-side through the Admin SDK, browsers use Firebase only for auth, and
 * firestore.rules stays deny-all for these collections too.
 *
 * Ids are DETERMINISTIC (see client-agents.ts): one umbrella per
 * (client, lab agent), one slot per (umbrella, day). Every write here is an
 * idempotent upsert, so a retried action or a re-run backfill converges instead
 * of duplicating.
 */

function withId<T>(doc: FirebaseFirestore.DocumentSnapshot): T {
  return { id: doc.id, ...(doc.data() as object) } as T;
}

const col = {
  clientAgents: () => adminDb().collection("clientAgents"),
  agentSlots: () => adminDb().collection("agentSlots"),
  clientAgentFeedback: () => adminDb().collection("clientAgentFeedback"),
};

/* ─────────────────────────── clientAgents ──────────────────────────── */

export async function getClientAgent(id: string): Promise<ClientAgent | null> {
  const doc = await col.clientAgents().doc(id).get();
  return doc.exists ? withId<ClientAgent>(doc) : null;
}

/** The umbrella for a (client, lab agent) pair, resolved by its deterministic id. */
export async function getClientAgentByKey(
  clientId: string,
  agentKey: string,
): Promise<ClientAgent | null> {
  return getClientAgent(clientAgentDocId(clientId, agentKey));
}

/**
 * Umbrellas for one client, or — with no filter — every umbrella there is.
 *
 * The unfiltered read exists for the CROSS-CLIENT staff surfaces (the calendar
 * overview, /jobs): they label every row through the §7.3 identity helper, and
 * the alternative is one query per printed row. The collection holds a single
 * doc per (client, lab agent), so reading it whole is cheaper than the fan-out
 * it replaces — the same trade `listCustomAgents()` already makes on those
 * pages. Callers still fence the result to the clients the viewer may see.
 */
export async function listClientAgents(opts?: { clientId?: string }): Promise<ClientAgent[]> {
  const base: FirebaseFirestore.Query = col.clientAgents();
  const query = opts?.clientId ? base.where("clientId", "==", opts.clientId) : base;
  const snap = await query.get();
  return snap.docs
    .map((d) => withId<ClientAgent>(d))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Create the umbrella for a (client, lab agent) pair, or return the existing
 * one untouched.
 *
 * Never overwrites an existing doc: launchState, the template registry and the
 * rotation are the accumulated truth of everything that has happened to this
 * agent, and a second bind (or a re-run of the backfill) must not reset them.
 */
export async function upsertClientAgent(
  input: Omit<ClientAgent, "id" | "createdAt" | "updatedAt"> & { createdAt?: number },
): Promise<{ id: string; created: boolean }> {
  const id = clientAgentDocId(input.clientId, input.agentKey);
  const ref = col.clientAgents().doc(id);
  const now = Date.now();
  const created = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, {
      ...input,
      id,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    } satisfies ClientAgent);
    return true;
  });
  return { id, created };
}

export async function updateClientAgent(id: string, data: Partial<ClientAgent>): Promise<void> {
  await col.clientAgents().doc(id).update({ ...data, updatedAt: Date.now() });
}

/**
 * Atomically move an umbrella into `launching`.
 *
 * The one-launch-in-flight rule has to be a transaction, not a read-then-write:
 * a client double-clicking Launch (or a staff launch racing a client one) would
 * otherwise submit two setup jobs and charge twice for a run that produces one
 * template set. Returns false when another launch already claimed it.
 */
export async function claimClientAgentLaunch(id: string): Promise<boolean> {
  const ref = col.clientAgents().doc(id);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const agent = snap.data() as ClientAgent;
    if (!canSubmitLaunch(agent.launchState)) return false;
    const now = Date.now();
    tx.update(ref, {
      launchState: "launching" satisfies ClientAgentLaunchState,
      launchStartedAt: now,
      launchCompletedAt: null,
      launchJobId: null,
      launchError: null,
      launchRefunded: null,
      updatedAt: now,
    });
    return true;
  });
}

/**
 * Release a claim that never became a real run (submission refused, charge
 * denied). Returns the umbrella to a launchable state so the client's next
 * press is not blocked by a launch that does not exist.
 */
export async function releaseClientAgentLaunch(
  id: string,
  opts?: { error?: string | null; refunded?: boolean },
): Promise<void> {
  const now = Date.now();
  await col.clientAgents().doc(id).update({
    launchState: (opts?.error
      ? "launch_failed"
      : "not_launched") satisfies ClientAgentLaunchState,
    launchJobId: null,
    launchStartedAt: null,
    launchError: opts?.error ?? null,
    launchRefunded: opts?.refunded ?? null,
    updatedAt: now,
  });
}

/** The umbrella whose in-flight launch produced this job, if any. */
export async function getClientAgentByLaunchJobId(jobId: string): Promise<ClientAgent | null> {
  const snap = await col.clientAgents().where("launchJobId", "==", jobId).limit(1).get();
  const doc = snap.docs[0];
  return doc ? withId<ClientAgent>(doc) : null;
}

/* ───────────────────────────── agentSlots ──────────────────────────── */

export async function getAgentSlot(id: string): Promise<AgentSlot | null> {
  const doc = await col.agentSlots().doc(id).get();
  return doc.exists ? withId<AgentSlot>(doc) : null;
}

export async function listAgentSlots(opts: {
  clientId?: string;
  clientAgentId?: string;
}): Promise<AgentSlot[]> {
  let query: FirebaseFirestore.Query = col.agentSlots();
  if (opts.clientAgentId) query = query.where("clientAgentId", "==", opts.clientAgentId);
  else if (opts.clientId) query = query.where("clientId", "==", opts.clientId);
  else return [];
  const snap = await query.get();
  return snap.docs.map((d) => withId<AgentSlot>(d)).sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
}

/**
 * Persist newly planned slots. Existing days are left EXACTLY as they are
 * (`create` semantics, not `set`): the plan is a record of intent, and a
 * regenerated horizon must not undo a day the client moved or annotated.
 */
export async function createAgentSlots(
  drafts: PlannedSlotDraft[],
  createdBy: string,
): Promise<number> {
  if (drafts.length === 0) return 0;
  const now = Date.now();
  let written = 0;
  // Chunked so a long horizon can't exceed the 500-write batch limit.
  for (let i = 0; i < drafts.length; i += 400) {
    const chunk = drafts.slice(i, i + 400);
    const refs = chunk.map((draft) => col.agentSlots().doc(draft.id));
    const existing = await adminDb().getAll(...refs);
    const batch = adminDb().batch();
    existing.forEach((snap, index) => {
      if (snap.exists) return;
      const draft = chunk[index];
      batch.set(refs[index], {
        ...draft,
        note: null,
        assetId: null,
        jobId: null,
        createdBy,
        createdAt: now,
        updatedAt: now,
      } satisfies AgentSlot);
      written += 1;
    });
    await batch.commit();
  }
  return written;
}

export async function updateAgentSlot(id: string, data: Partial<AgentSlot>): Promise<void> {
  await col.agentSlots().doc(id).update({ ...data, updatedAt: Date.now() });
}

/**
 * Claim a day's option pick — the single-winner guard for §4.5c.
 *
 * A read-then-write "have you already picked?" check is not idempotency: two
 * tabs, a double press, or a retry after a slow response all read `null` before
 * either writes, and both then mint a post for the same day. The winner is
 * decided INSIDE a transaction, on the slot doc that is the natural lock — the
 * same shape as claimExternalJobCompletion, which exists for the identical
 * single-delivery problem on jobs.
 *
 * Returns false when someone else got there first; the caller must treat that
 * as "already chosen" and not create an asset.
 *
 * The asset is deliberately created AFTER a successful claim, and the two
 * failure modes are not equivalent. A crash between the claim and the asset
 * strands that ONE DAY: it reads as chosen, has nothing behind it, the client
 * cannot pick again, and clearing it needs a direct edit to the slot doc. That
 * is a real cost, not a self-healing one — but it is one day, in a
 * millisecond-wide window, visible to nobody else. The reverse order would risk
 * a published post the client never confirmed, re-minted on every retry. The
 * ordering trades a recoverable-by-hand gap for the impossibility of a
 * duplicate, which is the right way round for something that becomes content.
 */
export async function claimAgentSlotOptionPick(
  id: string,
  pick: NonNullable<AgentSlot["optionPick"]>,
): Promise<boolean> {
  const ref = col.agentSlots().doc(id);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const slot = snap.data() as AgentSlot;
    if (slot.optionPick) return false;
    tx.update(ref, { optionPick: pick, updatedAt: Date.now() });
    return true;
  });
}

/** Link matched assets onto their slots in one batch (slot-plan output). */
export async function applySlotMatches(
  matches: Array<{ slotId: string; assetId: string }>,
): Promise<void> {
  if (matches.length === 0) return;
  const now = Date.now();
  for (let i = 0; i < matches.length; i += 400) {
    const batch = adminDb().batch();
    for (const match of matches.slice(i, i + 400)) {
      batch.update(col.agentSlots().doc(match.slotId), {
        assetId: match.assetId,
        updatedAt: now,
      });
    }
    await batch.commit();
  }
}

export { agentSlotDocId };

/* ─────────────────────── clientAgentFeedback ───────────────────────── */

export async function listClientAgentFeedback(opts: {
  clientAgentId: string;
  status?: ClientAgentFeedback["status"];
}): Promise<ClientAgentFeedback[]> {
  let query: FirebaseFirestore.Query = col
    .clientAgentFeedback()
    .where("clientAgentId", "==", opts.clientAgentId);
  if (opts.status) query = query.where("status", "==", opts.status);
  const snap = await query.get();
  return snap.docs.map((d) => withId<ClientAgentFeedback>(d)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getClientAgentFeedback(id: string): Promise<ClientAgentFeedback | null> {
  const doc = await col.clientAgentFeedback().doc(id).get();
  return doc.exists ? withId<ClientAgentFeedback>(doc) : null;
}

export async function createClientAgentFeedback(
  data: Omit<ClientAgentFeedback, "id">,
): Promise<string> {
  const ref = col.clientAgentFeedback().doc();
  await ref.set({ ...data, id: ref.id } satisfies ClientAgentFeedback);
  return ref.id;
}

export async function updateClientAgentFeedback(
  id: string,
  data: Partial<ClientAgentFeedback>,
): Promise<void> {
  await col.clientAgentFeedback().doc(id).update({ ...data, updatedAt: Date.now() });
}
