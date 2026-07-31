/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assetGcsPath,
  calendarDayKey,
  compareSurvivors,
  dedupeCalendarAssets,
  findDuplicateGroups,
  normalizeDedupeTitle,
  pickSurvivor,
  type CalendarDedupeAsset,
} from "@/lib/calendar-dedupe";

/**
 * The calendar-duplicates cluster. On the 30 Jul call the product owner
 * scrolled his content calendar and said "this is duplicated, this also" —
 * seventeen minutes after a colleague reported the calendar fixed, and four
 * minutes BEFORE the bulk upload he ran in the same session. So the duplicates
 * were already in Firestore; nothing that call did created them.
 *
 * Two halves, both pinned here:
 *   1. The write hole. The bulk-upload "complete" step registered a clip
 *      unconditionally, so a replayed POST wrote a second document for the same
 *      GCS object. Executed against the real route with an in-memory store.
 *   2. The read defence. The documents that hole already wrote are still in
 *      production, so the calendar collapses duplicate cells itself. That rule
 *      is a pure function, so it is CALLED, not asserted from source.
 *
 * Firestore is not writable by this campaign (the credentials in .env.local
 * point at production), so the cleanup script ships unrun — only its two
 * safety properties, dry-run-by-default and the require.main guard, are pinned
 * from source.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const CALENDAR_BODY = "src/app/(app)/calendar/calendar-body.tsx";
const CLEANUP_SCRIPT = "scripts/find-duplicate-assets.ts";

function asset(overrides: Partial<CalendarDedupeAsset> = {}): CalendarDedupeAsset {
  return {
    id: "a1",
    clientId: "c1",
    title: "Podcast cut 3",
    createdAt: 1_000,
    ...overrides,
  };
}

const DAY = 24 * 60 * 60 * 1000;
/** 2026-07-30T09:00:00Z and 2026-07-30T21:00:00Z — same UTC day, different hours. */
const JUL30_MORNING = Date.UTC(2026, 6, 30, 9, 0, 0);
const JUL30_EVENING = Date.UTC(2026, 6, 30, 21, 0, 0);

/* ══ 1. the write hole: "complete" is idempotent ═══════════════════════ */

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => ({ uid: "u1", role: "KAROS_ADMIN", disabled: false })),
}));

interface StoredAsset {
  id: string;
  clientId: string;
  createdAt: number;
  meta?: Record<string, unknown>;
}
const store: StoredAsset[] = [];
let nextId = 0;

vi.mock("@/lib/data", () => ({
  getClient: vi.fn(async (id: string) => ({ id, name: "Acme" })),
  createAsset: vi.fn(async (data: any) => {
    const id = `asset-${++nextId}`;
    store.push({ id, ...data });
    return id;
  }),
  // Same ordering contract as the real listAssets: newest first.
  listAssets: vi.fn(async (opts?: { clientId?: string }) =>
    store
      .filter((a) => !opts?.clientId || a.clientId === opts.clientId)
      .slice()
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
  ),
}));

vi.mock("@/lib/gcs-media", () => ({
  ALLOWED_VIDEO_MIME_TYPES: ["video/mp4"],
  MAX_VIDEO_BYTES: 5 * 1024 * 1024 * 1024,
  createReadSignedUrl: vi.fn(async (p: string) => `https://signed.test/${p}`),
  createUploadSignedUrl: vi.fn(async () => "https://signed.test/upload"),
  listClientMediaObjects: vi.fn(async () => []),
  mediaObjectPath: (clientId: string, filename: string) => `clients/${clientId}/podcast-clips/${filename}`,
}));

import { POST as bulkUploadPOST } from "@/app/api/assets/bulk-upload/route";

const GCS_PATH = "clients/c1/podcast-clips/cut-3.mp4";

function completeRequest(gcsPath = GCS_PATH): Request {
  return new Request("https://portal.test/api/assets/bulk-upload", {
    method: "POST",
    body: JSON.stringify({
      step: "complete",
      clientId: "c1",
      gcsPath,
      filename: "cut-3.mp4",
      contentType: "video/mp4",
    }),
  });
}

describe('bulk-upload "complete" is idempotent on the object path', () => {
  beforeEach(() => {
    store.length = 0;
    nextId = 0;
  });

  it("a replayed completion returns the same id and writes no second asset", async () => {
    const first = await (await bulkUploadPOST(completeRequest())).json();
    const second = await (await bulkUploadPOST(completeRequest())).json();

    expect(first.id).toBeTruthy();
    expect(second.id).toBe(first.id);
    expect(store).toHaveLength(1);
  });

  it("keeps the response shape a caller cannot tell apart from the original success", async () => {
    const first = await bulkUploadPOST(completeRequest());
    const replay = await bulkUploadPOST(completeRequest());

    expect(replay.status).toBe(first.status);
    expect(Object.keys(await replay.json())).toEqual(["id"]);
  });

  it("still registers a genuinely different clip", async () => {
    await bulkUploadPOST(completeRequest());
    const other = await (
      await bulkUploadPOST(completeRequest("clients/c1/podcast-clips/cut-4.mp4"))
    ).json();

    expect(store).toHaveLength(2);
    expect(other.id).not.toBe(store[0].id);
  });

  it("hands back the ORIGINAL, not the newest copy, when production already holds both", async () => {
    // The duplicates this cluster exists for are already written. listAssets
    // returns newest-first, so the survivor rule has to reach past the head.
    store.push(
      { id: "newer", clientId: "c1", createdAt: 2_000, meta: { gcsPath: GCS_PATH } },
      { id: "older", clientId: "c1", createdAt: 1_000, meta: { gcsPath: GCS_PATH } },
    );

    const res = await (await bulkUploadPOST(completeRequest())).json();

    expect(res.id).toBe("older");
    expect(store).toHaveLength(2);
  });
});

/* ══ 2. the read defence: the dedupe helper is pure ════════════════════ */

describe("dedupeCalendarAssets collapses duplicate documents", () => {
  it("collapses two assets sharing a gcsPath into one", () => {
    const out = dedupeCalendarAssets([
      asset({ id: "a", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING }),
      asset({ id: "b", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING, createdAt: 2_000 }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["a"]);
  });

  it("collapses a shared gcsPath even when title, day and status all differ", () => {
    // The gcsPath IS the identity: the same object in the bucket cannot be two
    // different posts, however the two documents were subsequently edited.
    const out = dedupeCalendarAssets([
      asset({ id: "a", title: "Cut 3", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING }),
      asset({ id: "b", title: "Renamed by hand", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING + 3 * DAY }),
    ]);

    expect(out).toHaveLength(1);
  });

  it("never merges across clients, even on an identical path", () => {
    const out = dedupeCalendarAssets([
      asset({ id: "a", clientId: "c1", meta: { gcsPath: GCS_PATH } }),
      asset({ id: "b", clientId: "c2", meta: { gcsPath: GCS_PATH } }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("collapses same client + same day + same title when neither has a gcsPath", () => {
    const out = dedupeCalendarAssets([
      asset({ id: "a", title: "Founder story", scheduledAt: JUL30_MORNING }),
      asset({ id: "b", title: "Founder story", scheduledAt: JUL30_EVENING, createdAt: 5_000 }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["a"]);
  });

  it("does NOT collapse two posts that merely share a day", () => {
    const out = dedupeCalendarAssets([
      asset({ id: "a", title: "Founder story", scheduledAt: JUL30_MORNING }),
      asset({ id: "b", title: "Product teardown", scheduledAt: JUL30_EVENING }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("does NOT collapse the same title on two different days", () => {
    const out = dedupeCalendarAssets([
      asset({ id: "a", title: "Founder story", scheduledAt: JUL30_MORNING }),
      asset({ id: "b", title: "Founder story", scheduledAt: JUL30_MORNING + DAY }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("does not pool undated or untitled assets with each other", () => {
    // Two blanks are not a duplicate pair — an asset the heuristic cannot
    // identify passes straight through, which is the safe direction.
    const out = dedupeCalendarAssets([
      asset({ id: "a", title: "", scheduledAt: JUL30_MORNING }),
      asset({ id: "b", title: "", scheduledAt: JUL30_MORNING }),
      asset({ id: "c", title: "Undated" }),
      asset({ id: "d", title: "Undated" }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores a blank gcsPath rather than treating it as a shared key", () => {
    const out = dedupeCalendarAssets([
      asset({ id: "a", title: "One", meta: { gcsPath: "   " }, scheduledAt: JUL30_MORNING }),
      asset({ id: "b", title: "Two", meta: { gcsPath: "" }, scheduledAt: JUL30_MORNING }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("is safe on an empty list and on a single asset", () => {
    expect(dedupeCalendarAssets([])).toEqual([]);
    const one = [asset({ id: "solo", meta: { gcsPath: GCS_PATH } })];
    expect(dedupeCalendarAssets(one)).toEqual(one);
  });

  it("keeps the input's order and does not shuffle survivors", () => {
    const out = dedupeCalendarAssets([
      asset({ id: "first", title: "A", scheduledAt: JUL30_MORNING }),
      asset({ id: "dupe-of-third", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING, createdAt: 9_000 }),
      asset({ id: "third", title: "C", scheduledAt: JUL30_MORNING }),
      asset({ id: "keeper", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING, createdAt: 1 }),
    ]);

    // The group takes the position of its FIRST member, whichever copy wins.
    expect(out.map((a) => a.id)).toEqual(["first", "keeper", "third"]);
  });

  it("returns the same answer however the duplicates are ordered", () => {
    const a = asset({ id: "a", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING, createdAt: 1_000 });
    const b = asset({ id: "b", meta: { gcsPath: GCS_PATH }, createdAt: 500 });

    expect(dedupeCalendarAssets([a, b]).map((x) => x.id)).toEqual(["a"]);
    expect(dedupeCalendarAssets([b, a]).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("the survivor rule is deterministic", () => {
  it("prefers the copy with a real scheduledAt", () => {
    const dated = asset({ id: "dated", scheduledAt: JUL30_MORNING, createdAt: 9_000 });
    const undated = asset({ id: "undated", createdAt: 1 });

    expect(pickSurvivor([undated, dated]).id).toBe("dated");
    expect(compareSurvivors(dated, undated)).toBeLessThan(0);
  });

  it("then prefers the oldest createdAt", () => {
    const older = asset({ id: "older", scheduledAt: JUL30_MORNING, createdAt: 1_000 });
    const newer = asset({ id: "newer", scheduledAt: JUL30_MORNING, createdAt: 2_000 });

    expect(pickSurvivor([newer, older]).id).toBe("older");
  });

  it("breaks a full tie on document id, so a refresh cannot reshuffle the grid", () => {
    const zed = asset({ id: "zed", scheduledAt: JUL30_MORNING, createdAt: 1_000 });
    const abe = asset({ id: "abe", scheduledAt: JUL30_MORNING, createdAt: 1_000 });

    expect(pickSurvivor([zed, abe]).id).toBe("abe");
    expect(pickSurvivor([abe, zed]).id).toBe("abe");
  });

  it("treats a missing createdAt as the oldest rather than throwing", () => {
    const noStamp = asset({ id: "no-stamp", scheduledAt: JUL30_MORNING, createdAt: undefined as any });
    const stamped = asset({ id: "stamped", scheduledAt: JUL30_MORNING, createdAt: 1_000 });

    expect(pickSurvivor([stamped, noStamp]).id).toBe("no-stamp");
  });
});

describe("findDuplicateGroups separates the two confidence levels", () => {
  it("labels a shared-path group and a title/day group differently", () => {
    const groups = findDuplicateGroups([
      asset({ id: "a", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING }),
      asset({ id: "b", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING }),
      asset({ id: "c", title: "Founder story", scheduledAt: JUL30_MORNING }),
      asset({ id: "d", title: "Founder story", scheduledAt: JUL30_EVENING }),
    ]);

    expect(groups.map((g) => g.kind).sort()).toEqual(["gcsPath", "titleDay"]);
    const exact = groups.find((g) => g.kind === "gcsPath")!;
    expect(exact.label).toBe(GCS_PATH);
    expect(exact.members.map((m) => m.id)).toEqual(["a", "b"]);
    expect(exact.survivor.id).toBe("a");
  });

  it("reports nothing when there are no duplicates", () => {
    expect(findDuplicateGroups([asset({ id: "a" }), asset({ id: "b", title: "Other" })])).toEqual([]);
  });

  it("agrees with dedupeCalendarAssets about the survivor", () => {
    const rows = [
      asset({ id: "a", meta: { gcsPath: GCS_PATH }, createdAt: 4_000 }),
      asset({ id: "b", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING, createdAt: 9_000 }),
    ];

    expect(findDuplicateGroups(rows)[0].survivor.id).toBe(dedupeCalendarAssets(rows)[0].id);
  });
});

describe("the grouping keys themselves", () => {
  it("reads meta.gcsPath and nothing else", () => {
    expect(assetGcsPath(asset({ meta: { gcsPath: GCS_PATH } }))).toBe(GCS_PATH);
    expect(assetGcsPath(asset({ meta: { locked: true } }))).toBeNull();
    expect(assetGcsPath(asset())).toBeNull();
  });

  it("buckets by UTC day, so the answer does not depend on where the render happened", () => {
    expect(calendarDayKey(JUL30_MORNING)).toBe("2026-07-30");
    expect(calendarDayKey(JUL30_EVENING)).toBe("2026-07-30");
  });

  it("normalizes case and whitespace in a title, nothing more", () => {
    expect(normalizeDedupeTitle("  Founder   Story ")).toBe("founder story");
    expect(normalizeDedupeTitle("Founder story")).toBe(normalizeDedupeTitle("FOUNDER STORY"));
    expect(normalizeDedupeTitle("Founder story")).not.toBe(normalizeDedupeTitle("Founder stories"));
  });
});

/* ══ 3. wiring and script safety ═══════════════════════════════════════ */

describe("the calendar payload is deduped server-side", () => {
  const body = source(CALENDAR_BODY);

  it("collapses duplicates where the posts payload is assembled, not at render", () => {
    expect(body).toContain('import { dedupeCalendarAssets } from "@/lib/calendar-dedupe"');
    expect(body).toMatch(/const postSurvivorIds = new Set\(\s*dedupeCalendarAssets\(/);
    expect(body).toMatch(/const posts: CalendarPost\[\] = assets\s*\.filter\(\(a\) => postSurvivorIds\.has\(a\.id\)\)/);
  });

  it("groups on the pre-redaction assets, so redacted placeholders cannot collapse into each other", () => {
    // redactLockedAsset rewrites a locked post's title to the template name and
    // strips meta to {locked}. Keyed off those, several genuinely different
    // upcoming posts on one day would share a title and merge.
    expect(body).toContain("const rawById = new Map(scopedAssets.map((a) => [a.id, a]))");
    expect(body).toContain("rawById.get(a.id) ?? a");
  });

  it("never tells a client how many copies were hidden", () => {
    // The churn rule: a duplicate count is a generation-time tell.
    expect(body).not.toMatch(/duplicate[s]?\s*(count|Count)|hiddenDuplicates|deduped\s*\d/);
  });
});

describe("the cleanup script ships safe and unrun", () => {
  const script = source(CLEANUP_SCRIPT);

  it("is dry-run by default and only writes behind --apply", () => {
    expect(script).toContain('const apply = process.argv.includes("--apply")');
    expect(script).toMatch(/DRY RUN — nothing is written/);
    // Every Firestore mutation in the file is behind the apply gate: the only
    // delete call sits after the `if (!apply) { … return; }` early exit.
    const gate = script.indexOf("if (!apply)");
    expect(gate).toBeGreaterThan(-1);
    expect(script.indexOf("batch.delete(")).toBeGreaterThan(gate);
    expect(script.match(/batch\.delete\(/g)).toHaveLength(1);
  });

  it("never deletes anything from the lower-confidence heuristic group", () => {
    expect(script).toMatch(/losers = exact\.flatMap/);
    expect(script).toContain("report only");
  });

  it("guards on require.main so importing it opens no connection", () => {
    expect(script).toContain("if (require.main === module)");
    expect(script.indexOf("if (require.main === module)")).toBeGreaterThan(script.indexOf("async function main()"));
  });

  it("shares the calendar's survivor rule instead of restating it", () => {
    expect(script).toContain('from "../src/lib/calendar-dedupe"');
    expect(script).toContain("findDuplicateGroups");
  });
});
