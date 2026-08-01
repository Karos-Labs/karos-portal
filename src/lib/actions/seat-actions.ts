"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import {
  getClient,
  getClientCredits,
  listEmployeeSeats,
  addEmployeeSeat,
  updateEmployeeSeat,
  removeEmployeeSeat,
  chargeClientCredits,
} from "@/lib/data";
import {
  CreditError,
  availableCredits,
  isBillableClientActor,
  evaluateSeatAddition,
  DEFAULT_LINKEDIN_SEAT_LIMIT,
} from "@/lib/credits";
import type { AppUser } from "@/lib/types";

/**
 * Exported so the workspace can read the refusal and a THROWN failure through
 * one narrowing (`seatFailure` there) instead of three ad-hoc ones. A type-only
 * export; nothing about the action contract changes.
 */
export type SeatActionResult =
  | { ok: true; seatId?: string; charged?: number }
  | { ok: false; error: string; gated?: boolean };

/** Staff, or the client's own user, may manage that client's seats. */
async function requireSeatAccess(clientId: string): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff && !(user.role === "CLIENT_USER" && user.clientId === clientId)) {
    throw new Error("Forbidden");
  }
  return user;
}

export interface AddSeatInput {
  employeeName: string;
  employeeEmail: string;
  /** Optional LinkedIn tokens pasted by an admin; encrypted at rest by the data layer. */
  credentials?: Record<string, string>;
  resumeUrl?: string | null;
  backgroundContext?: string | null;
}

/**
 * Add a LinkedIn employee-advocacy seat, enforcing the monetization gate. Seats
 * within the plan limit are free; the first seat over the limit charges credits
 * (ledger operation "seat_purchase"). When a billable client can't afford it,
 * the add is blocked with an upgrade prompt (`gated: true`).
 */
export async function addEmployeeSeatAction(
  clientId: string,
  input: AddSeatInput,
): Promise<SeatActionResult> {
  const user = await requireSeatAccess(clientId);
  if (!input.employeeName?.trim() || !input.employeeEmail?.trim()) {
    return { ok: false, error: "Employee name and email are required." };
  }

  const [client, seats, credits] = await Promise.all([
    getClient(clientId),
    listEmployeeSeats(clientId),
    getClientCredits(clientId),
  ]);
  if (!client) return { ok: false, error: "Client not found." };

  const seatLimit = client.linkedinSeatLimit ?? DEFAULT_LINKEDIN_SEAT_LIMIT;
  const billable = isBillableClientActor(user);
  const assessment = evaluateSeatAddition({
    currentSeatCount: seats.length,
    seatLimit,
    availableCredits: availableCredits(credits),
    billable,
  });

  if (!assessment.allowed) {
    return { ok: false, gated: true, error: assessment.reason ?? "Seat limit reached." };
  }

  if (assessment.requiresCharge && billable) {
    try {
      await chargeClientCredits({
        clientId,
        amount: assessment.cost,
        operation: "seat_purchase",
        reason: `LinkedIn employee seat: ${input.employeeName.trim()}`,
        actorUid: user.uid,
        actorName: user.name,
      });
    } catch (e) {
      if (e instanceof CreditError) return { ok: false, gated: true, error: e.message };
      throw e;
    }
  }

  const seat = await addEmployeeSeat(clientId, {
    employeeName: input.employeeName.trim(),
    employeeEmail: input.employeeEmail.trim(),
    credentials: input.credentials ?? {},
    status: "active",
    resumeUrl: input.resumeUrl ?? null,
    backgroundContext: input.backgroundContext ?? null,
    addedBy: user.uid,
  });

  revalidatePath(`/clients/${clientId}/settings`);
  return { ok: true, seatId: seat.id, charged: assessment.requiresCharge ? assessment.cost : 0 };
}

/** Pause/activate a seat or update its background metadata (no charge). */
export async function updateEmployeeSeatAction(
  clientId: string,
  seatId: string,
  patch: { status?: "active" | "paused"; resumeUrl?: string | null; backgroundContext?: string | null },
): Promise<SeatActionResult> {
  await requireSeatAccess(clientId);
  await updateEmployeeSeat(clientId, seatId, patch);
  revalidatePath(`/clients/${clientId}/settings`);
  return { ok: true };
}

/** Remove a seat (no charge / no refund). */
export async function removeEmployeeSeatAction(
  clientId: string,
  seatId: string,
): Promise<SeatActionResult> {
  await requireSeatAccess(clientId);
  await removeEmployeeSeat(clientId, seatId);
  revalidatePath(`/clients/${clientId}/settings`);
  return { ok: true };
}
