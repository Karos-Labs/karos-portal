import { describe, expect, it } from "vitest";
import {
  accountLabel,
  laneLabel,
  laneLabelOrNull,
  refLaneLabel,
} from "@/lib/draft-lane-label";

/**
 * The one home for humanising the lab's batch headings.
 *
 * SCOPE. This file covers the four label functions and nothing else. It says
 * nothing about WHICH fields cross to a client — that is the projections'
 * question, pinned in `client-agent-rows.test.ts`,
 * `client-agent-rows-account-label.test.ts` and
 * `agent-intake-feedback-rows.test.ts`.
 */

/**
 * The lab vocabulary, spelled out rather than imported: the whole point of
 * these assertions is that none of it survives, so a fixture that read the
 * module's own tables back would pass whatever the tables happen to say.
 */
// "draft"/"warming" were absent, which is why the sweep could not see the Reddit
// leak: the ordinal SHAPE is what SLOT_PREFIX forbids, so the words it can
// produce belong here too.
const LAB_WORDS = ["Avenue", "avenue", "Account", "seat", "Seat", "handle pending",
  "Draft 1", "draft 1", "warming", "Warming", "established"];

describe("laneLabel", () => {
  it("strips the lab's slot prefix and maps known lanes", () => {
    expect(laneLabel("Avenue 1 · Build-in-public")).toBe("Building in public");
    expect(laneLabel("Post 2 · POV thread")).toBe("Your point of view (thread)");
    expect(laneLabel("Post 1 · knowledge/explainer")).toBe("Explainer");
  });

  it("strips the ordinal when the heading drops its separator, which is the same shape", () => {
    // The gap: the prefix rule fired on "Avenue 2 · " and on a bare "Avenue 9",
    // and matched neither in between — so a heading the agent wrote without the
    // separator sentence-cased whole into "Avenue 2 news reaction" and reached a
    // client's option card as their angle.
    expect(laneLabel("Avenue 2 News-reaction")).toBe("Reacting to the news");
    expect(laneLabelOrNull("Post 3 Playbook")).toBe("Playbook");
    // The same shape inside a ref, so both direction paths answer alike.
    expect(refLaneLabel("Company page @getkaros · Avenue 2 News-reaction")).toBe(
      "Reacting to the news",
    );
    for (const word of LAB_WORDS) {
      expect(laneLabel("Avenue 2 News-reaction"), word).not.toContain(word);
    }
    // Neighbouring case: the punctuated form is untouched, so the widening did
    // not simply start eating the head of every heading.
    expect(laneLabel("Avenue 2 · News-reaction")).toBe("Reacting to the news");
    expect(laneLabel("Playbook")).toBe("Playbook");
    expect(accountLabel("Company page @getkaros")).toBe("Company page @getkaros");
  });

  it("keeps a freshness flag as a readable suffix", () => {
    expect(laneLabel("Avenue 3 · News-reaction (live)")).toBe("Reacting to the news · live");
  });

  it("sentence-cases anything unmapped and survives junk", () => {
    expect(laneLabel("Avenue 9 · SOME_NEW-lane")).toBe("Some new lane");
    expect(laneLabel("")).toBe("Draft");
    expect(laneLabel("Draft 4 ·   ")).toBe("Draft");
  });

  it("still falls back to the card word, so the review panes are unchanged", () => {
    // The review panes title a draft CARD with this, where "Draft" is the
    // honest generic. #155 changed the sentence-shaped callers, not these.
    expect(laneLabel("(live)")).toBe("Draft");
    expect(laneLabel("Avenue 2 · ")).toBe("Draft");
  });
});

describe("laneLabelOrNull", () => {
  it("answers exactly as laneLabel does whenever there is a lane to name", () => {
    // Non-vacuity for the nulls below: the two functions must differ ONLY in
    // the no-lane case, or one of them is quietly a second implementation.
    for (const heading of [
      "Avenue 1 · Build-in-public",
      "Post 2 · POV thread",
      "Avenue 3 · News-reaction (live)",
      "Avenue 9 · SOME_NEW-lane",
      "Playbook",
    ]) {
      expect(laneLabelOrNull(heading)).toBe(laneLabel(heading));
      expect(laneLabelOrNull(heading)).not.toBeNull();
    }
  });

  it("returns null rather than a status word when no lane is named", () => {
    // The #155 case: this value lands inside a client's sentence, and "Draft"
    // there reads as an internal status word.
    expect(laneLabelOrNull("")).toBeNull();
    expect(laneLabelOrNull("   ")).toBeNull();
    expect(laneLabelOrNull("Draft 4 ·   ")).toBeNull();
    expect(laneLabelOrNull("Avenue 2 · ")).toBeNull();
    expect(laneLabelOrNull("(live)")).toBeNull();
  });

  it("treats a bare slot ordinal as no lane, separator or not", () => {
    // "Avenue 9" alone names no lane, and a prefix rule that only fired when a
    // lane FOLLOWED would print the word Avenue to a client — the #87 defect
    // arriving through the tidier-looking half of the string.
    for (const heading of ["Avenue 9", "Post 2", "Draft 1", "Seat 3", "Account 4 "]) {
      expect(laneLabelOrNull(heading), heading).toBeNull();
    }
  });
});

describe("refLaneLabel", () => {
  it("drops the account head and humanises the lane tail", () => {
    expect(refLaneLabel("Company page @getkaros · Avenue 3 · News-reaction (live)")).toBe(
      "Reacting to the news · live",
    );
    expect(refLaneLabel("Albert Kattan · Avenue 2 · POV thread")).toBe(
      "Your point of view (thread)",
    );
  });

  it("leaves no lab vocabulary in what it returns, account bookkeeping included", () => {
    // The #87 shape, whole: the ref a client's feedback row used to print raw.
    const label = refLaneLabel(
      "Albert Kattan (seat 1, handle pending) · Avenue 3 · News-reaction (live)",
    );
    expect(label).toBe("Reacting to the news · live");
    for (const word of LAB_WORDS) expect(label).not.toContain(word);
  });

  it("says nothing for a ref with no lane segment to read", () => {
    // A single segment cannot be told apart from an account title, and printing
    // an account heading as an angle is the defect, so it yields nothing.
    expect(refLaneLabel("Albert Kattan (seat 1, handle pending)")).toBeNull();
    expect(refLaneLabel("Company page @getkaros")).toBeNull();
    expect(refLaneLabel("")).toBeNull();
    expect(refLaneLabel("Acme · ")).toBeNull();
  });
});

describe("accountLabel", () => {
  it("keeps a heading a client already recognises, verbatim", () => {
    // Non-vacuity for every drop below: the humaniser must not simply blank the
    // field, or the picker would stop telling a client which account a draft is
    // for — the reason the label is on the card at all.
    expect(accountLabel("Company page @getkaros")).toBe("Company page @getkaros");
    expect(accountLabel("Albert Kattan")).toBe("Albert Kattan");
    expect(accountLabel("Acme")).toBe("Acme");
  });

  it("drops the lab's seat bookkeeping and keeps the person", () => {
    expect(accountLabel("Albert Kattan (seat 1, handle pending)")).toBe("Albert Kattan");
    expect(accountLabel("Account 2 · Albert Kattan")).toBe("Albert Kattan");
    expect(accountLabel("Seat 3 · Albert Kattan (handle pending)")).toBe("Albert Kattan");
  });

  it("drops a parenthetical whatever it says, and an unclosed one too", () => {
    // The SHAPE is what is forbidden, not the spellings above: a bookkeeping
    // note nobody has written client copy for must not reach the picker either.
    expect(accountLabel("Albert Kattan (internal only, do not send)")).toBe("Albert Kattan");
    expect(accountLabel("Albert Kattan (slug: albert-k")).toBe("Albert Kattan");
    expect(accountLabel("Albert Kattan · (seat 1)")).toBe("Albert Kattan");
  });

  it("rescues a handle out of a parenthetical, because that is what a client knows", () => {
    expect(accountLabel("Company page (@getkaros)")).toBe("Company page @getkaros");
    expect(accountLabel("(@getkaros)")).toBe("@getkaros");
  });

  it("returns null when the heading was all bookkeeping", () => {
    // The honest answer for a heading with nothing client-meaningful in it is
    // to print no account, not to dress a seat number up as copy.
    expect(accountLabel("(seat 4, handle pending)")).toBeNull();
    expect(accountLabel("Seat 4 · ")).toBeNull();
    expect(accountLabel("Seat 4")).toBeNull();
    expect(accountLabel("")).toBeNull();
  });

  it("leaves no lab vocabulary in any of the headings the contract documents", () => {
    for (const title of [
      "Company page @getkaros",
      "Albert Kattan (seat 1, handle pending)",
      "Account 1 · Company page @getkaros",
      "Seat 2 · Albert Kattan (handle pending)",
    ]) {
      const label = accountLabel(title) ?? "";
      for (const word of LAB_WORDS) expect(label, `from ${title}`).not.toContain(word);
    }
  });
});
