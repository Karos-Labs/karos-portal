import { describe, expect, it } from "vitest";
import {
  CHAIN_SLOT_HOUR,
  chainFamilyFor,
  chainSlotForDay,
  deriveOrderKey,
  isAssetUnlockedForClient,
  isChainSchedulable,
  orderKeyForCreatedAt,
  orderKeyForLabItem,
  blockingPredecessor,
  planClientChain,
  sameLocalDay,
  startOfDayMs,
  templateForAsset,
  templateFromItemKey,
} from "@/lib/post-chain";
import { getClientLibraryAssets, redactLockedAsset } from "@/lib/asset-visibility";
import type { Asset } from "@/lib/types";

/** Server-local timestamp helper (month is 1-based). Keeps tests TZ-independent. */
function at(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

/** The chain slot (local CHAIN_SLOT_HOUR) on a given local day. */
function slot(y: number, m: number, d: number): number {
  return at(y, m, d, CHAIN_SLOT_HOUR, 0);
}

let seq = 0;
function makeAsset(overrides: Partial<Asset> = {}): Asset {
  seq++;
  return {
    id: `asset-${seq}`,
    clientId: "client-1",
    title: "Post",
    content: "Body",
    createdBy: "staff-1",
    createdAt: at(2026, 7, 1, 9),
    updatedAt: at(2026, 7, 1, 9),
    status: "draft",
    type: "instagram_post",
    ...overrides,
  };
}

/** Lab-imported draft with the real meta shape written by importLabRunAction. */
function labAsset(labRun: string, overrides: Partial<Asset> = {}): Asset {
  return makeAsset({
    meta: { source: "lab-import", labRun, agentFolder: labRun.split("/")[0] },
    ...overrides,
  });
}

const NOW = at(2026, 7, 14, 9, 30);
const START = at(2026, 7, 14);

/* ─────────────────────────── families ─────────────────────────── */

describe("chainFamilyFor / isChainSchedulable", () => {
  it("maps types to families and excludes notes", () => {
    expect(chainFamilyFor("instagram_post")).toBe("social");
    expect(chainFamilyFor("social_post")).toBe("social");
    expect(chainFamilyFor("email")).toBe("email");
    expect(chainFamilyFor("article")).toBe("article");
    expect(chainFamilyFor("note")).toBeNull();
    expect(isChainSchedulable("instagram_post")).toBe(true);
    expect(isChainSchedulable("note")).toBe(false);
  });
});

describe("planClientChain — family separation", () => {
  it("plans social and email chains independently so both can land on the same day", () => {
    const social = labAsset("instagram-agent/2026-07-06-run#01-post", { id: "ig-1" });
    const email = labAsset("newsletter-agent/2026-07-06-run#01-issue", { id: "nl-1", type: "email" });

    const plan = planClientChain([social, email], { now: NOW, mode: "migrate", startDayMs: START });

    expect(plan).toHaveLength(2);
    expect(plan.find((p) => p.id === "ig-1")?.scheduledAt).toBe(slot(2026, 7, 14));
    expect(plan.find((p) => p.id === "nl-1")?.scheduledAt).toBe(slot(2026, 7, 14));
  });

  it("restricts planning to opts.families when given", () => {
    const social = labAsset("instagram-agent/2026-07-06-run#01-post", { id: "ig-1" });
    const email = labAsset("newsletter-agent/2026-07-06-run#01-issue", { id: "nl-1", type: "email" });

    const plan = planClientChain([social, email], {
      now: NOW,
      mode: "migrate",
      startDayMs: START,
      families: ["social"],
    });

    expect(plan.map((p) => p.id)).toEqual(["ig-1"]);
  });
});

/* ──────────────────────── provenance guard ─────────────────────── */

describe("planClientChain — provenance", () => {
  it("never chain-assigns legacy assets, but their dates occupy days", () => {
    const legacy = makeAsset({
      id: "legacy-1",
      status: "scheduled",
      scheduledAt: at(2026, 7, 14, 12),
      meta: { source: "content-engine" },
    });
    const fresh = labAsset("instagram-agent/2026-07-06-run#01-post", { id: "fresh-1" });

    const plan = planClientChain([legacy, fresh], { now: NOW, mode: "migrate", startDayMs: START });

    expect(plan.map((p) => p.id)).toEqual(["fresh-1"]);
    // Legacy occupies 07-14, so the chain starts 07-15.
    expect(plan[0].scheduledAt).toBe(slot(2026, 7, 15));
  });

  it("admits assets via a stored orderKey; a bare managed taskType does not qualify", () => {
    // Post-chain webhook assets carry an orderKey; a pre-chain managed single
    // (taskType but no order signal) keeps whatever date staff gave it.
    const preChainManaged = makeAsset({ id: "wh-1", meta: { taskType: "social_post" } });
    const keyed = makeAsset({ id: "key-1", orderKey: "2026-07-01T00:00:00.000Z#key-1" });
    const legacyDraft = makeAsset({ id: "legacy-2", meta: { source: "content-engine" } });

    const plan = planClientChain([preChainManaged, keyed, legacyDraft], {
      now: NOW,
      mode: "migrate",
      startDayMs: START,
    });

    expect(plan.map((p) => p.id)).toEqual(["key-1"]);
  });

  it("ignores publishMode placeholder roadmap items entirely — no candidacy, no occupancy", () => {
    // Mirrors XO's l2r0p7Oc: an approved placeholder sits on 07-15 yet the
    // chain still lands there (placeholders are calendar decorations).
    const placeholder = makeAsset({
      id: "ph-1",
      type: "social_post",
      status: "approved",
      publishMode: "placeholder",
      scheduledAt: at(2026, 7, 15, 18),
      meta: { taskType: "social_post" },
    });
    const fresh = labAsset("instagram-agent/2026-07-06-run#01-post", { id: "fresh-1" });
    const occupier = makeAsset({
      id: "legacy-1",
      status: "scheduled",
      scheduledAt: at(2026, 7, 14, 12),
      meta: { source: "content-engine" },
    });

    const plan = planClientChain([placeholder, fresh, occupier], {
      now: NOW,
      mode: "migrate",
      startDayMs: START,
    });

    expect(plan.map((p) => p.id)).toEqual(["fresh-1"]);
    expect(plan[0].scheduledAt).toBe(slot(2026, 7, 15));
  });
});

/* ───────────────── real-data fixtures (oracle shapes) ──────────── */

/** Karos Labs per expected-chain-mapping.md: 12 candidates → 2026-07-14..25. */
function karosFixture(): { assets: Asset[]; skipIds: string[] } {
  const tl = (n: string, key: string, o: Partial<Asset> = {}) =>
    labAsset(`instagram-agent/2026-07-06-template-launch#${n}-${key}`, { id: `tl-${n}`, ...o });
  const w23 = (n: string, key: string, o: Partial<Asset> = {}) =>
    labAsset(`instagram-agent/2026-07-08-week2-3#${n}-${key}`, { id: `w23-${n}`, ...o });

  const assets: Asset[] = [
    // Posted 2026-07-13 — pinned, untouched.
    w23("01", "campaign-story", { status: "scheduled", scheduledAt: at(2026, 7, 13, 11), publishMode: "manual" }),
    w23("02", "playbook", { status: "scheduled", scheduledAt: at(2026, 7, 13, 14), publishMode: "manual" }),
    // Launch post: approved, undated; posted in reality — data cannot know, so it is --skip'd.
    labAsset("instagram-agent/2026-07-06-launch-post-kairos#run", { id: "launch", status: "approved" }),
    // Template-launch drafts (undated).
    tl("01", "campaign-story"),
    tl("02", "marketer-legend"),
    tl("03", "playbook"),
    tl("04", "by-the-numbers"),
    tl("05", "special-edition"),
    tl("06", "template-ideas"),
    // Week 2-3 items stacked 2/day on 07-14..16 by the old engine (mixed status).
    w23("03", "by-the-numbers", { status: "scheduled", scheduledAt: at(2026, 7, 14, 11), publishMode: "manual" }),
    w23("04", "marketer-legend", { status: "scheduled", scheduledAt: at(2026, 7, 14, 14), publishMode: "manual" }),
    w23("05", "special-edition", { status: "scheduled", scheduledAt: at(2026, 7, 15, 11), publishMode: "manual" }),
    w23("06", "campaign-story", { status: "scheduled", scheduledAt: at(2026, 7, 15, 14), publishMode: "manual" }),
    w23("07", "playbook"),
    w23("08", "by-the-numbers", { status: "scheduled", scheduledAt: at(2026, 7, 16, 11), publishMode: "manual" }),
  ];
  return { assets, skipIds: ["launch"] };
}

describe("planClientChain — migrate mode (Karos oracle)", () => {
  it("re-dates all 11 posting candidates one-per-day from 2026-07-14 in internal order", () => {
    const { assets, skipIds } = karosFixture();
    const plan = planClientChain(assets, { now: NOW, mode: "migrate", startDayMs: START, skipIds });

    const expected: Array<[string, number]> = [
      ["tl-01", slot(2026, 7, 14)],
      ["tl-02", slot(2026, 7, 15)],
      ["tl-03", slot(2026, 7, 16)],
      ["tl-04", slot(2026, 7, 17)],
      ["tl-05", slot(2026, 7, 18)],
      ["w23-03", slot(2026, 7, 19)],
      ["w23-04", slot(2026, 7, 20)],
      ["w23-05", slot(2026, 7, 21)],
      ["w23-06", slot(2026, 7, 22)],
      ["w23-07", slot(2026, 7, 23)],
      ["w23-08", slot(2026, 7, 24)],
    ];
    expect(plan.map((p) => [p.id, p.scheduledAt])).toEqual(expected);
    // Pinned/skipped items never appear — nor does the template-ideas
    // reference doc (an overview/explainer, not a posting template).
    for (const frozen of ["w23-01", "w23-02", "launch", "tl-06"]) {
      expect(plan.some((p) => p.id === frozen)).toBe(false);
    }
  });

  it("reference docs (template-ideas) never take a chain day and never block one", () => {
    const overview = labAsset("instagram-agent/2026-07-06-run#06-template-ideas", {
      id: "ref-1",
      scheduledAt: at(2026, 7, 15, 11), // stale chain date — planner must not re-place it
    });
    const post = labAsset("instagram-agent/2026-07-06-run#01-campaign-story", { id: "post-1" });

    const plan = planClientChain([overview, post], { now: NOW, mode: "migrate", startDayMs: START });

    expect(plan.map((p) => p.id)).toEqual(["post-1"]);
    expect(plan[0].scheduledAt).toBe(slot(2026, 7, 14));
  });

  it("in reflow mode the same data keeps every staff-booked date pinned", () => {
    const { assets, skipIds } = karosFixture();
    const plan = planClientChain(assets, { now: NOW, skipIds });

    // Only undated drafts move at runtime; scheduled items are staff-booked
    // (tl-06 is the template-ideas reference doc — never a candidate).
    expect(plan.map((p) => p.id).sort()).toEqual(
      ["tl-01", "tl-02", "tl-03", "tl-04", "tl-05", "w23-07"].sort(),
    );
    // Occupied days (14, 15, 16 hold scheduled items) are skipped.
    const byId = new Map(plan.map((p) => [p.id, p.scheduledAt]));
    expect(byId.get("tl-01")).toBe(slot(2026, 7, 17));
    expect(byId.get("tl-02")).toBe(slot(2026, 7, 18));
    expect(byId.get("w23-07")).toBe(slot(2026, 7, 22));
  });
});

describe("planClientChain — migrate mode (XO oracle)", () => {
  it("starts the chain on 07-15 when a pre-chain managed single occupies 07-14", () => {
    const testRun = (n: string, key: string, o: Partial<Asset> = {}) =>
      labAsset(`instagram-agent/2026-07-03-test-run#${n}-${key}`, { id: `tr-${n}`, ...o });
    const assets: Asset[] = [
      // Real shape of c03HTUR6: agent-service asset from a removed job system —
      // managed taskType but no order signal, so it is not a candidate. It keeps
      // its staff-given date and occupies 07-14.
      makeAsset({
        id: "c03",
        type: "social_post",
        status: "scheduled",
        scheduledAt: at(2026, 7, 14, 12),
        publishMode: "manual",
        meta: { taskType: "social_post" },
      }),
      // Placeholder roadmap items — wholly ignored.
      makeAsset({
        id: "ph-1",
        type: "social_post",
        status: "scheduled",
        publishMode: "placeholder",
        scheduledAt: at(2026, 7, 10, 15),
        meta: { taskType: "social_post" },
      }),
      makeAsset({
        id: "ph-2",
        type: "social_post",
        status: "approved",
        publishMode: "placeholder",
        scheduledAt: at(2026, 7, 15, 18),
        meta: { taskType: "social_post" },
      }),
      // Legacy content-engine items — never touched.
      makeAsset({
        id: "legacy-sched",
        status: "scheduled",
        scheduledAt: at(2026, 7, 13, 11),
        publishMode: "manual",
        meta: { source: "content-engine" },
      }),
      makeAsset({ id: "legacy-draft", meta: { source: "content-engine" } }),
      // The chain.
      testRun("01", "giro-da-semana", { status: "scheduled", scheduledAt: at(2026, 7, 15, 11), publishMode: "manual" }),
      testRun("02", "lendas", { status: "scheduled", scheduledAt: at(2026, 7, 16, 14), publishMode: "manual" }),
      testRun("03", "voce-sabia"),
      testRun("04", "nova-oferta"),
      labAsset(
        "instagram-agent/2026-07-08-voce-sabia-renda-fixa-risco#01-voce-sabia-renda-fixa-nao-e-sem-risco",
        { id: "voce-renda", status: "scheduled", scheduledAt: at(2026, 7, 16, 11), publishMode: "manual" },
      ),
      // Email family asset — untouched by a social-only run.
      makeAsset({ id: "xo-email", type: "email", meta: { taskType: "newsletter_issue" } }),
    ];

    const plan = planClientChain(assets, {
      now: NOW,
      mode: "migrate",
      startDayMs: START,
      families: ["social"],
    });

    expect(plan.map((p) => [p.id, p.scheduledAt])).toEqual([
      ["tr-01", slot(2026, 7, 15)],
      ["tr-02", slot(2026, 7, 16)],
      ["tr-03", slot(2026, 7, 17)],
      ["tr-04", slot(2026, 7, 18)],
      ["voce-renda", slot(2026, 7, 19)],
    ]);
  });
});

/* ───────────────── determinism & idempotence ───────────────────── */

describe("planClientChain — determinism", () => {
  it("is a pure function of its inputs", () => {
    const { assets, skipIds } = karosFixture();
    const a = planClientChain(assets, { now: NOW, mode: "migrate", startDayMs: START, skipIds });
    const b = planClientChain(assets, { now: NOW, mode: "migrate", startDayMs: START, skipIds });
    expect(a).toEqual(b);
  });

  it("re-planning its own applied output emits zero assignments", () => {
    const { assets, skipIds } = karosFixture();
    const plan = planClientChain(assets, { now: NOW, mode: "migrate", startDayMs: START, skipIds });
    const applied = assets.map((asset) => {
      const hit = plan.find((p) => p.id === asset.id);
      return hit ? { ...asset, scheduledAt: hit.scheduledAt, orderKey: hit.orderKey } : asset;
    });

    expect(planClientChain(applied, { now: NOW, mode: "migrate", startDayMs: START, skipIds })).toEqual([]);
    // Runtime reflow of the migrated state is also a no-op (future drafts
    // re-plan onto the very same days).
    const reflowChanges = planClientChain(applied, { now: NOW, skipIds }).filter((p) => {
      const before = applied.find((a) => a.id === p.id);
      return before?.scheduledAt !== p.scheduledAt || before?.orderKey !== p.orderKey;
    });
    expect(reflowChanges).toEqual([]);
  });
});

/* ─────────────────────── unlock boundary ───────────────────────── */

describe("isAssetUnlockedForClient", () => {
  const scheduled = { status: "draft" as const, scheduledAt: slot(2026, 7, 20) };

  it("stays locked at 23:59 the night before", () => {
    expect(isAssetUnlockedForClient(scheduled, at(2026, 7, 19, 23, 59))).toBe(false);
  });

  it("unlocks at local midnight of the scheduled day", () => {
    expect(isAssetUnlockedForClient(scheduled, at(2026, 7, 20, 0, 0))).toBe(true);
  });

  it("published and undated assets are always unlocked", () => {
    expect(
      isAssetUnlockedForClient({ status: "published", scheduledAt: slot(2026, 7, 20) }, at(2026, 7, 1)),
    ).toBe(true);
    expect(
      isAssetUnlockedForClient(
        { status: "draft", scheduledAt: slot(2026, 7, 20), publishedAt: at(2026, 7, 1) },
        at(2026, 7, 1),
      ),
    ).toBe(true);
    expect(isAssetUnlockedForClient({ status: "draft" }, at(2026, 7, 1))).toBe(true);
  });
});

/* ──────────────────────── redaction layer ──────────────────────── */

describe("redactLockedAsset / getClientLibraryAssets(forClient)", () => {
  const secret = makeAsset({
    id: "locked-1",
    title: "Secret campaign reveal",
    content: "Top secret body",
    imageUrl: "https://cdn/secret.png",
    mimeType: "image/png",
    scheduledAt: slot(2026, 7, 20),
    meta: { source: "lab-import", labRun: "instagram-agent/2026-07-06-run#01-by-the-numbers", about: "secret" },
    recommendedAt: slot(2026, 7, 20),
    recommendedReason: "chain",
    publishMode: "manual",
    scheduledPlatform: "instagram",
  });

  it("whitelists the placeholder — no content, image, meta, or original title survive", () => {
    const redacted = redactLockedAsset(secret);
    expect(redacted.title).toBe("By The Numbers");
    expect(redacted.content).toBe("");
    expect(redacted.imageUrl).toBeNull();
    expect(redacted.meta).toEqual({ locked: true });
    expect(redacted.locked).toBe(true);
    expect(redacted.scheduledAt).toBe(slot(2026, 7, 20));
    const serialized = JSON.stringify(redacted);
    for (const leak of ["Secret", "secret", "cdn", "recommended", "mimeType", "instagram-agent"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("falls back to a generic placeholder title when no template resolves", () => {
    const bare = makeAsset({ title: "Real title", scheduledAt: slot(2026, 7, 20) });
    expect(redactLockedAsset(bare).title).toBe("Upcoming post");
  });

  it("forClient redacts future-dated assets and passes unlocked ones through", () => {
    const unlocked = makeAsset({ id: "old-1", title: "Shipped", scheduledAt: slot(2026, 7, 10), updatedAt: 5 });
    const visible = getClientLibraryAssets([secret, unlocked], { forClient: true, now: NOW });
    expect(visible.find((a) => a.id === "locked-1")?.locked).toBe(true);
    expect(visible.find((a) => a.id === "old-1")?.title).toBe("Shipped");
  });

  it("staff callers (no opts) get full objects", () => {
    const [full] = getClientLibraryAssets([secret]);
    expect(full.title).toBe("Secret campaign reveal");
    expect(full.locked).toBeUndefined();
  });
});

/* ─────────────────────────── templates ─────────────────────────── */

describe("templateFromItemKey", () => {
  it("strips index and date prefixes", () => {
    expect(templateFromItemKey("01-by-the-numbers")).toEqual({ key: "by-the-numbers", name: "By The Numbers" });
    expect(templateFromItemKey("2026-07-06-template-launch")).toEqual({
      key: "template-launch",
      name: "Template Launch",
    });
    expect(templateFromItemKey("cafe-noir-spot")).toEqual({ key: "cafe-noir-spot", name: "Cafe Noir Spot" });
  });

  it("returns null for the flat-run key and empty remainders", () => {
    expect(templateFromItemKey("run")).toBeNull();
    expect(templateFromItemKey("2026-07-06")).toBeNull();
    expect(templateFromItemKey("01")).toBeNull();
  });

  it("collapses one-off slugs onto a known template key (longest prefix wins)", () => {
    expect(
      templateFromItemKey("01-voce-sabia-renda-fixa-nao-e-sem-risco", ["giro-da-semana", "voce-sabia"]),
    ).toEqual({ key: "voce-sabia", name: "Voce Sabia" });
    expect(templateFromItemKey("01-voce-sabia-cvm", ["voce", "voce-sabia"])).toEqual({
      key: "voce-sabia",
      name: "Voce Sabia",
    });
    // No known-key match → normal slug.
    expect(templateFromItemKey("01-nova-oferta", ["voce-sabia"])).toEqual({
      key: "nova-oferta",
      name: "Nova Oferta",
    });
  });
});

describe("templateForAsset", () => {
  it("prefers the stored pair, then labRun, then the managed product", () => {
    expect(
      templateForAsset(makeAsset({ templateKey: "playbook", templateName: "Playbook" })),
    ).toEqual({ key: "playbook", name: "Playbook" });
    expect(
      templateForAsset(labAsset("instagram-agent/2026-07-08-week2-3#03-by-the-numbers")),
    ).toEqual({ key: "by-the-numbers", name: "By The Numbers" });
    expect(templateForAsset(makeAsset({ meta: { taskType: "social_post" } }))).toEqual({
      key: "social_post",
      name: "Social posts",
    });
    expect(templateForAsset(makeAsset())).toBeNull();
  });
});

/* ─────────────────────────── order keys ────────────────────────── */

describe("order keys", () => {
  it("orderKeyForLabItem keeps prefixed item keys and injects internal dates for bare slugs", () => {
    expect(orderKeyForLabItem("2026-07-06-template-launch", "01-campaign-story")).toBe(
      "2026-07-06-template-launch#01-campaign-story",
    );
    expect(orderKeyForLabItem("2026-07-06-run", "01-campaign-story", "2026-07-09")).toBe(
      "2026-07-06-run#01-campaign-story",
    );
    expect(orderKeyForLabItem("2026-07-06-run", "cafe-noir-spot", "2026-07-09")).toBe(
      "2026-07-06-run#2026-07-09-cafe-noir-spot",
    );
    expect(orderKeyForLabItem("2026-07-06-run", "2026-07-09-cafe-noir", "2026-07-10")).toBe(
      "2026-07-06-run#2026-07-09-cafe-noir",
    );
  });

  it("deriveOrderKey: stored key → meta.labRun → createdAt+id", () => {
    expect(deriveOrderKey(makeAsset({ orderKey: "stored#key" }))).toBe("stored#key");
    expect(
      deriveOrderKey(labAsset("instagram-agent/2026-07-06-template-launch#01-campaign-story")),
    ).toBe("2026-07-06-template-launch#01-campaign-story");
    const fallback = makeAsset({ id: "abc", createdAt: Date.UTC(2026, 6, 5, 12) });
    expect(deriveOrderKey(fallback)).toBe("2026-07-05T12:00:00.000Z#abc");
    expect(orderKeyForCreatedAt(Date.UTC(2026, 6, 5, 12), "abc")).toBe("2026-07-05T12:00:00.000Z#abc");
  });

  it("cross-source keys interleave chronologically", () => {
    const labEarly = "2026-07-03-test-run#01-giro-da-semana";
    const webhookMid = orderKeyForCreatedAt(Date.UTC(2026, 6, 5, 15), "job-1");
    const labLate = "2026-07-08-week2-3#03-by-the-numbers";
    expect([labLate, webhookMid, labEarly].sort()).toEqual([labEarly, webhookMid, labLate]);
  });
});

/* ─────────────────────────── day math ──────────────────────────── */

describe("day math", () => {
  it("chainSlotForDay lands at CHAIN_SLOT_HOUR local", () => {
    expect(chainSlotForDay(at(2026, 7, 14))).toBe(at(2026, 7, 14, CHAIN_SLOT_HOUR));
  });

  it("startOfDayMs / sameLocalDay bucket by local calendar day", () => {
    expect(startOfDayMs(at(2026, 7, 14, 23, 59))).toBe(at(2026, 7, 14));
    expect(sameLocalDay(at(2026, 7, 14, 0, 1), at(2026, 7, 14, 23, 59))).toBe(true);
    expect(sameLocalDay(at(2026, 7, 14, 23, 59), at(2026, 7, 15, 0, 1))).toBe(false);
  });
});

/* ──────────────────── publish ordering gate ────────────────────── */

describe("blockingPredecessor", () => {
  /** Two posts of one series ("Playbook", nos 1 and 2), in lab-import order. */
  function series(overrides: { no1?: Partial<Asset>; no2?: Partial<Asset> } = {}) {
    const no1 = makeAsset({
      title: "The playbook, no 1",
      orderKey: "2026-07-06-templates#01-playbook",
      templateKey: "playbook",
      meta: { source: "lab-import" },
      ...overrides.no1,
    });
    const no2 = makeAsset({
      title: "The playbook, no 2",
      orderKey: "2026-07-06-templates#02-playbook",
      templateKey: "playbook",
      meta: { source: "lab-import" },
      status: "approved",
      publishMode: "auto",
      scheduledAt: at(2026, 7, 10, 11),
      ...overrides.no2,
    });
    return { no1, no2 };
  }

  it("holds a post whose predecessor is still a draft (the SCRUM-69 report)", () => {
    const { no1, no2 } = series();
    expect(blockingPredecessor(no2, [no1, no2])?.title).toBe("The playbook, no 1");
  });

  it("releases the post once the predecessor is published", () => {
    const { no1, no2 } = series({ no1: { status: "published", publishedAt: at(2026, 7, 9, 11) } });
    expect(blockingPredecessor(no2, [no1, no2])).toBeNull();
  });

  it("never holds the first post in a series", () => {
    const { no1, no2 } = series();
    expect(blockingPredecessor(no1, [no1, no2])).toBeNull();
  });

  it("reports the NEAREST predecessor, not the earliest", () => {
    const a = makeAsset({ title: "no 1", orderKey: "run#01", templateKey: "playbook", meta: { source: "lab-import" } });
    const b = makeAsset({ title: "no 2", orderKey: "run#02", templateKey: "playbook", meta: { source: "lab-import" } });
    const c = makeAsset({
      title: "no 3",
      orderKey: "run#03",
      templateKey: "playbook",
      meta: { source: "lab-import" },
      status: "approved",
      scheduledAt: at(2026, 7, 10, 11),
    });
    expect(blockingPredecessor(c, [a, b, c])?.title).toBe("no 2");
  });

  it("does not hold across chain families — a stalled post blocks only its own", () => {
    const { no2 } = series();
    const newsletter = makeAsset({
      title: "Newsletter no 1",
      type: "email",
      orderKey: "2026-07-06-templates#00-newsletter",
      meta: { source: "lab-import" },
    });
    expect(blockingPredecessor(no2, [newsletter, no2])).toBeNull();
  });

  it("does not hold across clients", () => {
    const { no1, no2 } = series({ no1: { clientId: "client-2" } });
    expect(blockingPredecessor(no2, [no1, no2])).toBeNull();
  });

  it("is not blocked by placeholders or reference docs — neither is ever posted", () => {
    const { no2 } = series();
    // Same series as the candidate, so only the placeholder guard can spare it.
    const placeholder = makeAsset({
      title: "Roadmap slot",
      orderKey: "2026-07-06-templates#00-slot",
      templateKey: "playbook",
      meta: { source: "lab-import" },
      publishMode: "placeholder",
    });
    const referenceDoc = makeAsset({
      title: "Template ideas",
      orderKey: "2026-07-06-templates#00-ideas",
      templateKey: "template-ideas",
      meta: { source: "lab-import" },
    });
    expect(blockingPredecessor(no2, [placeholder, referenceDoc, no2])).toBeNull();
  });

  it("is not blocked by legacy assets that carry no order signal", () => {
    const { no2 } = series();
    const legacy = makeAsset({
      title: "Old post",
      meta: { source: "content-engine" },
      createdAt: at(2020, 1, 1),
    });
    expect(blockingPredecessor(no2, [legacy, no2])).toBeNull();
  });

  it("agrees with planClientChain's ordering: same key → id tiebreak", () => {
    const shared = { orderKey: "run#01", templateKey: "playbook", meta: { source: "lab-import" } };
    const first = makeAsset({ ...shared, id: "aaa", title: "First" });
    const second = makeAsset({
      ...shared,
      id: "bbb",
      title: "Second",
      status: "approved",
      scheduledAt: at(2026, 7, 10, 11),
    });
    expect(blockingPredecessor(second, [first, second])?.id).toBe("aaa");
    expect(blockingPredecessor(first, [first, second])).toBeNull();
  });

  it("does not hold across templates — a stalled series blocks only its own", () => {
    const { no2 } = series();
    const otherTemplate = makeAsset({
      title: "By the numbers, no 1",
      orderKey: "2026-07-06-templates#00-by-the-numbers",
      templateKey: "by-the-numbers",
      meta: { source: "lab-import" },
    });
    expect(blockingPredecessor(no2, [otherTemplate, no2])).toBeNull();
  });

  it("does not wedge on an unrelated backlog of drafts (the normal post-import state)", () => {
    // Staff rush one post out ahead of a fresh import's un-approved drafts.
    // None of them share its series, so none of them may hold it hostage.
    const backlog = ["alpha", "beta", "gamma", "delta"].map((key, i) =>
      makeAsset({
        title: `Backlog ${key}`,
        orderKey: `2026-07-06-templates#0${i}-${key}`,
        templateKey: key,
        meta: { source: "lab-import" },
      }),
    );
    const rushed = makeAsset({
      title: "Rushed post",
      orderKey: "2026-07-06-templates#09-rushed",
      templateKey: "rushed",
      meta: { source: "lab-import" },
      status: "approved",
      publishMode: "auto",
      scheduledAt: at(2026, 7, 10, 11),
    });
    expect(blockingPredecessor(rushed, [...backlog, rushed])).toBeNull();
  });

  it("never holds an asset with no series identity — order can't be established", () => {
    const earlier = makeAsset({ title: "no 1", orderKey: "run#01", meta: { source: "lab-import" } });
    const later = makeAsset({
      title: "no 2",
      orderKey: "run#02",
      meta: { source: "lab-import" },
      status: "approved",
      scheduledAt: at(2026, 7, 10, 11),
    });
    expect(blockingPredecessor(later, [earlier, later])).toBeNull();
  });

  it("resolves the series from meta.labRun when no templateKey was stored", () => {
    const no1 = makeAsset({
      title: "The playbook, no 1",
      orderKey: "2026-07-06-templates#01-playbook",
      meta: { source: "lab-import", labRun: "instagram-agent/2026-07-06-templates#01-playbook" },
    });
    const no2 = makeAsset({
      title: "The playbook, no 2",
      orderKey: "2026-07-06-templates#02-playbook",
      meta: { source: "lab-import", labRun: "instagram-agent/2026-07-06-templates#02-playbook" },
      status: "approved",
      scheduledAt: at(2026, 7, 10, 11),
    });
    expect(blockingPredecessor(no2, [no1, no2])?.title).toBe("The playbook, no 1");
  });

  it("ignores non-chain types entirely", () => {
    const note = makeAsset({ type: "note", orderKey: "run#02", meta: { source: "lab-import" }, status: "approved" });
    const earlier = makeAsset({ type: "note", orderKey: "run#01", meta: { source: "lab-import" } });
    expect(blockingPredecessor(note, [earlier, note])).toBeNull();
  });
});
