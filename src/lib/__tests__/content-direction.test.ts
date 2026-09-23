import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * VERBATIM CONTENT MUST DECLARE ITS DIRECTION.
 *
 * This portal renders text its agents wrote, for clients who publish in
 * Hebrew. Until 2026-09-23 there was not one direction attribute anywhere in
 * `src/` and `<html lang="en">` was hardcoded, so every Hebrew deliverable was
 * laid out left-to-right: the punctuation lands at the wrong end, a mixed
 * Hebrew/Latin line reorders, and editing it put the caret in the wrong place.
 * The owner had already said so at a gate, in these words — "the text should
 * be rtl (right to left) like hebrew in the posts. just fix it".
 *
 * ## Why `whitespace-pre-wrap` is the right thing to key on
 *
 * DERIVED FROM THE SOURCE, not from a list of components. This codebase uses
 * `whitespace-pre-wrap` in exactly one situation: rendering text verbatim,
 * because its line breaks are part of the content. That is the same set as
 * "text a human or an agent wrote", which is the same set as "text that might
 * be Hebrew". So the rule needs no maintenance — a component added tomorrow is
 * covered the day it is written, and one deleted stops being checked without
 * anybody editing this file.
 *
 * ## Why `dir="auto"` and not a language lookup
 *
 * `auto` asks the browser to read the first strong character and lay the
 * element out accordingly. It is per-element, so the English chrome around a
 * Hebrew post is unaffected; it needs nothing threaded through from the
 * payload, which matters because **no gate payload currently carries a target
 * language at all**; and it stays correct for a client whose language nobody
 * has configured. A hardcoded `dir="rtl"` would mirror the entire English UI,
 * which is a different and worse bug.
 */

const REPO = path.resolve(__dirname, "../..", "..");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      tsxFiles(p, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(path.relative(REPO, p).split(path.sep).join("/"));
    }
  }
  return out;
}

/** The opening JSX tag of the element a `whitespace-pre-wrap` line belongs to. */
const OPENING_TAG = /<(p|pre|div|dd|span|li|td)\b/;

function undeclared(rel: string): string[] {
  const lines = readFileSync(path.join(REPO, rel), "utf8").split("\n");
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (!line.includes("whitespace-pre-wrap")) return;
    const trimmed = line.trimStart();
    // A doc comment that mentions the class is not an element using it.
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;

    // Walk back to the tag that opens this element — the class may sit several
    // lines below `<p`, on its own `className={...}` line.
    let j = i;
    while (j >= 0 && !OPENING_TAG.test(lines[j]!)) j -= 1;
    if (j < 0) return;
    if (lines.slice(j, i + 1).join("\n").includes("dir=")) return;
    found.push(`${rel}:${i + 1} — ${trimmed.slice(0, 80)}`);
  });
  return found;
}

describe("verbatim content declares its direction", () => {
  const files = tsxFiles(path.join(REPO, "src"));

  it("finds the render sites at all, so the check cannot pass by reading nothing", () => {
    // Anti-vacuity. A typo in the class name, or a refactor that renames it,
    // must fail loudly here rather than quietly reporting a clean sweep.
    const sites = files.flatMap((rel) =>
      readFileSync(path.join(REPO, rel), "utf8")
        .split("\n")
        .filter((l) => l.includes("whitespace-pre-wrap") && !l.trimStart().startsWith("*")),
    );
    expect(sites.length).toBeGreaterThan(15);
  });

  it("leaves no verbatim-content element without a direction", () => {
    const missing = files.flatMap(undeclared);
    expect(missing, `verbatim text with no direction — a Hebrew deliverable renders left-to-right here:\n${missing.join("\n")}`).toEqual([]);
  });
});
