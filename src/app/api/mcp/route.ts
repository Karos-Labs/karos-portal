import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/mcp/auth";
import { dispatch } from "@/lib/mcp/protocol";
import { MCP_TOOLS } from "@/lib/mcp/tools";

/**
 * Streamable-HTTP MCP endpoint (stateless). Two callers authenticate here:
 *   • staff via a personal access token (karos_pat_…) from /connect
 *   • a running agent-service job via its job-scoped token (karos_job_…)
 * The bearer resolves to an actor; every tool authorizes against it.
 */

export const runtime = "nodejs";
export const maxDuration = 300;

function bearer(req: NextRequest): string | undefined {
  const header = req.headers.get("authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="karos-mcp"' } },
  );
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(bearer(req));
  if (!actor) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  const ctx = { tools: MCP_TOOLS, actor };

  // JSON-RPC batch: respond only with the non-notification results.
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => dispatch(m, ctx)))).filter((r) => r !== null);
    return responses.length === 0
      ? new NextResponse(null, { status: 202 })
      : NextResponse.json(responses);
  }

  const response = await dispatch(body, ctx);
  return response === null ? new NextResponse(null, { status: 202 }) : NextResponse.json(response);
}

// Stateless server: no server-initiated SSE stream, and no session to delete.
export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

export function DELETE() {
  return new NextResponse(null, { status: 204 });
}
