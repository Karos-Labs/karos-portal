/**
 * Pure charge/refund pairing logic for the credit reconciler — no Firestore,
 * no server-only imports, so vitest can cover it (same split as
 * lab-outputs-shared.ts). The transactional sweep lives in credit-reconcile.ts.
 */

import type { CreditLedgerEntry } from "@/lib/types";

/** Deterministic ledger doc id pairing a refund to exactly one charge entry. */
export function refundEntryIdFor(chargeEntryId: string): string {
  return `refund_${chargeEntryId}`;
}

/**
 * The charge entry a stuck run's refund should pair with, given every ledger
 * entry for one jobId: the NEWEST charge with no paired refund. The running
 * attempt is always the last thing that charged this jobId (claims block
 * concurrent attempts), so newest-unpaired is exact for the stuck-release
 * path. Two guards:
 *   - pairing by deterministic id (`refund_<chargeEntryId>`);
 *   - a count guard — never more refunds than charges for a jobId — which
 *     also keeps refunds written under random ids (e.g. a future inline
 *     refund path) from being refunded a second time here.
 */
export function newestUnrefundedCharge(entries: CreditLedgerEntry[]): CreditLedgerEntry | null {
  const charges = entries.filter((e) => e.kind === "charge" && -e.delta > 0);
  const refunds = entries.filter((e) => e.kind === "refund");
  if (refunds.length >= charges.length) return null; // every charge already handed back
  const refundedIds = new Set(refunds.map((e) => e.id.replace(/^refund_/, "")));
  return charges.filter((c) => !refundedIds.has(c.id)).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}
