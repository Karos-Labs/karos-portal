import { getCurrentUser } from "@/lib/auth";
import { buildSwarmContext, runSwarm, type SwarmEvent } from "@/lib/agent-swarm";
import { tryAcquireAiProcessingLock, releaseAiProcessingLock } from "@/lib/data";
import { logGenerationFailure } from "@/lib/actions/_shared";

export const maxDuration = 120;

/**
 * Agent Swarm task generation over Server-Sent Events. The client's "Refresh
 * Task Map" trigger opens this stream; each backend debate turn is serialized to
 * an SSE `data:` frame the moment it lands, so the War Room console can render the
 * agents arguing in real time. The final frames report the locked consensus and
 * how many tasks were persisted.
 *
 * GET with `?clientId=` so it works over EventSource semantics; auth-scoped like
 * the copilot chat route.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const clientId = url.searchParams.get("clientId");
  // Optional explicit trend/event — when present the run builds a campaign bundle.
  const trend = url.searchParams.get("trend");
  if (!clientId) {
    return Response.json({ error: "clientId is required" }, { status: 400 });
  }
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
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
      try {
        const context = await buildSwarmContext(clientId, trend);
        for await (const event of runSwarm({ clientId, createdBy: user.uid, context, signal: ac.signal })) {
          if (event.type === "error") failure = event.message;
          safeEnqueue(event);
        }
      } catch (e) {
        failure = e instanceof Error ? e.message : "Swarm failed to start";
        safeEnqueue({ type: "error", message: failure });
      } finally {
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
