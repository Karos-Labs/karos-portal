import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { createActivityLog, getClientTask } from "@/lib/data";
import type { ActivityLog, AppUser, ClientTask } from "@/lib/types";

export async function requireStaff(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") throw new Error("Forbidden");
  return user;
}

export async function requireAdmin(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "KAROS_ADMIN") throw new Error("Forbidden");
  return user;
}

/** Allows both staff (any client) and a CLIENT_USER (own client only). */
export async function requireClientAccess(clientId: string): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff) {
    if (user.role !== "CLIENT_USER" || user.clientId !== clientId) throw new Error("Forbidden");
  }
  return user;
}

/**
 * Task-level authorization for the task-board actions. Resolves the task and
 * verifies it actually belongs to the given clientId — the browser supplies
 * both ids, so checking the user against the clientId param alone would let a
 * CLIENT_USER operate on another client's task by pairing a foreign task id
 * with their own clientId. Staff pass for any client; a CLIENT_USER only for
 * their own. Returns an error result (not a throw) to match the actions'
 * `{ ok, error }` contract.
 */
export async function requireTaskAccess(
  taskId: string,
  clientId: string,
): Promise<{ ok: true; user: AppUser; task: ClientTask } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  if (!user || user.disabled) return { ok: false, error: "Unauthorized" };

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff && (user.role !== "CLIENT_USER" || user.clientId !== clientId)) {
    return { ok: false, error: "Forbidden" };
  }

  const task = await getClientTask(taskId);
  // Same response for "missing" and "belongs to another client" — don't leak
  // which foreign task ids exist.
  if (!task || task.clientId !== clientId) return { ok: false, error: "Task not found" };

  return { ok: true, user, task };
}

/** Fire-and-forget activity log writer. Never throws — never blocks the caller. */
export async function logActivity(data: Omit<ActivityLog, "id">): Promise<void> {
  try {
    await createActivityLog(data);
  } catch {
    // Non-fatal
  }
}

/**
 * Record a failed workspace-generation cycle.
 *
 * The client-facing banner says the team has been notified, but releasing the
 * processing lock only wrote an error string onto the client record, whose only
 * readers were that same banner and one staff page (QA F69). An activity entry
 * puts the failure on the timeline both staff and the client already read, and
 * the /clients list badges it.
 */
export async function logGenerationFailure(clientId: string, failure?: string): Promise<void> {
  if (!failure) return;
  await logActivity({
    clientId,
    timestamp: Date.now(),
    type: "INTEL_GENERATION",
    title: "Workspace generation stopped early",
    description: failure.slice(0, 500),
    actor: "System AI",
    actorRole: "system",
  });
}
