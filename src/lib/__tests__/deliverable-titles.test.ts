import { describe, it, expect } from "vitest";
import { deliverableTitle, draftsDisplayTitle, topicPhrase } from "@/lib/deliverable-titles";

/**
 * The archive row's name for one delivered post.
 *
 * The rule these pin: a row may be titled by its SUBJECT, and when there is no
 * subject to read it must fall back rather than print a bare prefix. A row
 * reading "LinkedIn post · " is worse than the dated noun it replaced.
 */
describe("topicPhrase", () => {
  it("takes the opening words of the first non-empty line", () => {
    // Seven words in that line, so it truncates at six and says so.
    expect(topicPhrase("We shipped the new pricing page today.\n\nHere is why.")).toBe(
      "We shipped the new pricing page…",
    );
    // A leading blank line is not the subject.
    expect(topicPhrase("\n\n  Shipping in public  \nrest of the post")).toBe(
      "Shipping in public",
    );
  });

  it("marks truncation, and only when it truncated", () => {
    expect(topicPhrase("One two three four five six seven")).toBe("One two three four five six…");
    expect(topicPhrase("One two three")).toBe("One two three");
  });

  it("drops a trailing full stop rather than printing it before the ellipsis", () => {
    // "Six words exactly, then a stop." — the phrase ends at a sentence end, and
    // "…" after "." reads as a typo.
    expect(topicPhrase("Launch day is finally here.")).toBe("Launch day is finally here");
  });

  it("does not title a post with half a URL", () => {
    // A post opening with a link would otherwise be named after the link.
    expect(topicPhrase("https://karoslabs.com/blog/x Our launch is live")).toBe(
      "Our launch is live",
    );
    // Nothing BUT a link: no subject, so no title.
    expect(topicPhrase("https://karoslabs.com/blog/x")).toBeNull();
  });

  it("reads through markdown shape and a Topic: label", () => {
    expect(topicPhrase("**Topic:** Why founders undersell")).toBe("Why founders undersell");
    expect(topicPhrase("## Shipping in public")).toBe("Shipping in public");
  });

  it("returns null for nothing quotable", () => {
    for (const empty of ["", "   ", "\n\n", "***"]) {
      expect(topicPhrase(empty), JSON.stringify(empty)).toBeNull();
    }
  });
});

describe("deliverableTitle", () => {
  it("names the post by its own hook", () => {
    // A real LinkedIn deliverable from prep, whose opening line is the thing a
    // client would recognise their post by.
    expect(
      deliverableTitle({
        noun: "LinkedIn post",
        body: "You cannot justify a $250K CMO hire. The marketing still has to run.\n\nThat is the gap.",
      }),
    ).toBe("LinkedIn post · You cannot justify a $250K CMO…");
    expect(deliverableTitle({ noun: "X post", body: "Shipping beats polishing" })).toBe(
      "X post · Shipping beats polishing",
    );
  });

  it("returns null rather than a bare prefix when the post says nothing quotable", () => {
    // The caller's signal to keep the dated family noun.
    expect(deliverableTitle({ noun: "X post", body: "" })).toBeNull();
    expect(deliverableTitle({ noun: "LinkedIn post" })).toBeNull();
  });

  it("never emits an em dash of its own", () => {
    // No em dashes anywhere a client reads (2026-08). The separator is a middot.
    const title = deliverableTitle({ noun: "LinkedIn post", body: "A post about growth" });
    expect(title).not.toContain("—");
    expect(title).toContain(" · ");
  });
});

/**
 * The row and the modal it opens must print the SAME name.
 *
 * They did not: the row composed a client-safe title while the modal printed
 * the stored one, which for every agent-service delivery is just the agent's
 * name. Both now call `draftsDisplayTitle` on the same content, so the only way
 * they can disagree is if one of them stops calling it.
 */
describe("draftsDisplayTitle", () => {
  const xOne = [
    "# Account 1 · Company page @karoslabs",
    "",
    "## Avenue 1 · Build-in-public",
    "",
    "> Shipping beats polishing every time.",
    "",
  ].join("\n");
  const xThread = [
    "# Account 1 · Company page @karoslabs",
    "",
    "## Avenue 1 · POV thread",
    "",
    "> **1/2** Hiring is broken.",
    "",
    "> **2/2** Here is the fix.",
    "",
  ].join("\n");
  const xMany = [
    xOne,
    "## Avenue 2 · Knowledge/explainer",
    "",
    "> A second draft entirely.",
    "",
    "## Avenue 3 · News-reaction",
    "",
    "> A third draft entirely.",
    "",
  ].join("\n");

  it("names a one-post delivery by its subject", () => {
    expect(draftsDisplayTitle(xOne)).toBe("X post · Shipping beats polishing every time");
  });

  it("calls a thread a thread rather than undercounting it as one post", () => {
    expect(draftsDisplayTitle(xThread)).toBe("X thread · Hiring is broken");
  });

  it("gives a multi-draft delivery a subject AND an honest count", () => {
    // The old name was "X draft batch · 4 Aug": a client running the agent
    // several times a day could not tell two of those rows apart.
    const title = draftsDisplayTitle(xMany);
    expect(title).toContain("X drafts · Shipping beats polishing every time");
    expect(title).toContain("+2 more");
    // Never a singular promise over a delivery holding three.
    expect(title).not.toMatch(/^X post/);
  });

  it("carries no date, because the row already stamps one", () => {
    expect(draftsDisplayTitle(xOne)).not.toMatch(/\d{1,2} \w{3}|\d{4}-\d{2}-\d{2}/);
  });

  it("leaves anything that is not an X or LinkedIn deliverable to its stored title", () => {
    expect(draftsDisplayTitle("# Some other document\n\nBody text.")).toBeNull();
    expect(draftsDisplayTitle("")).toBeNull();
    expect(draftsDisplayTitle(null)).toBeNull();
  });
});
