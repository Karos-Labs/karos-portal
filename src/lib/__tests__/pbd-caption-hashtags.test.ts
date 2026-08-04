/**
 * CD-N — the caption hashtag script's pure core.
 *
 * What is pinned, and why it matters to the product rather than to coverage:
 *  - exactly three tags, lowercase, unique — "three of the most relevant" is
 *    the ask, not "some";
 *  - the guest leads a clip's tags: the caption is about that person;
 *  - idempotence: a second run must write nothing (the script may be re-run
 *    after every future feed sync without doubling tags);
 *  - captions that already carry tags are topped up, never duplicated;
 *  - only UPCOMING scheduled items are touched — a published caption is the
 *    client's own posting history and is out of bounds;
 *  - the appended line introduces no em dash (AF-8 house rule holds for
 *    everything we write into client-visible content).
 */
import { describe, expect, it } from "vitest";
import {
  appendHashtags,
  deriveHashtags,
  existingTags,
  isUpcoming,
  personTag,
  planCaptions,
  TAG_COUNT,
} from "../../../scripts/add-pbd-caption-hashtags";
import type { Asset } from "@/lib/types";

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function asset(over: Partial<Asset>): Asset {
  return {
    id: "a1",
    clientId: "jzgdl738dq7DclAdqky1",
    jobId: null,
    agentId: null,
    type: "social_post",
    title: "Werner Vogels",
    content: "Werner Vogels traces the AWS origin story.",
    meta: {},
    imageUrl: null,
    status: "scheduled",
    scheduledAt: NOW + DAY,
    createdBy: "test",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as Asset;
}

describe("personTag", () => {
  it("slugs a guest name to a searchable tag", () => {
    expect(personTag("Werner Vogels")).toBe("wernervogels");
  });
  it("folds diacritics rather than dropping the letters", () => {
    expect(personTag("Sebastián Kanovich")).toBe("sebastiankanovich");
  });
  it("refuses slugs too short or too long to read as a name tag", () => {
    expect(personTag("Al")).toBeNull();
    expect(personTag("A Name So Very Long It Cannot Be A Tag")).toBeNull();
    expect(personTag(null)).toBeNull();
  });
});

describe("deriveHashtags", () => {
  it("returns exactly three lowercase unique tags", () => {
    const tags = deriveHashtags({ title: "X", content: "nothing topical at all" });
    expect(tags).toHaveLength(TAG_COUNT);
    expect(new Set(tags).size).toBe(TAG_COUNT);
    for (const t of tags) expect(t).toBe(t.toLowerCase());
  });

  it("puts the clip's guest first, then the topic, then a filler", () => {
    const tags = deriveHashtags({
      title: "Martin Casado",
      content: "Martin says the biggest change this cycle is AGI as a north star.",
      person: "Martin Casado",
    });
    expect(tags[0]).toBe("martincasado");
    expect(tags).toContain("ai");
  });

  it("reads meta.about too, so a topic named only there still counts", () => {
    const tags = deriveHashtags({
      title: "Guest",
      content: "A short teaser line.",
      about: "The long note is about fundraising and the cap table.",
    });
    expect(tags).toContain("fundraising");
  });

  it("tags a regional-final post with the competition and its city", () => {
    const tags = deriveHashtags({
      title: "Famnest London",
      content: "How they won, London edition. Famnest took the London regional final.",
    });
    expect(tags).toContain("pitchcompetition");
    expect(tags).toContain("london");
  });

  it("backfills from the brand fillers when nothing topical matches", () => {
    const tags = deriveHashtags({ title: "Quiet", content: "plain words only here" });
    expect(tags).toEqual(["thepitch", "startups", "venturecapital"]);
  });
});

describe("appendHashtags", () => {
  it("appends one trailing line and strips trailing whitespace first", () => {
    const out = appendHashtags("A caption.\n", ["one", "two", "three"]);
    expect(out.content).toBe("A caption.\n\n#one #two #three");
    expect(out.added).toEqual(["one", "two", "three"]);
  });

  it("is idempotent: a second pass adds nothing and keeps content identical", () => {
    const first = appendHashtags("A caption.", ["one", "two", "three"]);
    const second = appendHashtags(first.content, ["one", "two", "three"]);
    expect(second.added).toEqual([]);
    expect(second.content).toBe(first.content);
  });

  it("tops up a caption that already carries one of the tags", () => {
    const out = appendHashtags("Already has #Startups in it.", ["startups", "ai", "founders"]);
    expect(out.added).toEqual(["ai", "founders"]);
    expect(out.content.endsWith("#ai #founders")).toBe(true);
  });

  it("never introduces an em dash into client-visible content", () => {
    const out = appendHashtags("Caption.", deriveHashtags({ title: "T", content: "C" }));
    expect(out.content.includes("—")).toBe(false);
  });
});

describe("existingTags", () => {
  it("finds tags anywhere in the caption, case-insensitively", () => {
    expect(existingTags("Mid #Alpha text #beta_2 end")).toEqual(new Set(["alpha", "beta_2"]));
  });
});

describe("isUpcoming / planCaptions", () => {
  it("touches only future scheduled items, never published or past ones", () => {
    expect(isUpcoming({ status: "scheduled", scheduledAt: NOW + DAY }, NOW)).toBe(true);
    expect(isUpcoming({ status: "published", scheduledAt: NOW + DAY }, NOW)).toBe(false);
    expect(isUpcoming({ status: "scheduled", scheduledAt: NOW - DAY }, NOW)).toBe(false);
    expect(isUpcoming({ status: "draft", scheduledAt: NOW + DAY }, NOW)).toBe(false);
  });

  it("plans in calendar order and reads the guest from meta.person", () => {
    const plan = planCaptions(
      [
        asset({ id: "later", title: "B", scheduledAt: NOW + 2 * DAY, meta: { person: "Ben Horowitz" } }),
        asset({ id: "sooner", title: "A", scheduledAt: NOW + DAY }),
        asset({ id: "past", title: "P", status: "published", scheduledAt: NOW - DAY }),
      ],
      NOW,
    );
    expect(plan.map((p) => p.assetId)).toEqual(["sooner", "later"]);
    expect(plan[1].derived[0]).toBe("benhorowitz");
    expect(plan.every((p) => p.added.length > 0)).toBe(true);
  });

  it("plans no write for a caption already carrying all three derived tags", () => {
    const tagged = appendHashtags(
      "Plain caption.",
      deriveHashtags({ title: "Plain", content: "Plain caption." }),
    ).content;
    const plan = planCaptions([asset({ content: tagged, title: "Plain" })], NOW);
    expect(plan).toHaveLength(1);
    expect(plan[0].added).toEqual([]);
  });
});
