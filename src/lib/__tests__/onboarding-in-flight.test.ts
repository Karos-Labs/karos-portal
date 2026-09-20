import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AI_PROCESSING_LOCK_STALE_MS, isOnboardingInFlight } from "@/lib/constants";

/**
 * 2026-09-20. "Pitch by Deel" sat at `onboardingStatus: "running"` in BOTH
 * environments from 2026-09-17 with `isAiProcessing: false` — a client-creation
 * run killed before the `after()` callback that moves the status to
 * "done"/"failed". Nothing else in the product writes that field and nothing
 * reaps it, so the value was permanent.
 *
 * The cost was invisible: the runway sweep and the auto-generate sweep both
 * skipped the client on every pass with `detail: "onboarding: running"`. A skip
 * is not an error, no banner reads the field, and the client simply stopped
 * receiving generated work without anything saying so.
 */
describe("isOnboardingInFlight", () => {
  const SRC = path.resolve(__dirname, "../..");
  const now = Date.now();

  it("is true while a setup run genuinely holds the lock", () => {
    expect(
      isOnboardingInFlight({ onboardingStatus: "running", isAiProcessing: true, aiProcessingStartedAt: now }),
    ).toBe(true);
  });

  it("is true for pending, which precedes the lock", () => {
    // The gap between the client record being written and the `after()`
    // callback acquiring the lock. Real, and short.
    expect(isOnboardingInFlight({ onboardingStatus: "pending" })).toBe(true);
  });

  it("is FALSE for a running status whose lock died — the incident", () => {
    expect(isOnboardingInFlight({ onboardingStatus: "running", isAiProcessing: false })).toBe(false);
    expect(
      isOnboardingInFlight({
        onboardingStatus: "running",
        isAiProcessing: true,
        aiProcessingStartedAt: now - AI_PROCESSING_LOCK_STALE_MS - 1,
      }),
    ).toBe(false);
  });

  it("is false for the settled states", () => {
    expect(isOnboardingInFlight({ onboardingStatus: "done" })).toBe(false);
    // "failed" means the research degraded, not that setup is still going —
    // the sweeps have always let it through, and still do.
    expect(isOnboardingInFlight({ onboardingStatus: "failed" })).toBe(false);
    expect(isOnboardingInFlight({})).toBe(false);
  });

  it("is what both sweeps actually ask, rather than the raw status", () => {
    // Stated over the source because the rule is only worth anything if the
    // two callers use it: each used to compare `onboardingStatus` itself, and
    // a third sweep written tomorrow would copy whichever it read first.
    for (const file of ["app/api/runway/route.ts", "app/api/tasks/auto-generate/route.ts"]) {
      const src = readFileSync(path.join(SRC, file), "utf8");
      expect(src, file).toContain("isOnboardingInFlight(client)");
      expect(src, file).not.toContain('client.onboardingStatus === "running"');
    }
  });
});
