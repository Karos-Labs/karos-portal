import "server-only";

import { userFromToken } from "@/lib/tokens";
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
 * Whether a staff user may act on a client — mirrors the web app's scoping
 * (`listClients({ employeeId })`): admins see every client, employees only the
 * clients they're assigned to.
 */
export function canStaffAccessClient(user: AppUser, client: Client): boolean {
  if (user.role === "KAROS_ADMIN") return true;
  if (user.role === "KAROS_EMPLOYEE") return (client.assignedEmployeeIds ?? []).includes(user.uid);
  return false;
}
