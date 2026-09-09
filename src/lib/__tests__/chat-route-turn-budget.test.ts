import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SCRUM-254 / T-B24: "maxDuration=60 with stepCountIs(6). A turn that has to
 * ask about files, route, run and return an id WILL NOT RELIABLY FIT in
 * that."
 *
 * This is a source-scan test, matching the precedent already set in this
 * same file's neighbors (chat-route-agent-guard.test.ts, credit-attribution
 * .test.ts) for the chat route specifically: it is 1000+ lines with a heavy
 * Firestore + streamText dependency graph, so driving it end-to-end is not
 * how this route is tested elsewhere in the repo.
 *
 * Two real, independently-checkable claims:
 *
 *  1. `stepCountIs` (from the `ai` SDK) is the ACTUAL, in-process budget for
 *     the copilot's tool-calling loop — it is what `stopWhen: STOP_WHEN`
 *     passes to `streamText`, and it stops the loop after N model steps
 *     regardless of wall-clock time. `stepCountIs(6)` is too tight for a
 *     multi-tool turn (find_output, run_agent_now, create_tasks, etc.) and
 *     is the thing this ticket must raise.
 *
 *  2. `maxDuration` is a Vercel-only convention. This repo deploys via Cloud
 *     Build to Cloud Run (cloudbuild.yaml), where request duration is capped
 *     once, service-wide, by `--timeout=300` — `maxDuration` on any App
 *     Router route here is inert and asserts a limit nothing enforces (this
 *     exact fact is already pinned for another route in
 *     asset-media-download.test.ts's "asserts no request-duration ceiling it
 *     does not control"). A number on this route was therefore not a second,
 *     tighter time budget fix — it was a false claim, and the prior attempt
 *     at this ticket was rejected for treating raising it as the fix.
 */

const REPO = join(__dirname, "..", "..", "..");
const CHAT_ROUTE = "src/app/api/clients/[id]/chat/route.ts";
const source = () => readFileSync(join(REPO, CHAT_ROUTE), "utf8");

describe("SCRUM-254: chat route's real turn budget is stepCountIs, not maxDuration", () => {
  it("raises the tool-call step budget well past the 6 that could not reliably fit a look-up + act + answer turn", () => {
    const src = source();
    const match = src.match(/const STOP_WHEN\s*=\s*\[[^\]]*stepCountIs\((\d+)\)/);
    expect(match, "could not find stepCountIs(N) feeding STOP_WHEN in the chat route").not.toBeNull();
    const n = Number(match![1]);
    // 6 is the value this ticket reports as too tight. Anything at or below
    // it is not a fix. This also guards against a token-only bump (e.g. 7)
    // that technically satisfies ">6" but does not address "will not
    // reliably fit" for a multi-tool turn.
    expect(n).toBeGreaterThanOrEqual(12);
  });

  it("STOP_WHEN (the loop's actual stopWhen) is the one that was raised, not a second unused constant", () => {
    const src = source();
    const stopWhenLine = src.match(/const STOP_WHEN\s*=\s*\[[^\]]*\]/);
    expect(stopWhenLine, "STOP_WHEN definition not found").not.toBeNull();
    expect(stopWhenLine![0]).toMatch(/stepCountIs\(\d+\)/);
    expect(src).toContain("stopWhen: STOP_WHEN");
  });

  it("does not assert a request-duration ceiling this route does not control", () => {
    // Same claim, same reasoning, as asset-media-download.test.ts's
    // "asserts no request-duration ceiling it does not control" — applied
    // here to the route this ticket actually touches. A bare
    // `export const maxDuration = N` is a claim that N seconds is this
    // route's ceiling; on this Cloud Run deploy that claim is false (the
    // real, service-wide ceiling is cloudbuild.yaml's --timeout=300), so
    // raising N (60 → 120, as the rejected attempt did) does not fix
    // anything — it just makes the false claim a bigger number.
    const route = source();
    // Match an actual statement, not a comment merely discussing this in
    // prose (e.g. "see asset-media-download.test.ts's ... reasoning").
    expect(route).not.toMatch(/^export const maxDuration/m);
    // The route should still explain, in its own text, why it isn't set —
    // pointing at the actual ceiling rather than leaving the omission
    // unexplained.
    expect(route).toContain("cloudbuild.yaml");
    const cloudbuild = readFileSync(join(REPO, "cloudbuild.yaml"), "utf8");
    expect(cloudbuild).toContain("--timeout=300");
  });
});
