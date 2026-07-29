import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The notification bell's two feeds have to be bounded the same way.
 *
 * The staff feed sorted newest-first and capped at 15 from the day it was
 * written. The client feed did neither: it returned every job in `review`, in
 * whatever order Firestore handed the documents back. A runway sweep tops one
 * client up with up to fourteen jobs inside a single minute, so an uncapped
 * feed turns one fire into fourteen bell rows carrying the same stamp — the
 * batch shape (A3/A4) on the chrome of every page.
 *
 * Source-read: data.ts reaches the Admin SDK, so it cannot be imported into a
 * node test run.
 */
const DATA = "src/lib/data.ts";
const LAYOUT = "src/app/(app)/layout.tsx";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** The client feed's body, so a match cannot come from the staff one below it. */
function clientFeed(): string {
  const src = read(DATA);
  const start = src.indexOf("export async function listReviewJobs(");
  expect(start, `${DATA} has no listReviewJobs`).toBeGreaterThan(-1);
  const end = src.indexOf("export async function listReviewJobsForClients(", start);
  expect(end, `${DATA} has no listReviewJobsForClients after it`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("the client review feed", () => {
  it("is capped at the same bound as the staff feed", () => {
    const feed = clientFeed();
    expect(feed).toMatch(/\.slice\(0, opts\?\.limit \?\? 15\)/);
    // The staff feed's own bound, read from the same file — if one moves, this
    // says so rather than letting the two drift apart again.
    const staff = read(DATA).slice(read(DATA).indexOf("export async function listReviewJobsForClients("));
    expect(staff).toMatch(/\.slice\(0, opts\?\.limit \?\? 15\)/);
  });

  it("orders newest first, so a cap keeps the rows that matter", () => {
    // A cap over document order would drop an arbitrary subset — worse than no
    // cap, because the bell would then be both short AND wrong.
    expect(clientFeed()).toMatch(/\.sort\(\(a, b\) => b\.updatedAt - a\.updatedAt\)/);
  });

  it("is called with the bound the staff call site uses", () => {
    const layout = read(LAYOUT);
    expect(layout).toMatch(/listReviewJobs\(user\.clientId, \{ limit: 15 \}\)/);
    expect(layout).toMatch(/listReviewJobsForClients\([\s\S]{0,60}\{ limit: 15 \}\)/);
  });
});
