import { describe, expect, it } from "vitest";
import { stepHeadline } from "@/lib/run-step-headline";

// Two real runs, every step in execution order, read off agentEngineRuns/{id}/steps
// on 2026-09-09. Real ids, because invented ones would only test the rules
// against themselves.
const INSTAGRAM = [
  "00-auto-setup", "01-open-run", "02-freeze-style-config", "02b-load-client-voice-context",
  "02c-load-brand-kit", "03-claim-topic", "04a-research-pull", "04b-research-extract-facts",
  "05a-list-used-images", "05z-attach-user-media", "04c-resolve-templates", "04d-read-past-feedback",
  "04e-read-output-history", "04f-read-intel-context", "05-write-copy-attempt-1",
  "05b-source-images-attempt-1", "06-vet-images-attempt-1", "06b-scrape-images-attempt-1",
  "06c-vet-scrape-attempt-1", "06d-generate-images-attempt-1", "06e-vet-generate-attempt-1",
  "06f-verify-images-on-disk-attempt-1", "07-self-check-attempt-1", "07b-craft-hygiene-attempt-1",
  "07d-dedupe-check-attempt-1", "07c-emit-slides-data-attempt-1", "08-render-carousel-attempt-1",
  "08b-visual-qa-attempt-1", "09a-batch-review-r0",
];
const LINKEDIN = [
  "00-channel-setup", "00-intake-check", "01-load-client-context", "02-load-memory-shelf",
  "03-load-recent-decisions", "04-research-pull", "05-extract-candidate-summary", "06-reserve-topic",
  "07-select-candidate", "08-determine-archetype", "04e-read-past-feedback", "read-output-history",
  "read-intel-context", "09-draft-post", "10-verify-numbers-sourced", "11-verify-brand-compliance",
  "12-render-preview-check", "13-verify-no-placeholder", "14-verify-no-leak", "15-batch-review-r0",
];

describe("stepHeadline", () => {
  it("never tells a client about review, on any step of either real run", () => {
    // "12-render-preview-check" once read as review, because "preview" contains
    // it. Whole words only, and no rule for review steps at all.
    for (const id of [...INSTAGRAM, ...LINKEDIN]) {
      expect(stepHeadline(id), id).not.toMatch(/review|approv/i);
    }
  });

  it("says what the agent is doing on the steps a client would recognise", () => {
    expect(stepHeadline("00-auto-setup")).toBe("Getting set up");
    expect(stepHeadline("04b-research-extract-facts")).toBe("Reading up on your brand");
    expect(stepHeadline("05-write-copy-attempt-1")).toBe("Writing the copy");
    expect(stepHeadline("09-draft-post")).toBe("Writing the copy");
    expect(stepHeadline("08-render-carousel-attempt-1")).toBe("Making the visuals");
    expect(stepHeadline("11-verify-brand-compliance")).toBe("Checking its own work");
  });

  it("always says something", () => {
    expect(stepHeadline(null)).toBe("Starting the run");
    expect(stepHeadline("99-a-step-nobody-has-written-yet")).toBe("Working on it");
  });
});
