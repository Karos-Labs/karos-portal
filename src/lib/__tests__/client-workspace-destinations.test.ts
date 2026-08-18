import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { matchingBrace, stripComments } from "./source-scan";

/**
 * THE CONTROL THAT SENT A CLIENT TO `/tasks` FOR SOMETHING THAT WAS NOT ON THE
 * TAB THEY LANDED ON (#102).
 *
 * `/tasks` — the Workspace board — is gone entirely (2026-08, locked decision:
 * "The Board is replaced by the action list on Home"). This file used to also
 * cover #101, the dashboard attention rows' own board link
 * (`taskBoardHref` in client-home-overview.tsx): that function and its call
 * sites were deleted with the board rather than kept pointing at a route that
 * no longer exists, and client-home-overview.tsx's own comments explain what
 * replaced them (the rows now report a count with nowhere left to send the
 * reader). Only #102 survives here, because the copilot's link now resolves
 * to Account Center's Archive tab instead — a real destination, not a retired
 * one, so it is still worth pinning.
 *
 *  #102 The copilot's `[View this output]` link fell through to a bare `/tasks`
 *       — the board, which held tasks and not deliverables — and even with
 *       `?tab=archive` it would still have been a lie for the DRAFTS that
 *       `find_output` can reach, because the archive excludes drafts and so does
 *       the agent detail page's own list.
 *
 * It lives in a closure inside a route handler that cannot be imported without
 * a request, so it is read from source — and read as BLOCKS (the function's
 * own brace range, the statement that opens its client half), never as "these
 * strings both appear in this file".
 */

const REPO = path.resolve(__dirname, "../..", "..");
const ROUTE = "src/app/api/clients/[id]/chat/route.ts";
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

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
    // And the fallback is the ARCHIVE tab (via the shared clientArchiveLink
    // helper every other archive link in the app goes through now), not the
    // long-gone board. The bare board return is the defect verbatim.
    expect(clientHalf, ROUTE).toContain(
      "return clientArchiveLink({ clientId, isStaff: false }).href;",
    );
    expect(clientHalf, ROUTE).not.toMatch(/return "\/tasks/);
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
