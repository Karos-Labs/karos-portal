import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { contextDocList } from "@/lib/agent-engine/context-grounding";
import type { AssetContextGrounding } from "@/lib/types";

/**
 * SCRUM-404 — the client-visible "this was drafted without your …" label.
 *
 * ## Why this is client-facing copy and not a staff diagnostic
 *
 * T-A10 blocks the grounded agents outright because a client-facing deliverable
 * naming external parties, drafted with zero grounding, is worse than not
 * drafting. SCRUM-388 relaxed that for a first-time client's onboarding, since
 * `intel-report-agent` would otherwise BLOCK on the very documents that run
 * exists to produce. **The relaxation is only honest if the marker is visible**
 * — a marker only staff can see leaves the client reading a bootstrap
 * deliverable that looks exactly like a fully-grounded one, which is the
 * situation T-A10 exists to prevent.
 *
 * ## Why the copy is shaped the way it is
 *
 * It says what is missing and what that means for the reader, and it does not
 * apologise or hedge. The failure mode to avoid is scare copy: this fires on a
 * new client's FIRST deliverable, which is the worst possible moment to imply
 * the work is broken. It is not broken — it was drafted before the documents
 * existed, which on an onboarding run is the expected order of events. So:
 * `warning`, never `danger`; a stated cause; and no suggestion that the client
 * did something wrong.
 *
 * The engine's own `reason` is rendered verbatim in the detail variant rather
 * than paraphrased. It carries the policy row's rationale, and re-wording it
 * here would put this component in the business of restating a decision it does
 * not own — the same reason the engine surfaces the rationale "verbatim in the
 * BLOCK reason / DEGRADED marker".
 */
export function ContextGroundingNotice({
  grounding,
  variant = "detail",
}: {
  grounding: AssetContextGrounding;
  /**
   * `"detail"` — the full notice, for a reader who has opened the deliverable.
   * `"chip"` — a two-word marker for a list row, so the gap is visible WITHOUT
   * opening it. A list that hides this until you click is a list that reads as
   * though every row were equally grounded.
   */
  variant?: "detail" | "chip";
}) {
  const docs = contextDocList(grounding.missingDocTypes);

  if (variant === "chip") {
    return (
      <span title={grounding.reason}>
        <Badge tone="warning">Limited context</Badge>
      </span>
    );
  }

  return (
    <div
      className="rounded-lg border border-warning/30 bg-warning/5 p-3"
      // Announced to a screen reader when the modal opens: this qualifies the
      // content below it, so a reader who never sees the amber must still be
      // told before they read the draft.
      role="note"
      aria-label="Context note for this deliverable"
    >
      <div className="flex items-start gap-2">
        <Icon name="CircleAlert" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        <div className="min-w-0 space-y-1">
          <p className="text-[12px] font-medium text-warning">
            {docs ? `Drafted without your ${docs}` : "Drafted with limited context"}
          </p>
          <p className="text-[11px] leading-relaxed text-muted">
            {docs
              ? `This was written before your ${docs} ${grounding.missingDocTypes.length > 1 ? "documents were" : "document was"} on file, so it is working from less about you than usual. Worth a closer read than a later one.`
              : "This was written with less of your setup on file than usual, so it is worth a closer read than a later one."}
          </p>
          {/* The engine's own words, kept as the smallest text rather than
              omitted: it is the audit trail for anyone asking why the label is
              here, and it names the agent so a client with several can tell
              which one this was. */}
          <p className="text-[10px] leading-relaxed text-muted-2">
            {grounding.agentId} · {grounding.reason}
          </p>
        </div>
      </div>
    </div>
  );
}
