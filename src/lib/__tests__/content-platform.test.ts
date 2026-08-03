import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assetRowPlatform,
  platformForAgentIdentity,
  platformForAsset,
  runRowPlatform,
  scheduleRowPlatform,
} from "@/lib/content-platform";
import { redactLockedAsset } from "@/lib/asset-visibility";
import type { ClientAgentIdentity } from "@/lib/agent-identity-map";
import type { Asset } from "@/lib/types";
import { stripComments } from "./source-scan";

/**
 * THE ONE RULE FOR WHICH LOGO A CALENDAR ITEM WEARS (AF-20).
 *
 * The property under test is not "does it find a platform" — it is WHEN IT
 * REFUSES TO. A calendar chip is the whole of what most clients read about next
 * Tuesday, so a mark that is merely plausible is a false statement made in one
 * glyph, with no room for a hedge and nothing to click through to. Every
 * `toBeNull` below is therefore load-bearing, and the two that matter most are
 * `social_post` (whose type name suggests nothing about its target) and a bare
 * library note (which is what a draft-only Reddit reply lands as).
 */

const instagramUmbrella: ClientAgentIdentity = {
  id: "client-1__instagram-agent",
  agentKey: "instagram-agent",
  customAgentId: "ca-ig",
  displayName: "Instagram Agent",
  platform: "instagram",
  chainFamily: "social",
  launchState: "live",
};

/** The case the umbrella rung exists for: renamed, so its name says nothing. */
const renamedUmbrella: ClientAgentIdentity = {
  id: "client-1__acme-voice",
  agentKey: "karos-instagram-tiktok-content-agent",
  customAgentId: "ca-voice",
  displayName: "Acme's voice",
  platform: "instagram",
  chainFamily: "social",
  launchState: "live",
};

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "a1",
    clientId: "client-1",
    type: "note",
    title: "Untitled",
    content: "",
    status: "draft",
    createdBy: "",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("platformForAsset", () => {
  it("takes the booked channel over every other rung", () => {
    const a = asset({
      type: "instagram_post",
      scheduledPlatform: "linkedin",
      channels: ["tiktok"],
      meta: { agentFolder: "reddit-agent" },
    });
    expect(platformForAsset(a, { platform: "instagram" })).toBe("linkedin");
  });

  it("maps the registry's own spellings onto their marks", () => {
    expect(platformForAsset(asset({ scheduledPlatform: "twitter" }))).toBe("x");
    expect(platformForAsset(asset({ scheduledPlatform: "linkedin_community" }))).toBe("linkedin");
  });

  it("skips a channel that maps onto no mark rather than giving up on the list", () => {
    // A client's channel list can carry analytics connections; they are not
    // places a post goes, so they must not shadow the one that is.
    expect(platformForAsset(asset({ channels: ["google_analytics", "youtube"] }))).toBe("youtube");
  });

  it("falls to the umbrella's stored platform when the post has no channel yet", () => {
    // The placeholder / roadmap case, which is most of a client's future week.
    expect(platformForAsset(asset({ type: "social_post" }), { platform: "instagram" })).toBe("instagram");
  });

  it("reads a type that names a platform", () => {
    expect(platformForAsset(asset({ type: "instagram_post" }))).toBe("instagram");
  });

  it("reads the producing agent's folder when nothing better answers", () => {
    expect(platformForAsset(asset({ meta: { agentFolder: "reddit-agent" } }))).toBe("reddit");
  });

  it("refuses a generic social post rather than inheriting the scheduling default", () => {
    // DEFAULT_PLATFORM_FOR_ASSET points social_post at instagram so the
    // scheduler has a channel to try first. That is not a claim about the
    // content — and instagram is not even among social_post's publish targets.
    expect(platformForAsset(asset({ type: "social_post" }))).toBeNull();
  });

  it("refuses an article, whose linkedin default is the same kind of guess", () => {
    expect(platformForAsset(asset({ type: "article" }))).toBeNull();
  });

  it("refuses a bare note", () => {
    expect(platformForAsset(asset())).toBeNull();
  });

  it("never reads the title, however loudly the title names a platform", () => {
    const a = asset({ type: "article", title: "5 ways to grow on Instagram" });
    expect(platformForAsset(a)).toBeNull();
  });
});

describe("platformForAgentIdentity", () => {
  it("answers the three exact-key agents", () => {
    expect(platformForAgentIdentity("karos-x-agent")).toBe("x");
    expect(platformForAgentIdentity("karos-linkedin-agent")).toBe("linkedin");
    expect(platformForAgentIdentity("karos-reddit-agent")).toBe("reddit");
  });

  it("answers a per-client LinkedIn company instance", () => {
    expect(platformForAgentIdentity("karos-linkedin-company-acme")).toBe("linkedin");
  });

  it("falls to the identity spelling for the agents with no key predicate", () => {
    expect(platformForAgentIdentity("karos-instagram-tiktok-content-agent")).toBe("instagram");
    expect(platformForAgentIdentity(null, "TikTok Agent")).toBe("tiktok");
  });

  it("keeps the key's answer when the name has been renamed past it", () => {
    expect(platformForAgentIdentity("karos-x-agent", "Acme's voice")).toBe("x");
  });

  it("refuses an agent that targets no platform", () => {
    expect(platformForAgentIdentity("karos-landing-builder", "Landing Builder")).toBeNull();
    expect(platformForAgentIdentity(null, null)).toBeNull();
  });
});

describe("row helpers", () => {
  it("gives a run its umbrella's platform", () => {
    const job = { agentName: "karos-instagram-agent", clientAgentId: instagramUmbrella.id };
    expect(runRowPlatform(job, [instagramUmbrella])).toBe("instagram");
  });

  it("keeps a renamed umbrella's mark, which its printed name can no longer give", () => {
    const job = { agentName: "some-run", clientAgentId: renamedUmbrella.id };
    expect(runRowPlatform(job, [renamedUmbrella])).toBe("instagram");
  });

  it("gives a schedule the same answer before it has ever fired", () => {
    const row = { agentName: "karos-reddit-agent", customAgentId: "" };
    expect(scheduleRowPlatform(row, [])).toBe("reddit");
  });

  it("refuses a run whose agent names no platform", () => {
    expect(runRowPlatform({ agentName: "Landing page" }, [])).toBeNull();
  });

  it("lets one post's booked channel outrank the umbrella that produced it", () => {
    // An umbrella can publish a single post somewhere it is not named after,
    // and the post is the thing being drawn.
    const a = asset({ type: "social_post", scheduledPlatform: "linkedin", meta: { taskType: "social_post" } });
    expect(assetRowPlatform(a, [instagramUmbrella])).toBe("linkedin");
  });
});

describe("a client's locked week", () => {
  /**
   * The chips AF-20 is most about are future-dated, and a client's future-dated
   * assets cross the boundary as whitelist-redacted copies. `scheduledPlatform`
   * is not on that whitelist, so the top rung is BLIND for exactly those posts —
   * the same class of defect calendar-locked-chip.test.ts pins for `postKind`.
   *
   * This asserts the resolver still answers through the rungs that DO survive
   * (`channels`, the umbrella reached via the asset's family, the type), so the
   * locked chip and the unlocked one agree about where the post is going.
   */
  it("still answers off a redacted copy, through the rungs that survive", () => {
    const real = asset({
      type: "social_post",
      scheduledPlatform: "instagram",
      channels: ["instagram"],
      scheduledAt: Date.now() + 86_400_000,
      meta: { agentFolder: "instagram-agent" },
    });
    const locked = redactLockedAsset(real);
    expect(locked.scheduledPlatform).toBeUndefined();
    expect(assetRowPlatform(locked, [instagramUmbrella])).toBe("instagram");
  });

  it("answers a channel-less locked post through its family's live umbrella", () => {
    const locked = redactLockedAsset(
      asset({ type: "social_post", scheduledAt: Date.now() + 86_400_000 }),
    );
    expect(locked.channels).toBeUndefined();
    expect(assetRowPlatform(locked, [instagramUmbrella])).toBe("instagram");
  });
});

describe("the calendar ships the token, not the fields it was read from", () => {
  /**
   * The resolver's rules are proved above; this proves only the WIRING, which
   * no behavioural test on a server component can reach. What it is really
   * guarding is the boundary rule: the projection resolves and sends
   * `platform`, so no umbrella row, job name or channel list has to cross for a
   * chip to draw a logo.
   */
  const body = stripComments(
    readFileSync(join(process.cwd(), "src/app/(app)/calendar/calendar-body.tsx"), "utf8"),
  );

  it("resolves all three calendar item kinds server-side", () => {
    expect(body).toContain("scheduleRowPlatform(");
    expect(body).toContain("runRowPlatform(");
    expect(body).toContain("assetRowPlatform(");
  });

  it("hands the client component a platform field on both shapes", () => {
    const calendar = stripComments(
      readFileSync(join(process.cwd(), "src/components/run-calendar.tsx"), "utf8"),
    );
    for (const shape of ["CalendarRun", "CalendarPost"]) {
      const start = calendar.indexOf(`export interface ${shape} {`);
      expect(start, `${shape} should still be declared`).toBeGreaterThan(-1);
      const body = calendar.slice(start, calendar.indexOf("\n}", start));
      expect(body, `${shape} should carry the resolved token`).toContain("platform?: SocialPlatform");
    }
  });
});
