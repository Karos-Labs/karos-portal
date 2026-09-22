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
  /**
   * WHAT THE AGENT ACTUALLY RECEIVED — agent-engine's own
   * `RunRecordSchema.input` (`packages/workflow/src/adapters/types.ts`), the
   * run envelope's `input` object as the engine persisted it.
   *
   * It has always been on the document; this mirror simply never declared it,
   * so the run page had nothing to print but `job.input` — a separate,
   * portal-side copy that three of the four dispatch callers never filled in.
   * Reading the engine's copy is the difference between "what we believe we
   * sent" and "what arrived", and only the second can show a field being lost
   * on the way, by its absence.
   *
   * Absent on a run dispatched with no input at all, which is the normal
   * state for a scheduled run drafting from the client's standing brief.
   */
  input?: Record<string, unknown>;
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
  /**
   * What happens if nobody decides — agent-engine's `GateTimeout`
   * (`packages/core/src/types/gate.ts`): `duration` like `"1h"`/`"6h"`/`"24h"`,
   * `onTimeout` `"auto_approve"` (the draft ships itself), `"hold"` or
   * `"escalate"`. Absent on a gate from before timeouts existed.
   */
  timeout?: { duration: string; onTimeout: string; reason?: string; flags?: string[] };
  /**
   * The decision on this gate, once there is one — `decision` mirrors the
   * engine's `GateResponseSchema` (`revise` was missing here until 2026-09-22,
   * though the engine has accepted it since the review cycle existed).
   * `actor` is `system:gate-timeout` when the timeout decided, never a person.
   *
   * PRESENT ON A GATE THE RUN IS STILL PARKED AT means the decision was
   * recorded and the run has not yet moved past it — either the continuation
   * is about to start (the engine hands it to its worker) or the run is
   * wedged and the engine's sweep will apply it. Either way there is nothing
   * left for a reviewer to decide, and the panel must not offer buttons that
   * will meet a 409.
   */
  response?: { decision: "approve" | "revise" | "reject"; actor: string; at: string; notes?: string; reason?: string; feedback?: string };
}

export interface AgentEngineRunView {
  run: AgentEngineRunRecord;
  steps: AgentEngineStepRecord[];
  /** The gate the run is parked at, resolved or not — see `AgentEngineGateRecord.response`. */
  pendingGate?: AgentEngineGateRecord;
}

/**
 * When an `auto_approve` gate will decide itself, as epoch millis — or
 * `undefined` for a gate that never does (a `hold`/`escalate` gate, an
 * unparseable duration, no gate step to date it from).
 *
 * Dated from the gate STEP's `startedAt`, which the engine preserves across
 * replays as the moment the gate opened (`gateStepStartedAt`) — the same
 * clock its sweep uses to decide the gate is due. The step is looked up by
 * the gate's workflow-local id (the part after `${runId}__`).
 */
export function autoApproveDeadlineMs(gate: AgentEngineGateRecord, steps: readonly AgentEngineStepRecord[]): number | undefined {
  if (gate.timeout?.onTimeout !== "auto_approve") return undefined;
  const durationMs = parseGateDurationMs(gate.timeout.duration);
  if (durationMs === undefined) return undefined;
  const localId = gate.gateId.startsWith(`${gate.runId}__`) ? gate.gateId.slice(gate.runId.length + 2) : gate.gateId;
  const step = steps.find((s) => s.stepId === localId || s.stepId.endsWith(`::${localId}`));
  if (!step) return undefined;
  return step.startedAt + durationMs;
}

/** `"1h"`, `"30m"`, `"7d"`, `"45s"` → millis; a mirror of agent-engine's own `parseGateDurationMs`. */
export function parseGateDurationMs(duration: string): number | undefined {
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(duration.trim());
  if (!match) return undefined;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!.toLowerCase()];
  return unit === undefined ? undefined : Number(match[1]) * unit;
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

/**
 * Just the run doc — for the client's progress poll, which reads it every four
 * seconds per watched run. `readAgentEngineRun` also reads every step's
 * `output` and the gate payload, which the poll never uses: its status
 * predicates read `run` alone and the headline needs `run.currentStepId`.
 */
export async function readAgentEngineRunRecord(runId: string): Promise<AgentEngineRunRecord | undefined> {
  const snap = await adminDb().collection("agentEngineRuns").doc(runId).get();
  return snap.exists ? (snap.data() as AgentEngineRunRecord) : undefined;
}
