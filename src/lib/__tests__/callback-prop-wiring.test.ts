import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isStringDelimiter, matchingBrace, skipStringLiteral } from "./source-scan";

/**
 * A DECLARED CALLBACK PROP THAT NOTHING PASSES.
 *
 * `QuickAddTaskBar` declared `onAdded` — "fired after a task is successfully
 * added" — and called it with the owner a MODEL had just routed the task to, so
 * the board could follow. The single mount passed only `clientId`, and a
 * repo-wide grep found no other caller: the prop was dead in every render. The
 * board therefore stayed on whichever tab it was on, and a task routed to
 * karos_managed while the client sat on "Depending on you" was announced by name
 * (`Added "<title>"`) and rendered nowhere.
 *
 * `onAdded` itself is gone now — `QuickAddTaskBar` was deleted with the
 * Workspace board (2026-08), the only surface that ever rendered it. The
 * anti-vacuity checks below anchor on `onNavigate` instead (notification-bell.tsx
 * and its mounts), a currently-live optional callback with real, non-forwarding
 * callers — the finding this file exists to catch is about the SHAPE of a dead
 * channel, not about this one prop's name.
 *
 * That is this campaign's "a predicate that exists is not a predicate that is
 * asked", one layer up: a channel that exists is not a channel that is wired.
 *
 * DERIVED FROM THE SOURCE, not from a list of prop names. The scan reads what is
 * declared and what is passed, so a prop added tomorrow is covered on the day it
 * is written, and a name removed from the tree stops being checked without
 * anybody editing this file.
 *
 * THE EXEMPTION IS MECHANICAL AND IT IS THE COMPILER. Only OPTIONAL props are
 * scanned (`onX?:`). A required `onX:` cannot be silently omitted — every JSX
 * mount that leaves it out fails `tsc --noEmit`, which runs in this repo's own
 * checks — so tsc is already a stricter guard than this file could be. Make a
 * dead prop required and it stops being reported here because it has stopped
 * being possible.
 */

const REPO = path.resolve(__dirname, "../..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      // This directory is where the scan lives, not where the app does.
      if (entry === "__tests__" || entry === "node_modules") continue;
      sourceFiles(p, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(path.relative(REPO, p).split(path.sep).join("/"));
    }
  }
  return out;
}

const files = sourceFiles(path.join(REPO, "src"));
const sources = new Map(files.map((rel) => [rel, readFileSync(path.join(REPO, rel), "utf8")]));

/**
 * An optional callback prop declaration: a member named `onSomething?` whose type
 * is a function.
 *
 * The type is read to the end of the declaration — the next `;` or `,` at the
 * top level of the member, or the end of the line if the member has neither —
 * with string literals skipped whole so a `;` inside one cannot end it early.
 * Anything holding `=>` counts as a callback, which is deliberately generous:
 * over-reading here means MORE props are checked, which is the fail-closed
 * direction for a guard whose failure mode is missing a dead one.
 */
function declaredOptionalCallbacks(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(on[A-Z]\w*)\?\s*:/g)) {
    const name = m[1]!;
    let depth = 0;
    let i = m.index! + m[0].length;
    let type = "";
    for (; i < src.length; i++) {
      const ch = src[i]!;
      if (isStringDelimiter(ch)) {
        const end = skipStringLiteral(src, i);
        type += src.slice(i, end + 1);
        i = end;
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[" || ch === "<") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (ch === ">" && src[i - 1] !== "=") depth--;
      else if (depth === 0 && (ch === ";" || ch === "," || ch === "\n")) break;
      type += ch;
    }
    if (type.includes("=>")) out.push(name);
  }
  return out;
}

/**
 * Does any file hand this prop to a component?
 *
 * A JSX attribute is the only way an optional prop reaches a component, and it is
 * always spelled `name={…}`. An IDENTITY FORWARD does not count: `onX={onX}` is a
 * component passing along a prop it was itself given, so if nothing supplies the
 * outer one the inner is just as dead. Counting a forward as a caller is how a
 * pass-through chain would report green with nothing at the top of it.
 */
function passSites(name: string): string[] {
  const attribute = new RegExp(String.raw`(^|[\s{])${name}\s*=\s*\{`, "g");
  const identityForward = new RegExp(String.raw`^\{\s*${name}\s*\}$`);
  const out: string[] = [];
  for (const [rel, src] of sources) {
    for (const m of src.matchAll(attribute)) {
      const open = src.indexOf("{", m.index! + m[0].length - 1);
      const close = matchingBrace(src, open);
      if (close < 0) continue;
      const value = src.slice(open, close + 1).replace(/\s+/g, " ");
      if (identityForward.test(value)) continue;
      out.push(`${rel} → ${value.slice(0, 60)}`);
    }
  }
  return out;
}

const declared = [...new Set(files.flatMap((rel) => declaredOptionalCallbacks(sources.get(rel)!)))];

describe("every declared optional callback prop has a caller", () => {
  it("finds the declarations at all", () => {
    // Anti-vacuity: a scan that reads nothing passes for the wrong reason.
    expect(declared).toContain("onNavigate");
    expect(declared.length).toBeGreaterThan(1);
  });

  it("reports nothing dead", () => {
    const dead = declared.filter((name) => passSites(name).length === 0);
    expect(dead).toEqual([]);
  });

  it("does not count a pass-through forward as the caller", () => {
    // The tightening that makes the check above mean something: if the only
    // `onNavigate={…}` in the tree were a forward of an `onNavigate` the
    // forwarding component was never given, nothing would supply it.
    expect(passSites("onNavigate").length).toBeGreaterThan(0);
    expect(passSites("onNavigate").every((site) => !/→ \{ onNavigate \}$/.test(site))).toBe(true);
  });

  it("scans only the optional half, because tsc owns the required half", () => {
    // The mechanical exemption, asserted rather than described: a REQUIRED
    // callback prop is absent from this set even when it exists in the tree.
    // TaskTicketModal's `onDelete` is required precisely so that the compiler,
    // not this file, is what forces every mount to hand it over.
    const ticket = sources.get("src/components/task-ticket-modal.tsx")!;
    expect(ticket).toContain("onDelete: () => void");
    expect(declared).not.toContain("onDelete");
  });
});
