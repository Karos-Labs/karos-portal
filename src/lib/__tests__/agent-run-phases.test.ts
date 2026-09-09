import { describe, expect, it } from "vitest";
import { RUN_PHASES, phaseForStep, phaseProgress, stepStem } from "@/lib/agent-run-phases";

/**
 * The mapping is checked against the step ids agent-engine ACTUALLY wrote, read
 * off `agentEngineRuns/{id}/steps` on 2026-09-09 — one full instagram-agent run
 * (29 steps) and one full linkedin-agent run (20). Invented ids would test the
 * rules against themselves; these are the vocabulary the rules exist to
 * survive, including the two spellings of the same idea that already disagree
 * (`04e-read-past-feedback` and `read-output-history`).
 */

const INSTAGRAM: ReadonlyArray<[string, string]> = [
  ["00-auto-setup", "code"],
  ["01-open-run", "code"],
  ["02-freeze-style-config", "code"],
  ["02b-load-client-voice-context", "code"],
  ["02c-load-brand-kit", "code"],
  ["03-claim-topic", "code"],
  ["04a-research-pull", "code"],
  ["04b-research-extract-facts", "agent"],
  ["05a-list-used-images", "code"],
  ["05z-attach-user-media", "code"],
  ["04c-resolve-templates", "code"],
  ["04d-read-past-feedback", "code"],
  ["04e-read-output-history", "code"],
  ["04f-read-intel-context", "code"],
  ["05-write-copy-attempt-1", "agent"],
  ["05b-source-images-attempt-1", "code"],
  ["06-vet-images-attempt-1", "agent"],
  ["06b-scrape-images-attempt-1", "code"],
  ["06c-vet-scrape-attempt-1", "agent"],
  ["06d-generate-images-attempt-1", "code"],
  ["06e-vet-generate-attempt-1", "agent"],
  ["06f-verify-images-on-disk-attempt-1", "code"],
  ["07-self-check-attempt-1", "code"],
  ["07b-craft-hygiene-attempt-1", "code"],
  ["07d-dedupe-check-attempt-1", "code"],
  ["07c-emit-slides-data-attempt-1", "code"],
  ["08-render-carousel-attempt-1", "code"],
  ["08b-visual-qa-attempt-1", "agent"],
  ["09a-batch-review-r0", "gate"],
];

const LINKEDIN: ReadonlyArray<[string, string]> = [
  ["00-channel-setup", "code"],
  ["00-intake-check", "code"],
  ["01-load-client-context", "code"],
  ["02-load-memory-shelf", "code"],
  ["03-load-recent-decisions", "code"],
  ["04-research-pull", "code"],
  ["05-extract-candidate-summary", "code"],
  ["06-reserve-topic", "code"],
  ["07-select-candidate", "code"],
  ["08-determine-archetype", "code"],
  ["04e-read-past-feedback", "code"],
  ["read-output-history", "code"],
  ["read-intel-context", "code"],
  ["09-draft-post", "agent"],
  ["10-verify-numbers-sourced", "code"],
  ["11-verify-brand-compliance", "code"],
  ["12-render-preview-check", "code"],
  ["13-verify-no-placeholder", "code"],
  ["14-verify-no-leak", "code"],
  ["15-batch-review-r0", "gate"],
];

describe("stepStem", () => {
  it("drops the position prefix and the retry suffix", () => {
    expect(stepStem("09a-batch-review-r0")).toBe("batch-review");
    expect(stepStem("05-write-copy-attempt-1")).toBe("write-copy");
    expect(stepStem("06f-verify-images-on-disk-attempt-1")).toBe("verify-images-on-disk");
    // No prefix to drop is not an error — one real id has none.
    expect(stepStem("read-output-history")).toBe("read-output-history");
  });
});

describe("phaseForStep, against the ids the engine really writes", () => {
  it("puts every gate in review, whatever its id says", () => {
    for (const [id, kind] of [...INSTAGRAM, ...LINKEDIN]) {
      if (kind !== "gate") continue;
      expect(phaseForStep(id, kind), id).toBe("review");
    }
  });

  it("reads the Instagram run the way a person would describe it", () => {
    const phase = (id: string) => phaseForStep(id, INSTAGRAM.find(([s]) => s === id)?.[1]);
    expect(phase("00-auto-setup")).toBe("setup");
    expect(phase("02c-load-brand-kit")).toBe("setup");
    expect(phase("04b-research-extract-facts")).toBe("research");
    expect(phase("05-write-copy-attempt-1")).toBe("writing");
    expect(phase("06d-generate-images-attempt-1")).toBe("visuals");
    expect(phase("08-render-carousel-attempt-1")).toBe("visuals");
    expect(phase("07d-dedupe-check-attempt-1")).toBe("checks");
    expect(phase("09a-batch-review-r0")).toBe("review");
  });

  it("reads the LinkedIn run the same way, through different spellings", () => {
    const phase = (id: string) => phaseForStep(id, LINKEDIN.find(([s]) => s === id)?.[1]);
    expect(phase("00-intake-check")).toBe("setup");
    expect(phase("02-load-memory-shelf")).toBe("setup");
    expect(phase("09-draft-post")).toBe("writing");
    expect(phase("11-verify-brand-compliance")).toBe("checks");
    expect(phase("15-batch-review-r0")).toBe("review");
    // The two ids that already disagree on how to spell one idea.
    expect(phase("04e-read-past-feedback")).toBe("research");
    expect(phase("read-output-history")).toBe("research");
  });

  it("never returns nothing, for any id the engine might add tomorrow", () => {
    const ids = ["99-brand-new-step", "", "xyz", "42z-something-nobody-planned"];
    for (const id of ids) {
      expect(RUN_PHASES.map((p) => p.id), id).toContain(phaseForStep(id));
    }
  });
});

describe("phaseProgress", () => {
  it("places a run on the ladder from the current step alone", () => {
    // agent-engine reports currentStepId and NO completed list — this is the
    // case that matters, and the one a completed-ids-only implementation would
    // render as an empty bar for the whole run.
    const p = phaseProgress({ currentStepId: "05-write-copy-attempt-1", currentStepKind: "agent" });
    expect(p.headline).toBe("Writing the copy");
    expect(p.done).toBe(2); // setup and research are behind it
    expect(p.total).toBe(RUN_PHASES.length);
    expect(p.phases.find((x) => x.id === "writing")?.state).toBe("active");
    expect(p.phases.find((x) => x.id === "visuals")?.state).toBe("pending");
  });

  it("names the human gate as the wait it is", () => {
    const p = phaseProgress({ currentStepId: "09a-batch-review-r0", currentStepKind: "gate" });
    expect(p.headline).toBe("Waiting for your Karos team to review");
    expect(p.done).toBe(5);
  });

  it("does not animate a phase for a run that has reported nothing yet", () => {
    const p = phaseProgress({});
    expect(p.headline).toBe("Starting the run");
    expect(p.done).toBe(0);
    expect(p.phases.every((x) => x.state === "pending")).toBe(true);
  });

  it("never goes backwards when a run interleaves phases", () => {
    // The real Instagram run sources images (visuals) between two writing
    // steps. Placing the bar by "which phases have been touched" would move it
    // to visuals and then back to writing; placing it by the CURRENT step's
    // index cannot.
    const p = phaseProgress({
      currentStepId: "05-write-copy-attempt-1",
      recordedStepIds: INSTAGRAM.map(([id]) => id),
    });
    expect(p.phases.find((x) => x.id === "writing")?.state).toBe("active");
    expect(p.phases.find((x) => x.id === "checks")?.state).toBe("pending");
    expect(p.phases.find((x) => x.id === "review")?.state).toBe("pending");
  });

  it("shows a finished run as finished, with nothing animating", () => {
    const p = phaseProgress({ finished: true, currentStepId: "09a-batch-review-r0" });
    expect(p.done).toBe(p.total);
    expect(p.phases.every((x) => x.state === "done")).toBe(true);
  });
});
