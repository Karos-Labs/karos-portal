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
  /** The step currently executing — real-time progress reporting (agent-engine's `markStepRunning`). Absent on a run from before this field existed, or one with no steps recorded yet. */
  currentStepId?: string | null;
}

export interface AgentEngineStepRecord {
  stepId: string;
  /**
   * `"gate"` is a human-approval step. It only started appearing once
   * agent-engine's `runStepGate` began writing a checkpoint of its own — before
   * that, a gate registered its `agentEngineGates/{gateId}` record and threw,
   * leaving NO step record at all, so the step table skipped straight from 14
   * to 16 on every x-agent run that paused for review. A record from before
   * that change simply isn't there; nothing here needs to special-case its
   * absence beyond what a missing step already implies.
   */
  kind: "code" | "agent" | "gate";
  /**
   * The step's own execution verdict, mirroring agent-engine's
   * `StepRecordSchema.status` (`packages/workflow/src/adapters/types.ts`).
   *
   * `"running"`: the checkpoint exists but hasn't reached a terminal state yet
   * — no `completedAt`/`costUsd`/`durationMs`/`output` yet. For a `"gate"` step
   * this is the genuine "registered, still waiting on a human" state, which can
   * last as long as the gate's own timeout.
   *
   * The four middle values arrived with AU67 (SCRUM-365) for `step.code` and
   * AU68 (SCRUM-366) for `step.agent`. Before those, a failure REPORTED AS A
   * RETURNED OUTCOME rather than thrown was persisted as `"completed"`, so this
   * union was accidentally accurate. It is a description of what Firestore
   * holds, not a validator — nothing parses these records — which is precisely
   * why it went stale silently and why widening it is the whole of this repo's
   * half of SCRUM-366.
   *
   * `"failed"` now means only what it always actually meant: the step's body
   * THREW, so there is no outcome and no replayable output.
   *
   * HISTORIC RECORDS KEEP THE OLD MEANING. A `"completed"` written before those
   * changes may describe a step whose tool failed. The boundary is the deploy,
   * not a data migration — agent-engine deliberately did not rewrite history.
   */
  status: "running" | "completed" | "content_fail" | "not_available" | "tooling_error" | "budget_exceeded" | "failed";
  /** Arbitrary — either the step's real (possibly-summarized) output, or `{archived:true, gcsUri, sizeBytes}` for an oversized output offloaded to GCS (agent-engine's own dual-storage archive). Absent while `status === "running"`. */
  output?: unknown;
  costUsd?: number;
  durationMs?: number;
  startedAt: number;
  completedAt?: number;
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
  return steps.reduce((sum, step) => sum + (typeof step.costUsd === "number" && Number.isFinite(step.costUsd) ? step.costUsd : 0), 0);
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
