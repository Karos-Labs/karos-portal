import { describe, expect, it } from "vitest";
import {
  notPickedReason,
  optionCandidatesFromBatch,
  optionText,
  resolveOptions,
} from "@/lib/x-options";
import type { XParsedBatch } from "@/lib/x-drafts";

/**
 * §4.5 / WP-9. The load-bearing rule here is the REF CONVENTION: it must be
 * byte-identical to what x-drafts-review already writes into
 * XDraftFeedback.draftRef, or one client's history splits across two namespaces
 * and the learning log teaches the agent from half of it.
 */

const batch: XParsedBatch = {
  accounts: [
    {
      title: "Company page @getkaros",
      drafts: [
        { avenue: "Avenue 1 · Playbook", posts: [{ text: "Ship it weekly." }], meta: [] },
        {
          avenue: "Avenue 3 · News-reaction (live)",
          posts: [{ text: "On today's news:" }, { text: "…and why it matters." }],
          meta: [],
        },
      ],
    },
    {
      title: "Albert Kattan",
      drafts: [{ avenue: "Avenue 2 · Founder POV", posts: [{ text: "What I learned." }], meta: [] }],
    },
  ],
};

describe("optionCandidatesFromBatch", () => {
  it("mints refs exactly as the review pane does — account · avenue", () => {
    const refs = optionCandidatesFromBatch(batch).map((c) => c.ref);
    expect(refs).toEqual([
      "Company page @getkaros · Avenue 1 · Playbook",
      "Company page @getkaros · Avenue 3 · News-reaction (live)",
      "Albert Kattan · Avenue 2 · Founder POV",
    ]);
  });

  it("carries a readable direction and the account, for the diversity passes", () => {
    const [first] = optionCandidatesFromBatch(batch);
    expect(first.account).toBe("Company page @getkaros");
    // laneLabel strips the lab's "Avenue N · " prefix.
    expect(first.direction).not.toMatch(/^Avenue \d/);
    expect(first.direction).toBeTruthy();
  });

  it("drops a duplicate ref rather than offering one draft twice", () => {
    const dupes: XParsedBatch = {
      accounts: [
        {
          title: "Company page @getkaros",
          drafts: [
            { avenue: "Avenue 1 · Playbook", posts: [{ text: "A" }], meta: [] },
            { avenue: "Avenue 1 · Playbook", posts: [{ text: "B" }], meta: [] },
          ],
        },
      ],
    };
    expect(optionCandidatesFromBatch(dupes)).toHaveLength(1);
  });
});

describe("resolveOptions", () => {
  it("returns the texts in the order the DAY assigned them, not the batch order", () => {
    const options = resolveOptions(batch, [
      "Albert Kattan · Avenue 2 · Founder POV",
      "Company page @getkaros · Avenue 1 · Playbook",
    ]);
    expect(options.map((o) => o.account)).toEqual(["Albert Kattan", "Company page @getkaros"]);
  });

  it("keeps every post of a thread", () => {
    const [thread] = resolveOptions(batch, [
      "Company page @getkaros · Avenue 3 · News-reaction (live)",
    ]);
    expect(thread.posts).toHaveLength(2);
    expect(optionText(thread)).toBe("On today's news:\n\n…and why it matters.");
  });

  it("drops a ref the batch no longer contains instead of rendering a blank card", () => {
    const options = resolveOptions(batch, [
      "Company page @getkaros · Avenue 1 · Playbook",
      "Gone · Avenue 9 · Removed",
    ]);
    expect(options).toHaveLength(1);
  });
});

describe("notPickedReason", () => {
  it("names the winner — the log cannot otherwise tell a loser from an unseen draft", () => {
    const reason = notPickedReason("Albert Kattan · Avenue 2 · Founder POV");
    // addXDraftFeedbackAction refuses a not_posted row with an empty reason.
    expect(reason.trim().length).toBeGreaterThan(0);
    expect(reason).toContain("Albert Kattan · Avenue 2 · Founder POV");
  });
});
