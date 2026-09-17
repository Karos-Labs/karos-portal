import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALL_INTAKE_FEEDBACK_FAMILIES,
  intakeFeedbackFieldId,
  intakeFeedbackPlaceholder,
} from "@/lib/intake-feedback-copy";
import { matchingBrace, stripComments } from "./source-scan";

/**
 * SCRUM-412: the intake forms may not each keep their own copy of a shared
 * section.
 *
 * THE DEFECT. `x-agent-intake.tsx` was not the LinkedIn component with
 * different props; it was a separate copy that had already drifted. Measured
 * before the fix, the two files declared six functions under the SAME name, and
 * three of those pairs were the same code written twice:
 *
 *   RequiredMark   3 lines each, byte identical
 *   fieldError     3 lines each, byte identical
 *   FeedbackBox  135 lines each, differing in FOUR places: the view types
 *                (themselves byte identical), the action, the DOM id prefix,
 *                and one placeholder sentence
 *
 * `fieldError` was in fact declared SIX times, once per intake family, and the
 * six did not agree: linkedin/reddit/x painted the error `text-danger` and
 * blog/newsletter/reputation painted it `text-red-400`. `--danger` is themed
 * (globals.css defines it twice, light and dark); `red-400` is a fixed palette
 * colour. So half the intake forms printed validation errors in a colour that
 * ignored the theme, and nobody could have seen it by reading one file.
 *
 * WHY A SOURCE SWEEP AND NOT A LIST. A list of the six files it was fixed in
 * says nothing about the seventh. The file set here is DERIVED - every
 * `*-agent-intake.tsx` under `src/components` - so a new intake family is swept
 * the day it is added, and the floor below fails if that glob ever finds fewer
 * files than the families that exist.
 *
 * WHAT IT DOES NOT CLAIM. `CompanyForm`, `SeatCard` and `AddSeatForm` are still
 * declared in both files under the same names, ON PURPOSE, and this file
 * deliberately does not forbid that. They are different components that share a
 * title: LinkedIn's `CompanyForm` fires the one-time stand-up run on first save
 * and takes a URL suggestion off the client profile, X's holds the engagement
 * roster, the Premium tri-state and a one-shot announcements drop. Merging them
 * would make one component with two disjoint halves. The residual is written
 * down rather than guarded, because a guard here would be a claim that they
 * OUGHT to be one thing, and they ought not.
 */

const COMPONENTS = path.resolve(__dirname, "../..", "components");

/** Every intake family's own component, by glob rather than by list. */
const INTAKE_FILES = readdirSync(COMPONENTS)
  .filter((f) => f.endsWith("-agent-intake.tsx"))
  .sort();

const code = (rel: string) =>
  stripComments(readFileSync(path.join(COMPONENTS, rel), "utf8"));

const SOURCES = INTAKE_FILES.map((f) => ({ file: f, src: code(f) }));

/* ───────────────────────────── the floor ───────────────────────────── */

describe("the sweep can fail", () => {
  it("found every intake family's component", () => {
    // The six families of IntakeFamily in agent-intake-links.ts. A seventh
    // family with no component here would break this, which is the point.
    expect(INTAKE_FILES).toEqual([
      "blog-agent-intake.tsx",
      "linkedin-agent-intake.tsx",
      "newsletter-agent-intake.tsx",
      "reddit-agent-intake.tsx",
      "reputation-agent-intake.tsx",
      "x-agent-intake.tsx",
    ]);
  });

  it("read real component source, not empty strings", () => {
    for (const { file, src } of SOURCES) {
      expect(src.length, file).toBeGreaterThan(2_000);
      expect(src, file).toContain("export function");
    }
  });
});

/* ───────────────────── one declaration, many readers ───────────────────── */

describe("the shared field bits", () => {
  it("are declared nowhere but the shared module", () => {
    const offenders = SOURCES.filter(
      ({ src }) => /\bfunction (RequiredMark|fieldError)\b/.test(src),
    ).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("are imported by every intake file that shows a validation error", () => {
    for (const { file, src } of SOURCES) {
      if (!src.includes("fieldError(")) continue;
      expect(src, file).toContain('from "@/components/intake-field"');
    }
  });

  it("leaves no intake form painting its errors in an unthemed colour", () => {
    // The whole reason the six copies mattered. `text-danger` follows the
    // theme; `text-red-400` is a fixed palette value that does not.
    for (const { file, src } of SOURCES) {
      expect(src, file).not.toContain("text-red-400");
    }
    const shared = stripComments(
      readFileSync(path.join(COMPONENTS, "intake-field.tsx"), "utf8"),
    );
    expect(shared).toContain("text-danger");
    expect(shared).not.toContain("text-red-400");
  });
});

describe("the feedback box", () => {
  it("is declared by nobody who mounts it, and by exactly the two who do not", () => {
    // THE RESIDUAL, WRITTEN DOWN rather than claimed closed. Five files
    // declared a `FeedbackBox`. Two of them - LinkedIn and X - were the same
    // 135-line component written twice, and those two are what moved. The
    // remaining two are DIFFERENT components that share a name: newsletter's
    // and Reddit's file one note against the whole program, so neither has the
    // "This is about" account picker that made the LinkedIn/X pair one thing,
    // and each carries its own approval sentence in its own vocabulary ("an
    // issue", "the replies") that the shared box does not spell.
    //
    // Folding them in would mean an optional picker and a third register row
    // for copy that is already correct where it lives. So this test pins the
    // split by NAME: nobody who mounts the shared box may also declare one, and
    // if newsletter or Reddit ever grows an account picker the next test fails
    // and says to come here.
    const declares = SOURCES.filter(({ src }) => /\bfunction FeedbackBox\b/.test(src)).map(
      ({ file }) => file,
    );
    expect(declares).toEqual([
      "newsletter-agent-intake.tsx",
      "reddit-agent-intake.tsx",
    ]);
    for (const { file, src } of SOURCES) {
      if (!src.includes("<IntakeFeedbackBox")) continue;
      expect(src, `${file} both mounts the shared box and declares its own`).not.toMatch(
        /\bfunction FeedbackBox\b/,
      );
    }
  });

  it("is what a single-account surface would have to become, and neither has", () => {
    // The one difference that decides whether a surface belongs in the shared
    // box: does the note get filed against a CHOSEN account, or against the
    // whole program. An account picker appearing in either of these two means
    // the components have converged and the fold is now the smaller change.
    //
    // Read the FeedbackBox BODY, not the file. Reddit's own AccountForm holds a
    // `setAccountHistory` - a different concept, a different card - and a
    // file-wide substring match reported that as a picker.
    const bodies = SOURCES.filter(({ src }) => /\bfunction FeedbackBox\b/.test(src)).map(
      ({ file, src }) => {
        const open = src.indexOf("function FeedbackBox");
        const brace = matchingBrace(src, src.indexOf("{", src.indexOf(") {", open)));
        return { file, body: src.slice(open, brace + 1) };
      },
    );
    expect(bodies).toHaveLength(2);
    for (const { file, body } of bodies) {
      expect(body.length, file).toBeGreaterThan(1_000); // the slice found the whole box
      expect(body, `${file} grew an account picker - fold it into IntakeFeedbackBox`).not.toMatch(
        /setAccount\b/,
      );
      // And it must still be filing a note, or this test says nothing.
      expect(body, file).toMatch(/action: "note"/);
    }
  });

  it("is mounted by exactly the families the copy register answers for", () => {
    const mounting = SOURCES.filter(({ src }) => src.includes("<IntakeFeedbackBox")).map(
      ({ file }) => file.replace("-agent-intake.tsx", ""),
    );
    expect(mounting.sort()).toEqual([...ALL_INTAKE_FEEDBACK_FAMILIES].sort());
  });

  it("gets its family from the prop, so neither mount can pick the other's copy", () => {
    for (const { file, src } of SOURCES) {
      if (!src.includes("<IntakeFeedbackBox")) continue;
      const family = file.replace("-agent-intake.tsx", "");
      expect(src, file).toContain(`family="${family}"`);
    }
  });

  it("hand-spells no field id, so htmlFor and id cannot drift apart", () => {
    // They used to be `lf-account` and `xf-account`, in files that shared
    // nothing, so a third mount would have had to invent a third prefix.
    for (const { file, src } of SOURCES) {
      expect(src, file).not.toMatch(/["'][a-z]f-account["']/);
    }
  });
});

/* ─────────────────────────── the copy register ─────────────────────────── */

describe("the feedback placeholder register", () => {
  it("answers for both families and gives each its own sentence", () => {
    expect([...ALL_INTAKE_FEEDBACK_FAMILIES].sort()).toEqual(["linkedin", "x"]);
    const said = ALL_INTAKE_FEEDBACK_FAMILIES.map(intakeFeedbackPlaceholder);
    expect(new Set(said).size).toBe(said.length);
    for (const s of said) expect(s.length).toBeGreaterThan(40);
  });

  it("prompts each channel about ITS failure mode, which is why it is a table", () => {
    // A table with two identical rows would be a copy of one string. These two
    // differ in the one word that makes the prompt useful.
    expect(intakeFeedbackPlaceholder("linkedin")).toContain("Too corporate?");
    expect(intakeFeedbackPlaceholder("x")).toContain("Too salesy?");
    expect(intakeFeedbackPlaceholder("linkedin")).not.toContain("Too salesy?");
    expect(intakeFeedbackPlaceholder("x")).not.toContain("Too corporate?");
  });

  it("reads as client copy: no em dash, no spaced hyphen", () => {
    // The recorded product-owner ruling, enforced repo-wide by
    // client-copy-boundary.test.ts. Asked here too because this register is the
    // one place these two sentences now live.
    for (const s of ALL_INTAKE_FEEDBACK_FAMILIES.map(intakeFeedbackPlaceholder)) {
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/ - /);
    }
  });

  it("builds a field id that is unique per family and stable per field", () => {
    const ids = ALL_INTAKE_FEEDBACK_FAMILIES.map((f) => intakeFeedbackFieldId(f, "account"));
    expect(new Set(ids).size).toBe(ids.length);
    expect(intakeFeedbackFieldId("x", "account")).toBe(
      intakeFeedbackFieldId("x", "account"),
    );
    for (const id of ids) expect(id).toMatch(/^[a-z]+-feedback-account$/);
  });
});
