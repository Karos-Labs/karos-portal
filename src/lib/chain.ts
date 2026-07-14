/**
 * Server-side content-chain orchestration.
 *
 * SERVER-ONLY (pulls in data.ts → firebase-admin): never import this from a
 * client component. The pure planning logic lives in post-chain.ts, which IS
 * client-safe.
 */

import { applyChainAssignments, listAssets } from "@/lib/data";
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
  opts?: { mode?: "reflow" | "migrate"; now?: number; startDayMs?: number; families?: ChainFamily[] },
): Promise<{ changed: number; assignments: ChainAssignment[] }> {
  const assets = await listAssets({ clientId });
  const assignments = planClientChain(assets, {
    now: opts?.now ?? Date.now(),
    ...(opts?.mode ? { mode: opts.mode } : {}),
    ...(opts?.startDayMs != null ? { startDayMs: opts.startDayMs } : {}),
    ...(opts?.families ? { families: opts.families } : {}),
  });
  await applyChainAssignments(assignments);
  return { changed: assignments.length, assignments };
}
