/**
 * The rendered NAME of a context document — the doc-type register (pure,
 * client-safe: imports nothing but the type).
 *
 * `ContextDocType` is stored kebab-case (`brand-voice`, `branding-guidelines`),
 * and three surfaces printed it raw into text a CLIENT reads: two activity-log
 * titles ("branding-guidelines corrected (targeted)") and two credit-ledger
 * reasons ("Doc correction · branding-guidelines"). All four travel through
 * Firestore, so they are not visible to a sweep that reads a string where it is
 * rendered — they were written on one day and painted on another.
 *
 * SCOPE — stated, not counted. This module owns the `ContextDocType` → NAME map
 * for PROSE: activity titles, ledger reasons, and the copilot's context headings
 * (copilot-context.ts, which held a private copy of exactly this map).
 *
 * It deliberately does NOT own `DOC_TABS` in client-documents.tsx. That table is
 * a TAB STRIP whose every tab is about the one client already named on the page,
 * so it labels `client-guidelines` "Guidelines" where prose needs "Client
 * guidelines" — the one entry where the two disagree. Consolidating them would
 * rename a tab a client clicks in order to fix a sentence a client reads, and a
 * consolidation has to be true at every site it takes over. Two homes here is
 * the deliberate answer, not an oversight to tidy.
 */

import type { ContextDocType } from "@/lib/types";

/**
 * Sentence case, because these names are read INSIDE sentences ("Brand voice
 * corrected", "Document correction · Brand voice"). The tab strip capitalises
 * its own labels; a tab is a heading and a heading is not a sentence.
 */
export const CONTEXT_DOC_LABEL: Record<ContextDocType, string> = {
  "brand-voice": "Brand voice",
  "market-strategy": "Market strategy",
  "competitor-analysis": "Competitor analysis",
  "product-information": "Product information",
  "branding-guidelines": "Branding guidelines",
  "target-audience": "Target audience",
  "client-guidelines": "Client guidelines",
  "action-plan": "Action plan",
  "meeting-notes": "Meeting notes",
};

/**
 * The name for one context-doc type, falling back to the stored value for a type
 * Firestore holds and the union does not (which is why the parameter is
 * `string`) — the same shape `assetTypeLabel` uses next door.
 *
 * The fallback prints a kebab-case identifier, which is the defect this module
 * exists to remove. It is still the right fallback: a row whose docType predates
 * the union has to say SOMETHING, and dropping the name silently would leave
 * "corrected" with no object. A type added to the union without a label here is
 * a compile error, so the fallback is reachable only from stored data.
 */
export function contextDocLabel(docType: string): string {
  return CONTEXT_DOC_LABEL[docType as ContextDocType] ?? docType;
}
