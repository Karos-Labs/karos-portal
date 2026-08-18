import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  contentLabelsByAsset,
  identitiesByClient,
  runRowLabel,
  scheduleRowLabel,
  type ClientAgentIdentity,
} from "@/lib/agent-identity-map";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import type { ChainFamily } from "@/lib/post-chain";
import type { Asset, ClientAgent, Job, ManagedTaskType, PlannedScheduledRun } from "@/lib/types";

/**
 * WP-7: the SURFACES, not the resolver.
 *
 * agent-identity-map.test.ts proves the rules. This file proves the WIRING —
 * that the calendar's two run mappings, the archive's group headings, the /jobs
 * rows and the agent run-history rows all reach the same answer for one stream,
 * because that agreement (not any single label) is what F147 asked for: Albert's
 * 27 Jul screenshot had "Instagram Agent" and "Social posts (IG/TikTok)" stacked
 * on the same day, describing the same work.
 *
 * It used to do that by RE-DECLARING each surface's call as a local closure,
 * which proves nothing: a surface that went back to printing `job.agentName`
 * would leave every assertion here green. So the surfaces' label decision is now
 * two exported functions (`runRowLabel` / `scheduleRowLabel`) that the surfaces
 * import, this file drives THOSE, and the wiring block at the bottom asserts —
 * from the surface sources themselves — that each one still calls them.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const instagramUmbrella: ClientAgent & ClientAgentIdentity = {
  id: "c1__instagram-agent",
  clientId: "c1",
  agentKey: "instagram-agent",
  customAgentId: "ca-ig",
  displayName: "Instagram Agent",
  platform: "instagram",
  chainFamily: "social",
  slotMode: "single",
  launchState: "live",
  templates: [],
  rotation: [],
  createdBy: "staff-1",
  createdAt: 0,
  updatedAt: 0,
};

/** The other client on a staff cross-client page — no umbrella of its own. */
const OTHER_CLIENT = "c2";

/**
 * The F147 fixture: a managed social run as submit-managed.ts mints it, and the
 * post it produced. Everything a client sees of this run is one of the two.
 */
const managedRun: Job = {
  id: "job-managed",
  clientId: "c1",
  agentId: "agent-service",
  agentName: "Social posts (IG/TikTok)",
  title: "Social posts (IG/TikTok) — Acme",
  status: "review",
  input: {},
  assetIds: ["asset-1"],
  events: [],
  external: { serviceJobId: "svc-1", taskType: "social_post" },
  createdBy: "staff-1",
  createdAt: 1_753_000_000_000,
  updatedAt: 1_753_000_000_000,
};

const managedPost: Asset = {
  id: "asset-1",
  clientId: "c1",
  jobId: "job-managed",
  type: "instagram_post",
  title: "Three ways to read a P&L",
  content: "…",
  meta: { taskType: "social_post" },
  status: "published",
  createdBy: "agent-service",
  createdAt: 1_753_000_000_000,
  updatedAt: 1_753_000_000_000,
};

/** The umbrella's own scheduled fire — the other half of the same screenshot. */
const umbrellaSchedule: Pick<
  PlannedScheduledRun,
  "clientId" | "clientAgentId" | "customAgentId" | "agentName"
> = {
  clientId: "c1",
  clientAgentId: instagramUmbrella.id,
  customAgentId: "ca-ig",
  agentName: "karos-instagram-tiktok-content-agent",
};

const umbrellas = [instagramUmbrella];

describe("calendar-body run mappings (§7.3)", () => {
  it("labels a managed social run with the umbrella that owns the stream", () => {
    expect(runRowLabel(managedRun, umbrellas)).toBe("Instagram Agent");
  });

  it("labels the umbrella's own schedule the same way", () => {
    // The schedule carries the lab agent's repo name; printing it verbatim is
    // the same defect wearing a third name.
    expect(scheduleRowLabel(umbrellaSchedule, umbrellas)).toBe("Instagram Agent");
  });

  it("the two cards that used to disagree now read identically", () => {
    expect(runRowLabel(managedRun, umbrellas)).toBe(scheduleRowLabel(umbrellaSchedule, umbrellas));
  });

  it("keeps today's label for a client with no umbrella", () => {
    const otherClientRun: Job = { ...managedRun, clientId: OTHER_CLIENT };
    expect(runRowLabel(otherClientRun, [])).toBe("Social posts (IG/TikTok)");
  });
});

describe("archive grouping (§7.3)", () => {
  // tasks-body.tsx: contentLabelsByAsset(assets, jobs, umbrellas) → ArchiveView.
  // archive-view.tsx then groups on `agentLabelByAssetId[asset.id]`.
  function groupHeadings(assets: Asset[], jobs: Job[], forClient: ClientAgentIdentity[]): string[] {
    const labels = contentLabelsByAsset(assets, jobs, forClient);
    return [...new Set(assets.map((asset) => labels[asset.id]!))].sort();
  }

  it("heads a managed social post's group with the umbrella's display name", () => {
    expect(contentLabelsByAsset([managedPost], [managedRun], umbrellas)).toEqual({
      "asset-1": "Instagram Agent",
    });
  });

  it("collapses posts from both systems into ONE group", () => {
    // The double identity as the archive rendered it: the same week's work
    // split across two headings because one batch came through the managed
    // catalog and one through the umbrella's own agent.
    const umbrellaRun: Job = {
      ...managedRun,
      id: "job-umbrella",
      agentName: "karos-instagram-tiktok-content-agent",
      customAgentId: "ca-ig",
      clientAgentId: instagramUmbrella.id,
      assetIds: ["asset-2"],
      external: { serviceJobId: "svc-2", taskType: "custom" },
    };
    const umbrellaPost: Asset = {
      ...managedPost,
      id: "asset-2",
      jobId: "job-umbrella",
      meta: { agentFolder: "instagram-agent" },
    };
    expect(
      groupHeadings([managedPost, umbrellaPost], [managedRun, umbrellaRun], umbrellas),
    ).toEqual(["Instagram Agent"]);
  });

  it("attributes a post whose job never made it into the payload", () => {
    // A client's timeline drops launch runs, so the archive can hold an asset
    // whose job it cannot see. The family rule answers from the asset alone.
    expect(contentLabelsByAsset([managedPost], [], umbrellas)).toEqual({
      "asset-1": "Instagram Agent",
    });
  });

  it("leaves a client with no umbrella on a catalog heading", () => {
    // Rung 4 with an asset in hand is the catalog product's own name — the
    // archive used to read the JOB's stored agentName here, so the heading
    // loses the "(IG/TikTok)" parenthetical, which is internal routing detail
    // and not something a client ever needed in a group title. Nothing about
    // WHICH assets group together changes.
    expect(groupHeadings([managedPost], [managedRun], [])).toEqual(["Social posts"]);
  });
});

describe("cross-client staff surfaces (§7.3)", () => {
  // jobs/page.tsx + calendar-body.tsx both index one scoped read this way.
  it("resolves each row against ITS OWN client's umbrellas", () => {
    const byClient = identitiesByClient([instagramUmbrella]);
    const rowLabel = (job: Job) => runRowLabel(job, byClient.get(job.clientId) ?? []);

    expect(rowLabel(managedRun)).toBe("Instagram Agent");
    // Same job shape, different client: c2 has no umbrella, so nothing of c1's
    // identity may bleed onto its row.
    const otherClientRun: Job = { ...managedRun, id: "job-2", clientId: OTHER_CLIENT };
    expect(rowLabel(otherClientRun)).toBe("Social posts (IG/TikTok)");
  });

  it("indexes every umbrella exactly once", () => {
    const second: ClientAgent & ClientAgentIdentity = {
      ...instagramUmbrella,
      id: "c1__karos-x-agent",
      agentKey: "karos-x-agent",
      customAgentId: "ca-x",
      displayName: "X Agent",
      platform: "x",
      slotMode: "options",
    };
    const third: ClientAgent & ClientAgentIdentity = {
      ...instagramUmbrella,
      id: "c2__instagram-agent",
      clientId: OTHER_CLIENT,
    };
    const byClient = identitiesByClient([instagramUmbrella, second, third]);
    expect(byClient.get("c1")).toHaveLength(2);
    expect(byClient.get(OTHER_CLIENT)).toHaveLength(1);
  });
});

describe("one identity across every surface (F147)", () => {
  it("calendar, archive, jobs list and run history all print one name", () => {
    const byClient = identitiesByClient([instagramUmbrella]);
    const forClient = byClient.get("c1") ?? [];

    const calendarRun = runRowLabel(managedRun, forClient);
    const calendarSchedule = scheduleRowLabel(umbrellaSchedule, forClient);
    const archiveHeading = contentLabelsByAsset([managedPost], [managedRun], forClient)[
      managedPost.id
    ];
    // jobs/page.tsx row + client-agent-rows.ts toRunRows both make this call.
    const jobsRow = runRowLabel(managedRun, forClient);

    expect(
      new Set([calendarRun, calendarSchedule, archiveHeading, jobsRow]),
    ).toEqual(new Set(["Instagram Agent"]));
  });

  it("without the umbrella the surfaces genuinely disagreed — the fixture is live", () => {
    // Guard against a test that would pass on any input: with no umbrella the
    // same fixture produces the two names from the screenshot.
    const calendarRun = runRowLabel(managedRun, []);
    const calendarSchedule = scheduleRowLabel(umbrellaSchedule, []);
    expect(calendarRun).not.toBe(calendarSchedule);
    expect(calendarRun).toBe("Social posts (IG/TikTok)");
  });
});

/**
 * The exhaustiveness guard.
 *
 * Rung 3 — content family → the client's live umbrella that owns it — is the
 * rung that actually kills the double identity, and it is driven by a hand-kept
 * map (FAMILY_BY_TASK_TYPE). Add a fifth managed product and nothing breaks:
 * its runs quietly fall through to rung 4 and start printing the catalog name
 * beside the umbrella's own, which is F147 exactly, re-entered in silence.
 *
 * So every product in the catalog is enumerated here. A new one is either given
 * a family (and this passes) or declared family-less on purpose (and named
 * below) — there is no third outcome that leaves the suite green.
 */
describe("every managed product resolves through the family rung (F147 guard)", () => {
  /**
   * Products that belong to NO content chain, deliberately. A landing page is a
   * one-off asset, not a stream any umbrella runs, so there is nothing for rung
   * 3 to resolve it to and rung 4 (the catalog name) is the right answer.
   */
  const NO_CHAIN_FAMILY = new Set<ManagedTaskType>(["landing_page"]);

  const familyUmbrella = (family: ChainFamily, id: string, name: string): ClientAgentIdentity => ({
    id,
    agentKey: id,
    customAgentId: `ca-${id}`,
    displayName: name,
    // No social platform: this fixture is about the family rung, not the mark.
    platform: "",
    chainFamily: family,
    launchState: "live",
  });

  const allFamilies: ClientAgentIdentity[] = [
    familyUmbrella("social", "u-social", "Social Umbrella"),
    familyUmbrella("email", "u-email", "Email Umbrella"),
    familyUmbrella("article", "u-article", "Article Umbrella"),
  ];
  const umbrellaNames = allFamilies.map((u) => u.displayName);

  it("the family-less list only names products that still exist", () => {
    const catalog = new Set(MANAGED_PRODUCTS.map((p) => p.taskType));
    for (const taskType of NO_CHAIN_FAMILY) expect(catalog.has(taskType)).toBe(true);
  });

  for (const product of MANAGED_PRODUCTS) {
    it(`${product.taskType}: a run resolves to the umbrella that owns its stream`, () => {
      const job: Job = {
        ...managedRun,
        agentName: product.name,
        external: { serviceJobId: "svc", taskType: product.taskType },
      };
      const label = runRowLabel(job, allFamilies);

      if (NO_CHAIN_FAMILY.has(product.taskType)) {
        expect(label).toBe(product.name);
        return;
      }
      // The failure a NEW product would produce: `label` stays the catalog name
      // because no family maps its task type, so the client reads the product
      // name beside their umbrella's own — F147.
      expect(umbrellaNames).toContain(label);
      expect(label).not.toBe(product.name);
    });

    it(`${product.taskType}: a deliverable resolves the same way from the asset alone`, () => {
      // The archive can hold an asset whose job never crossed the boundary, so
      // the asset's own `meta.taskType` has to reach the same rung.
      const asset: Asset = {
        ...managedPost,
        type: "note", // no chain family from the TYPE — forces the meta path
        meta: { taskType: product.taskType },
      };
      const label = contentLabelsByAsset([asset], [], allFamilies)[asset.id];

      if (NO_CHAIN_FAMILY.has(product.taskType)) {
        expect(umbrellaNames).not.toContain(label);
        return;
      }
      expect(umbrellaNames).toContain(label);
    });
  }
});

/**
 * The wiring itself. The behavioural blocks above can only prove the shared
 * functions are right; these prove the surfaces still call them, which is the
 * half that silently rotted before.
 */
describe("the surfaces route through the shared label functions", () => {
  const SURFACES: Array<{ file: string; calls: string[] }> = [
    {
      file: "src/app/(app)/calendar/calendar-body.tsx",
      calls: ["runRowLabel(", "scheduleRowLabel("],
    },
    { file: "src/app/(app)/jobs/page.tsx", calls: ["runRowLabel("] },
    // tasks-body.tsx used to cover contentLabelsByAsset( here too, alongside
    // runRowLabel(. It was deleted with the Workspace board's routes (2026-08);
    // client Home is a live caller of the same function now.
    { file: "src/app/(app)/clients/[id]/page.tsx", calls: ["contentLabelsByAsset("] },
    { file: "src/lib/client-agent-rows.ts", calls: ["runRowLabel("] },
  ];

  for (const surface of SURFACES) {
    it(`${surface.file} imports and calls the helper`, () => {
      const src = source(surface.file);
      expect(src).toContain('from "@/lib/agent-identity-map"');
      for (const call of surface.calls) expect(src).toContain(call);
    });
  }
});
