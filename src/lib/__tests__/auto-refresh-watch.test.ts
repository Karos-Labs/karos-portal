import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A page watching an in-flight run used to pay for a full route re-render every
 * four seconds to discover that nothing had happened.
 *
 * `router.refresh()` re-renders the entire route segment tree: every layout,
 * every Suspense boundary, every data fetch on the page. Eleven of the twelve
 * `AutoRefresh` mounts did that on every tick. The twelfth — the Job detail
 * page — already polls a narrow `{ inProgress }` route instead, and the
 * component's own comment explains why the rest could not follow: each watches
 * a DIFFERENT in-flight signal, computed from data the page already holds, and
 * moving those predicates into a route would copy page logic somewhere the two
 * can drift.
 *
 * `watchUrl` is the answer that does not require moving them. It asks "did
 * anything MOVE" rather than "is it in flight", so the page keeps its own
 * predicate and only the POLL gets cheap.
 *
 * These assert the two properties that make that safe, because both are easy
 * to lose in an edit and neither shows up as a broken screen — it shows up as
 * a page that quietly stops updating, or one that refreshes forever.
 */

const SOURCE = readFileSync(join(process.cwd(), "src/components/auto-refresh.tsx"), "utf8");

describe("AutoRefresh's watch mode", () => {
  it("refreshes only when the number GROWS, not when it merely arrives", () => {
    // `>` and not `!==`: a clock that goes backwards — a replica lagging, a
    // document rewritten with an older timestamp — would otherwise refresh on
    // every tick forever.
    expect(SOURCE).toMatch(/changedAt > seen/);
  });

  it("seeds from the first response rather than from zero", () => {
    // Seeding at 0 would make mounting itself count as a change, so every page
    // that mounts this would pay for exactly the refresh it was added to avoid.
    expect(SOURCE).toMatch(/seen === undefined/);
  });

  it("treats a failed poll as 'no change', never as a change", () => {
    // A network hiccup that refreshed the page would be worse than the problem:
    // an offline client would refresh every four seconds indefinitely.
    const watchBlock = SOURCE.slice(SOURCE.indexOf("watchUrl) {"), SOURCE.indexOf("if (!statusUrl) {"));
    expect(watchBlock).toMatch(/if \(!res\.ok \|\| cancelled\) return;/);
    expect(watchBlock).toMatch(/catch \{/);
  });

  it("does not let watchUrl override the narrower statusUrl", () => {
    // `statusUrl` answers "is it done", which is strictly better when a page
    // has it: it can stop polling entirely. The branch order is what keeps that
    // true if a call site ever passes both.
    expect(SOURCE.indexOf("if (!statusUrl && watchUrl)")).toBeLessThan(SOURCE.indexOf("if (!statusUrl) {"));
  });

  it("cleans up on unmount, so a navigated-away page stops polling", () => {
    const watchBlock = SOURCE.slice(SOURCE.indexOf("watchUrl) {"), SOURCE.indexOf("if (!statusUrl) {"));
    expect(watchBlock).toMatch(/cancelled = true/);
    expect(watchBlock).toMatch(/clearInterval\(t\)/);
  });
});

describe("the watch endpoint stays a read", () => {
  const ROUTE = readFileSync(join(process.cwd(), "src/app/api/clients/[id]/activity/route.ts"), "utf8");

  it("exports only GET", () => {
    // Something polled every few seconds must never also be a write path — the
    // same rule the job status route states for itself.
    expect(ROUTE).toMatch(/export async function GET/);
    expect(ROUTE).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it("answers 'not yours' and 'no such client' identically", () => {
    // Otherwise the status code is an oracle for which client ids exist.
    expect(ROUTE).toMatch(/!client \|\| !canViewClient\(user, client\)/);
    expect(ROUTE).not.toMatch(/status: 403/);
  });
});
