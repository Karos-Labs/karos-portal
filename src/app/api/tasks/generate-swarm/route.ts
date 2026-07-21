import { getCurrentUser } from "@/lib/auth";
import { buildSwarmContext, runSwarm, type SwarmEvent } from "@/lib/agent-swarm";
import { tryAcquireAiProcessingLock, releaseAiProcessingLock } from "@/lib/data";

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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let failure: string | undefined;
      try {
        const context = await buildSwarmContext(clientId, trend);
        for await (const event of runSwarm({ clientId, createdBy: user.uid, context })) {
          if (event.type === "error") failure = event.message;
          controller.enqueue(frame(event));
        }
      } catch (e) {
        failure = e instanceof Error ? e.message : "Swarm failed to start";
        controller.enqueue(frame({ type: "error", message: failure }));
      } finally {
        await releaseAiProcessingLock(clientId, failure);
        controller.close();
      }
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
