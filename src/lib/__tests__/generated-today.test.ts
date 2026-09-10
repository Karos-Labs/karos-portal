import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  GENERATED_TODAY_EMPTY_HINT,
  GENERATED_TODAY_EMPTY_TITLE,
  GENERATED_TODAY_EXPLAINER,
  GENERATED_TODAY_TITLE,
  generatedToday,
  isGeneratedToday,
} from "@/lib/generated-today";
import { CLIENT_ASSET_STATUS_LABEL } from "@/lib/asset-status-copy";
import { stripComments } from "./source-scan";

/**
 * SCRUM-417: a client can see what their agents produced today.
 *
 * WHY IT WAS MISSING, and it is not that nobody built the widget. Home's
 * nearest card is "Recent activity", and for a CLIENT it is filtered to
 * `isInClientArchive` - approved, non-future, inside the 30-day window. So a
 * client who ran three agents this morning saw an EMPTY card until a staff
 * member approved the output, possibly the next day. The card answers "what
 * has been delivered", which is the archive one screen over, and it was
 * standing where the reader's actual question goes.
 *
 * THE TENSION THIS TICKET HAD TO RESOLVE. A3/A4 deliberately REMOVED drafts
 * from that card, for a good reason recorded in its own comment: a draft's
 * delivery stamp is the fire, so five drafts read "Untitled · 3 hours ago" and
 * published the shape of the generation run as if it were delivered work. This
 * card puts them back, and the resolution is in the frame rather than in
 * overriding the ruling - the heading says the reader asked what came out
 * today, every row carries its real status through `assetStatusLabel`, and the
 * capped-with-a-count half of that ruling is kept. Both halves are asserted
 * below, so a future edit cannot quietly drop one.
 */

const SRC = path.resolve(__dirname, "../..");
const code = (rel: string) => stripComments(readFileSync(path.join(SRC, rel), "utf8"));

/** Only the fields the selector reads, so a fixture cannot pass by accident. */
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m, d, h, min, 0).getTime();
const asset = (createdAt: number, id = String(createdAt)) => ({ id, createdAt });

/* ─────────────────────────── what "today" means ─────────────────────────── */

describe("the today selector", () => {
  const now = at(2026, 8, 9, 14, 30);

  it("keeps what was generated on the same calendar day", () => {
    expect(isGeneratedToday(asset(at(2026, 8, 9, 9)), now)).toBe(true);
    expect(isGeneratedToday(asset(at(2026, 8, 9, 0, 1)), now)).toBe(true);
    expect(isGeneratedToday(asset(at(2026, 8, 9, 23, 59)), now)).toBe(true);
  });

  it("drops yesterday, even an hour of it", () => {
    // A LOCAL CALENDAR DAY, not a 24-hour window. 23:30 and 00:30 are an hour
    // apart and are two different days - and the word the reader is given is
    // "today", so the grain has to be the date's.
    expect(isGeneratedToday(asset(at(2026, 8, 8, 23, 30)), at(2026, 8, 9, 0, 30))).toBe(false);
    expect(isGeneratedToday(asset(at(2026, 8, 8, 14)), now)).toBe(false);
  });

  it("drops tomorrow, so a future-dated asset is not counted as made today", () => {
    expect(isGeneratedToday(asset(at(2026, 8, 10, 9)), now)).toBe(false);
  });

  it("orders newest first and returns the WHOLE day, so the caller can say what it hid", () => {
    const rows = generatedToday(
      [
        asset(at(2026, 8, 9, 9), "morning"),
        asset(at(2026, 8, 8, 18), "yesterday"),
        asset(at(2026, 8, 9, 13), "lunch"),
        asset(at(2026, 8, 9, 11), "late-morning"),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(["lunch", "late-morning", "morning"]);
  });

  it("does not mutate the array it was handed", () => {
    // It sorts, and `Array.prototype.sort` is in place - the caller's `assets`
    // prop is the same array the sibling card reads.
    const input = [asset(at(2026, 8, 9, 9), "a"), asset(at(2026, 8, 9, 13), "b")];
    const order = input.map((r) => r.id);
    generatedToday(input, now);
    expect(input.map((r) => r.id)).toEqual(order);
  });

  it("reads createdAt and nothing else", () => {
    // The one client-facing list deliberately keyed to the GENERATION instant.
    // A fixture with only createdAt has to work, or something else is being read.
    expect(generatedToday([{ createdAt: at(2026, 8, 9, 9) }], now)).toHaveLength(1);
  });
});

/* ───────────────────────────────── the copy ───────────────────────────────── */

describe("the widget's words", () => {
  const strings = [
    GENERATED_TODAY_TITLE,
    GENERATED_TODAY_EXPLAINER,
    GENERATED_TODAY_EMPTY_TITLE,
    GENERATED_TODAY_EMPTY_HINT,
  ];

  it("carries the one-line explanation Lola asked for, and it names both steps", () => {
    // "after that it goes into the calendar (little explanation)". The review
    // step has to be named too or the sentence is false: nothing reaches a
    // client's calendar until a person has approved it.
    expect(GENERATED_TODAY_EXPLAINER).toMatch(/review/i);
    expect(GENERATED_TODAY_EXPLAINER).toMatch(/Calendar/);
  });

  it("names Calendar, not the retired Workspace", () => {
    // Workspace is retired from both shells; Calendar is what the rail says.
    for (const s of strings) expect(s).not.toMatch(/Workspace/i);
  });

  it("reads the empty day as normal, not as an error", () => {
    // An agent on a weekly schedule leaves this card empty five days in seven.
    for (const s of [GENERATED_TODAY_EMPTY_TITLE, GENERATED_TODAY_EMPTY_HINT]) {
      expect(s).not.toMatch(/error|failed|problem|wrong|sorry/i);
    }
  });

  it("names no stored status and reads as client copy", () => {
    const stored = Object.keys(CLIENT_ASSET_STATUS_LABEL);
    for (const s of strings) {
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/ - /);
      for (const word of stored) {
        expect(s.toLowerCase(), `"${s}" names the stored "${word}"`).not.toMatch(
          new RegExp(`\\b${word}\\b`),
        );
      }
    }
  });
});

/* ──────────────────── the card, and the ruling it inherits ──────────────── */

describe("the home card", () => {
  const home = code("components/client-home-overview.tsx");

  it("is what a CLIENT gets in that slot, and staff keep Recent activity", () => {
    // Replacing it for both readers would have been a product change nobody
    // asked for: the staff set is every asset stamped at generation, which is
    // the useful staff read, and no staff complaint exists.
    expect(home).toContain("<GeneratedTodayCard");
    expect(home).toMatch(/viewerIsClient \? \(\s*<GeneratedTodayCard/);
    expect(home).toContain("Recent activity");
  });

  it("occupies ONE slot rather than adding a second list of assets", () => {
    // Lola's word for this page was "overwhelming". Two lists of assets that
    // mostly disagree is how it got that way.
    expect((home.match(/<GeneratedTodayCard/g) ?? []).length).toBe(1);
    expect((home.match(/<CardTitle/g) ?? []).length).toBe(3); // attention, recent, today
  });

  it("keeps the capped-plus-count half of the A3/A4 ruling", () => {
    // The half that stays: a list which silently stops at its limit states
    // that the limit is all there was.
    expect(home).toContain("const hidden = today.length - shown.length;");
    expect(home).toMatch(/more today/);
  });

  it("stamps its rows at generation, not at delivery", () => {
    expect(home).toMatch(/relativeTime\(a\.createdAt\)/);
  });

  it("shows every row's real status through the register", () => {
    // What lets a draft appear here without claiming to be delivered.
    expect(home).toContain("assetStatusLabel(a.status, true)");
  });

  it("links a row only where the archive would hold it", () => {
    // The phantom-destination rule, fourth application in this epic. Today's
    // drafts are exactly the rows the archive provably excludes, so most of
    // them are inert - and the count line is not a link either.
    expect(home).toMatch(/const inArchive = isInClientArchive\(a, now\);/);
    const card = home.slice(home.indexOf("function GeneratedTodayCard"));
    expect(card).toMatch(/\{inArchive \? \(/);
    // The "and N more today" line must not be an anchor.
    expect(card).not.toMatch(/more today[\s\S]{0,80}<\/Link>/);
  });
});
