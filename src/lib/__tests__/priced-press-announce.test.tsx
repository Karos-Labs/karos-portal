import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A CONFIRMATION IS ONLY AS GOOD AS THE NUMBER ON IT — asked of the RENDERED
 * MARKUP, not of the helper the component is supposed to call.
 *
 * Two client-pressed surfaces were metered in the same pass and only one of
 * them said so. `client-model-metering.test.ts` proves each quote matches the
 * amount its route actually charged; that leaves one question this file answers
 * instead: does the control PAINT it. A component can import a price function
 * and never render its result, or hardcode "5 credits" beside it, and every
 * string-level assertion stays green through both.
 *
 * So the assertion is over `renderToStaticMarkup` output, and the expected text
 * is built from the constant the route charges from — never a literal "5
 * credits", which would pin the wrong thing the moment the price moves.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { CREDIT_COSTS, creditsLabel } from "@/lib/credits";
import { RefreshTaskMapButton } from "@/components/refresh-task-map-button";
import { AiInsights } from "@/components/ai-insights";

function refreshButtonMarkup(viewerIsBilled: boolean): string {
  return renderToStaticMarkup(<RefreshTaskMapButton clientId="c1" viewerIsBilled={viewerIsBilled} />);
}

function insightsMarkup(viewerIsBilled: boolean): string {
  return renderToStaticMarkup(<AiInsights clientId="c1" viewerIsBilled={viewerIsBilled} />);
}

/** Markup text with the tags and React's numeric entities taken back out. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("the Task Map's Refresh Task Map button announces its price", () => {
  it("paints the price a billable client will be charged", () => {
    const text = textOf(refreshButtonMarkup(true));
    // POST /api/tasks/generate-swarm charges CREDIT_COSTS.taskExecution.
    expect(text).toContain(creditsLabel(CREDIT_COSTS.taskExecution));
  });

  /**
   * PARITY PASS (2026-09) changed the answer for the unbilled reader on THIS
   * control, and only this one. It used to paint no price at all, which made
   * staff's copy of the Task Map a visibly shorter button than the client's.
   * The ruling is that staff read the client's page as the client gets it, so
   * the suffix stays — attributed, in muted type, and named in the button's own
   * tooltip. The thing still worth pinning is that it is not presented as a
   * charge to the reader.
   *
   * The attribution moved into the BUTTON's title in the review wave (2026-09):
   * it used to hang on a `title` of the price span, nested inside the button's
   * own, so the two halves of the sentence had two different tooltips and the
   * button's said nothing about the client's price at all.
   */
  it("still quotes the client's price to a reader who is never charged, marked as the client's", () => {
    const markup = refreshButtonMarkup(false);
    // Same figure the billed client is quoted — a staff preview that showed a
    // different number would be worse than showing none.
    expect(textOf(markup)).toContain(creditsLabel(CREDIT_COSTS.taskExecution));
    // Rendered, for a touch device that has no hover at all…
    expect(textOf(markup)).toContain("client");
    // …and in the button's ONE title, which quotes the client's figure.
    expect(markup).toContain(`${creditsLabel(CREDIT_COSTS.taskExecution)} a press for the client, free for staff`);
    // Exactly one title on this control: a tooltip inside a tooltip is a
    // coin toss about which one the reader gets.
    expect(markup.match(/title="/g)?.length ?? 0).toBe(1);
  });

  it("never tells the unbilled reader the press costs THEM anything", () => {
    // The hover description is the one place the control says "costs …"; it is
    // still gated on `viewerIsBilled`, so an admin in "View as Client" is not
    // told they are about to spend. Asked of the raw markup because that copy
    // lives in a `title=` attribute, which `textOf` strips with the tags.
    expect(refreshButtonMarkup(false)).not.toMatch(/costs/i);
    expect(refreshButtonMarkup(true)).toMatch(/costs/i);
  });

  it("still renders the button itself, so the price test is not vacuous", () => {
    for (const billed of [true, false]) {
      expect(textOf(refreshButtonMarkup(billed))).toContain("Refresh Task Map");
    }
  });
});

describe("the AI Insights Refresh announces its price", () => {
  it("paints the price a billable client will be charged", () => {
    const text = textOf(insightsMarkup(true));
    // POST /api/clients/[id]/insights?force=1 charges CREDIT_COSTS.chatMessage —
    // singular today, which is exactly the case an unconditional "N credits"
    // renders as "1 credits".
    expect(text).toContain(creditsLabel(CREDIT_COSTS.chatMessage));
    expect(text).not.toContain(`${CREDIT_COSTS.chatMessage} credits`);
  });

  it("paints no price at all for a reader who is never charged", () => {
    expect(textOf(insightsMarkup(false))).not.toMatch(/credit/i);
  });

  it("still renders the card itself, so the price test is not vacuous", () => {
    for (const billed of [true, false]) {
      expect(textOf(insightsMarkup(billed))).toContain("AI Insights");
    }
  });
});

/**
 * The lab's own words for money never reach these surfaces: "credits" is the
 * client-facing currency, and "token" is claimed by PATs and LLM token counts.
 */
describe("the announced prices stay in client vocabulary", () => {
  it("never says token on either surface", () => {
    expect(textOf(refreshButtonMarkup(true))).not.toMatch(/token/i);
    expect(textOf(insightsMarkup(true))).not.toMatch(/token/i);
  });
});
