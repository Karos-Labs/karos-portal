import "server-only";

import { userFromToken } from "@/lib/tokens";
import { canViewClient } from "@/lib/client-visibility";
import { verifyJobToken } from "./job-token";
import type { AppUser, Client } from "@/lib/types";

/**
 * The two kinds of caller the MCP server serves, resolved from a bearer token:
 *
 *   staff   — an employee/admin driving Karos from their own Claude Code, via a
 *             personal access token (`karos_pat_…`). Acts as that user, scoped
 *             to the clients they can access, with the full toolset.
 *   service — a running agent-service job pulling data / uploading artifacts
 *             mid-run, via a job-scoped token (`karos_job_…`). Locked to exactly
 *             one client and a read/upload subset of tools.
 */
export type McpActor =
  | { kind: "staff"; user: AppUser }
  | { kind: "service"; clientId: string; jobId: string };

export type McpActorKind = McpActor["kind"];

/**
 * Resolve a bearer token to an actor, or null if it authenticates as neither.
 * The two token schemes carry distinct prefixes, so each verifier fast-rejects
 * the other's tokens — no ambiguity, no wasted lookups.
 */
export async function resolveActor(bearer: string | undefined): Promise<McpActor | null> {
  if (!bearer) return null;

  const user = await userFromToken(bearer);
  if (user) return { kind: "staff", user };

  const claims = verifyJobToken(bearer);
  if (claims) return { kind: "service", clientId: claims.clientId, jobId: claims.jobId };

  return null;
}

/**
 * Whether a staff user may act on a client.
 *
 * The assignment rule itself is `canViewClient` — one home, shared with the
 * `/clients/[id]` route guard, so a change to what "assigned" means cannot
 * reach the web app and miss the MCP server. What this adds is MCP's own
 * restriction, which is a fact about THIS transport and not about the client:
 * the staff actor kind is reached from a personal access token, and only
 * employees and admins drive Karos that way. Delegating without the role test
 * would hand a CLIENT_USER holding a PAT their own client's full toolset.
 */
export function canStaffAccessClient(user: AppUser, client: Client): boolean {
  if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") return false;
  return canViewClient(user, client);
}
