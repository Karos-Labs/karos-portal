import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clientSafeActor,
  isInternalActor,
  RUNWAY_ACTOR_NAME,
} from "@/lib/activity-actors";
import { computeRunway, FAMILY_PRODUCT, RUNWAY_HORIZON_DAYS } from "@/lib/runway";
import { startOfDayMs } from "@/lib/post-chain";
import type { Asset } from "@/lib/types";

/** Server-local timestamp helper (month 1-based) — keeps the suite TZ-independent. */
function at(y: number, m: number, d: number, h = 0): number {
  return new Date(y, m - 1, d, h, 0, 0, 0).getTime();
}

let seq = 0;
function makeAsset(overrides: Partial<Asset> = {}): Asset {
  seq++;
  return {
    id: `a-${seq}`,
    clientId: "c1",
    title: "Post",
    content: "Body",
    createdBy: "staff",
    createdAt: at(2026, 7, 1),
    updatedAt: at(2026, 7, 1),
    status: "draft",
    type: "instagram_post",
    meta: { source: "lab-import" },
    ...overrides,
  };
}

// NOW = Tue 2026-07-14. The 14-day window [07-14, 07-28) holds weekends on
// 07-18/19 and 07-25/26, so a weekday-only social target = 10 postable days.
const NOW = at(2026, 7, 14, 9);
const SOCIAL_TARGET = 10;

describe("computeRunway — active families", () => {
  it("marks social active from a connected platform even with no assets yet", () => {
    const r = computeRunway([], ["instagram"], NOW);
    expect(r.activeFamilies).toEqual(["social"]);
    expect(r.targetByFamily.social).toBe(SOCIAL_TARGET);
    expect(r.deficitByFamily.social).toBe(SOCIAL_TARGET);
    expect(r.shortFamilies).toEqual(["social"]);
    expect(r.coveredThroughMs).toBeNull();
  });

  it("is empty for a client with no platforms and no assets", () => {
    const r = computeRunway([], [], NOW);
    expect(r.activeFamilies).toEqual([]);
    expect(r.shortFamilies).toEqual([]);
  });

  it("activates email/article only when the client already produces them", () => {
    const r = computeRunway([makeAsset({ type: "email" })], [], NOW);
    expect(r.activeFamilies).toEqual(["email"]);
    expect(r.targetByFamily.email).toBe(2);
  });
});

describe("computeRunway — deficit & coverage", () => {
  it("counts undated backlog drafts as available future candidates", () => {
    const drafts = Array.from({ length: SOCIAL_TARGET }, () => makeAsset({ scheduledAt: undefined }));
    const r = computeRunway(drafts, ["instagram"], NOW);
    expect(r.availableByFamily.social).toBe(SOCIAL_TARGET);
    expect(r.deficitByFamily.social).toBe(0);
    expect(r.shortFamilies).toEqual([]);
  });

  it("reports coveredThroughMs as the furthest upcoming dated post", () => {
    const assets = [
      makeAsset({ status: "scheduled", scheduledAt: at(2026, 7, 16, 11) }),
      makeAsset({ status: "scheduled", scheduledAt: at(2026, 7, 22, 11) }),
      makeAsset({ status: "scheduled", scheduledAt: at(2026, 7, 10, 11) }), // past — ignored
    ];
    const r = computeRunway(assets, ["instagram"], NOW);
    expect(r.coveredThroughMs).toBe(startOfDayMs(at(2026, 7, 22)));
  });

  it("ignores placeholders, reference docs and published posts as future candidates", () => {
    const assets = [
      makeAsset({ publishMode: "placeholder", scheduledAt: at(2026, 7, 20, 11), status: "scheduled" }),
      makeAsset({ templateKey: "template-ideas", scheduledAt: at(2026, 7, 21, 11), status: "scheduled" }),
      makeAsset({ status: "published", publishedAt: at(2026, 7, 20, 11), scheduledAt: at(2026, 7, 20, 11) }),
    ];
    const r = computeRunway(assets, ["instagram"], NOW);
    expect(r.availableByFamily.social).toBe(0);
    expect(r.deficitByFamily.social).toBe(SOCIAL_TARGET);
  });

  it("keeps email short until it has its low-cadence target of upcoming issues", () => {
    const r = computeRunway([makeAsset({ type: "email", scheduledAt: at(2026, 7, 20, 10), status: "scheduled" })], [], NOW);
    expect(r.availableByFamily.email).toBe(1);
    expect(r.deficitByFamily.email).toBe(1); // target 2 − 1
    expect(r.shortFamilies).toEqual(["email"]);
  });
});

describe("runway constants", () => {
  it("exposes a 14-day horizon and the family→product map the cron dispatches", () => {
    expect(RUNWAY_HORIZON_DAYS).toBe(14);
    expect(FAMILY_PRODUCT).toEqual({
      social: "social_post",
      email: "newsletter_issue",
      article: "blog_article",
    });
  });
});


describe("the autopilot never signs a client's activity feed", () => {
  it("redacts the internal actor for client viewers only", () => {
    expect(clientSafeActor(RUNWAY_ACTOR_NAME, "staff", true)).toEqual({
      actor: "Karos",
      // The role moves with the name: a row labelled "Karos" that still claims
      // a staff actor puts a person behind an automated event.
      actorRole: "system",
    });
    // Staff keep the real name — they are the ones who need to know which
    // sweep fired.
    expect(clientSafeActor(RUNWAY_ACTOR_NAME, "staff", false)).toEqual({
      actor: RUNWAY_ACTOR_NAME,
      actorRole: "staff",
    });
  });

  it("leaves a real person's name alone", () => {
    expect(clientSafeActor("Albert Kattan", "staff", true)).toEqual({
      actor: "Albert Kattan",
      actorRole: "staff",
    });
    expect(clientSafeActor("Maya at Geektime", "client", true)).toEqual({
      actor: "Maya at Geektime",
      actorRole: "client",
    });
  });

  it("covers the other synthetic writers, however the string was stored", () => {
    for (const name of ["System AI", "Scheduler", "Client schedule", "  runway autopilot  "]) {
      expect(isInternalActor(name)).toBe(true);
      expect(clientSafeActor(name, "staff", true).actor).toBe("Karos");
    }
    expect(isInternalActor("Albert")).toBe(false);
  });

  it("is applied at the timeline projection, not at render", () => {
    // Everything on a timeline row is serialized into the RSC payload, so a
    // name redacted at render has already been shipped.
    const src = readFileSync(join(process.cwd(), "src/components/activity-timeline.tsx"), "utf8");
    expect(src).toContain("clientSafeActor(l.actor, l.actorRole, viewerIsClient)");
  });

  it("reads the actor name from one constant the route also uses", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/runway/route.ts"), "utf8");
    expect(route).toContain("name: RUNWAY_ACTOR_NAME");
    expect(route).not.toContain('name: "Runway autopilot"');
  });

  it("hands the agent a brief with no operations vocabulary in it", () => {
    // Whatever goes into the brief can come back out in a caption.
    const route = readFileSync(join(process.cwd(), "src/app/api/runway/route.ts"), "utf8");
    const brief = route.match(/notes: "([^"]+)"/)?.[1] ?? "";
    expect(brief).toBeTruthy();
    for (const phrase of ["runway", "top-up", "next two weeks", "automated"]) {
      expect(brief.toLowerCase()).not.toContain(phrase);
    }
  });
});
