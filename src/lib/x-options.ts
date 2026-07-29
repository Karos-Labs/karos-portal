/**
 * The X batch, sliced into a day's three choices (§4.5, WP-9) — the pure half.
 *
 * The X engine produces a weekly batch of drafts; the client is presented with
 * three options a day. Generation cadence and presentation cadence differ, and
 * the client cannot tell — that gap is the whole interim design (Tomer seam T7
 * closes it by making the engine produce three-a-day directly, at which point
 * this selector retires and nothing else changes).
 *
 * THE REF CONVENTION IS LOAD-BEARING. `${accountTitle} · ${avenue}` is exactly
 * what x-drafts-review already writes into XDraftFeedback.draftRef, and the
 * learning log (x-agent-context.ts) reads those rows back into every future
 * run. Minting refs any other way here would split one client's history across
 * two namespaces, and the agent would learn from half of it.
 */

import { laneLabel } from "@/lib/draft-lane-label";
import type { OptionCandidate } from "@/lib/slot-plan";
import type { XParsedBatch } from "@/lib/x-drafts";

/** One option as the picker renders it. */
export interface XOption {
  ref: string;
  /** The account this draft was written for — its display title. */
  account: string;
  /** Human label for the angle ("News reaction", "Playbook"). */
  direction: string;
  /** Every post in the draft; more than one ⇒ it is a thread. */
  posts: string[];
}

/**
 * Every draft in a batch, as assignable candidates.
 *
 * Deduplicated by ref, first occurrence winning: two drafts of the same avenue
 * for the same account collide under this convention, and a duplicate ref would
 * let the same draft be assigned to two different days and then recorded twice
 * in the learning log under one name. The collision is pre-existing (the review
 * pane mints refs the same way); what matters is that it degrades to "one of
 * them is offered" rather than to a corrupt history.
 */
export function optionCandidatesFromBatch(batch: XParsedBatch): OptionCandidate[] {
  const seen = new Set<string>();
  const out: OptionCandidate[] = [];
  for (const account of batch.accounts) {
    for (const draft of account.drafts) {
      const ref = `${account.title} · ${draft.avenue}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push({ ref, direction: laneLabel(draft.avenue), account: account.title });
    }
  }
  return out;
}

/**
 * Resolve assigned refs back to the text the picker shows.
 *
 * Order follows the REFS, not the batch, so the three cards render in the order
 * the day was assigned rather than in whatever order the markdown happened to
 * list them. A ref that no longer resolves (the batch was re-imported and that
 * draft is gone) is dropped rather than rendered empty — a blank card is worse
 * than two cards.
 */
export function resolveOptions(batch: XParsedBatch, refs: string[]): XOption[] {
  const byRef = new Map<string, XOption>();
  for (const account of batch.accounts) {
    for (const draft of account.drafts) {
      const ref = `${account.title} · ${draft.avenue}`;
      if (byRef.has(ref)) continue;
      byRef.set(ref, {
        ref,
        account: account.title,
        direction: laneLabel(draft.avenue),
        posts: draft.posts.map((p) => p.text).filter(Boolean),
      });
    }
  }
  return refs.map((ref) => byRef.get(ref)).filter((o): o is XOption => Boolean(o));
}

/** The full text of an option, threads joined the way the composer expects. */
export function optionText(option: XOption): string {
  return option.posts.join("\n\n");
}

/**
 * The reason recorded against an option the client did NOT choose.
 *
 * `addXDraftFeedbackAction` refuses a `not_posted` row with an empty reason —
 * correctly, since a rejection with no reason teaches the agent nothing. A pick
 * is a rejection of the others by implication, so the reason is synthesized
 * from what actually happened, and it NAMES the winner: "they preferred a
 * different angle" is the signal, and without the winner's ref the log cannot
 * tell a losing draft from a draft nobody was ever shown.
 */
export function notPickedReason(chosenRef: string): string {
  return `Not picked — the client chose "${chosenRef}" for that day.`;
}
