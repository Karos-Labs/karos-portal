import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * SCRUM-264: "There is no counterpart to isAgentServiceConfigured() for the
 * engine. A client who has been cut over gets NO WARNING OF ANY KIND when it
 * breaks."
 *
 * A health check or a banner component that no page ever mounts changes
 * nothing for a real client — they would still get zero warning end to end.
 * So this does not test `EngineHealthBanner` or `shouldShowEngineHealthBanner`
 * in isolation (that is `health.test.ts`); it tests that the two pages a
 * cut-over client and staff actually load — the agents roster and an agent's
 * own page — import and render the banner, gated by the health check, the
 * same way both pages already mount `isAgentServiceConfigured()`'s banner.
 *
 * Source scans, not renders: both pages are server components whose module
 * graph reaches Firestore and the auth cookie (see `agents-page-catalog.
 * test.ts`'s own note on the same constraint) — what is being asserted is a
 * structural fact about what the page mounts, which the source states
 * directly.
 */

const ROSTER_PAGE = path.join(process.cwd(), "src/app/(app)/clients/[id]/agents/page.tsx");
const DETAIL_PAGE = path.join(process.cwd(), "src/app/(app)/clients/[id]/agents/[agentId]/page.tsx");

const rosterSource = readFileSync(ROSTER_PAGE, "utf8");
const detailSource = readFileSync(DETAIL_PAGE, "utf8");

describe("the roster page (clients/[id]/agents) mounts the engine health banner", () => {
  it("imports EngineHealthBanner and its gate", () => {
    expect(rosterSource).toMatch(/import\s*\{\s*EngineHealthBanner\s*\}\s*from\s*"@\/components\/engine-health-banner"/);
    expect(rosterSource).toMatch(/import\s*\{\s*shouldShowEngineHealthBanner\s*\}\s*from\s*"@\/lib\/agent-engine\/health"/);
  });

  it("renders <EngineHealthBanner ...> gated by shouldShowEngineHealthBanner, on both the client and staff branches", () => {
    // `shouldShowEngineHealthBanner(...)`'s own arguments contain nested
    // parens (`agents.map((a) => a.key)`), so this matches the gate call up
    // to its OWN closing paren by depth-counting rather than a `[^)]*`
    // regex, then requires `&& (\n <EngineHealthBanner` shortly after.
    const renderSites = findGatedRenders(rosterSource);
    // One on the client (viewerIsClient) branch, one on the staff (isStaff)
    // branch — the same "one banner, two registers" split the agent-service
    // banner already uses on this page (F34's comment, just above each one).
    expect(renderSites).toBeGreaterThanOrEqual(2);
  });
});

describe("an agent's own detail page (clients/[id]/agents/[agentId]) mounts the engine health banner", () => {
  it("imports EngineHealthBanner and its gate", () => {
    expect(detailSource).toMatch(/import\s*\{\s*EngineHealthBanner\s*\}\s*from\s*"@\/components\/engine-health-banner"/);
    expect(detailSource).toMatch(/import\s*\{\s*shouldShowEngineHealthBanner\s*\}\s*from\s*"@\/lib\/agent-engine\/health"/);
  });

  it("renders <EngineHealthBanner ...> gated by shouldShowEngineHealthBanner", () => {
    expect(findGatedRenders(detailSource)).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Counts call sites of the shape
 *   shouldShowEngineHealthBanner(<balanced-paren args>) && (
 *     <EngineHealthBanner
 * by walking the call's own arguments to their matching close-paren (depth
 * counting, since the real call sites nest parens — `agents.map((a) =>
 * a.key)`), rather than a `[^)]*` regex that would stop at the first inner
 * `)` and never reach the real one.
 */
function findGatedRenders(source: string): number {
  const callName = "shouldShowEngineHealthBanner(";
  let count = 0;
  let searchFrom = 0;
  for (;;) {
    const start = source.indexOf(callName, searchFrom);
    if (start === -1) break;
    let depth = 1;
    let i = start + callName.length;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    // `i` now sits just past the call's own matching close-paren. What
    // follows, allowing only whitespace, must be `&& (` then `<EngineHealthBanner`.
    const after = source.slice(i, i + 200);
    if (/^\s*&&\s*\(\s*<EngineHealthBanner\b/.test(after)) count++;
    searchFrom = i;
  }
  return count;
}
