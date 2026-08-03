/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assetGcsPath,
  calendarDayKey,
  calendarPlacedAt,
  compareSurvivors,
  dedupeCalendarAssets,
  findDuplicateGroups,
  normalizeDedupeTitle,
  pickSurvivor,
  showsOnCalendar,
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
 * The second half is deliberately NARROW, and most of the cases below exist to
 * keep it that way: hiding a client's real post is a worse defect than showing
 * a duplicate of it. So a shared object path only collapses when the copies
 * agree about where they sit, a published copy can never lose its square to an
 * undated stray, and the title/day guess never reaches the render path at all.
 *
 * Firestore is not writable by this campaign (the credentials in .env.local
 * point at production), so the cleanup script ships unrun — only its safety
 * properties are pinned from source.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const CALENDAR_BODY = "src/app/(app)/calendar/calendar-body.tsx";
/** Where the four assembly steps live now — see the wiring block below. */
const CLIENT_CALENDAR = "src/lib/client-calendar.ts";
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

  it("collapses a shared gcsPath on one day even when the titles differ", () => {
    // Within one day the gcsPath IS the identity: the same object cannot be two
    // posts on the same square, however the two documents were later edited.
    const out = dedupeCalendarAssets([
      asset({ id: "a", title: "Cut 3", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING }),
      asset({ id: "b", title: "Renamed by hand", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_EVENING }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["a"]);
  });

  it("collapses a dated copy with its undated strays", () => {
    // The replay shape the bulk-upload hole actually produced: the original was
    // scheduled, the replayed documents never were.
    const out = dedupeCalendarAssets([
      asset({ id: "scheduled", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING, createdAt: 5_000 }),
      asset({ id: "stray-1", meta: { gcsPath: GCS_PATH }, createdAt: 6_000 }),
      asset({ id: "stray-2", meta: { gcsPath: GCS_PATH }, createdAt: 7_000 }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["scheduled"]);
  });

  it("never merges across clients, even on an identical path", () => {
    const out = dedupeCalendarAssets([
      asset({ id: "a", clientId: "c1", meta: { gcsPath: GCS_PATH } }),
      asset({ id: "b", clientId: "c2", meta: { gcsPath: GCS_PATH } }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("does NOT collapse one clip deliberately scheduled for two different days", () => {
    // The bounce that sent this rule back. Reusing a podcast cut is ordinary
    // work here: two dated copies on two days are two real posts, and hiding
    // one of them is worse than the duplicate this module exists to remove.
    const out = dedupeCalendarAssets([
      asset({ id: "mon", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING }),
      asset({ id: "thu", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING + 3 * DAY, createdAt: 2_000 }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["mon", "thu"]);
  });

  it("still collapses the replays WITHIN each day when a clip is reused", () => {
    // Three documents, two days: the pair sharing Thursday is a replay of one
    // post, the Monday copy is a different post. One cell each, not one cell.
    const out = dedupeCalendarAssets([
      asset({ id: "mon", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING }),
      asset({ id: "thu", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING + 3 * DAY, createdAt: 2_000 }),
      asset({ id: "thu-replay", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING + 3 * DAY, createdAt: 9_000 }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["mon", "thu"]);
  });

  it("leaves an undated stray alone when the dated copies disagree about the day", () => {
    // There is no honest way to say which of the two days the stray duplicates,
    // so it is not attributed to either. It has no scheduledAt or publishedAt,
    // so it draws no cell anyway — this only keeps it out of a wrong merge.
    const out = dedupeCalendarAssets([
      asset({ id: "mon", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING }),
      asset({ id: "thu", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING + 3 * DAY }),
      asset({ id: "stray", meta: { gcsPath: GCS_PATH }, createdAt: 9_000 }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["mon", "thu", "stray"]);
  });

  it("does NOT collapse two posts that share a day and a title on the render path", () => {
    // The title/day guess is reporting-only. A templated content plan routinely
    // produces two posts on one day whose titles normalise alike, and a guess
    // may not take one of them off a client's screen.
    const out = dedupeCalendarAssets([
      asset({ id: "a", title: "Founder story", scheduledAt: JUL30_MORNING }),
      asset({ id: "b", title: "Founder story", scheduledAt: JUL30_EVENING, createdAt: 5_000 }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["a", "b"]);
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
    // Two blanks are not a duplicate pair — an asset with no shared object path
    // passes straight through, which is the safe direction.
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
      asset({ id: "loser", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING, createdAt: 9_000 }),
      asset({ id: "third", title: "C", scheduledAt: JUL30_MORNING }),
      asset({ id: "keeper", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING, createdAt: 1 }),
    ]);

    // Dropping a copy is a filter, not a reshuffle: every survivor holds the
    // position it came in at, so the rest of the list cannot move under it.
    expect(out.map((a) => a.id)).toEqual(["first", "third", "keeper"]);
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

  it("keeps a PUBLISHED copy over an undated stray", () => {
    // The other bounce. A published post carries publishedAt and usually no
    // scheduledAt, so a rule that read scheduledAt alone ranked it BELOW a
    // stray and took already-published client work off the calendar. Placement
    // is read the way the calendar reads it, and eligibility outranks it.
    const published = asset({
      id: "published",
      status: "published",
      publishedAt: JUL30_MORNING,
      createdAt: 9_000,
    });
    const stray = asset({ id: "stray", status: "draft", createdAt: 1 });

    expect(pickSurvivor([stray, published]).id).toBe("published");
    expect(compareSurvivors(published, stray)).toBeLessThan(0);
    expect(calendarPlacedAt(published)).toBe(JUL30_MORNING);
    expect(calendarPlacedAt(stray)).toBeNull();
  });

  it("keeps the published copy when the two are grouped for real", () => {
    // End to end through the render path, not just the comparator: the stray is
    // undated, so the pair agrees about placement and does collapse — onto the
    // copy the client has already been shown.
    const out = dedupeCalendarAssets([
      asset({ id: "stray", status: "draft", meta: { gcsPath: GCS_PATH }, createdAt: 1 }),
      asset({
        id: "published",
        status: "published",
        publishedAt: JUL30_MORNING,
        meta: { gcsPath: GCS_PATH },
        createdAt: 9_000,
      }),
    ]);

    expect(out.map((a) => a.id)).toEqual(["published"]);
  });

  it("never lets a copy the calendar would not draw suppress one it would", () => {
    // Rung 0. Both are placed and the stray is older, so every later rung would
    // hand it the square — but a draft with a date the calendar declines to
    // draw must not be the reason a scheduled post disappears.
    const invisible = asset({
      id: "invisible",
      status: "delivered",
      publishError: undefined,
      scheduledAt: undefined,
      publishedAt: undefined,
      createdAt: 1,
    });
    const shown = asset({
      id: "shown",
      status: "scheduled",
      scheduledAt: JUL30_MORNING,
      createdAt: 9_000,
    });

    expect(showsOnCalendar(invisible)).toBe(false);
    expect(showsOnCalendar(shown)).toBe(true);
    expect(pickSurvivor([invisible, shown]).id).toBe("shown");
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
  const mixed = () => [
    asset({ id: "a", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING }),
    asset({ id: "b", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING }),
    asset({ id: "c", title: "Founder story", scheduledAt: JUL30_MORNING }),
    asset({ id: "d", title: "Founder story", scheduledAt: JUL30_EVENING }),
  ];

  it("labels a shared-path group and a title/day group differently", () => {
    const groups = findDuplicateGroups(mixed());

    const exact = groups.find((g) => g.kind === "gcsPath")!;
    expect(exact.label).toBe(GCS_PATH);
    expect(exact.members.map((m) => m.id)).toEqual(["a", "b"]);
    expect(exact.survivor.id).toBe("a");
  });

  it("returns the high-confidence groups first, as the docstring promises", () => {
    expect(findDuplicateGroups(mixed()).map((g) => g.kind)).toEqual(["gcsPath", "titleDay"]);
  });

  it("still reports the title/day guess the render path refuses to act on", () => {
    // The one place the heuristic is allowed to exist: a line printed for a
    // member of staff to read. `dedupeCalendarAssets` ignores the same pair.
    const rows = mixed();
    const guess = findDuplicateGroups(rows).find((g) => g.kind === "titleDay")!;

    expect(guess.members.map((m) => m.id)).toEqual(["c", "d"]);
    expect(dedupeCalendarAssets(rows).map((a) => a.id)).toContain("c");
    expect(dedupeCalendarAssets(rows).map((a) => a.id)).toContain("d");
  });

  it("names the day when one clip's copies are split across two of them", () => {
    const groups = findDuplicateGroups([
      asset({ id: "mon-1", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING }),
      asset({ id: "mon-2", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_EVENING }),
      asset({ id: "thu", meta: { gcsPath: GCS_PATH }, scheduledAt: JUL30_MORNING + 3 * DAY }),
    ]);

    // Only the same-day pair is a group at all, and its label says which day,
    // so the operator reading the plan can see the clip is reused on purpose.
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.id)).toEqual(["mon-1", "mon-2"]);
    expect(groups[0].label).toContain(GCS_PATH);
    expect(groups[0].label).toContain("2026-07-30");
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

/**
 * Source assertions below are whitespace-normalised and about BEHAVIOUR only —
 * never a comment, never a line break. A wiring test that fails because
 * prettier rewrapped an argument list is noise, and noise is how a real failure
 * gets waved through.
 */
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("the dedupe module stays reviewable", () => {
  it("holds no NUL bytes, so git diffs it as text and plain grep can find it", () => {
    // It shipped with `\0` key separators, which made git call the whole file
    // "Binary files differ" — unreviewable in a diff, invisible to grep. The
    // repo already carries one file like that (src/lib/seo-geo.ts) and the
    // handover has a section about the false "zero matches" it causes.
    const raw = source("src/lib/calendar-dedupe.ts");

    expect(raw).not.toContain("\0");
    expect(raw).toContain("bucketBy");
  });
});

describe("the calendar payload is deduped server-side", () => {
  const src = source(CALENDAR_BODY);
  const body = flat(src);
  const projectionSrc = source(CLIENT_CALENDAR);
  const projection = flat(projectionSrc);

  it("collapses duplicates where the payload is assembled, not at render", () => {
    // THE FOUR STEPS MOVED (AF-19), and the rule did not. Building this payload
    // — status filter, client redaction boundary, dedupe, classify — now lives
    // in lib/client-calendar, because the daily digest has to read the same list
    // and a second copy of the sequence in a cron is exactly what "one source of
    // truth" rules out. Still ONE dedupe call, still on the assembly side, and
    // the page takes its result instead of deriving one of its own.
    expect(projection).toContain('import { dedupeCalendarAssets } from "@/lib/calendar-dedupe"');
    expect(projectionSrc.match(/dedupeCalendarAssets\(/g)).toHaveLength(1);
    expect(src, "the page must not grow a second dedupe").not.toContain("dedupeCalendarAssets");
    expect(body).toContain('import { clientVisibleCalendarAssets } from "@/lib/client-calendar"');
  });

  it("hands the deduped list to every downstream reader, not just the posts map", () => {
    // The run cards ("drafted 8 posts") and the runway badge read the same
    // assets. On the un-deduped list a past-run card printed a deliverable
    // twice and the badge over-counted the days the calendar is filled through.
    // Pinned as an invariant rather than three call sites: nothing may read the
    // pre-dedupe list after the deduped one is derived from it.
    expect(body).toContain("const assets = clientVisibleCalendarAssets(scopedAssets,");
    expect(src.lastIndexOf("scopedAssets")).toBeLessThan(src.indexOf("const assetsByJob"));
    expect(body).toContain("computeRunway(assets,");
    expect(body).toContain("const posts: CalendarPost[] = assets .map(");
  });

  it("groups on the pre-redaction assets, so a locked placeholder keeps its real path", async () => {
    // redactLockedAsset strips a locked post's meta to {locked}, taking the
    // gcsPath the whole decision rests on with it. ASKED OF THE FUNCTION rather
    // than of its source now that it is one: two copies of the same GCS object
    // on the same future day are one post, and a client reads them through the
    // redaction, which is precisely the case where a source assertion could pass
    // over a broken order.
    const { clientVisibleCalendarAssets } = await import("@/lib/client-calendar");
    const FUTURE = Date.now() + 7 * DAY;
    const twin = (id: string): any => ({
      id,
      clientId: "c1",
      type: "social_post",
      title: "Podcast cut 3",
      content: "body",
      meta: { gcsPath: GCS_PATH },
      status: "scheduled",
      scheduledAt: FUTURE,
      createdBy: "u1",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const survivors = clientVisibleCalendarAssets([twin("a1"), twin("a2")], {
      isClient: true,
      now: Date.now(),
    });

    expect(survivors, "the redacted copies were grouped, so neither had a path").toHaveLength(1);
    expect(survivors[0].locked, "the survivor must still be the redacted copy").toBe(true);
    expect(survivors[0].meta).toEqual({ locked: true });
  });

  it("never tells a client how many copies were hidden", () => {
    // The churn rule: a duplicate count is a generation-time tell.
    expect(body).not.toMatch(/duplicate[s]?\s*(count|Count)|hiddenDuplicates|deduped\s*\d/);
  });
});

describe("the cleanup script ships safe and unrun", () => {
  const script = source(CLEANUP_SCRIPT);
  const flatScript = flat(script);

  it("is dry-run by default and only writes behind --apply", () => {
    expect(flatScript).toContain('const apply = process.argv.includes("--apply")');
    expect(script).toMatch(/DRY RUN — nothing is written/);
    // Every Firestore mutation in the file is behind the apply gate: the only
    // delete call sits after the `if (!apply) { … return; }` early exit.
    const gate = script.indexOf("if (!apply)");
    expect(gate).toBeGreaterThan(-1);
    expect(script.indexOf("batch.delete(")).toBeGreaterThan(gate);
    expect(script.match(/batch\.delete\(/g)).toHaveLength(1);
  });

  it("refuses --apply without --client, before it even opens a connection", () => {
    // A fleet-wide unattended delete is not a thing this script can be asked to
    // do — one client per invocation, the fence refresh-apply.ts already holds.
    const refusal = script.indexOf("if (apply && !clientArg)");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(script.indexOf("getFirestore()"));
    expect(script.indexOf("batch.delete(")).toBeGreaterThan(refusal);
    expect(flatScript).toContain("REFUSING TO RUN");
  });

  it("cross-checks the plan against the named client before deleting", () => {
    expect(flatScript).toContain("const foreign = losers.filter((l) => l.clientId !== clientArg)");
    expect(script.indexOf("const foreign")).toBeLessThan(script.indexOf("batch.delete("));
  });

  it("skips assets with no clientId instead of pooling them under one blank id", () => {
    expect(flatScript).toContain("const orphans = rows.filter((r) => !r.clientId.trim())");
    expect(flatScript).toContain("findDuplicateGroups(scannable)");
    expect(flatScript).toContain("Skipped ${orphans.length} asset(s) with no clientId");
  });

  it("never deletes anything from the lower-confidence heuristic group", () => {
    expect(flatScript).toContain("losers = exact.flatMap");
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
