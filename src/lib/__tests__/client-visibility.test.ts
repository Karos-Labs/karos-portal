import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasAiProcessingFailure,
  toClientPortalView,
  toStaffShellView,
} from "@/lib/client-visibility";
import type { StaffShellClientView } from "@/lib/client-visibility";
// Type-only: `active-client-context.tsx` is a "use client" module, and this
// import is erased before vitest ever resolves it. `tsc` still checks it.
import type { ActiveClientData } from "@/lib/active-client-context";
import { clientIntelSchedule } from "@/lib/intel-schedule";
import type { Client } from "@/lib/types";

function makeClient(patch: Partial<Client> = {}): Client {
  return {
    id: "c1",
    name: "Acme",
    status: "active",
    assignedEmployeeIds: ["staff-1", "staff-2"],
    clientKeyId: "ck_supersecretjointoken",
    agentsRepoSlug: "acme",
    logoStoragePath: "clients/c1/logo.png",
    onboardingError: "pipeline blew up on stage 3",
    customAgentIds: ["agent-1"],
    linkedinSeatLimit: 5,
    website: "https://acme.test",
    brandVoice: "warm",
    isAiProcessing: true,
    aiProcessingError: "out of credits",
    createdAt: 1,
    createdBy: "staff-1",
    ...patch,
  };
}

describe("toClientPortalView", () => {
  it("never carries the workspace join token into the client payload", () => {
    const view = toClientPortalView(makeClient());
    expect(view.clientKeyId).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("ck_supersecretjointoken");
  });

  it("drops internal routing, storage and pipeline fields", () => {
    const view = toClientPortalView(makeClient());
    expect(view.agentsRepoSlug).toBeUndefined();
    expect(view.logoStoragePath).toBeUndefined();
    expect(view.onboardingError).toBeUndefined();
    expect(view.customAgentIds).toBeUndefined();
    expect(view.linkedinSeatLimit).toBeUndefined();
    expect(view.assignedEmployeeIds).toEqual([]);
    expect(view.createdBy).toBe("");
  });

  it("keeps what the rail actually renders", () => {
    const view = toClientPortalView(makeClient());
    expect(view.id).toBe("c1");
    expect(view.name).toBe("Acme");
    expect(view.website).toBe("https://acme.test");
    expect(view.brandVoice).toBe("warm");
    expect(view.isAiProcessing).toBe(true);
  });

  it("resolves the category HERE, so the old field name never crosses (CD-L)", () => {
    // `industry` and `category` were the same fact under two names. Both used to
    // be shipped, and the panel painted only the second — so a client whose
    // value predated the rename saw an empty chip in their own sidebar while the
    // copilot briefed itself on the one they could not see. The projection is
    // where the fallback is answered: one field crosses, under the name the
    // panel's pencil writes back to.
    for (const [stored, expected] of [
      [{ category: "Martech", industry: "SaaS" }, "Martech"],
      [{ industry: "SaaS" }, "SaaS"],
      [{ category: "  ", industry: "SaaS" }, "SaaS"],
    ] as Array<[Partial<Client>, string]>) {
      const view = toClientPortalView(makeClient(stored));
      expect(view.category).toBe(expected);
      expect("industry" in view, "the legacy field name crossed the boundary").toBe(false);
    }
    // Neither stored: no key at all, same as every other absent profile field.
    const bare = toClientPortalView(makeClient());
    expect("category" in bare).toBe(false);
    expect("industry" in bare).toBe(false);
  });

  // F69: both client-side readers only ever asked WHETHER the last run failed,
  // and aiProcessingError is a raw provider string (500 chars of it).
  it("tells the client THAT generation failed, never why", () => {
    const view = toClientPortalView(makeClient());
    expect(view.aiProcessingFailed).toBe(true);
    expect(view.aiProcessingError).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("out of credits");
  });

  it("sets no failure flag when the last run did not fail", () => {
    const view = toClientPortalView(makeClient({ aiProcessingError: undefined }));
    expect(view.aiProcessingFailed).toBeUndefined();
  });

  it("hasAiProcessingFailure answers the same on either side of the boundary", () => {
    const staff = makeClient();
    expect(hasAiProcessingFailure(staff)).toBe(true);
    expect(hasAiProcessingFailure(toClientPortalView(staff))).toBe(true);
    const healthy = makeClient({ aiProcessingError: undefined });
    expect(hasAiProcessingFailure(healthy)).toBe(false);
    expect(hasAiProcessingFailure(toClientPortalView(healthy))).toBe(false);
  });

  it("is built by construction — an unknown future field is excluded by default", () => {
    const withFuture = { ...makeClient(), someNewSecret: "leak-me" } as unknown as Client;
    expect(JSON.stringify(toClientPortalView(withFuture))).not.toContain("leak-me");
  });

  /**
   * The branding sub-projection used to spread-and-delete: `{ ...g }` with one
   * field rebuilt, plus an early `return g` for a record with no palette. So
   * every other field was opted IN by default, one level down from the
   * whitelist above — including the storage path this same test file asserts is
   * excluded at the top level.
   */
  describe("branding sub-projection", () => {
    const branded = (patch: Partial<Client["brandingGuidelines"]> = {}) =>
      toClientPortalView(
        makeClient({
          brandingGuidelines: {
            dominantColors: [
              { hex: "#e91e8c", dominanceRank: 1, role: "Logo fill", usagePct: 60 },
              { hex: "#101014", dominanceRank: 2, usagePct: 40 },
            ],
            fontHeading: "Söhne",
            toneKeywords: ["warm", "direct"],
            logoUrl: "https://cdn.test/logo.png",
            logoStoragePath: "clients/c1/branding/logo.png",
            updatedAt: 42,
            ...patch,
          },
        }),
      ).brandingGuidelines!;

    it("strips the agency's internal usage mix from every swatch", () => {
      const view = branded();
      expect(view.dominantColors?.every((c) => c.usagePct === undefined)).toBe(true);
      expect(JSON.stringify(view)).not.toContain("usagePct");
    });

    it("drops the storage path nested inside branding, not just at the top level", () => {
      expect(branded().logoStoragePath).toBeUndefined();
      expect(JSON.stringify(branded())).not.toContain("clients/c1/branding");
    });

    it("still drops it for a record with NO palette (the old early return)", () => {
      const view = branded({ dominantColors: undefined });
      expect(view.logoStoragePath).toBeUndefined();
      expect(view.dominantColors).toBeUndefined();
    });

    it("excludes an unknown future branding field by default", () => {
      const view = branded({ someNewInternal: "leak-me" } as never);
      expect(JSON.stringify(view)).not.toContain("leak-me");
    });

    it("keeps what the brand panel renders and lets the client edit", () => {
      const view = branded({
        primaryAccent: "#e91e8c",
        guidelines: "Warm, never shouty.",
        visualStyle: "Minimalist",
      });
      expect(view.dominantColors).toHaveLength(2);
      expect(view.dominantColors?.[0]).toEqual({
        hex: "#e91e8c",
        dominanceRank: 1,
        role: "Logo fill",
      });
      expect(view.fontHeading).toBe("Söhne");
      expect(view.toneKeywords).toEqual(["warm", "direct"]);
      expect(view.logoUrl).toBe("https://cdn.test/logo.png");
      expect(view.guidelines).toBe("Warm, never shouty.");
      expect(view.visualStyle).toBe("Minimalist");
      // The legacy scalar the modal falls back to for pre-palette records.
      expect(view.primaryAccent).toBe("#e91e8c");
      expect(view.updatedAt).toBe(42);
    });
  });
});

/**
 * #42 — the staff shell was an RSC over-fetch, not a permission hole.
 *
 * Staff may see everything on a client document. What they may not do is have
 * the whole document serialized into a "use client" component's payload on
 * every page, where it is readable from view-source whether or not anything
 * paints it — the same rule toClientPortalView exists for, applied to the other
 * shell. The picker mounts on EVERY staff page, so the join token was in every
 * staff RSC payload; the /clients/[id] layout added the rest.
 */
describe("toStaffShellView", () => {
  it("does not ship the join token to the browser", () => {
    const view = toStaffShellView(makeClient());
    expect(JSON.stringify(view)).not.toContain("ck_supersecretjointoken");
    expect((view as Record<string, unknown>).clientKeyId).toBeUndefined();
  });

  it("drops the internal fields no component in the shell reads", () => {
    const view = toStaffShellView(makeClient()) as Record<string, unknown>;
    for (const field of [
      "agentsRepoSlug",
      "logoStoragePath",
      "onboardingStatus",
      "onboardingError",
      "customAgentIds",
      "linkedinSeatLimit",
      "assignedEmployeeIds",
      "status",
      "createdBy",
      "createdAt",
    ]) {
      expect(view[field], field).toBeUndefined();
    }
  });

  it("carries THAT the workspace run failed, never the provider's words", () => {
    const view = toStaffShellView(makeClient({ aiProcessingError: "ECONNRESET at line 40" }));
    expect(view.aiProcessingFailed).toBe(true);
    expect((view as Record<string, unknown>).aiProcessingError).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("ECONNRESET");
    // The one reader in the rail asks through the shared helper, so the boolean
    // is enough for it and the staff PAGE still prints the reason from its own
    // full client document.
    expect(hasAiProcessingFailure(view)).toBe(true);
  });

  it("still carries everything the staff rail renders", () => {
    // The positive half: a shell missing a field it paints is worse than the
    // over-fetch, because the rail silently goes blank.
    const view = toStaffShellView(
      makeClient({
        name: "Acme",
        logoUrl: "https://cdn.test/logo.png",
        accentColor: "#ff0000",
        industry: "SaaS",
        category: "Martech",
        teamSize: "11–50",
        brief: "Two sentences.",
        description: "Longer about text.",
        contactEmail: "ops@acme.test",
        domains: ["acme.test"],
        socialLinks: { x: "acme" },
        brandingGuidelines: {
          dominantColors: [{ hex: "#111", dominanceRank: 1, usagePct: 60 }],
          updatedAt: 9,
        },
        intelScheduleEnabled: true,
        intelScheduleIntervalMonths: 3,
        intelScheduleDayOfMonth: 12,
        intelScheduleNextRunAt: 555,
        lastIntelReportAt: 444,
      }),
    );
    expect(view.id).toBe("c1");
    expect(view.name).toBe("Acme");
    expect(view.website).toBe("https://acme.test");
    expect(view.logoUrl).toBe("https://cdn.test/logo.png");
    expect(view.accentColor).toBe("#ff0000");
    // ONE CATEGORY CROSSES, not two names for it. `industry` is `category`'s
    // legacy spelling and the projection resolves the fallback here, so the
    // shell it feeds never has to know the old name existed — and when both are
    // stored, the field the editors write is the one that wins.
    expect(view.category).toBe("Martech");
    expect("industry" in view).toBe(false);
    expect(view.teamSize).toBe("11–50");
    expect(view.brief).toBe("Two sentences.");
    expect(view.description).toBe("Longer about text.");
    expect(view.brandVoice).toBe("warm");
    expect(view.contactEmail).toBe("ops@acme.test");
    expect(view.domains).toEqual(["acme.test"]);
    expect(view.socialLinks).toEqual({ x: "acme" });
    expect(view.isAiProcessing).toBe(true);
    // WHOLE, unlike the portal's copy: BrandColorsSection mounts with isStaff
    // and edits the internal usagePct mix, so removing it would break the panel.
    expect(view.brandingGuidelines?.dominantColors?.[0].usagePct).toBe(60);
    expect(clientIntelSchedule(view)).toEqual({
      enabled: true,
      intervalMonths: 3,
      dayOfMonth: 12,
      nextRunAt: 555,
      lastIntelReportAt: 444,
    });
  });

  /**
   * THE PROJECTION IS APPLIED AT BOTH MOUNT POINTS — asserted as the guarantee,
   * not as a copy of the source.
   *
   * Why source has to be read at all: the narrowing cannot be enforced by the
   * type. `StaffShellClientView` is a `Pick` of `Client`, so a WHOLE `Client`
   * satisfies it structurally and `clients = adminData.allClients` compiles
   * cleanly. The projection call is an unforced choice at two mount points, and
   * dropping either one silently reinstates the join token in an RSC payload.
   *
   * Why not the byte string: `toContain("client={toStaffShellView(client)}")`
   * goes red when a formatter breaks that JSX attribute over two lines — a
   * change that alters nothing — and a test that fails on its own codebase
   * being tidied is a test the next person deletes. Both halves below are
   * whitespace-tolerant, and each positive is paired with the NEGATIVE it
   * exists to catch: handing the raw document across instead.
   */
  it("hands the projection across the boundary, never the raw client document", () => {
    const layout = readFileSync(
      join(process.cwd(), "src/app/(app)/clients/[id]/layout.tsx"),
      "utf8",
    );
    expect(layout).toMatch(/client=\{\s*toStaffShellView\(/);
    // The regression: ClientContextSync handed the document it was given.
    expect(layout).not.toMatch(/client=\{\s*client\s*\}/);

    const app = readFileSync(join(process.cwd(), "src/app/(app)/layout.tsx"), "utf8");
    expect(app).toMatch(/allClients\s*\.\s*map\(\s*toStaffShellView\s*\)/);
    // The regression: the picker's array assigned straight from the fetch.
    expect(app).not.toMatch(/clients\s*=\s*\{?\s*(adminData\.allClients|staffClients)\s*\}?\s*;/);
  });
});

/* ── CD-L P5: the two views of one client's company panel ────────────────── */

/**
 * THE AVATAR HAS TO RESOLVE THE SAME WAY IN BOTH SHELLS.
 *
 * ClientProfilePanel is one component mounted from two projections, and its
 * BrandFavicon reads four fields to decide what to draw: the uploaded logo, the
 * generated one nested in `brandingGuidelines`, the website whose favicon is the
 * fallback, and the accent the initials chip is tinted with. The fallback chain
 * is ordered, so ONE of those four missing on one side is enough to send that
 * shell down a different branch and paint a different tile — which is what the
 * product owner saw when he put the two views side by side.
 *
 * Neither projection is free to drop one quietly: both are built by
 * construction, field by field, in two separate lists that nothing compares. So
 * this compares them, on the same document, for exactly the fields the avatar
 * reads.
 */
describe("the client's company panel resolves identically in both shells", () => {
  const withBrand = makeClient({
    logoUrl: "https://cdn.test/acme.png",
    accentColor: "#7c3aed",
    brandingGuidelines: { logoUrl: "https://cdn.test/generated.png", updatedAt: 9 },
  });

  it("gives the avatar the same four inputs from either projection", () => {
    const client = toClientPortalView(withBrand);
    const staff = toStaffShellView(withBrand);
    // The BrandFavicon call's own arguments, in the panel's order.
    const avatarInputs = (c: {
      logoUrl?: string;
      website?: string;
      accentColor?: string;
      brandingGuidelines?: { logoUrl?: string };
    }) => [c.logoUrl, c.brandingGuidelines?.logoUrl, c.website, c.accentColor];
    expect(avatarInputs(client)).toEqual(avatarInputs(staff));
    // Non-vacuity: two matching rows of `undefined` would satisfy the line
    // above while proving the opposite of what it claims.
    expect(avatarInputs(client)).toEqual([
      "https://cdn.test/acme.png",
      "https://cdn.test/generated.png",
      "https://acme.test",
      "#7c3aed",
    ]);
  });

  it("falls back to the Ember accent, not the pre-Ember green", () => {
    // The one avatar difference that was NOT a projection difference: both
    // mounts read this line, and it still named `#2dff9e` while every other
    // brand tile in the app fell back to the orange. Same account, same
    // screenful, two colours.
    const panel = readFileSync(
      join(process.cwd(), "src/components/client-profile-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain('accentColor={client.accentColor ?? "#ff6b2c"}');
    expect(panel.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("#2dff9e");
  });

  it("carries every field the panel renders, from either projection", () => {
    // The whole contract, not just the avatar: `ClientProfileFields` is the
    // panel's stated field list, and a projection that drops one of them shows
    // that shell a panel with a hole in it. Listed here rather than imported
    // because the panel is a "use client" module this run cannot load.
    const panelFields = [
      "id",
      "name",
      "logoUrl",
      "accentColor",
      "brandingGuidelines",
      "website",
      "category",
      "teamSize",
      "brief",
      "description",
      "contactEmail",
      "socialLinks",
    ] as const;
    const full = makeClient({
      logoUrl: "https://cdn.test/acme.png",
      accentColor: "#7c3aed",
      brandingGuidelines: { logoUrl: "https://cdn.test/generated.png", updatedAt: 9 },
      category: "Fintech",
      teamSize: "11–50",
      brief: "b",
      description: "d",
      contactEmail: "hi@acme.test",
      socialLinks: { instagram: "acme" },
    });
    const client = toClientPortalView(full) as unknown as Record<string, unknown>;
    const staff = toStaffShellView(full) as Record<string, unknown>;
    for (const f of panelFields) {
      expect(client[f], `client portal view drops ${f}`).toBeDefined();
      expect(staff[f], `staff shell view drops ${f}`).toBeDefined();
    }
  });
});

/**
 * The half that IS a type, and is checked by `npx tsc --noEmit` rather than by
 * reading text: what the staff shell's context can be asked for at all.
 *
 * A component mounted under ClientContextSync that reaches for `clientKeyId`
 * does not compile, because the context is typed as the projection. That is the
 * durable part of #42 — the source checks above only prove the projection is
 * still called, this proves what it is worth having called it.
 */
type ExcludedFromStaffShell =
  | "clientKeyId"
  | "agentsRepoSlug"
  | "logoStoragePath"
  | "onboardingStatus"
  | "onboardingError"
  | "customAgentIds"
  | "linkedinSeatLimit"
  | "assignedEmployeeIds"
  | "status"
  | "createdBy"
  | "aiProcessingError";

type NoInternalKeys =
  Extract<keyof StaffShellClientView, ExcludedFromStaffShell> extends never ? true : never;

/** Red at `tsc` if any internal field is ever added back to the view. */
const _staffShellExcludesInternals: NoInternalKeys = true;

/** Red at `tsc` if the staff context stops being typed by the projection. */
const _contextIsTheProjection: ActiveClientData["client"] extends StaffShellClientView
  ? StaffShellClientView extends ActiveClientData["client"]
    ? true
    : never
  : never = true;

void _staffShellExcludesInternals;
void _contextIsTheProjection;
