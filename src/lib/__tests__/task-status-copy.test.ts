import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { icons } from "lucide-react";
import { describe, expect, it } from "vitest";

import {
  TASK_RUNNING_LABEL,
  TASK_STATUS_LABEL,
  taskIsExecuting,
  taskStatusLabel,
} from "@/lib/task-status-copy";
import type { TaskStatus } from "@/lib/types";
import { isStringDelimiter, matchingBrace, skipStringLiteral, stripComments } from "./source-scan";

/**
 * ONE REGISTER FOR A TASK STATE, and nowhere else to write a second.
 *
 * WHAT WENT WRONG. `in_progress` was named three times on one screen. The board
 * card's badge said "Running Agent" (`STATUS_META`), the column heading over that
 * card and the ticket modal's header both said "In Progress" (`BOARD_COLUMNS` and
 * `STATUS_LABEL`), and the status filter between them re-typed all four words a
 * third time as hand-written `<option>` text. The badge was also FALSE: it is
 * painted from `task.status` alone, so it fired on the board's "Depending on you"
 * tab, where every row is `client_managed` work no agent will ever touch.
 *
 * FOUR CLAIMS, and they are four because one of them alone is satisfiable by
 * cheating:
 *
 *  1. The register says what it says — pinned by value, so changing a rendered
 *     word is a deliberate act.
 *  2. "An agent is running" hangs off `metadata.executing` and nothing else, so
 *     no status can imply it.
 *  3. No OTHER file in src/ writes a second task-status vocabulary. Swept by
 *     shape from the filesystem, per object literal.
 *  4. The four sites that print a state word ask the register, pinned AT THE
 *     CALL — because "the file imports the module" is satisfied by an import line
 *     for ever.
 *
 * The neighbours, not the overlap: `asset-status-registers.test.ts` asks the same
 * question of the ASSET status words and `status-render-sweep.test.ts` of what
 * gets rendered raw. Neither covers `TaskStatus` — its five members share no word
 * with either union, so a task status is "another domain" to both, correctly and
 * silently. This file is that domain's own.
 */

const SRC = join(process.cwd(), "src");
const HOME = join(SRC, "lib", "task-status-copy.ts");

/** `relative(SRC, …)`, normalized to forward slashes so literals stay portable. */
function relToSrc(file: string): string {
  return relative(SRC, file).split(sep).join("/");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).filter((f) => !f.includes("__tests__"));

/**
 * Comment-free source, through the SHARED strip.
 *
 * Not a local `.replace(/\/\/.*$/gm, "")`: that one reads `//` as a comment
 * opener inside a string too, so a template literal holding a URL is truncated
 * and loses its closing backtick — the stray that `skipStringLiteral` cannot
 * bound to a line, which then mis-pairs every literal below it and makes the
 * brace walks in this file read bogus ranges. `stripComments` skips literals
 * whole, so it cannot manufacture that.
 */
function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/** Whitespace-collapsed, for the call pins. */
function flat(src: string): string {
  return src.replace(/\s+/g, " ");
}

/* ─────────────── claim 1: the register, pinned by value ──────────────── */

describe("the task-status register", () => {
  it("reads in the house's sentence case, and says what the state is", () => {
    // THIS TEST WAS NAMED "still reads exactly as the two maps it replaced did",
    // and that premise stopped being true the moment the words were corrected —
    // which is the shape this campaign has now shipped twice, so the name went
    // with the words.
    //
    // The lift itself WAS byte-preserving, and that was the right call at the
    // time: a file move and a copy change in one diff is a copy change nobody
    // reviewed. Two of the five words it faithfully preserved were wrong —
    // "In Progress" and "Review Pending" are Title Case against house rule 10,
    // and "Review Pending" is the stored enum `review_pending` word-split rather
    // than a phrase anyone would write. Corrected here, deliberately and on its
    // own, with the pin kept so the next change is also a decision.
    expect(TASK_STATUS_LABEL).toEqual({
      pending: "Pending",
      in_progress: "In progress",
      review_pending: "In review",
      completed: "Done",
      archived: "Archived",
    });
  });

  it("prints no stored enum, and no word split out of one", () => {
    // The closed question behind the two corrections, asked of the whole union
    // rather than of the two that were wrong.
    //
    // WHAT IS NOT ASSERTED, because it is not mechanically decidable: "is this
    // phrase one a person would write, or the enum with its underscores taken
    // out". `in_progress` → "In progress" is BOTH, and correct; `review_pending`
    // → "Review pending" is both, and wrong ("In review" is what a person
    // writes). A check for that shape fails on the first, which is the other way
    // a guard is useless. What IS decidable — no stored value rendered, no
    // underscore, and sentence case — catches both defects that were here.
    for (const [key, label] of Object.entries(TASK_STATUS_LABEL)) {
      expect(label, `${key} is rendered as its own stored value`).not.toBe(key);
      expect(label, `${key} carries an underscore`).not.toMatch(/_/);
      // SENTENCE CASE — house rule 10, and the half of this that IS mechanical.
      // Both defects here were Title Case ("In Progress", "Review Pending").
      expect(label, `${key} is Title Case`).not.toMatch(/\s[A-Z]/);
    }
  });

  it("names every state the type allows, and never with its own enum", () => {
    // `TASK_STATUS_LABEL` is a Record over `TaskStatus`, which tsc keeps total —
    // so reading its keys IS the union, and this checks the words rather than
    // re-listing the keys.
    for (const status of Object.keys(TASK_STATUS_LABEL) as TaskStatus[]) {
      const label = taskStatusLabel(status);
      expect(label, `${status} has no word`).toBeTruthy();
      expect(label, `${status} prints its own enum`).not.toBe(status);
      expect(label).toMatch(/^[A-Z]/);
    }
  });

  it("has no register word that claims an agent is running", () => {
    // THE DEFECT ITSELF. `in_progress` is where a task sits while it waits to be
    // run, while it runs, and on the client tab while a PERSON does it — so no
    // word for that state may name an agent. Asked of every entry rather than of
    // the one that was wrong, because the next copy will be in another.
    for (const [status, label] of Object.entries(TASK_STATUS_LABEL)) {
      expect(label, `${status} claims a run`).not.toMatch(/agent|\bAI\b|running/i);
    }
    // And the exact string that was there, so a revert is caught by name too.
    expect(Object.values(TASK_STATUS_LABEL)).not.toContain("Running Agent");
  });
});

/* ────── claim 2: the running claim hangs off the flag, not the status ───── */

describe("'an agent is running' is asked of the flag", () => {
  it("answers from the flag alone, and only when it is exactly true", () => {
    // Both directions on the state that used to imply it. A task parked in
    // `in_progress` with nothing dispatched is the "Depending on you" row that
    // was being told an agent had it.
    expect(taskIsExecuting({ metadata: { executing: true } })).toBe(true);
    expect(taskIsExecuting({ metadata: { executing: false } })).toBe(false);
    expect(taskIsExecuting({ metadata: {} })).toBe(false);
    expect(taskIsExecuting({})).toBe(false);
    // Strictly `true`: the field is `Record<string, unknown>`, so a truthy
    // non-boolean must not arm a claim about a live run.
    expect(taskIsExecuting({ metadata: { executing: "yes" } })).toBe(false);
  });

  it("gives the running claim one wording, and no state name may read like it", () => {
    // Written twice before — "Agent running" on the card chip, "AI Working…" in
    // the ticket header — for one fact, on two surfaces a client moves between
    // with one click.
    expect(TASK_RUNNING_LABEL).toBe("Agent running");
    // It is not one of the state names, which is the other half: a state and a
    // live run are different things and must not read alike.
    expect(Object.values(TASK_STATUS_LABEL)).not.toContain(TASK_RUNNING_LABEL);
  });

  it("leaves no rendering surface reading the flag for itself", () => {
    // SCOPE, MEASURED, because "one read in the repo" would be false and a test
    // named for a false premise is worse than no test. Eight modules read
    // `metadata.executing`: the two status guards in lib/actions, the credit
    // reconciler, the Firestore claim query, data.ts's two dispatch guards,
    // task-sync's stuck-run test and task-outcome-copy's `ranWithoutDeliverable`.
    // Every one of them GATES A WRITE or answers a different question; none of
    // them puts a word on a screen.
    //
    // What this closes is the half where the defect lived: a component or a route
    // deciding for itself whether to paint the running claim. Under components/
    // and app/ the only way to ask is `taskIsExecuting`.
    const readers = FILES.filter(
      (f) => f.startsWith(join(SRC, "components")) || f.startsWith(join(SRC, "app")),
    )
      .filter((f) => /\.executing\b/.test(code(f)))
      .map((f) => relToSrc(f));
    expect(
      readers,
      "these read the executing flag at a render surface; ask taskIsExecuting",
    ).toEqual([]);

    // Non-vacuity for that negative: the walk really covers those trees.
    const rendered = FILES.filter(
      (f) => f.startsWith(join(SRC, "components")) || f.startsWith(join(SRC, "app")),
    );
    expect(rendered.length, "the walk found no components or routes at all").toBeGreaterThan(50);
  });
});

/* ─────────── claim 3: no second task-status vocabulary in src/ ─────────── */

const TASK_STATUS_KEYS = new Set(Object.keys(TASK_STATUS_LABEL));

/**
 * A value that is not a WORD FOR A READER.
 *
 * Four closed questions, and each one is closed rather than a guess at what a
 * label looks like — the heuristic asset-status-registers.test.ts had to abandon
 * when a lowercase label map walked past a "starts with a capital" rule:
 *
 *  · a CSS variable or a hex colour;
 *  · a class fragment — lowercase/punctuation with a hyphen or slash in it,
 *    which is every `bg-neon` / `bg-muted-2` the board's dot map holds;
 *  · a LUCIDE ICON NAME, asked of lucide's own export rather than of a list here.
 *    The ticket's `STATUS_ICON` and the board columns really do key glyphs by
 *    status, deliberately (they disagree on `in_progress`), and "Circle" is
 *    indistinguishable from a one-word label by shape alone;
 *  · a TASK STATUS. A map from status to status is a state machine
 *    (`STATUS_NEXT`), not a vocabulary. Rendering that value WOULD be a defect,
 *    and it is `status-render-sweep.test.ts`'s question — printing a stored enum
 *    — not this file's.
 */
const ICON_NAMES = new Set(Object.keys(icons));

function isLabelForAReader(s: string): boolean {
  if (s === "") return false;
  if (/^var\(--/.test(s)) return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return false;
  if (/[-/]/.test(s) && /^[a-z0-9:[\]/_.-]+$/.test(s)) return false;
  if (ICON_NAMES.has(s)) return false;
  if (TASK_STATUS_KEYS.has(s)) return false;
  return true;
}

/** Every string literal inside a slice of source, nested ones included. */
function stringsIn(body: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (!isStringDelimiter(body[i]!)) continue;
    const end = skipStringLiteral(body, i);
    if (end > i) {
      out.push(body.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

const KEY_AT = /(?:["'])?(pending|in_progress|review_pending|completed|archived)(?:["'])?\s*:/y;

/**
 * Per object literal, the task-status keys written at THAT literal's own level
 * whose value carries a word.
 *
 * PER LITERAL, not per file, and that distinction is load-bearing rather than
 * tidy: counting across a whole file is how this directory's other sweep turned
 * two unrelated one-branch expressions into a "vocabulary", and it is how
 * `constants.ts` — whose `ACTION_ITEM_STATUS_LABELS` is a DIFFERENT key domain
 * that happens to contain `in_progress` — would collide with anything else in
 * the same file. Attribution to the enclosing braces is what makes the
 * two-key threshold below safe without an allowlist of file paths.
 *
 * Nested literals get their own frame, so `{ in_progress: { label: "x" } }`
 * records `in_progress` on the OUTER frame (its value's strings are read whole)
 * and an empty inner frame — which is the shape `STATUS_META` was written in.
 */
function taskStatusKeyedLiterals(src: string): Array<Map<string, string[]>> {
  const out: Array<Map<string, string[]>> = [];
  const stack: Array<Map<string, string[]>> = [];
  // A property name may only start after one of these, so a `pending:` inside a
  // ternary or a type position is not read as a key.
  let atPropertyStart = true;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;

    if (isStringDelimiter(ch)) {
      const end = skipStringLiteral(src, i);
      if (end > i && !atPropertyStart) {
        i = end;
        continue;
      }
      // A quoted KEY falls through to the matcher below.
    }

    if (ch === "{") {
      stack.push(new Map());
      atPropertyStart = true;
      continue;
    }
    if (ch === "}") {
      const frame = stack.pop();
      if (frame) out.push(frame);
      atPropertyStart = true;
      continue;
    }
    if (/\s/.test(ch)) continue;
    if (ch === "," || ch === ";") {
      atPropertyStart = true;
      continue;
    }

    if (atPropertyStart && stack.length > 0) {
      KEY_AT.lastIndex = i;
      const m = KEY_AT.exec(src);
      if (m) {
        const key = m[1]!;
        let v = KEY_AT.lastIndex;
        while (v < src.length && /\s/.test(src[v]!)) v++;
        let values: string[] = [];
        if (isStringDelimiter(src[v]!)) {
          const end = skipStringLiteral(src, v);
          if (end > v) values = [src.slice(v + 1, end)];
        } else if (src[v] === "{") {
          const close = matchingBrace(src, v);
          if (close > v) values = stringsIn(src.slice(v, close + 1));
        }
        const words = values.filter(isLabelForAReader);
        if (words.length > 0) {
          const frame = stack[stack.length - 1]!;
          frame.set(key, [...(frame.get(key) ?? []), ...words]);
        }
        i = KEY_AT.lastIndex - 1;
        atPropertyStart = false;
        continue;
      }
    }

    atPropertyStart = false;
  }

  return out;
}

/**
 * TWO keys, not three.
 *
 * The asset sweep needs three because `approved` and `delivered` are words in two
 * unions at once, so a pair proves nothing. `TaskStatus` shares no member with
 * any other status union in this repo, and it only has five — a
 * `{ in_progress: …, completed: … }` pair is already a second vocabulary and
 * already enough to disagree with the register.
 */
function isSecondVocabulary(frame: Map<string, string[]>): boolean {
  return frame.size >= 2;
}

function flagged(src: string): boolean {
  return taskStatusKeyedLiterals(stripComments(src)).some(isSecondVocabulary);
}

describe("the task-status vocabulary is written once", () => {
  it("is the only task-status label map in src/", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file === HOME) continue;
      for (const frame of taskStatusKeyedLiterals(code(file))) {
        if (isSecondVocabulary(frame)) {
          offenders.push(`${relToSrc(file)} → { ${[...frame.keys()].join(", ")} }`);
        }
      }
    }
    expect(
      offenders,
      "these are a second task vocabulary; ask taskStatusLabel instead",
    ).toEqual([]);
  });

  it("catches the map that was really there, and the revert of the fix", () => {
    // Teeth, checked rather than trusted. The first two are `STATUS_META` and
    // `BOARD_COLUMNS`-as-a-map, verbatim in shape.
    expect(
      flagged(`const M: Record<BoardStatus, { label: string; dot: string }> = {
        pending: { label: "Pending", dot: "bg-muted-2" },
        in_progress: { label: "Running Agent", dot: "bg-neon" },
        completed: { label: "Done", dot: "bg-success" },
      };`),
    ).toBe(true);
    expect(
      flagged(`const L = { pending: "Pending", in_progress: "In Progress", completed: "Done" };`),
    ).toBe(true);
    // A pair is enough, and a lowercase pair too — the case a "starts with a
    // capital" rule waved through in the asset suite.
    expect(flagged(`const L = { in_progress: "working on it", completed: "all done" };`)).toBe(true);
    expect(flagged(`const L = { in_progress: "Running", completed: "Finished" };`)).toBe(true);

    // What must stay legal, and every one of these is live code in the two files
    // this fix touched.
    // The dot map that stayed with the board.
    expect(
      flagged(`const D: Record<BoardStatus, string> = {
        pending: "bg-muted-2", in_progress: "bg-neon", completed: "bg-success" };`),
    ).toBe(false);
    // The two icon maps, which deliberately disagree and are presentation.
    expect(
      flagged(`const I = { pending: "Circle", in_progress: "Clock", completed: "CircleCheck" };`),
    ).toBe(false);
    expect(
      flagged(`const I = { pending: "Circle", in_progress: "CirclePlay", completed: "CircleCheck" };`),
    ).toBe(false);
    // The state machine: status to status is not a vocabulary.
    expect(
      flagged(`const N = { pending: "in_progress", in_progress: "review_pending", completed: "pending" };`),
    ).toBe(false);
    // A bucket of tasks keyed by column — no strings at all.
    expect(flagged(`const map = { pending: [], in_progress: [], completed: [] };`)).toBe(false);
    // One key is a sentence, not a vocabulary — and it is what spares
    // constants.ts's ACTION_ITEM_STATUS_LABELS, a different key domain that
    // happens to hold `in_progress`.
    expect(
      flagged(`const A = { open: "Open", in_progress: "In Progress", in_review: "In Review", done: "Done" };`),
    ).toBe(false);
  });

  it("attributes keys to their own literal, so two unrelated maps do not add up", () => {
    // The per-file accumulation failure, planted. `ACTION_ITEM_STATUS_LABELS`
    // and a single-state bucket label live in the same tree today; if the count
    // were per file, one more colliding key anywhere in constants.ts would turn
    // this sweep red on legitimate code — and a sweep that cries wolf gets
    // widened, which is how a guard dies.
    expect(
      flagged(`const A = { open: "Open", in_progress: "In Progress", done: "Done" };
        const B = { active: "Active", completed: "Completed" };`),
    ).toBe(false);
    // Non-vacuity for that negative: put the two colliding keys in ONE literal
    // and it flags, so the answer above is the attribution working rather than
    // the scan having gone blind.
    expect(
      flagged(`const A = { open: "Open", in_progress: "In Progress", completed: "Done" };`),
    ).toBe(true);
  });

  it("still finds the register itself, so an empty offender list is not an empty walk", () => {
    // Liveness. If the walk, the strip or the key matcher breaks, every list
    // above empties and reads like success — so the scan must still see the one
    // literal that IS a task-status vocabulary, and must still see the tree.
    expect(FILES.length, "the walk found almost nothing; src/ moved").toBeGreaterThan(100);
    const home = taskStatusKeyedLiterals(code(HOME)).filter(isSecondVocabulary);
    expect(
      home.length,
      "the sweep cannot see the register itself, so it can see nothing",
    ).toBeGreaterThan(0);
    expect([...home[0]!.keys()].sort()).toEqual(
      [...Object.keys(TASK_STATUS_LABEL)].sort(),
    );
  });
});

/* ────────────── claim 4: the four print sites ask the register ────────── */

/**
 * The file that prints a state, read at MODULE scope rather than inside the
 * describe below. A throw in a describe body is collected as "(0 test)" and the
 * file disappears quietly; at module scope a moved file is a loud import error.
 *
 * This used to read TWO files — tasks-board.tsx alongside this one — and pin
 * its own STATUS_META/BOARD_COLUMNS assertions the same way. The board was
 * deleted 2026-08 (it was rendered only inside ProgressView, which lost its
 * own last renderer when the Workspace board's routes were removed), so those
 * board-specific assertions went with it. The ticket modal's own assertions
 * below are unaffected — the register it reads from is unchanged.
 */
const ticket = code(join(SRC, "components/task-ticket-modal.tsx"));

describe("the surfaces that print a task state", () => {

  it("hand-types no task-status <option> anywhere in src/", () => {
    // The third copy, by SHAPE and over the whole repo — the value of an
    // `<option>` is the mechanical part, so this catches the same list retyped
    // with different words, or somewhere else.
    // NORMALISED ON THE VALUE, not on one spelling of the attribute:
    // `value="x"`, `value={"x"}` and value={`x`} are the same defect, and a
    // guard that reads only the first teaches the next person to write the
    // second.
    const HAND_TYPED_OPTION =
      /<option[^>]*\bvalue=\{?\s*["'`](?:pending|in_progress|review_pending|completed|archived)["'`]/;
    const offenders = FILES.filter((file) => HAND_TYPED_OPTION.test(flat(code(file)))).map((file) =>
      relToSrc(file),
    );
    expect(offenders, "these hand-type a task status option; map the register").toEqual([]);
  });

  it("gives the ticket header the register's word and the shared running label", () => {
    const f = flat(ticket);
    expect(f, "the ticket keeps a status map of its own").not.toContain("STATUS_LABEL");
    // The header, gate and both branches pinned as ONE expression: a running
    // claim moved off the flag, or a second wording, fails this without needing
    // a second assertion for the same rule.
    expect(f, "the ticket header no longer reads the register or the shared label").toContain(
      "{isExecuting ? TASK_RUNNING_LABEL : taskStatusLabel(task.status)}",
    );
    // The footer's "Move to <next state>", which is the same vocabulary one
    // transition ahead.
    expect(f, "the footer names the next state itself").toContain(
      "Move to {taskStatusLabel(nextStatus)}",
    );
  });

  it("leaves neither of the two running wordings anywhere in src/", () => {
    // Swept repo-wide rather than pinned at the two sites, because the question
    // is whether a THIRD wording exists, and the next one will be in a file
    // nobody listed. "Running Agent" was the badge; "AI Working…" was the ticket.
    const offenders = FILES.filter((file) => {
      const src = code(file);
      return src.includes("Running Agent") || src.includes("AI Working");
    }).map((file) => relToSrc(file));
    expect(offenders, "a retired running wording is back").toEqual([]);

    // THE REMEDY THE DELETION COULD HAVE TAKEN WITH IT. Removing two wordings is
    // only a fix if a client is still told a run is under way — and on each of
    // those two surfaces the wording removed was the only thing saying so. So
    // both must still USE the shared constant, counted rather than merely
    // present: one occurrence is the import line, which every deleted render
    // would leave behind untouched.
    const painted = FILES.filter((file) => {
      if (file === HOME) return false;
      return [...code(file).matchAll(/\bTASK_RUNNING_LABEL\b/g)].length >= 2;
    }).map((file) => relToSrc(file));
    expect(
      painted.sort(),
      "the running claim is painted nowhere; the deletion took the remedy with it",
    ).toEqual(["components/task-ticket-modal.tsx"]);
  });
});
