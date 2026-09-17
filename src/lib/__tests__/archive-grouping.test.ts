import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  NO_PLATFORM_GROUP,
  archiveGroupFor,
  archiveGroupLogoSlug,
  orderArchiveGroups,
} from "@/lib/archive-grouping";
import { platformLabel } from "@/lib/integrations/platforms";
import type { Asset } from "@/lib/types";
import { stripComments } from "./source-scan";

/**
 * SCRUM-428: one Instagram section, not several.
 *
 * WHAT LOLA SAW. "Instagram results are being split up into different
 * categories and it's confusing."
 *
 * WHAT IT WAS. The archive grouped by `agentLabelByAssetId[id] ??
 * agentLabelForAsset(asset) ?? "Other content"` - by WHICH AGENT MADE IT. A
 * client with an Instagram agent and a carousel agent and a campaign agent that
 * also posts to Instagram got three sections that all read as "Instagram" from
 * outside. The key was an implementation fact (which of our agents ran)
 * presented as a content fact (what this post is).
 *
 * THE TEST THAT MATTERS is the first one below: several agents, one platform,
 * ONE section. Everything else guards the ways that could be true and still
 * wrong - the agent vanishing from the page, a second derivation of "what
 * platform is this" drifting from the one the asset card reads, or the
 * not-a-platform pile floating to the top on one fresh placeholder.
 */

const SRC = path.resolve(__dirname, "../..");
const code = (rel: string) => stripComments(readFileSync(path.join(SRC, rel), "utf8"));

const asset = (overrides: Partial<Asset> = {}): Asset =>
  ({
    id: "a1",
    clientId: "c1",
    type: "social_post",
    title: "A post",
    content: "Body",
    createdBy: "staff-1",
    createdAt: 1,
    status: "approved",
    ...overrides,
  }) as Asset;

/* ─────────────────────────── the bug, driven ─────────────────────────── */

describe("the grouping key", () => {
  it("puts several agents' Instagram output in ONE section", () => {
    // The whole ticket. Three assets, three different producing agents, one
    // platform between them.
    const fromInstagramAgent = asset({ id: "1", type: "instagram_post" });
    const fromCarouselAgent = asset({ id: "2", channels: ["instagram"] });
    const fromCampaignAgent = asset({ id: "3", scheduledPlatform: "instagram" });

    const sections = new Set(
      [fromInstagramAgent, fromCarouselAgent, fromCampaignAgent].map((a) => archiveGroupFor(a)),
    );
    expect([...sections]).toEqual([platformLabel("instagram")]);
    expect(sections.size).toBe(1);
  });

  it("still separates genuinely different platforms", () => {
    // Non-vacuity for the above: collapsing everything into one section would
    // also satisfy it.
    expect(archiveGroupFor(asset({ channels: ["linkedin"] }))).toBe(platformLabel("linkedin"));
    expect(archiveGroupFor(asset({ channels: ["reddit"] }))).toBe(platformLabel("reddit"));
    expect(archiveGroupFor(asset({ channels: ["linkedin"] }))).not.toBe(
      archiveGroupFor(asset({ channels: ["reddit"] })),
    );
  });

  it("spells each platform the way the rest of the app spells it", () => {
    // Through `platformLabel`, so "X (Twitter)" is not re-spelled here and a
    // new platform needs no edit in this module. QA F122 was this exact defect
    // one surface over: a bare id under CSS `capitalize` printed "Linkedin".
    for (const id of ["instagram", "linkedin", "reddit", "tiktok", "x"]) {
      expect(archiveGroupFor(asset({ channels: [id] }))).toBe(platformLabel(id));
    }
  });

  it("collects everything with no recorded platform into one pile", () => {
    // `social_post` deliberately answers null - its own type name says nothing
    // about its target (see content-platform.ts). So does a bare note.
    expect(archiveGroupFor(asset({ type: "social_post" }))).toBe(NO_PLATFORM_GROUP);
    expect(archiveGroupFor(asset({ type: "note" }))).toBe(NO_PLATFORM_GROUP);
    // And the pile is not named like a platform, so it cannot be mistaken for
    // one in a list of them.
    expect(NO_PLATFORM_GROUP).toBe("Other content");
    expect(platformLabel("other content")).not.toBe(NO_PLATFORM_GROUP);
  });
});

/* ──────────────────────────── the heading's mark ─────────────────────────── */

describe("the heading logo", () => {
  it("hands PlatformLogo a slug it actually matches", () => {
    // THE TRAP. `PlatformLogo` tests slug PREFIXES - `x-`, not `x` - so the
    // bare platform id would have silently dropped the X mark and drawn the
    // fallback glyph on an X section. Nothing would have errored.
    expect(archiveGroupLogoSlug(asset({ channels: ["x"] }))).toBe("x-");
    const logo = code("components/icon.tsx");
    expect(logo, "PlatformLogo stopped keying off an `x-` prefix").toContain('slug.startsWith("x-")');
  });

  it("passes the platform id through for the ones whose id IS the prefix", () => {
    expect(archiveGroupLogoSlug(asset({ channels: ["instagram"] }))).toBe("instagram");
    expect(archiveGroupLogoSlug(asset({ channels: ["linkedin"] }))).toBe("linkedin");
    expect(archiveGroupLogoSlug(asset({ channels: ["reddit"] }))).toBe("reddit");
    expect(archiveGroupLogoSlug(asset({ channels: ["tiktok"] }))).toBe("tiktok");
  });

  it("answers null for the pile, so no section wears somebody else's logo", () => {
    expect(archiveGroupLogoSlug(asset({ type: "social_post" }))).toBeNull();
  });
});

/* ────────────────────────────── section order ────────────────────────────── */

describe("section order", () => {
  it("keeps the not-a-platform pile last however fresh it is", () => {
    // A single new placeholder in the pile would otherwise push the platforms
    // the reader came for below the fold.
    const ordered = orderArchiveGroups([
      { name: NO_PLATFORM_GROUP, latestAt: 9_999 },
      { name: "Instagram", latestAt: 10 },
      { name: "LinkedIn", latestAt: 20 },
    ]);
    expect(ordered.map((g) => g.name)).toEqual(["LinkedIn", "Instagram", NO_PLATFORM_GROUP]);
  });

  it("orders the platform sections by their most recent work", () => {
    const ordered = orderArchiveGroups([
      { name: "Instagram", latestAt: 10 },
      { name: "Reddit", latestAt: 30 },
      { name: "LinkedIn", latestAt: 20 },
    ]);
    expect(ordered.map((g) => g.name)).toEqual(["Reddit", "LinkedIn", "Instagram"]);
  });

  it("does not mutate the array it was handed", () => {
    const input = [
      { name: "Instagram", latestAt: 10 },
      { name: "Reddit", latestAt: 30 },
    ];
    orderArchiveGroups(input);
    expect(input.map((g) => g.name)).toEqual(["Instagram", "Reddit"]);
  });
});

/* ───────────────────── the archive actually uses all this ───────────────── */

describe("the archive view", () => {
  const view = code("components/archive-view.tsx");

  it("keys its sections off the shared helper, deriving nothing itself", () => {
    // A second answer to "what platform is this" here is how this page and the
    // Assets page would come to disagree - which the ticket names as the next
    // version of this bug.
    expect(view).toContain("archiveGroupFor(asset)");
    expect(view).toContain("orderArchiveGroups(");
    expect(view).not.toContain("platformForAsset(");
    expect(view).not.toContain("platformLabel(");
  });

  it("no longer groups by the producing agent", () => {
    // The old key, gone from the grouping. `agentNameFor` survives - it feeds
    // the filter and the tile - so this asks about the MAP it used to build.
    expect(view).not.toContain("const byAgent = new Map");
    expect(view).toContain("const byPlatform = new Map");
  });

  it("keeps the agent as the secondary filter, narrowing WITHIN the sections", () => {
    // Keying the filter off the group name would have silently stopped
    // matching the moment the group stopped being the agent.
    expect(view).toContain('if (agent !== "all" && agentNameFor(asset) !== agent) continue;');
    expect(view).toContain('<option value="all">All agents</option>');
  });

  it("prints the producing agent on every tile", () => {
    // It used to be the section heading. Without this the agent that made a
    // post would be visible nowhere on the page, and it is the fact a client
    // asks about when a post reads oddly.
    expect(view).toContain("agentName={agentNameFor(asset)}");
    expect(view).toContain("{agentName}");
  });

  it("draws the platform's own mark on the heading, with a real fallback", () => {
    expect(view).toContain("<PlatformLogo");
    expect(view).toContain("slug={group.logoSlug}");
    // The pile has no slug, so the branch must exist rather than passing null
    // into a component whose fallback would then be its only output.
    expect(view).toContain("group.logoSlug ? (");
  });
});
