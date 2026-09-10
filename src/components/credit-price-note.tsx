"use client";

import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/**
 * The announce line that sits beside a control which spends credits on press.
 *
 * WHY IT EXISTS (flow audit 2026-09, R3). The product already had this pattern
 * and applied it in three places out of eleven: `agent-detail-panel.tsx`'s
 * "Costs N credits" under "Create a new post", the format rows, and
 * `refresh-task-map-button.tsx`. Every intake surface charged silently — the
 * four "Set it up" bands, LinkedIn's "Build their voice", X's "Propose
 * accounts", the dynamic agents' "Run agent". Eight controls each growing their
 * own sentence is eight chances to word it differently or quote the wrong
 * number, so the sentence is one component and the number is passed in already
 * resolved from the constant its own server path charges from.
 *
 * THE PRICE IS THE CLIENT'S, ALWAYS, and the sentence says whose. This is
 * `refresh-task-map-button.tsx`'s parity rule: an unbilled reader (staff, or an
 * admin previewing an account) must not get a SHORTER control than the client
 * does — a price that simply vanishes means nobody previewing an account can
 * see the figure the client is quoted. Both readers get the same figure; what
 * changes is who the line says is paying it, RENDERED rather than left to a
 * tooltip a touch device cannot see. The unbilled reader is never told the
 * press costs THEM anything, which is the half of that rule about money.
 *
 * `price` is a formatted string ("5 credits") rather than a number because its
 * callers resolve it differently and both resolutions must stay at their
 * source: the constant-priced presses read `credits.ts`'s own quote helpers
 * (`xRosterProposalPrice(true)`, `simulationPrice(true)`), and the per-agent
 * setup runs read a figure the server resolved off the agent document. Null
 * renders nothing, so a caller with no price to state cannot accidentally
 * print "Costs credits".
 */
export function CreditPriceNote({
  price,
  viewerIsBilled,
  className,
}: {
  /** The CLIENT's price for one press, already formatted (e.g. "10 credits"). */
  price: string | null;
  /** `isBillableClientActor()` for this session — decides the marker, not the figure. */
  viewerIsBilled: boolean;
  className?: string;
}) {
  if (!price) return null;
  return (
    <p className={cn("mt-2 flex items-center gap-1 text-xs text-muted-2", className)}>
      <Icon name="Coins" className="h-3 w-3 shrink-0 text-neon" />
      {/* THE HEDGE LIVES IN `price`, NOT HERE (credits rework, 2026-09), and
          that is a correctness point rather than a style one. Most of this
          component's callers quote a SETUP charge, which is in
          `UNSETTLED_OPERATIONS` and never reconciles against actual cost — so
          "about" would be wrong for them however the flag is set. The callers
          that quote a settling press get their string from `credits.ts`'s own
          quote helpers, which hedge when and only when the rework is on. This
          component renders whichever string it is handed, in both voices. */}
      {viewerIsBilled ? `Costs ${price}` : `The client is charged ${price}`}
    </p>
  );
}
