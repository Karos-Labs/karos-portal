import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE MANUAL PUBLISH NOW PLUMBING, PINNED AT THE SOURCE.
 *
 * `agent-draft-auto-publish.test.ts` proves `agentDraftManualPublishTarget`
 * computes the right eligibility. That proves nothing about whether any real
 * screen ever asks it, or whether the "Publish Now" button it feeds actually
 * reaches a LinkedIn/X agent draft — a predicate that renders correctly
 * while nothing ever calls it is exactly the shape of gap this fix exists to
 * close (compare the old agent-draft-picker-suppression-wiring.test.ts,
 * which pinned the PR #174/#175 plumbing this file replaces).
 *
 * So this file follows the data one hop at a time: the two components that
 * render a note asset's Publish Now button (`asset-card.tsx`, the staff
 * Assets list; `asset-detail-modal.tsx`, the client-reachable one) both
 * compute eligibility through the shared pure helper, and every server page
 * that feeds either component its `connectedPlatforms` also feeds it the
 * sibling `agentDraftPublishPlatforms` — the same discipline F107 pinned for
 * `connectedPlatformsByClient` itself.
 */

const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("asset-card.tsx computes agent-draft Publish Now eligibility and wires the new manual door", () => {
  const card = src("src/components/asset-card.tsx");

  it("imports the shared eligibility helper, rather than re-deriving it", () => {
    expect(card).toContain(
      'import { agentDraftManualPublishTarget } from "@/lib/agent-draft-auto-publish"',
    );
  });

  it("accepts the platforms prop and computes eligibility from it and the asset", () => {
    expect(card).toContain("agentDraftPublishPlatforms?: string[]");
    expect(card).toContain("agentDraftManualPublishTarget(asset, agentDraftPublishPlatforms)");
  });

  it("imports and calls the new manual publish action - not a second, forked mechanism", () => {
    expect(card).toContain("publishAgentDraftNowAction");
  });

  it("threads `published` (never the old suppress flag) to both readers", () => {
    const liMount = card.slice(card.indexOf("<LiDraftsBatch"), card.indexOf("<LiDraftsBatch") + 400);
    const xMount = card.slice(card.indexOf("<XDraftsBatch"), card.indexOf("<XDraftsBatch") + 400);
    expect(liMount, "LiDraftsBatch mount").toContain("published");
    expect(xMount, "XDraftsBatch mount").toContain("published");
    expect(card).not.toContain("suppressPickToPost");
  });
});

describe("asset-detail-modal.tsx gets the identical fix, reusing PublishNowInline", () => {
  const modal = src("src/components/asset-detail-modal.tsx");

  it("imports the shared eligibility helper", () => {
    expect(modal).toContain(
      'import { agentDraftManualPublishTarget } from "@/lib/agent-draft-auto-publish"',
    );
  });

  it("accepts the platforms prop and threads it to PublishNowInline (the SAME component every other platform's Publish Now uses)", () => {
    expect(modal).toContain("agentDraftPublishPlatforms?: string[]");
    const inlineMount = modal.slice(
      modal.indexOf("<PublishNowInline"),
      modal.indexOf("<PublishNowInline") + 300,
    );
    expect(inlineMount).toContain("agentDraftPublishPlatforms");
  });

  it("PublishNowInline itself calls the new manual publish action for an eligible agent draft", () => {
    expect(modal).toContain("publishAgentDraftNowAction");
    expect(modal).toContain("agentDraftManualPublishTarget(asset, agentDraftPublishPlatforms)");
  });

  it("threads `published` to both readers, never the old suppress flag", () => {
    const liMount = modal.slice(modal.indexOf("<LiDraftsBatch"), modal.indexOf("<LiDraftsBatch") + 400);
    const xMount = modal.slice(modal.indexOf("<XDraftsBatch"), modal.indexOf("<XDraftsBatch") + 400);
    expect(liMount, "LiDraftsBatch mount").toContain("published");
    expect(xMount, "XDraftsBatch mount").toContain("published");
    expect(modal).not.toContain("suppressPickToPost");
  });
});

describe("the data reaches those two components from a real ClientIntegration read, not a client-side fetch", () => {
  it("publish-targets.ts exposes the server-side lookup, scoped to note assets, NEVER gated on the agentAutoPublish flag", () => {
    const targets = src("src/lib/publish-targets.ts");
    expect(targets).toContain("export async function agentDraftPublishPlatformsByClient(");
    expect(targets).toContain('a.type === "note"');
    // The whole point of this redesign: eligibility is connected+usable, not
    // gated on the opt-in flag.
    expect(targets).not.toContain("i.agentAutoPublish === true");
  });

  it("run-calendar.tsx (staff calendar) threads it into the detail modal it owns", () => {
    const calendar = src("src/components/run-calendar.tsx");
    expect(calendar).toContain("agentDraftPublishPlatformsByClient?: Record<string, string[]>");
    const modalMount = calendar.slice(calendar.lastIndexOf("<AssetDetailModal"));
    expect(modalMount).toContain("agentDraftPublishPlatforms=");
  });

  it("calendar-body.tsx computes it server-side, staff-only, same as connectedPlatformsByClient", () => {
    const body = src("src/app/(app)/calendar/calendar-body.tsx");
    expect(body).toContain("agentDraftPublishPlatformsByClient(assets)");
    expect(body).toContain("agentDraftPublishPlatformsByClient:");
  });

  it("assets-view.tsx (the staff Assets grid) threads it into every AssetCard mount", () => {
    const view = src("src/components/assets-view.tsx");
    expect(view).toContain("agentDraftPublishPlatformsByClient?: Record<string, string[]>");
    const cardMounts = [...view.matchAll(/<AssetCard\b[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(cardMounts.length).toBeGreaterThan(0);
    for (const mount of cardMounts) {
      expect(mount, mount).toContain("agentDraftPublishPlatforms");
    }
  });

  it("/assets (both branches) and /clients/[id]/assets compute the map and pass it down", () => {
    for (const rel of ["src/app/(app)/assets/page.tsx", "src/app/(app)/clients/[id]/assets/page.tsx"]) {
      const page = src(rel);
      expect(page, rel).toContain("agentDraftPublishPlatformsByClient(");
      expect(page, rel).toContain("agentDraftPublishPlatformsByClient:");
    }
  });

  it("the job detail page (AssetCard, not AssetsView) computes and passes it too", () => {
    const page = src("src/app/(app)/jobs/[id]/page.tsx");
    expect(page).toContain("agentDraftPublishPlatformsByClient(realAssets)");
    expect(page).toContain("agentDraftPublishPlatforms");
  });
});

describe("asset-actions.ts exposes the new manual publish action, sharing the real publish with the automatic door", () => {
  const actions = src("src/lib/actions/asset-actions.ts");

  it("exports publishAgentDraftNowAction, staff-gated, with assetPublishBlock eligibility", () => {
    expect(actions).toContain("export async function publishAgentDraftNowAction(");
    expect(actions).toContain("await requireStaff()");
    expect(actions).toContain("assetPublishBlock(asset)");
  });

  it("shares the actual publish call with the automatic (agentAutoPublish) door, not a forked implementation", () => {
    expect(actions).toContain("async function publishAgentDraftTarget(");
    expect(actions).toContain("await publishAgentDraftTarget(asset, target, integration");
  });

  it("records LinkedIn/X-specific feedback so the learning loop hears a real publish the same way it hears a compose-shortcut pick", () => {
    expect(actions).toContain("async function recordAgentDraftPublishedFeedback(");
    expect(actions).toContain("addLiDraftFeedbackAction");
    expect(actions).toContain("addXDraftFeedbackAction");
  });
});
