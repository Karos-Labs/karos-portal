import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * SCRUM-265 item 3 — "cache() on the hot getters (present exactly once
 * today)."
 *
 * WHY THIS IS A SOURCE-STRUCTURE CHECK, NOT A RUNTIME ONE, AND WHY THAT IS
 * DISCLOSED RATHER THAN PAPERED OVER:
 *
 * `react`'s `cache()` only memoizes under the `react-server` module
 * condition (see `node_modules/react/cjs/react.react-server.development.js`)
 * — that build reads the active render dispatcher
 * (`ReactSharedInternals.A`) and, finding none outside an actual RSC render,
 * falls back to calling straight through. This repo's vitest config
 * (`vitest.config.ts`) resolves plain "react" (no `react-server` condition),
 * where `cache()` is INTENTIONALLY a no-op passthrough:
 *
 *   exports.cache = function (fn) { return function () { return fn.apply(null, arguments); }; };
 *
 * A test that imports `getAsset` here and asserts "the second call didn't
 * re-fetch" would show NO memoization both before and after wrapping it in
 * `cache()` — that is the exact "check structurally incapable of failing"
 * trap: it would pass on unmodified code as readily as on fixed code, proving
 * nothing about the change. The real memoization only exists inside Next's
 * own request/render pipeline, which cannot be stood up in a vitest unit test
 * without cloud credentials and a running server — outside this task's reach.
 * This file checks the one thing that IS true and checkable here: that the
 * source has actually opted into request memoization, and that it has done
 * so for the getter it is safe for.
 */
function dataTsSource(): string {
  return readFileSync(resolve(process.cwd(), "src/lib/data.ts"), "utf8");
}

/** True if `name`'s exported getter is wrapped as `cache(async ...)`, not a bare `async function`. */
function isCacheWrapped(source: string, name: string): boolean {
  return new RegExp(`export const ${name} = cache\\(`).test(source);
}

describe("request-memoized data getters (react cache())", () => {
  it("getClient stays cache()-wrapped — the one usage this repo already had", () => {
    expect(isCacheWrapped(dataTsSource(), "getClient")).toBe(true);
  });

  it("getAsset is now cache()-wrapped alongside it", () => {
    // FAILS on unmodified code: getAsset was a bare `export async function`
    // there. `getClient` was the ONLY cache()-wrapped getter in this file
    // before this change — hence the ticket's "(present exactly once today)".
    expect(isCacheWrapped(dataTsSource(), "getAsset")).toBe(true);
  });

  it("getJob is deliberately NOT cache()-wrapped", () => {
    // This is the guard, not the fix: `refreshJobStatusAction` and
    // `requestJobCancellation` (src/lib/actions/external-job-actions.ts) both
    // re-call `getJob(jobId)` by the same id specifically to read back a
    // value `updateJob` just wrote earlier in the same call ("const fresh =
    // await getJob(jobId)" right after the write). A request-scoped cache
    // would hand them the pre-write copy forever. If this ever flips to
    // `true`, whoever changed it needs to also re-check those two call
    // sites — this test exists so that check isn't optional.
    expect(isCacheWrapped(dataTsSource(), "getJob")).toBe(false);
  });

  it("both the fresh-read-after-write call sites this decision rests on still exist", () => {
    // If either of these ever stops being a same-id re-read after a write,
    // the note above (and the reason getJob is excluded) needs revisiting —
    // this pins the premise so that isn't a silent drift.
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/actions/external-job-actions.ts"),
      "utf8",
    );
    expect(source).toMatch(/const fresh = await getJob\(jobId\)/);
    expect(source).toMatch(/freshJob = await getJob\(jobId\)/);
  });
});
