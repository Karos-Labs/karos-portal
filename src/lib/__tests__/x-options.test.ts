import { describe, expect, it } from "vitest";
import {
  notPickedReason,
  optionCandidatesFromBatch,
  optionText,
  optionsLead,
  resolveOptions,
  toClientXOption,
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

describe("toClientXOption", () => {
  const raw = {
    ref: "Albert Kattan (seat 1, handle pending) · Avenue 2 · Founder POV",
    account: "Albert Kattan (seat 1, handle pending)",
    direction: "Founder pov",
    posts: ["What I learned."],
  };

  it("humanises the account and touches nothing else", () => {
    const option = toClientXOption(raw);
    expect(option.account).toBe("Albert Kattan");
    // The rest crosses byte-for-byte: the direction is already humanised by
    // resolveOptions, and the posts are the client's own drafts.
    expect(option.direction).toBe(raw.direction);
    expect(option.posts).toEqual(raw.posts);
    expect(Object.keys(option).sort()).toEqual(["account", "direction", "posts", "ref"]);
  });

  it("keeps the ref byte-identical — it is the pick action's join key", () => {
    // THE STATED SCOPE, and the reason it is stated: the account heading is
    // still readable inside this one field. pickAgentSlotOptionAction resolves
    // the pick by matching this string against slot.optionRefs, and the learning
    // log records the same string as draftRef, so it cannot be rewritten here.
    expect(toClientXOption(raw).ref).toBe(raw.ref);
  });

  it("prints no account rather than a bare seat number", () => {
    const anonymous = toClientXOption({ ...raw, account: "(seat 4, handle pending)" });
    expect(anonymous.account).toBeNull();
    // …and the neighbouring case still carries one, so this is a drop and not a
    // blanket blanking of the field.
    expect(toClientXOption({ ...raw, account: "Company page @getkaros" }).account).toBe(
      "Company page @getkaros",
    );
  });

  it("humanises every option resolveOptions produces, straight off a batch", () => {
    const options = resolveOptions(batch, [
      "Albert Kattan · Avenue 2 · Founder POV",
      "Company page @getkaros · Avenue 1 · Playbook",
    ]).map(toClientXOption);
    expect(options.map((o) => o.account)).toEqual(["Albert Kattan", "Company page @getkaros"]);
    expect(options.map((o) => o.direction)).not.toContain("Avenue 2 · Founder POV");
  });
});

describe("optionsLead", () => {
  it("says three when there are three, and asks for a pick", () => {
    const lead = optionsLead(3);
    expect(lead).toContain("3 directions");
    expect(lead).toContain("Pick one");
  });

  it("does not say one direction is several, or ask a client to pick between one", () => {
    // A one-option day is DOCUMENTED, not exotic: resolveOptions drops a ref
    // whose draft is gone and optionCandidatesFromBatch dedupes colliding refs,
    // so this line rendered "1 directions to choose from" on a real day.
    const lead = optionsLead(1);
    expect(lead).not.toContain("1 directions");
    expect(lead).not.toContain("directions");
    expect(lead).not.toContain("choose from");
    expect(lead).not.toContain("Pick one");
    expect(lead).toContain("One direction for today");
  });

  it("still says picking is free, whichever day it is", () => {
    // The component's own rule: nothing is generated by choosing, so no copy on
    // this surface may imply a credit path.
    for (const count of [1, 2, 3]) {
      expect(optionsLead(count), `count ${count}`).toContain("costs nothing");
    }
  });

  it("never renders a hyphen where the house style wants an em dash", () => {
    for (const count of [1, 2, 3]) {
      expect(optionsLead(count)).not.toContain(" - ");
      expect(optionsLead(count)).toContain("—");
    }
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
