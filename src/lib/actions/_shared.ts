import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { createActivityLog } from "@/lib/data";
import type { ActivityLog, AppUser } from "@/lib/types";

export async function requireStaff(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") throw new Error("Forbidden");
  return user;
}

export async function requireAdmin(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.role !== "KAROS_ADMIN") throw new Error("Forbidden");
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

/** Fire-and-forget activity log writer. Never throws — never blocks the caller. */
export async function logActivity(data: Omit<ActivityLog, "id">): Promise<void> {
  try {
    await createActivityLog(data);
  } catch {
    // Non-fatal
  }
}
