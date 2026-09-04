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
 * The three ways this list can be empty, said one at a time (review wave,
 * 2026-09).
 *
 * It used to say "everything this snapshot found is work your Karos team owns"
 * in all three, including the case where client-owned findings existed and were
 * dropped for confidence. That reads as "we checked and cleared it" about work
 * nobody has checked — the same untrue-by-default problem this section replaced
 * "What we're fixing" to get away from. `buildClientSuggestions` says which
 * case it is; each sentence claims only that.
 */
const EMPTY_COPY: Record<ClientSuggestionsEmptyReason, string> = {
  karosOwned:
    "Nothing is waiting on you right now. Everything this snapshot found is work your Karos team owns.",
  lowConfidence:
    "Nothing to ask you for yet. This snapshot turned up a couple of things that would be yours to fix, but we have not confirmed them well enough to hand over.",
  none: "This snapshot did not turn up anything for you to act on.",
};

export function ClientSuggestions({
  suggestions,
  emptyReason = "karosOwned",
}: {
  suggestions: ClientSuggestion[];
  /** Why the list is empty. Ignored when there is anything to show. */
  emptyReason?: ClientSuggestionsEmptyReason | null;
}) {
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
              Short, confirmed things we measured that we cannot do from our side. Your team
              owns the accounts and the relationships these need.
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
