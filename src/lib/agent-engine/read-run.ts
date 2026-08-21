import "server-only";
import { adminDb } from "@/lib/firebase/admin";

/**
 * Reads agent-engine's own Firestore layout directly (`agentEngineRuns/
 * {runId}`, `.../steps/{stepId}`, `.../slots/{slotId}`, and the top-level
 * `agentEngineGates/{gateId}` — see agent-engine's
 * `packages/workflow/src/adapters/firestore/firestore-store.ts`) through
 * the SAME `firebase-admin` singleton this portal already uses for the
 * `jobs` collection (`src/lib/firebase/admin.ts`'s `adminDb()`) — both
 * point at the same GCP project/database, so no new Firestore client or
 * credential is needed here, only new collection names.
 *
 * This is a read-only mirror of agent-engine's own internal record shapes
 * (`RunRecord`/`StepRecord`/`SlotRecord`/`GateRecord`), not a shared
 * package — agent-engine is a separate deployable with its own release
 * cycle, so duplicating the shape here (rather than depending on its
 * source) is deliberate.
 */

export interface AgentEngineRunRecord {
  runId: string;
  clientSlug: string;
  productId: string;
  runKind: "setup" | "recurring";
  status: "running" | "completed" | "failed" | "degraded" | "awaiting_gate" | "held" | "blocked_intake";
  createdAt: number;
  updatedAt: number;
  totalCostUsd?: number;
  failureReason?: string | null;
  pendingGateId?: string | null;
  reason?: string | null;
}

export interface AgentEngineStepRecord {
  stepId: string;
  kind: "code" | "agent";
  status: "completed" | "failed";
  /** Arbitrary — either the step's real (possibly-summarized) output, or `{archived:true, gcsUri, sizeBytes}` for an oversized output offloaded to GCS (agent-engine's own dual-storage archive). */
  output: unknown;
  costUsd: number;
  durationMs: number;
  startedAt: number;
  completedAt: number;
  error?: string;
}

export interface AgentEngineGateRecord {
  gateId: string;
  runId: string;
  kind: string;
  payload: unknown;
  requiredRole: string;
  response?: { decision: "approve" | "reject"; actor: string; at: string; notes?: string };
}

export interface AgentEngineRunView {
  run: AgentEngineRunRecord;
  steps: AgentEngineStepRecord[];
  pendingGate?: AgentEngineGateRecord;
}

function isArchivedOutput(output: unknown): output is { archived: true; gcsUri: string; sizeBytes: number } {
  return typeof output === "object" && output !== null && (output as { archived?: unknown }).archived === true;
}

/** Total cost across every step actually recorded so far — real-time, updates as steps land, not just at run completion. */
export function totalStepCostUsd(steps: readonly AgentEngineStepRecord[]): number {
  return steps.reduce((sum, step) => sum + (Number.isFinite(step.costUsd) ? step.costUsd : 0), 0);
}

export { isArchivedOutput };

/**
 * Reads one run's full current state: the run doc, every step recorded so
 * far (sorted by `startedAt`, execution order), and — when the run is
 * genuinely paused — the specific gate it's waiting on, so the portal can
 * render its payload and offer an approve/reject action without a second
 * round trip. Returns `undefined` for a `runId` that doesn't exist (yet, or
 * ever) — a run just dispatched via Pub/Sub may not have landed in
 * Firestore the instant the portal first checks.
 */
export async function readAgentEngineRun(runId: string): Promise<AgentEngineRunView | undefined> {
  const runSnap = await adminDb().collection("agentEngineRuns").doc(runId).get();
  if (!runSnap.exists) return undefined;
  const run = runSnap.data() as AgentEngineRunRecord;

  const stepsSnap = await adminDb().collection("agentEngineRuns").doc(runId).collection("steps").get();
  const steps = stepsSnap.docs.map((doc) => doc.data() as AgentEngineStepRecord).sort((a, b) => a.startedAt - b.startedAt);

  let pendingGate: AgentEngineGateRecord | undefined;
  if (run.status === "awaiting_gate" && run.pendingGateId) {
    const gateSnap = await adminDb().collection("agentEngineGates").doc(run.pendingGateId).get();
    if (gateSnap.exists) pendingGate = gateSnap.data() as AgentEngineGateRecord;
  }

  return { run, steps, ...(pendingGate ? { pendingGate } : {}) };
}
