/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "@/lib/actions/asset-actions";
import * as data from "@/lib/data";
import * as auth from "@/lib/auth";
import { assetPublishBlock, redactLockedAsset } from "@/lib/asset-visibility";
import { canMarkAssetPosted, markPostedBlock } from "@/lib/mark-posted";
import type { Asset } from "@/lib/types";
import { stripComments } from "./source-scan";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data");
vi.mock("@/lib/auth");

const SRC = join(process.cwd(), "src");
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-02T12:00:00Z");

function makeAsset(patch: Partial<Asset> = {}): Asset {
  return {
    id: "a1",
    clientId: "c1",
    type: "social_post",
    title: "Post",
    content: "hi",
    status: "approved",
    publishMode: "manual",
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Asset;
}

/**
 * "Mark as posted" is the client's attestation that they published something by
 * hand. Three paths reached the one action carrying three eligibility rules:
 * the asset card (status + placeholder, and NOTHING about the date, so a
 * future-dated post on the staff Assets list and the job detail page showed an
 * enabled button that failed on click), MarkPostedRow (which keyed on
 * `asset.locked` — a flag only a CLIENT's redacted payload carries, so the
 * detail modal and the calendar day card had the same dead button for STAFF),
 * and the server action, which had the real rule.
 *
 * The rule is now `lib/mark-posted`, asked by the control and again by the
 * action. These tests assert the rule by CALLING it and the refusals by calling
 * the action; the wiring — that no surface re-derives it — is scanned below.
 */
describe("markPostedBlock — the shared rule", () => {
  it("allows an approved, scheduled or delivered post whose day has come", () => {
    for (const status of ["approved", "scheduled", "delivered"] as const) {
      const asset = makeAsset({ status, scheduledAt: NOW - DAY });
      expect(markPostedBlock(asset, NOW), status).toBeNull();
      expect(canMarkAssetPosted(asset, NOW), status).toBe(true);
    }
  });

  it("refuses a future-dated post — the clause the asset card was missing", () => {
    const asset = makeAsset({ status: "scheduled", scheduledAt: NOW + 3 * DAY });
    expect(markPostedBlock(asset, NOW)).toBe("locked");
    expect(canMarkAssetPosted(asset, NOW)).toBe(false);
  });

  it("refuses the redacted placeholder a client receives for a future-dated post", () => {
    // Two independent reasons on this payload, and the rule needs both: the
    // server's own `locked` verdict (present only after redaction) and the day
    // comparison (which is what answers for staff, who never receive `locked`).
    const locked = redactLockedAsset(
      makeAsset({ status: "approved", scheduledAt: NOW + 3 * DAY }),
    );
    expect(locked.locked).toBe(true);
    expect(markPostedBlock(locked, NOW)).toBe("locked");

    const flagOnly = makeAsset({ status: "approved", scheduledAt: NOW - DAY, locked: true });
    expect(markPostedBlock(flagOnly, NOW)).toBe("locked");
  });

  it("refuses a draft, a placeholder and an already-published post", () => {
    expect(markPostedBlock(makeAsset({ status: "draft" }), NOW)).toBe("unapproved");
    expect(markPostedBlock(makeAsset({ publishMode: "placeholder" }), NOW)).toBe("placeholder");
    expect(markPostedBlock(makeAsset({ status: "published" }), NOW)).toBe("published");
  });

  it("agrees with assetPublishBlock wherever that rule has an answer", () => {
    // The consolidation's claim: the by-hand attestation refuses exactly the set
    // the live push refuses, and adds one clause. If the two ever diverge on the
    // shared three, this is where it shows.
    const shapes: Array<Partial<Asset>> = [
      { status: "draft" },
      { status: "approved" },
      { status: "scheduled" },
      { status: "delivered" },
      { status: "published" },
      { status: "approved", publishMode: "placeholder" },
      { status: "published", publishMode: "placeholder" },
      { status: "draft", publishMode: "placeholder" },
    ];
    for (const shape of shapes) {
      const asset = makeAsset({ ...shape, scheduledAt: NOW - DAY });
      const publish = assetPublishBlock(asset);
      if (publish !== null) {
        expect(markPostedBlock(asset, NOW), JSON.stringify(shape)).toBe(publish);
      } else {
        expect(markPostedBlock(asset, NOW), JSON.stringify(shape)).toBeNull();
      }
    }
  });

  it("unlocks exactly at local midnight of the scheduled day, not at the scheduled hour", () => {
    const scheduledAt = NOW + 2 * DAY;
    const dayStart = new Date(scheduledAt).setHours(0, 0, 0, 0);
    expect(canMarkAssetPosted(makeAsset({ status: "scheduled", scheduledAt }), dayStart - 1))
      .toBe(false);
    expect(canMarkAssetPosted(makeAsset({ status: "scheduled", scheduledAt }), dayStart))
      .toBe(true);
  });
});

describe("markAssetPostedAction — the server refusals, which are the ones that count", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(auth, "getCurrentUser").mockImplementation(
      async () => ({ id: "u-client", role: "CLIENT_USER", disabled: false, clientId: "c1" }) as any,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("refuses a future-dated post with copy that names the way out", async () => {
    (data.getAsset as any).mockResolvedValue(
      makeAsset({ status: "scheduled", scheduledAt: Date.now() + 3 * DAY }),
    );

    const res = await actions.markAssetPostedAction("a1");

    expect(res).toEqual({
      ok: false,
      error: "This post is scheduled for a later day — you can mark it posted on the day it goes out.",
    });
    expect(data.reconcileAssetPublished).not.toHaveBeenCalled();
  });

  it("keeps refusing a draft and a placeholder, each with its own reason", async () => {
    (data.getAsset as any).mockResolvedValue(makeAsset({ status: "draft" }));
    expect(await actions.markAssetPostedAction("a1")).toEqual({
      ok: false,
      error: "Only an approved, scheduled, or delivered post can be marked as posted",
    });

    (data.getAsset as any).mockResolvedValue(
      makeAsset({ status: "approved", publishMode: "placeholder" }),
    );
    expect(await actions.markAssetPostedAction("a1")).toEqual({
      ok: false,
      error: "This is a placeholder — put it on the calendar before marking it posted",
    });

    (data.getAsset as any).mockResolvedValue(makeAsset({ status: "published" }));
    expect(await actions.markAssetPostedAction("a1")).toEqual({
      ok: false,
      error: "Already marked as posted",
    });

    expect(data.reconcileAssetPublished).not.toHaveBeenCalled();
  });

  it("still records today's approved post — the refusals are not a blanket block", async () => {
    (data.getAsset as any).mockResolvedValue(
      makeAsset({ status: "scheduled", scheduledAt: Date.now() }),
    );
    (data.reconcileAssetPublished as any).mockResolvedValue({ changed: true });

    const res = await actions.markAssetPostedAction("a1");

    expect(res).toEqual({ ok: true });
    expect(data.reconcileAssetPublished).toHaveBeenCalledTimes(1);
  });
});

/** Every .ts/.tsx that renders something, i.e. the UI half of the app. */
function uiFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__") continue;
        walk(full);
        continue;
      }
      if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
    }
  };
  walk(join(SRC, "components"));
  walk(join(SRC, "app"));
  return out;
}

/**
 * The wiring, not the rule. A second button is what created the split, so the
 * tripwire is keyed to the ACTION — the thing a second button would have to
 * call — rather than to the words on it or to any file's name.
 */
describe("one control, one rule", () => {
  // Computed per test, never in this describe's BODY: a throw out here reports
  // "(0 test)" and drops the whole file without failing anything.
  const callers = () =>
    uiFiles()
      .filter((f) => /\bmarkAssetPostedAction\b/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f).split(sep).join("/"))
      .sort();

  it("has exactly one UI caller of markAssetPostedAction", () => {
    expect(callers()).toEqual(["components/mark-posted-row.tsx"]);
  });

  it("has that one caller ask the shared predicate", () => {
    const src = stripComments(
      readFileSync(join(SRC, "components/mark-posted-row.tsx"), "utf8"),
    );
    expect(src).toContain('from "@/lib/mark-posted"');
    expect(src).toContain("canMarkAssetPosted(asset,");
  });

  it("has the asset card render that control instead of its own", () => {
    const src = stripComments(readFileSync(join(SRC, "components/asset-card.tsx"), "utf8"));
    expect(src).toContain("<MarkPostedRow");
    // The eligibility test it used to carry, in the shape it carried it.
    expect(src).not.toContain("canMarkPosted");
  });

  it("has the server action ask the same rule", () => {
    const src = stripComments(readFileSync(join(SRC, "lib/actions/asset-actions.ts"), "utf8"));
    expect(src).toContain('from "@/lib/mark-posted"');
    expect(src).toContain("markPostedBlock(asset,");
  });

  it("reports a planted second caller — the scan is not vacuous", () => {
    // The scan reads stripped source for the identifier; prove that finds a real
    // call and ignores one that only appears in prose.
    const re = /\bmarkAssetPostedAction\b/;
    expect(re.test(stripComments("const r = await markAssetPostedAction(id);"))).toBe(true);
    expect(re.test(stripComments("// see markAssetPostedAction for the rule\nexport {};"))).toBe(
      false,
    );
    // …and that the walker actually reached a real file with the identifier in it.
    expect(uiFiles().length).toBeGreaterThan(50);
    expect(callers()).toHaveLength(1);
  });
});
