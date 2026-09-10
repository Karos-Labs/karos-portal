/**
 * Integration status helpers — the single place that interprets
 * `ClientIntegration.status`. Both "expired" (publish path) and "reauthenticate"
 * (analytics path) mean the same thing to consumers: the token is dead and the
 * channel needs reconnecting. Centralizing this keeps every gate site correct as
 * new status values are added, instead of scattering `!== "expired"` checks that
 * silently treat a "reauthenticate" integration as usable.
 *
 * Pure and client-safe (only imports a type).
 */

import type { ClientIntegration } from "@/lib/types";

/** True when the integration's token is dead and the channel needs reconnecting. */
export function integrationNeedsReconnect(i: Pick<ClientIntegration, "status">): boolean {
  return i.status === "expired" || i.status === "reauthenticate";
}

/** True when the integration is operational (status "active" or absent). */
export function integrationIsUsable(i: Pick<ClientIntegration, "status">): boolean {
  return !integrationNeedsReconnect(i);
}
