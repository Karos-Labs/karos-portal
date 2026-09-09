import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The roster row declares `min-h-[64px]` and five columns. Both are promises,
 * and one staff sentence used to break them together.
 *
 * THE SHAPE OF THE BUG. Everything to the right of the agent's name is
 * `shrink-0` — the status badge, three fixed columns, the platform mark, the
 * chevron, the gaps and the padding — so the identity column is the row's only
 * flexible child and absorbs the whole deficit alone. The five-column layout
 * switched on at `@2xl` (672px), where that furniture already wanted about
 * 630px, leaving the identity column 38px: the agent's NAME truncated to
 * nothing on the row whose entire job is naming agents. One pixel narrower, the
 * compact layout took over and it jumped back to 542px, so the WORST width was
 * the one just inside the "roomy" branch.
 *
 * Nobody read it as a squeeze, because every line in that column truncates and
 * a truncating line loses characters silently while keeping its height. Every
 * line but one: the staff `note` wrapped instead, and turned a 64px row into a
 * 313px tower of one or two words per line. That is what got screenshotted.
 *
 * So the two invariants below are the two halves of that failure, and they are
 * checked as ARITHMETIC and as SHAPE rather than by asserting the current
 * class strings back at themselves — a test that only says "@4xl appears here"
 * would pass just as happily on a row whose columns had grown past the width
 * again.
 */

const ROW = readFileSync(
  join(process.cwd(), "src/components/client-agents/roster-row.tsx"),
  "utf8",
);

/** Tailwind v4 container-query breakpoints, in px. */
const CONTAINER_BREAKPOINT: Record<string, number> = {
  "@xl": 576,
  "@2xl": 672,
  "@3xl": 768,
  "@4xl": 896,
  "@5xl": 1024,
  "@6xl": 1152,
};

/** Tailwind spacing scale for the `w-*` utilities this row uses, in px. */
const W = (n: number) => n * 4;

/**
 * The identity column is the row's REASON. Below this it stops holding a name
 * plus a readable stretch of blurb, which is the whole comparison the roster
 * exists to support. Measured: at 896px it gets 262px, at 672px it got 38px.
 */
const MIN_IDENTITY_COLUMN = 200;

describe("roster row: the identity column is never starved by its own furniture", () => {
  it("switches to five columns only at a width that still leaves the name room", () => {
    // The breakpoint the desktop columns gate on, read off the row rather than
    // assumed: every one of them is `hidden <bp>:block`.
    const gates = [...ROW.matchAll(/hidden [^"]*?(@\d?x?l|@\dxl):(?:block|flex)/g)].map(
      (m) => m[1],
    );
    expect(gates.length).toBeGreaterThanOrEqual(4);
    expect(new Set(gates).size, `the desktop columns disagree on their breakpoint: ${gates}`).toBe(
      1,
    );

    const bp = CONTAINER_BREAKPOINT[gates[0]!];
    expect(bp, `unknown container breakpoint ${gates[0]}`).toBeDefined();

    // What the row owes everything that is NOT the identity column, at that
    // width. The three fixed columns are declared; the rest are measured
    // constants from the rendered row, named so a future change to any of them
    // shows up here as a number rather than as a screenshot.
    const lastMade = W(36); // `w-36`, widening to w-48 only further up
    const next = W(20); // `w-20`
    const verbCol = W(28); // `w-28`
    const badge = 128; // "Runs on request", the widest status word
    const mark = 36; // AgentIdentity size="sm"
    const chevron = 16;
    const gaps = 6 * 16; // gap-4 between seven children
    const padding = 2 * 16; // px-4

    const furniture = lastMade + next + verbCol + badge + mark + chevron + gaps + padding;
    expect(
      bp! - furniture,
      `at ${bp}px the five-column layout leaves the identity column ${bp! - furniture}px`,
    ).toBeGreaterThanOrEqual(MIN_IDENTITY_COLUMN);
  });

  it("hands over between the two layouts at one width, so neither doubles nor gaps", () => {
    // The compact fallback hides at the same breakpoint the columns appear at.
    // If these ever drift apart there is a band showing both the inline badge
    // and the badge column, or one showing neither the meta line nor the
    // columns — the row would lose its status word entirely.
    const shown = [...ROW.matchAll(/hidden [^"]*?(@\dxl):(?:block|flex)/g)].map((m) => m[1]);
    const hidden = [...ROW.matchAll(/(@\dxl):hidden/g)].map((m) => m[1]);
    expect(hidden.length).toBeGreaterThanOrEqual(2);
    expect(new Set([...shown, ...hidden]).size).toBe(1);
  });
});

describe("roster row: every line in the identity column has a ceiling", () => {
  it("clamps or truncates each of them", () => {
    // The column, from `min-w-0 flex-1` to the badge column that follows it.
    const start = ROW.indexOf('<div className="min-w-0 flex-1">');
    const end = ROW.indexOf('<span className="hidden', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const column = ROW.slice(start, end);

    const paragraphs = [...column.matchAll(/<p className="([^"]*)"/g)].map((m) => m[1]!);
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);

    const unbounded = paragraphs.filter(
      (cls) => !cls.includes("truncate") && !cls.includes("line-clamp-"),
    );
    expect(
      unbounded,
      "a line here with no ceiling sets the row's height: it is the only flexible column, " +
        "so a long server-composed sentence wraps into a tower instead of losing characters",
    ).toEqual([]);
  });

  it("gives the clamped staff note a way back to the text it hides", () => {
    // Both writers join their parts with a middot — `rosterStatus` can carry
    // two sentences at once and `client-roster` appends the queue fact and the
    // legacy-schedule fact after them — so a worst-case note is around 400
    // characters and two lines genuinely cannot hold it. The part the clamp
    // eats is the LEGACY-SCHEDULE warning, which is the one an operator is
    // least likely to already know, so it may not be lost outright.
    const note = ROW.match(/<p className="[^"]*line-clamp-2[^"]*"([^>]*)>/);
    expect(note, "the staff note is no longer clamped").not.toBeNull();
    expect(note![1]).toContain("title={note}");
  });
});
