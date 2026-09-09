import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE INTAKE SURFACES ANNOUNCE WHAT A PRESS COSTS — asked of the RENDERED
 * MARKUP, for the reason priced-press-announce.test.tsx already states about
 * its own two controls: a component can import a price helper and never render
 * its result, or hardcode a figure beside it, and a source-level assertion
 * stays green through both.
 *
 * WHAT THIS COVERS. The flow audit (2026-09, R3) found the product applying its
 * own "Costs N credits" pattern in three places out of eleven: every metered
 * control on an intake surface charged silently. These are the ones that were
 * silent — the four "Set it up" bands, X's "Propose accounts", the dynamic
 * agents' "Run agent" — plus the two LinkedIn controls that fired a billable
 * run from a label that named only a save.
 *
 * Expected text is always built from the constant or prop the charge is taken
 * from, never a literal "10 credits", which would pin the wrong thing the
 * moment a price moves.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

// EXACT, NOT HEDGED, and that is a claim about these particular presses rather
// than about the rework (credits rework, 2026-09). Almost every price this file
// covers is a one-time SETUP charge, which sits in `UNSETTLED_OPERATIONS` and
// never reconciles against actual cost — "about" would be wrong for it whatever
// the flag says. The X roster proposal DOES settle, and it reads its quote from
// `xRosterProposalPrice`, which hedges only when `CREDITS_PLAN_V2_ENABLED` is
// on; these tests run with it off, which is production's own default.
import { CREDIT_COSTS, creditsLabel } from "@/lib/credits";
import { BlogAgentIntake } from "@/components/blog-agent-intake";
import { NewsletterAgentIntake } from "@/components/newsletter-agent-intake";
import { ReputationAgentIntake } from "@/components/reputation-agent-intake";
import {
  LinkedInAgentIntake,
  type LiIntakeView,
  type LiSeatView,
} from "@/components/linkedin-agent-intake";
import { XAgentIntake } from "@/components/x-agent-intake";
import { DynamicAgentIntakeForm } from "@/components/dynamic-agent-intake-form";

/** Markup text with the tags and React's numeric entities taken back out. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** A per-agent setup price that is deliberately not any constant in the app. */
const SETUP_COST = 37;

function blog(viewerIsBilled: boolean): string {
  return renderToStaticMarkup(
    <BlogAgentIntake
      clientId="c1"
      company={{ cmsName: "WordPress" }}
      isSetUp={false}
      runs={[]}
      setupCost={SETUP_COST}
      viewerIsBilled={viewerIsBilled}
      isStaff={false}
    />,
  );
}

function newsletter(viewerIsBilled: boolean): string {
  return renderToStaticMarkup(
    <NewsletterAgentIntake
      clientId="c1"
      company={{ preferredWeekday: 2 }}
      isSetUp={false}
      feedback={[]}
      runs={[]}
      setupCost={SETUP_COST}
      viewerIsBilled={viewerIsBilled}
      isStaff={false}
    />,
  );
}

function reputation(viewerIsBilled: boolean): string {
  return renderToStaticMarkup(
    <ReputationAgentIntake
      clientId="c1"
      company={{ reviewSurfaces: ["Google"] }}
      isSetUp={false}
      runs={[]}
      setupCost={SETUP_COST}
      viewerIsBilled={viewerIsBilled}
      isStaff={false}
    />,
  );
}

function linkedin(opts: {
  viewerIsBilled: boolean;
  isSetUp: boolean;
  /** null opens the company form; a saved intake leaves it collapsed. */
  company?: LiIntakeView | null;
  seats?: LiSeatView[];
}): string {
  return renderToStaticMarkup(
    <LinkedInAgentIntake
      clientId="c1"
      company={
        opts.company === undefined
          ? { handle: "linkedin.com/company/acme", offLimits: "nothing" }
          : opts.company
      }
      seats={opts.seats ?? []}
      news={[]}
      isSetUp={opts.isSetUp}
      feedback={[]}
      runs={[]}
      runInFlight={false}
      setupCost={SETUP_COST}
      viewerIsBilled={opts.viewerIsBilled}
      isStaff={false}
    />,
  );
}

function xAgent(viewerIsBilled: boolean): string {
  return renderToStaticMarkup(
    <XAgentIntake
      clientId="c1"
      company={null}
      seats={[]}
      news={[]}
      feedback={[]}
      runs={[]}
      runInFlight={false}
      viewerIsBilled={viewerIsBilled}
      isStaff={false}
    />,
  );
}

describe("every setup band quotes what its press charges", () => {
  const bands: Array<[string, (billed: boolean) => string]> = [
    ["blog", blog],
    ["newsletter", newsletter],
    ["reputation", reputation],
    ["linkedin", (billed) => linkedin({ viewerIsBilled: billed, isSetUp: false })],
  ];

  for (const [family, paint] of bands) {
    it(`${family} paints the per-agent setup price a billable client pays`, () => {
      const text = textOf(paint(true));
      expect(text).toContain("Set it up");
      expect(text).toContain(`Costs ${creditsLabel(SETUP_COST)}`);
    });

    it(`${family} quotes the same figure to an unbilled reader, as the client's`, () => {
      // The parity rule refresh-task-map-button.tsx set: staff previewing an
      // account see the number the client is quoted, never a shorter control —
      // and never a line saying the press costs THEM anything.
      const text = textOf(paint(false));
      expect(text).toContain(`The client is charged ${creditsLabel(SETUP_COST)}`);
      expect(text).not.toContain(`Costs ${creditsLabel(SETUP_COST)}`);
    });
  }
});

describe("LinkedIn's two silent charges name the run and quote it", () => {
  it('the first "Save company page" names the setup run it fires', () => {
    // The save auto-fires the billable stand-up while `isSetUp === false`, and
    // the button used to say only "Save company page". `company: null` is what
    // opens the form on first paint — a saved one collapses behind "Edit".
    const text = textOf(linkedin({ viewerIsBilled: true, isSetUp: false, company: null }));
    expect(text).toContain("Save and set it up");
    expect(text).toContain(`Costs ${creditsLabel(SETUP_COST)}`);
  });

  it("a later save fires no run, so it neither renames nor quotes", () => {
    const text = textOf(linkedin({ viewerIsBilled: true, isSetUp: true, company: null }));
    expect(text).toContain("Save company page");
    expect(text).not.toContain("Save and set it up");
  });

  it('a seat\'s "Build their voice" quotes the run it fires', () => {
    // Rendered from the seat card's footer, which paints in both states — the
    // one voice-run control a first paint can reach.
    const seat: LiSeatView = {
      id: "s1",
      name: "Dana Fine",
      slug: "dana-fine",
      intake: { handle: null, offLimits: "nothing" },
      voiceReady: false,
    };
    const text = textOf(linkedin({ viewerIsBilled: true, isSetUp: true, seats: [seat] }));
    expect(text).toContain("Build their voice");
    expect(text).toContain(`Costs ${creditsLabel(SETUP_COST)}`);
  });

  it('"Add seat" names the voice run it fires', () => {
    // SOURCE, not render, and only for this one control: the add form is behind
    // its own disclosure, so a static paint (no event loop to click with)
    // reaches the "+ Add a seat" toggle and stops there. The price line beside
    // it is the shared CreditPriceNote every render assertion above covers; what
    // cannot be reached any other way is the LABEL, which is the half of this
    // finding about a press that did not say it was buying a run.
    const src = readFileSync(
      join(process.cwd(), "src/components/linkedin-agent-intake.tsx"),
      "utf8",
    );
    expect(src).toContain('"Add seat and build their voice"');
    const addForm = src.slice(src.indexOf("function AddSeatForm"));
    expect(addForm.slice(0, addForm.indexOf("\n}\n"))).toContain("<CreditPriceNote");
  });
});

describe("X's account proposal quotes the credit it spends", () => {
  it("paints the price beside the control, from the constant the action charges", () => {
    // proposeXRosterAction charges CREDIT_COSTS.chatMessage — "the existing
    // rate for the nearest operation", see its own docstring.
    const text = textOf(xAgent(true));
    expect(text).toContain("Propose accounts");
    expect(text).toContain(`Costs ${creditsLabel(CREDIT_COSTS.chatMessage)}`);
  });

  it("quotes the client's figure to an unbilled reader, as the client's", () => {
    const text = textOf(xAgent(false));
    expect(text).toContain(`The client is charged ${creditsLabel(CREDIT_COSTS.chatMessage)}`);
  });
});

describe("the dynamic agents' Run agent quotes its spec's price", () => {
  it("paints the figure the submit core freezes onto the run", () => {
    const html = renderToStaticMarkup(
      <DynamicAgentIntakeForm
        inputSchema={[]}
        clientId="c1"
        onSubmit={() => {}}
        creditsCost={12}
        viewerIsBilled
      />,
    );
    expect(textOf(html)).toContain("Run agent");
    expect(textOf(html)).toContain(`Costs ${creditsLabel(12)}`);
  });

  it("says nothing when the mount has no price to state", () => {
    // Absent ⇒ no line at all, never "Costs credits".
    const html = renderToStaticMarkup(
      <DynamicAgentIntakeForm inputSchema={[]} clientId="c1" onSubmit={() => {}} />,
    );
    expect(textOf(html)).not.toMatch(/costs/i);
    expect(textOf(html)).toContain("Run agent");
  });
});
