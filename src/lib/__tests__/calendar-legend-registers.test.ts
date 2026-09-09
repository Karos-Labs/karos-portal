import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALL_CALENDAR_FILTER_KEYS,
  ALL_CALENDAR_RUN_LEGEND_KEYS,
  calendarFilterKeyMatchable,
  calendarFilterLabel,
  calendarRunLegendLabel,
} from "@/lib/calendar-kind";

/**
 * The calendar legend names TWO kinds of thing, and a reader has to be able to
 * tell which is which.
 *
 * Reported from outside (SCRUM-422): "these are too many options and repeat",
 * followed by nine words — Scheduled run, Completed run, Draft, Scheduled,
 * Published, Waiting, Placeholder, Failed, Suggested — and the question "are
 * completed run and published the same thing?"
 *
 * They are not, and nothing was repeating. Those nine were one flex row holding
 * two vocabularies at one weight: two RUN states (a job the agent performed) and
 * seven POST states (a thing that job produced). One completed run can leave a
 * post that is scheduled, waiting, or failed to publish, so "Completed run" and
 * "Published" are answers to different questions. The row is split and labelled
 * now; no state was deleted, because deleting a word does not delete the state
 * it names — it only stops the calendar explaining itself.
 *
 * WHAT THIS TEST HOLDS. Two things the JSX cannot:
 *
 *  1. Neither register may produce a word that could be read as the other's.
 *     That is the machine-checkable form of "they repeat" — and the trap is
 *     real, since "Scheduled" and "Scheduled run" already sit one line apart.
 *     Containment, not equality: "Scheduled" is a prefix of "Scheduled run",
 *     which is exactly how the two looked like one taxonomy.
 *  2. The words come from the register, not from the component. Both run labels
 *     were string literals in run-calendar.tsx until SCRUM-422, which is why
 *     nothing could state rule 1 before.
 */

const CALENDAR = join(process.cwd(), "src/components/run-calendar.tsx");

/** Comments stripped, so this file's own explanations do not answer its questions. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/** Both registers' words, for one viewer. */
function words(viewerIsClient: boolean) {
  const runs = ALL_CALENDAR_RUN_LEGEND_KEYS.map(calendarRunLegendLabel);
  const posts = ALL_CALENDAR_FILTER_KEYS
    // The row only offers what this viewer can match, and drops `review`
    // outright per the locked "In review is removed" decision.
    .filter((key) => calendarFilterKeyMatchable(key, viewerIsClient) && key !== "review")
    .map((key) => calendarFilterLabel(key, viewerIsClient));
  return { runs, posts };
}

describe("the calendar legend's two registers", () => {
  it("both have members to compare", () => {
    // Non-vacuity: an empty side would make every rule below hold over nothing.
    expect(ALL_CALENDAR_RUN_LEGEND_KEYS.length).toBe(2);
    for (const viewerIsClient of [true, false]) {
      const { posts } = words(viewerIsClient);
      expect(posts.length, `no post words for viewerIsClient=${viewerIsClient}`).toBeGreaterThan(3);
    }
  });

  for (const viewerIsClient of [true, false]) {
    const who = viewerIsClient ? "a client" : "staff";

    it(`gives ${who} no run word identical to a post word`, () => {
      const { runs, posts } = words(viewerIsClient);
      const collisions: string[] = [];
      for (const run of runs) {
        for (const post of posts) {
          if (run.toLowerCase() === post.toLowerCase()) {
            collisions.push(`"${run}" is both a run word and a post word`);
          }
        }
      }
      expect(collisions, "one word cannot name two different objects in one row").toEqual([]);
    });

    it(`keeps ${who}'s overlapping pair distinguishable, and it is a known pair`, () => {
      // "Scheduled run" CONTAINS "Scheduled", and that is allowed — but only
      // because the row labels its two halves, so the reader is not deciding
      // between them out of context. Left as an assertion rather than a comment
      // because the containment is the whole reason the report said "repeat":
      // if a THIRD such pair appears, or if the headings that make this one
      // readable are removed, somebody has to look again.
      const { runs, posts } = words(viewerIsClient);
      const overlapping = runs.flatMap((run) =>
        posts
          .filter((post) => {
            const a = run.toLowerCase();
            const b = post.toLowerCase();
            return a !== b && (a.includes(b) || b.includes(a));
          })
          .map((post) => `${run} / ${post}`),
      );
      expect(overlapping.sort()).toEqual(["Scheduled run / Scheduled"]);

      // The headings are what license it. Asserted here too, next to the pair
      // they justify, so removing them fails beside the reason they exist.
      const src = code(CALENDAR);
      expect(src).toMatch(/>\s*Runs\s*</);
      expect(src).toMatch(/>\s*Posts\s*</);
    });

    it(`gives ${who} no two post words that are the same`, () => {
      const { posts } = words(viewerIsClient);
      expect(new Set(posts).size, `duplicate post words: ${posts.join(", ")}`).toBe(posts.length);
    });
  }

  it("takes both run words from the register, never from the component", () => {
    const src = code(CALENDAR);
    for (const key of ALL_CALENDAR_RUN_LEGEND_KEYS) {
      const label = calendarRunLegendLabel(key);
      expect(src, `${label} is typed into run-calendar.tsx again`).not.toContain(`"${label}"`);
    }
    expect(src).toContain("calendarRunLegendLabel(key)");
  });

  it("says which register each half of the row belongs to", () => {
    // The fix is not the split, it is the naming: an unlabelled split is still
    // two groups of words a reader has to guess the difference between.
    const src = code(CALENDAR);
    expect(src).toMatch(/>\s*Runs\s*</);
    expect(src).toMatch(/>\s*Posts\s*</);
  });
});
