/**
 * Server-side content-chain orchestration.
 *
 * SERVER-ONLY (pulls in data.ts → firebase-admin): never import this from a
 * client component. The pure planning logic lives in post-chain.ts, which IS
 * client-safe.
 */

import { applyChainAssignments, getClient, listAssets } from "@/lib/data";
import { planClientChain, type ChainAssignment, type ChainFamily } from "@/lib/post-chain";

/**
 * Re-plan a client's content chains and persist the resulting dates.
 *
 * Called after a lab import, after each agent-service webhook asset creation,
 * and from the staff "re-plan calendar" recovery action, so later batches
 * interleave by internal generation order and everything downstream shifts
 * deterministically. Runtime mode ("reflow") only ever writes drafts — the
 * write layer (applyChainAssignments) re-checks the draft invariant per doc —
 * so the /api/publish cron can never pick up a chain-assigned post.
 */
export async function reflowClientChain(
  clientId: string,
  opts?: {
    mode?: "reflow" | "migrate";
    now?: number;
    startDayMs?: number;
    families?: ChainFamily[];
    /**
     * Asset ids excluded from candidacy — their own date is left untouched,
     * while the day it already occupies still books normally so nothing else
     * lands on it. For a webhook-created asset that carries an approved
     * Task-Map suggestion's `scheduledAt`: that date is the day the client
     * saw and clicked Approve on, not a placeholder the chain is free to
     * relocate — without this, planClientChain's `isPinned` treats any
     * future-dated draft with chain provenance as a reflow candidate and
     * silently re-dates it to the family lane's next free day.
     */
    skipIds?: string[];
  },
): Promise<{ changed: number; assignments: ChainAssignment[] }> {
  // The client record comes along for ONE field: `dailyPace`, which decides how
  // many items a calendar day holds for them (lib/daily-pace). A read failure or
  // a client with nothing configured resolves to the one-item-a-day default, so
  // this cannot change a calendar it has no instruction about.
  const [assets, client] = await Promise.all([
    listAssets({ clientId }),
    getClient(clientId).catch(() => null),
  ]);
  const assignments = planClientChain(assets, {
    now: opts?.now ?? Date.now(),
    ...(opts?.mode ? { mode: opts.mode } : {}),
    ...(opts?.startDayMs != null ? { startDayMs: opts.startDayMs } : {}),
    ...(opts?.families ? { families: opts.families } : {}),
    ...(opts?.skipIds ? { skipIds: opts.skipIds } : {}),
    pace: client?.dailyPace ?? null,
  });
  await applyChainAssignments(assignments);
  return { changed: assignments.length, assignments };
}
