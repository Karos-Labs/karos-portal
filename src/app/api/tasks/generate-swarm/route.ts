import { getCurrentUser } from "@/lib/auth";
import { buildSwarmContext, runSwarm, type SwarmEvent } from "@/lib/agent-swarm";
import { canViewClient } from "@/lib/client-visibility";
import { getClient, tryAcquireAiProcessingLock, releaseAiProcessingLock } from "@/lib/data";
import { logGenerationFailure } from "@/lib/actions/_shared";
import { CREDIT_COSTS } from "@/lib/credits";
import { chargeClientModelCall, refundClientModelCall } from "@/lib/client-model-charge";

export const maxDuration = 120;

/**
 * Agent Swarm task generation over Server-Sent Events. The client's "Refresh
 * Task Map" trigger opens this stream; each backend debate turn is serialized to
 * an SSE `data:` frame the moment it lands, so the War Room console can render the
 * agents arguing in real time. The final frames report the locked consensus and
 * how many tasks were persisted.
 *
 * POST, not GET (2026-08): this route takes the client's AI lock, spends 5 of
 * their credits, and writes tasks to their board — a GET is exactly what a
 * cross-site page can trigger unattended (a top-level navigation or an
 * auto-redirecting link fires an authenticated GET from the signed-in
 * visitor's own browser with no confirmation). The caller never relied on
 * GET/EventSource semantics — it's a streamed `fetch` with a reader, same as
 * `/api/clients/[id]/insights` — so there was nothing to preserve by keeping
 * it. SameSite=Lax cookies aren't sent on a cross-site POST, which is what
 * actually closes the gap. Fenced by `canViewClient` exactly as the
 * `/api/clients/[id]/*` routes are — this one lives under a different path
 * but takes the same argument, and it is the only member of that set that
 * takes a lock, charges, and WRITES.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { clientId?: string; trend?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const clientId = body.clientId ?? null;
  // Optional explicit trend/event — when present the run builds a campaign bundle.
  const trend = body.trend ?? null;
  if (!clientId) {
    return Response.json({ error: "clientId is required" }, { status: 400 });
  }
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Fence ──
  // The role check above says WHICH KIND of actor this is, not WHICH CLIENTS
  // they may touch — so before this, any employee could name any client id and
  // take that client's processing lock, spend 5 of their credits, and persist
  // swarm-generated tasks onto their board. Unconditional and above the lock,
  // so a refused actor takes nothing and writes nothing; 404 rather than 403
  // so a refusal does not confirm the client exists.
  const client = await getClient(clientId);
  if (!client || !canViewClient(user, client)) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  // Guards against overlapping the post-onboarding / manual Regenerate background
  // pipelines for the same client — a second concurrent "Refresh Task Map" click
  // is rejected up front instead of racing the debate.
  if (!(await tryAcquireAiProcessingLock(clientId))) {
    return Response.json(
      { error: "AI generation is already running for this client. Please wait for it to finish." },
      { status: 409 },
    );
  }

  // ── Charge ──
  // "Refresh Task Map" is the most expensive thing a client can press in the
  // portal outside an agent run: DEFAULT_ROUNDS (2) × TURN_ORDER (3) = six
  // model calls before the optional Sonnet campaign pass. It ran free and
  // unlimited.
  //
  // PRICED AT `CREDIT_COSTS.taskExecution` (5) — the existing rate for one
  // in-process AI run that puts work on the task board, which is exactly what
  // this produces. THIS IS THE NEAREST EXISTING RATE, NOT A MEASURED ONE, and
  // it rounds DOWN: on the scale that constant is defined against (1 credit ≈
  // one Haiku-sized call) six turns plus a campaign pass is dearer than five.
  // Undercharging is the safe direction for a price nobody has approved, so
  // the gap is stated here rather than closed with an invented number. If the
  // debate grows more turns, this needs Daniel, not a bigger literal.
  //
  // Charged AFTER the concurrency lock so a rejected 409 costs nothing, and
  // refunded below whenever the run puts no tasks on the board.
  const swarmCharge = {
    user,
    clientId,
    amount: CREDIT_COSTS.taskExecution,
    operation: "ai_tool" as const,
    // Client copy: the ledger feed renders ungated to a CLIENT_USER.
    reason: "Task map refresh",
  };
  //
  // The lock is released on BOTH ways out of the charge, not just the refusal. A
  // Firestore outage makes chargeClientModelCall throw rather than deny, and
  // this is now the only code between the acquire and the stream that can: an
  // uncaught throw here would leave `isAiProcessing` set with no stream to clear
  // it, blocking every Regenerate and Refresh Task Map for that client until
  // somebody reset it by hand.
  let denied: string | null;
  let chargedAt: number | null;
  try {
    ({ denied, chargedAt } = await chargeClientModelCall(swarmCharge));
  } catch (e) {
    await releaseAiProcessingLock(clientId);
    throw e;
  }
  if (denied !== null) {
    await releaseAiProcessingLock(clientId);
    return Response.json({ error: denied }, { status: 402 });
  }

  const encoder = new TextEncoder();
  const frame = (event: SwarmEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

  // Aborted when the client disconnects (tab closed, component unmounted, fetch
  // aborted) via the stream's `cancel()` below — stops in-flight model calls and
  // skips persistence instead of burning LLM spend + Firestore writes for nobody.
  const ac = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let failure: string | undefined;
      const safeEnqueue = (event: SwarmEvent) => {
        try {
          controller.enqueue(frame(event));
        } catch {
          // Enqueueing on an already-canceled controller throws — treat it as
          // a disconnect signal so runSwarm stops on its next abort check.
          ac.abort();
        }
      };
      // What the client actually got. The refund below turns on this rather
      // than on `failure`, because the two are not the same question: a run can
      // end with no error and still put nothing on the board (every draft
      // deduped away, or the reader disconnected mid-debate and the generator
      // returned before persisting). "Did they receive tasks" is what they paid
      // for, so that is what decides.
      let created = 0;
      try {
        const context = await buildSwarmContext(clientId, trend);
        for await (const event of runSwarm({ clientId, createdBy: user.uid, context, signal: ac.signal })) {
          if (event.type === "error") failure = event.message;
          if (event.type === "done") created = event.created;
          safeEnqueue(event);
        }
      } catch (e) {
        failure = e instanceof Error ? e.message : "Swarm failed to start";
        safeEnqueue({ type: "error", message: failure });
      } finally {
        if (created === 0) {
          await refundClientModelCall(
            swarmCharge,
            chargedAt,
            "Refund · task map refresh added no tasks",
          );
        }
        await releaseAiProcessingLock(clientId, failure);
        await logGenerationFailure(clientId, failure);
        try {
          controller.close();
        } catch {
          // Already closed/errored via cancel() — nothing to do.
        }
      }
    },
    cancel() {
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering so frames flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
