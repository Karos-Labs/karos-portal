import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clientSafeActor,
  isInternalActor,
  RUNWAY_ACTOR_NAME,
} from "@/lib/activity-actors";
import {
  computeRunway,
  dispatchesFor,
  FAMILY_PRODUCT,
  resolveMaxJobs,
  RUNWAY_HORIZON_DAYS,
} from "@/lib/runway";
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

  it("ships a deploy cap that can actually fill the horizon", () => {
    // The code default is right, and irrelevant on a real deploy: cloudbuild
    // passes RUNWAY_MAX_JOBS_PER_CLIENT as an env var on every release, so the
    // substitution — not RUNWAY_MAX_JOBS_DEFAULT — is what the sweep reads in
    // production. It shipped as "2", which is the deficit-of-10-gets-2
    // behaviour Albert's 2026-07-28 ruling removed from the code, waiting in
    // config to come back the moment the flag is flipped.
    //
    // One managed run yields one asset, so a client who starts empty needs a
    // full horizon of dispatches to reach it. Anything below that silently
    // caps the first fill.
    const yaml = readFileSync(join(process.cwd(), "cloudbuild.yaml"), "utf8");
    const cap = yaml.match(/^\s*_RUNWAY_MAX_JOBS_PER_CLIENT:\s*"(\d*)"/m)?.[1];
    expect(cap, "cloudbuild.yaml no longer sets _RUNWAY_MAX_JOBS_PER_CLIENT").toBeDefined();
    // Empty is allowed — it hands the decision back to the code default, which
    // is derived from the horizon. Any number set must cover a full fill.
    if (cap !== "") expect(Number(cap)).toBeGreaterThanOrEqual(RUNWAY_HORIZON_DAYS);
    // And the substitution has to reach the service, or none of this matters.
    expect(yaml).toContain("RUNWAY_MAX_JOBS_PER_CLIENT=${_RUNWAY_MAX_JOBS_PER_CLIENT}");
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

  it("is applied at the RSC boundary, not inside the client component", () => {
    // Everything on a timeline row is serialized into the RSC payload, so a
    // name redacted at render has already been shipped. This assertion used to
    // point INSIDE activity-timeline.tsx — a "use client" component, i.e. the
    // render side of that very boundary — so it was pinning the failure it was
    // written to prevent. The projection belongs in the server file.
    const server = readFileSync(join(process.cwd(), "src/app/(app)/tasks/tasks-body.tsx"), "utf8");
    expect(server).toContain("clientSafeActor(log.actor, log.actorRole, isClientViewer)");
    // ...and the redacted list has to be the one that actually goes down.
    expect(server).toContain("activityLogs={timelineActivity}");

    // Comments stripped: the assertions below say the names are absent from the
    // CODE, and the component's docstrings name them precisely to explain why.
    const ui = readFileSync(join(process.cwd(), "src/components/activity-timeline.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(ui).toContain('"use client"');
    // The component cannot leak what it never receives: it takes the projected
    // rows and no longer imports the redactor at all.
    expect(ui).toContain("activityLogs: TimelineActivity[]");
    expect(ui).not.toContain("clientSafeActor");
    expect(ui).not.toContain("ActivityLog");
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


/**
 * The FILL policy (Albert's ruling, 2026-07-28). One managed run yields one
 * asset, so a family that is 14 days short needs 14 dispatches to be full. The
 * original cap of 2 turned "every client always has a visible runway" into "two
 * more posts a week", which never catches up on a client who starts empty.
 */
describe("runway dispatch budget", () => {
  it("defaults to a full 14-day fill", () => {
    expect(resolveMaxJobs(undefined)).toBe(RUNWAY_HORIZON_DAYS);
    expect(resolveMaxJobs("")).toBe(RUNWAY_HORIZON_DAYS);
  });

  it("honours an explicit zero instead of inverting it", () => {
    // `Number(raw) || DEFAULT` read 0 as absent and substituted the default, so
    // the one value an operator uses to say "dispatch nothing this sweep" was
    // the value that dispatched the most.
    expect(resolveMaxJobs("0")).toBe(0);
  });

  it("takes an operator's explicit ceiling", () => {
    expect(resolveMaxJobs("3")).toBe(3);
    expect(resolveMaxJobs("30")).toBe(30);
  });

  it("falls back on anything that is not a whole non-negative count", () => {
    for (const raw of ["-1", "2.5", "lots", "NaN"]) {
      expect(resolveMaxJobs(raw)).toBe(RUNWAY_HORIZON_DAYS);
    }
  });
});

describe("dispatchesFor", () => {
  it("fires one job per missing day", () => {
    // A deficit of 10 gets 10 dispatches under a 14 cap — not 1, and not one
    // job carrying "make 10 posts" (the managed schemas take no count field,
    // and a prose request for ten posts returns ten versions of one idea).
    expect(dispatchesFor(10, 14)).toBe(10);
  });

  it("never exceeds what is left of the client's budget", () => {
    expect(dispatchesFor(14, 3)).toBe(3);
    expect(dispatchesFor(10, 0)).toBe(0);
  });

  it("treats a family with no deficit as nothing to do", () => {
    expect(dispatchesFor(0, 14)).toBe(0);
    expect(dispatchesFor(-2, 14)).toBe(0);
  });

  it("shares one budget across two short families", () => {
    // The second family gets what the first left, so a client short on both
    // does not spend the whole sweep on whichever came first.
    let remaining = 14;
    const social = dispatchesFor(10, remaining);
    remaining -= social;
    const email = dispatchesFor(8, remaining);
    expect([social, email]).toEqual([10, 4]);
    expect(social + email).toBe(14);
  });
});

describe("the sweep stays off until Tomer flips it", () => {
  it("keeps the flag check, the report-only path and per-client isolation", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/runway/route.ts"), "utf8");
    expect(src).toContain('process.env.RUNWAY_AUTOGEN_ENABLED === "1"');
    expect(src).toContain("if (!enabled || !serviceReady || dryRun)");
    expect(src).toContain("RUNWAY_AUTOGEN_ENABLED not set — report only");
    // One client's failure must not end the sweep for the rest.
    expect(src).toContain("} catch (e) {");
    expect(src).toContain('operation: "runway_autopilot"');
  });

  it("fills the deficit rather than slicing the family list", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/runway/route.ts"), "utf8");
    expect(src).toContain("dispatchesFor(runway.deficitByFamily[family] ?? 0, remaining)");
    // The old shape capped by SLICING the candidate families, which is what
    // made a 14-day hole a 2-post top-up.
    expect(src).not.toContain(".slice(0, maxJobsPerClient)");
  });
});
