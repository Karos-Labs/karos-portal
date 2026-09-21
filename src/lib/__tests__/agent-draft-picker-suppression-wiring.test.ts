import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE DOUBLE-PUBLISH BUG'S PLUMBING, PINNED AT THE SOURCE.
 *
 * `agent-draft-picker-suppression.test.tsx` proves `LiDraftsBatch`/
 * `XDraftsBatch` hide their pick-to-post buttons when told to. That proves
 * nothing about whether any real screen ever tells them to — and a prop that
 * renders correctly while nothing ever sets it is exactly the shape of bug
 * this fix exists to close (compare context-grounding-visible.test.tsx's own
 * "mounted, not just rendered" half for SCRUM-404).
 *
 * So this file follows the data one hop at a time: the two components that
 * ALWAYS render the generic Approve bar next to a drafts batch
 * (`asset-detail-modal.tsx`, the client-reachable one; `asset-card.tsx`, the
 * staff Assets list's own copy) both compute the suppression flag through the
 * shared pure helper and hand it to both readers — and every server page that
 * feeds either component its `connectedPlatforms` also feeds it the sibling
 * `agentAutoPublishPlatforms`, the same way F107 pinned that `connectedPlatformsByClient`
 * itself never goes missing.
 */

const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("asset-detail-modal.tsx computes and threads the suppression flag", () => {
  const modal = src("src/components/asset-detail-modal.tsx");

  it("imports the shared decision function, rather than re-deriving it", () => {
    expect(modal).toContain(
      'import { agentDraftAutoPublishSuppressesPicker } from "@/lib/agent-draft-auto-publish"',
    );
  });

  it("accepts the platforms prop and computes the flag from it and the asset", () => {
    expect(modal).toContain("agentAutoPublishPlatforms?: string[]");
    expect(modal).toContain(
      "agentDraftAutoPublishSuppressesPicker(asset, agentAutoPublishPlatforms)",
    );
  });

  it("hands the computed flag to BOTH readers - LinkedIn and X are mutually exclusive per asset, but the wiring must not silently drop either", () => {
    const liMount = modal.slice(modal.indexOf("<LiDraftsBatch"), modal.indexOf("<LiDraftsBatch") + 400);
    const xMount = modal.slice(modal.indexOf("<XDraftsBatch"), modal.indexOf("<XDraftsBatch") + 400);
    expect(liMount, "LiDraftsBatch mount").toContain("suppressPickToPost");
    expect(xMount, "XDraftsBatch mount").toContain("suppressPickToPost");
  });
});

describe("asset-card.tsx (the staff Assets list's own copy of the same layout) gets the identical fix", () => {
  const card = src("src/components/asset-card.tsx");

  it("imports the shared decision function", () => {
    expect(card).toContain(
      'import { agentDraftAutoPublishSuppressesPicker } from "@/lib/agent-draft-auto-publish"',
    );
  });

  it("accepts the platforms prop and computes the flag", () => {
    expect(card).toContain("agentAutoPublishPlatforms?: string[]");
    expect(card).toContain(
      "agentDraftAutoPublishSuppressesPicker(asset, agentAutoPublishPlatforms)",
    );
  });

  it("hands the computed flag to both readers", () => {
    const liMount = card.slice(card.indexOf("<LiDraftsBatch"), card.indexOf("<LiDraftsBatch") + 400);
    const xMount = card.slice(card.indexOf("<XDraftsBatch"), card.indexOf("<XDraftsBatch") + 400);
    expect(liMount, "LiDraftsBatch mount").toContain("suppressPickToPost");
    expect(xMount, "XDraftsBatch mount").toContain("suppressPickToPost");
  });
});

describe("the data reaches those two components from a real ClientIntegration read, not a client-side fetch", () => {
  it("publish-targets.ts exposes the server-side lookup, scoped to note assets (never isAssetPublishable - a draft never qualifies)", () => {
    const targets = src("src/lib/publish-targets.ts");
    expect(targets).toContain("export async function agentAutoPublishPlatformsByClient(");
    expect(targets).toContain("a.type === \"note\"");
    expect(targets).toContain("i.agentAutoPublish === true");
  });

  it("run-calendar.tsx (staff calendar) threads it into the detail modal it owns", () => {
    const calendar = src("src/components/run-calendar.tsx");
    expect(calendar).toContain("agentAutoPublishPlatformsByClient?: Record<string, string[]>");
    const modalMount = calendar.slice(calendar.lastIndexOf("<AssetDetailModal"));
    expect(modalMount).toContain("agentAutoPublishPlatforms=");
  });

  it("calendar-body.tsx computes it server-side, staff-only, same as connectedPlatformsByClient", () => {
    const body = src("src/app/(app)/calendar/calendar-body.tsx");
    expect(body).toContain("agentAutoPublishPlatformsByClient(assets)");
    expect(body).toContain("agentAutoPublishPlatformsByClient: autoPublishPlatformsByClient");
  });

  it("assets-view.tsx (the staff Assets grid) threads it into every AssetCard mount", () => {
    const view = src("src/components/assets-view.tsx");
    expect(view).toContain("agentAutoPublishPlatformsByClient?: Record<string, string[]>");
    const cardMounts = [...view.matchAll(/<AssetCard\b[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(cardMounts.length).toBeGreaterThan(0);
    for (const mount of cardMounts) {
      expect(mount, mount).toContain("agentAutoPublishPlatforms");
    }
  });

  it("/assets (both branches) and /clients/[id]/assets compute the map and pass it down", () => {
    for (const rel of ["src/app/(app)/assets/page.tsx", "src/app/(app)/clients/[id]/assets/page.tsx"]) {
      const page = src(rel);
      expect(page, rel).toContain("agentAutoPublishPlatformsByClient(");
      expect(page, rel).toContain("agentAutoPublishPlatformsByClient:");
    }
  });

  it("the job detail page (AssetCard, not AssetsView) computes and passes it too", () => {
    const page = src("src/app/(app)/jobs/[id]/page.tsx");
    expect(page).toContain("agentAutoPublishPlatformsByClient(realAssets)");
    expect(page).toContain("agentAutoPublishPlatforms: autoPublishPlatforms");
  });
});
