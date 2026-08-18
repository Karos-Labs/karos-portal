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
    // GET /api/tasks/generate-swarm charges CREDIT_COSTS.taskExecution.
    expect(text).toContain(creditsLabel(CREDIT_COSTS.taskExecution));
  });

  it("paints no price at all for a reader who is never charged", () => {
    // Staff, and an admin in "View as Client" — quoting them a price they do not
    // pay is the same class of defect in the other direction.
    expect(textOf(refreshButtonMarkup(false))).not.toMatch(/credit/i);
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
