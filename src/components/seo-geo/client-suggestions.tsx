import { Card } from "@/components/ui";
import { FlagButton } from "@/components/seo-geo/flag-button";
import type { ClientSuggestion, ClientSuggestionsEmptyReason } from "@/lib/seo-geo";

/**
 * "Things only you can do" (portal feedback round 4, 2026-09).
 *
 * REPLACES "What we're fixing" on the client-facing report. The product owner's
 * ruling was that the old list was not true: `computeCheckGaps` turned every
 * measured check below target into a row, `buildRecommendations` gave each one a
 * Karos owner line and an Approve button, and the result was a page of promises
 * nothing in this product executes. What survives here is the opposite selection
 * — the handful of confirmed findings whose fix belongs to the client, off-site
 * work no agent can ship for them (`buildClientSuggestions` documents the exact
 * rules).
 *
 * SO THERE IS NO CONTROL THAT COMMITS ANYONE. No Approve, no task, no owner
 * line, no impact badge. One row is: what to do, one sentence of why it has to
 * be them, and the evidence we actually measured, in that order — the reading
 * order of the sentence a person would say out loud. The only affordance is the
 * same support dialog every other trigger in the portal opens, labelled the same
 * word (flow audit 2026-09, R7), and it is introduced by a sentence rather than
 * standing on its own.
 *
 * Server component: `FlagButton` is the one client leaf.
 */
/**
 * The two ways this list can be empty, said one at a time (review wave,
 * 2026-09; rewritten round 6).
 *
 * It used to say "everything this snapshot found is work your Karos team owns"
 * in all three, including the case where client-owned findings existed and were
 * dropped for confidence. That reads as "we checked and cleared it" about work
 * nobody has checked — the same untrue-by-default problem this section replaced
 * "What we're fixing" to get away from. `buildClientSuggestions` says which
 * case it is; each sentence claims only that.
 *
 * ROUND 6: the sentence is about THEM, not about us. "Everything this snapshot
 * found is work your Karos team owns" is a sentence about Karos on the one
 * section of the report that is about the reader, and it made an absence read
 * like an apology. `karosOwned` and `none` are the same fact from the reader's
 * side — nothing here is waiting on you — so they say it in the same words.
 * `lowConfidence` is a different fact and keeps its own line.
 */
const EMPTY_COPY: Record<ClientSuggestionsEmptyReason, string> = {
  karosOwned: "Nothing on your side is holding you back right now.",
  lowConfidence:
    "Nothing to ask you for yet. We saw something on your side that we have not confirmed well enough to hand over.",
  none: "Nothing on your side is holding you back right now.",
};

export function ClientSuggestions({
  suggestions,
  emptyReason = "karosOwned",
}: {
  suggestions: ClientSuggestion[];
  /** Why the list is empty. Ignored when there is anything to show. */
  emptyReason?: ClientSuggestionsEmptyReason | null;
}) {
  // THE HEADING RENDERS WHETHER OR NOT THERE IS A ROW (round 6). The absence is
  // the finding the reader is paying for, and a section that disappears when it
  // finds nothing reads as a section that failed to load.
  return (
    <section className="space-y-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
        Things only you can do
      </p>
      <Card>
        {suggestions.length === 0 ? (
          <p className="text-sm text-muted-2">{EMPTY_COPY[emptyReason ?? "karosOwned"]}</p>
        ) : (
          <>
            <p className="mb-4 text-xs text-muted-2">
              Confirmed on this snapshot, and yours rather than ours: each needs an account
              or a record only your business can act on.
            </p>
            <ul>
              {suggestions.map((s) => (
                <li
                  key={s.id}
                  className="border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0"
                >
                  {/* No icon and no chevron: nothing here navigates, and a
                      glyph that suggests otherwise is the "one row affordance"
                      finding from the flow audit. The hierarchy is typographic
                      — what to do, why, what we saw. */}
                  <p className="text-sm font-medium text-foreground">{s.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{s.why}</p>
                  {s.evidence && (
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-2">
                      What we found: {s.evidence}
                    </p>
                  )}
                  {/* R7 (flow audit 2026-09): the invitation is the sentence,
                      the control keeps the one word every support trigger in
                      the portal uses. Short, because it repeats down the list. */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-muted-2">Need a hand?</span>
                    <FlagButton
                      subject={`Question about a suggestion on our visibility report: ${s.title}`}
                      message={`We'd like help with "${s.title}".${s.evidence ? ` The report says: ${s.evidence}` : ""}`}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </section>
  );
}
