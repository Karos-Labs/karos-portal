import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE UNIFIED BUTTON SET (product ruling, 2026-09-21, third design round).
 *
 * `li-drafts-review.tsx` / `x-drafts-review.tsx` used to render their own
 * "Pick & post" / "Pick with edits" / "Request a change" / "Skip" decision
 * tree, ALONGSIDE the host's (asset-card.tsx / asset-detail-modal.tsx)
 * generic Approve/Publish Now/Download bar — two uncoordinated button groups
 * on one card, which is what the CEO flagged from a live screenshot. That
 * shape is gone: each reader now offers exactly ONE primary control per
 * draft ("Open in LinkedIn" / "Open in X" — a convenience shortcut, not a
 * competing publish mechanism) plus the shared Download, with editing/
 * skipping demoted to plain text links. This file renders both readers
 * directly and pins that shape.
 *
 * It also pins the OTHER half of the redesign: button visibility must never
 * depend on `ClientIntegration.agentAutoPublish` (there is no `suppress`
 * prop left to set) — the compose shortcut is ALWAYS there. The only state
 * that changes what a draft card shows is `published`: once the note asset
 * has actually gone out (through auto-publish OR a staff click on the
 * host's own Publish Now), the card shows a plain confirmation instead.
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

function liMarkup(published?: boolean): string {
  const batch = parseLiDrafts(LI_COMPANY_SINGLE)!;
  return renderToStaticMarkup(
    <LiDraftsBatch
      clientId="client_1"
      assetId="asset_1"
      accounts={batch.accounts}
      media={[]}
      {...(published ? { published } : {})}
    />,
  );
}

function xMarkup(published?: boolean): string {
  const batch = parseXDrafts(X_COMPANY_SINGLE)!;
  return renderToStaticMarkup(
    <XDraftsBatch
      clientId="client_1"
      assetId="asset_1"
      accounts={batch.accounts}
      {...(published ? { published } : {})}
    />,
  );
}

describe("LiDraftsBatch renders the unified button set", () => {
  it("shows ONE primary control (Open in LinkedIn) plus Download, no old four-button vocabulary", () => {
    const html = liMarkup(false);
    expect(html).toContain("Open in LinkedIn");
    expect(html).toContain("Download");
    // The old picker vocabulary must be gone entirely - it never coexists
    // with the new one, whatever the asset's state.
    expect(html).not.toContain("Pick &amp; post");
    expect(html).not.toContain("Pick with edits");
    expect(html).not.toContain(">Skip<");
  });

  it("keeps offering the shortcut regardless of agentAutoPublish - there is no suppress prop anymore", () => {
    // liMarkup(false) above already proves the button renders whether or not
    // a caller would have set the old `suppressPickToPost` flag - the prop no
    // longer exists on this component's public API, so the shortcut can only
    // ever be hidden by `published` (asserted below).
    const html = liMarkup(false);
    expect(html).toContain("Open in LinkedIn");
  });

  it("shows a plain confirmation instead of any action row once `published` is true", () => {
    const html = liMarkup(true);
    expect(html).not.toContain("Open in LinkedIn");
    expect(html).not.toContain("Request a change");
    expect(html).not.toContain(">Skip<");
    // Download still offered - the one hand-off every asset type keeps.
    expect(html).toContain("Download");
    expect(html).toContain("Karos posted this to LinkedIn.");
  });
});

describe("XDraftsBatch renders the unified button set", () => {
  it("shows ONE primary control (Open in X) plus Download", () => {
    const html = xMarkup(false);
    expect(html).toContain("Open in X");
    expect(html).toContain("Download");
    expect(html).not.toContain("Pick &amp; post");
    expect(html).not.toContain("Pick with edits");
    expect(html).not.toContain(">Skip<");
  });

  it("shows a plain confirmation instead of any action row once `published` is true", () => {
    const html = xMarkup(true);
    expect(html).not.toContain("Open in X");
    expect(html).not.toContain(">Skip<");
    expect(html).toContain("Download");
    expect(html).toContain("Karos posted this to X.");
  });
});
