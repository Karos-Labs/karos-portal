import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isStringDelimiter, matchingBrace, skipStringLiteral, stripComments } from "./source-scan";
import { taskBoardHref } from "@/components/client-home-overview";
import type { ClientTask } from "@/lib/types";

/**
 * THE TWO CONTROLS THAT SEND A CLIENT TO `/tasks` FOR SOMETHING THAT IS NOT ON
 * THE TAB THEY LAND ON (#101, #102).
 *
 * `/tasks` is three surfaces behind one path. The BOARD splits by task owner
 * into two disjoint tabs, `?owner=` (or a resolved `?task=`) picks which, and an
 * absent owner defaults to "karos". The ARCHIVE is a different view of the same
 * route, reached only with `?tab=archive`, and it holds delivered work — never a
 * draft, by design.
 *
 *  #101 The dashboard's attention rows counted tasks of EITHER owner and linked
 *       a bare `/tasks`, so a client whose review-pending work is all
 *       client-owned clicked "waiting for your sign-off" and got the karos tab,
 *       holding none of it. QA F64 fixed exactly this in the notification bell
 *       and left it here.
 *
 *  #102 The copilot's `[View this output]` link fell through to a bare `/tasks`
 *       — the board, which holds tasks and not deliverables — and even with
 *       `?tab=archive` it would still have been a lie for the DRAFTS that
 *       `find_output` can reach, because the archive excludes drafts and so does
 *       the agent detail page's own list.
 *
 * HOW EACH HALF IS ASKED. #101's rule is a fact about a returned string, so it
 * is called. #102's lives in a closure inside a route handler that cannot be
 * imported without a request, so it is read from source — and read as BLOCKS
 * (the function's own brace range, the statement that opens its client half),
 * never as "these two strings both appear in this file".
 */

const REPO = path.resolve(__dirname, "../..", "..");
const ROUTE = "src/app/api/clients/[id]/chat/route.ts";
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

/* ───────────── #101: the board opens on the tab holding the work ────────── */

function task(over: Partial<ClientTask> & Pick<ClientTask, "id">): ClientTask {
  return {
    clientId: "c1",
    title: "Approve the July calendar",
    status: "review_pending",
    priority: "medium",
    source: "copilot",
    owner: "client_managed",
    createdBy: "uid",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as ClientTask;
}

/**
 * The URL an href attribute resolves to, whatever spelling it was typed in:
 * `"/x"`, `{"/x"}` and {`/x`} all become `/x`.
 */
function hrefLiteral(raw: string): string {
  return raw
    .replace(/^\{([\s\S]*)\}$/, "$1")
    .trim()
    .replace(/^([`"'])([\s\S]*)\1$/, "$2");
}

describe("#101 — the attention row's destination", () => {
  it("keys the board on a task, so the board picks the tab that holds it", () => {
    // NOT `?owner=`. The board resolves `?task=` through its own
    // ownerTab(inferOwner(task)) and that outranks `?owner=`, so the owner→tab
    // mapping stays in the one place that owns it instead of gaining a fourth
    // copy. A row that spelled the mapping itself is a row that can drift from
    // the board it links to.
    expect(taskBoardHref([task({ id: "t-1" })])).toBe("/tasks?task=t-1");
  });

  it("carries the same first task when the row counts several", () => {
    const href = taskBoardHref([task({ id: "t-1" }), task({ id: "t-2", owner: "karos_managed" })]);
    expect(href).toBe("/tasks?task=t-1");
  });

  it("escapes the id rather than pasting it into a query string", () => {
    expect(taskBoardHref([task({ id: "a b&c" })])).toBe("/tasks?task=a%20b%26c");
  });

  it("falls back to the board itself when there is no task to key on", () => {
    // Unreachable from the rows (they render only when non-empty) and therefore
    // exactly the branch that would rot unnoticed: a `tasks[0]!` here would put
    // "/tasks?task=undefined" on screen.
    expect(taskBoardHref([])).toBe("/tasks");
  });

  it("leaves no bare board link on either attention row", () => {
    // The function above can be right while a row still carries the old href.
    // Keyed to the AttentionRow elements' own href values, not to whether the
    // string "/tasks" appears in the file — it appears in this file's prose too.
    const code = stripComments(read("src/components/client-home-overview.tsx"));
    const hrefs = attentionRowHrefs(code);
    expect(hrefs.length, "no AttentionRow carries an href").toBeGreaterThan(0);
    for (const href of hrefs) {
      // `/calendar` is the failed-publish row and is a different destination
      // entirely; what must not survive is a hand-written board link.
      // KEYED TO THE VALUE, not to the spelling. `/^["']\/tasks["']$/` matched only
      // the bare-string form, so `href={"/tasks"}` and href={`/tasks`} — the two
      // other ordinary ways to write the same defect — restored the finding with
      // this green. A value that is not a literal at all (a call, a concat) falls
      // through `hrefLiteral` unchanged and still fails to equal "/tasks".
      expect(
        hrefLiteral(href),
        "an attention row links the board without keying its tab",
      ).not.toBe("/tasks");
    }
  });
});

/** Every `href=` value on an `<AttentionRow …>` element. */
function attentionRowHrefs(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/<AttentionRow(?=[\s/>])/g)) {
    const gt = openingTagEnd(code, m.index);
    if (gt < 0) continue;
    out.push(...hrefValues(code.slice(m.index, gt + 1)));
  }
  return out;
}

/* ───────── #102: the copilot's output link, or no link at all ───────────── */

/** The brace-delimited body of the arrow function bound to `name`. */
function arrowBody(code: string, name: string): string {
  const at = code.indexOf(`const ${name} = `);
  expect(at, `${ROUTE}: no ${name} binding`).toBeGreaterThan(-1);
  const open = code.indexOf("{", code.indexOf("=>", at));
  const close = matchingBrace(code, open);
  expect(close, `${ROUTE}: ${name} never closes`).toBeGreaterThan(open);
  return code.slice(open + 1, close);
}

describe("#102 — the copilot links an output only where the output is", () => {
  const code = stripComments(read(ROUTE));

  it("declares that a viewer may have no destination at all", () => {
    // The type is what forces every caller to face the null. Loosen it back to
    // `string` and the archive gate below cannot compile.
    expect(code, ROUTE).toContain("const deepLinkForAsset = (asset: Asset): string | null =>");
  });

  it("opens the client half with the archive's own predicate", () => {
    // Read as a BLOCK: the staff half is skipped by matching its brace, so what
    // is asserted is the first statement a CLIENT meets — not "this call appears
    // somewhere in the function", which would pass with the gate sitting after
    // the returns it is meant to guard.
    const body = arrowBody(code, "deepLinkForAsset");
    const staffAt = body.indexOf("if (!viewerIsClient) {");
    expect(staffAt, `${ROUTE}: no staff branch to skip`).toBeGreaterThan(-1);
    const clientHalf = body.slice(matchingBrace(body, body.indexOf("{", staffAt)) + 1).trim();
    expect(clientHalf, ROUTE).toMatch(
      /^if \(!isInClientArchive\(asset, nowMs\)\) return null;/,
    );
    // And the fallback is the ARCHIVE tab, not the board. The bare board return
    // is the defect verbatim.
    expect(clientHalf, ROUTE).toContain('return "/tasks?tab=archive";');
    expect(clientHalf, ROUTE).not.toMatch(/return "\/tasks";/);
  });

  it("composes the link line in exactly one place, and that place can withhold it", () => {
    // Two `[View this output](` in the file would mean one caller still emits it
    // unconditionally — the half of this defect that survives a fixed resolver.
    const marker = "[View this output](";
    const hits = [...code.matchAll(/\[View this output\]\(/g)].map((m) => m.index);
    expect(hits.length, `${ROUTE}: expected one ${marker}`).toBe(1);
    const line = arrowBody(code, "viewOutputLine");
    const lineAt = code.indexOf(line);
    expect(hits[0]!, `${ROUTE}: the link line is built outside viewOutputLine`).toBeGreaterThan(
      lineAt,
    );
    expect(hits[0]!).toBeLessThan(lineAt + line.length);
    // …and that place returns nothing when there is nowhere to go.
    expect(line, ROUTE).toContain("deepLinkForAsset(asset)");
    expect(line, ROUTE).toMatch(/:\s*""/);
  });
});

/* ── the two scanning primitives this file needs, delimiter-aware ────────── */

function openingTagEnd(code: string, at: number): number {
  for (let i = at; i < code.length; i++) {
    const ch = code[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(code, i);
      continue;
    }
    if (ch === "{") {
      const brace = matchingBrace(code, i);
      if (brace < 0) return -1;
      i = brace;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

function hrefValues(tag: string): string[] {
  const out: string[] = [];
  for (const m of tag.matchAll(/\bhref\s*=\s*/g)) {
    const at = m.index + m[0].length;
    if (tag[at] === "{") {
      const close = matchingBrace(tag, at);
      out.push(close > at ? tag.slice(at, close + 1) : tag.slice(at));
      continue;
    }
    if (isStringDelimiter(tag[at])) {
      const close = skipStringLiteral(tag, at);
      out.push(close > at ? tag.slice(at, close + 1) : tag.slice(at));
      continue;
    }
    out.push(tag.slice(at));
  }
  return out;
}
