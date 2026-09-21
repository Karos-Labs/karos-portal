import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE DOUBLE-PUBLISH BUG (PR #174 follow-up).
 *
 * `asset-detail-modal.tsx` (and `asset-card.tsx`, the staff Assets list's own
 * copy of the same layout) ALWAYS renders its own generic Approve bar for a
 * draft asset, entirely independently of whatever the LinkedIn/X drafts
 * reader renders inside it. Before this fix, an agent-drafted LinkedIn/X note
 * with `ClientIntegration.agentAutoPublish` turned on showed BOTH:
 *   - the reader's own "Pick & post" / "Pick with edits" / "Request a
 *     change" / "Skip" buttons (which only record feedback and hand the post
 *     to LinkedIn's/X's own compose UI for a human to press Post), and
 *   - the generic Approve button (which, with the flag on, calls the real
 *     OAuth publisher and posts for real — `autoPublishApprovedAgentDraft`).
 * Clicking both posted the same content twice.
 *
 * `LiDraftsBatch`/`XDraftsBatch` now take a `suppressPickToPost` prop (wired
 * from `agentDraftAutoPublishSuppressesPicker`, asserted separately in
 * agent-draft-auto-publish.test.ts) that hides exactly that button group,
 * leaving only Download — the same hand-off every other asset type gets —
 * when the auto-publish door is actually armed for this draft. This file
 * renders the two readers directly and asserts the buttons are gone exactly
 * when they should be, and present exactly when they shouldn't.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/actions/linkedin-agent-actions", () => ({ addLiDraftFeedbackAction: vi.fn() }));
vi.mock("@/lib/actions/x-agent-actions", () => ({ addXDraftFeedbackAction: vi.fn() }));

import { LiDraftsBatch } from "@/components/li-drafts-review";
import { XDraftsBatch } from "@/components/x-drafts-review";
import { parseLiDrafts } from "@/lib/li-drafts";
import { parseXDrafts } from "@/lib/x-drafts";

const LI_COMPANY_SINGLE = `# LinkedIn drafts — Karos Labs

## Account 1 · Karos Labs — Company page
*Brand voice: measured, no hype.*

### Post 1 · Thought-leadership

> Most founders do not need a $250K CMO.

\`40 chars\`
`;

const X_COMPANY_SINGLE = `# Account 1 · Company page @getkaros

## Avenue 1 · Build-in-public

> We shipped the drafts reader today.

\`36 chars\`
`;

function liMarkup(suppress: boolean): string {
  const batch = parseLiDrafts(LI_COMPANY_SINGLE)!;
  return renderToStaticMarkup(
    <LiDraftsBatch
      clientId="client_1"
      assetId="asset_1"
      accounts={batch.accounts}
      media={[]}
      {...(suppress ? { suppressPickToPost: true } : {})}
    />,
  );
}

function xMarkup(suppress: boolean): string {
  const batch = parseXDrafts(X_COMPANY_SINGLE)!;
  return renderToStaticMarkup(
    <XDraftsBatch
      clientId="client_1"
      assetId="asset_1"
      accounts={batch.accounts}
      {...(suppress ? { suppressPickToPost: true } : {})}
    />,
  );
}

describe("LiDraftsBatch suppresses pick-to-post exactly when the auto-publish door is armed", () => {
  it("shows the normal picker when suppressPickToPost is not set (every existing client, unchanged)", () => {
    const html = liMarkup(false);
    // renderToStaticMarkup HTML-escapes "&" to "&amp;".
    expect(html).toContain("Pick &amp; post on LinkedIn");
    expect(html).toContain("Pick with edits");
    expect(html).toContain("Request a change");
    expect(html).toContain("Skip");
    // Download stays either way.
    expect(html).toContain("Download");
  });

  it("hides the picker and keeps only Download when suppressPickToPost is true", () => {
    const html = liMarkup(true);
    expect(html).not.toContain("Pick &amp; post on LinkedIn");
    expect(html).not.toContain("Pick with edits");
    expect(html).not.toContain("Request a change");
    expect(html).not.toContain(">Skip<");
    expect(html).toContain("Download");
    // Explains why the buttons are gone, without assuming THIS viewer has
    // the (staff-only) Approve button on their own screen.
    expect(html).toContain("Once your team approves it");
  });
});

describe("XDraftsBatch suppresses pick-to-post exactly when the auto-publish door is armed", () => {
  it("shows the normal picker when suppressPickToPost is not set", () => {
    const html = xMarkup(false);
    expect(html).toContain("Pick &amp; post on X");
    expect(html).toContain("Pick with edits");
    expect(html).toContain(">Skip<");
    expect(html).toContain("Download");
  });

  it("hides the picker and keeps only Download when suppressPickToPost is true", () => {
    const html = xMarkup(true);
    expect(html).not.toContain("Pick &amp; post on X");
    expect(html).not.toContain("Pick with edits");
    expect(html).not.toContain(">Skip<");
    expect(html).toContain("Download");
    expect(html).toContain("Once your team approves it");
  });
});
