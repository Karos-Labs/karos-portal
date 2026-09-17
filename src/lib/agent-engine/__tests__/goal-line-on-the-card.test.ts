/**
 * D11: every output states its point — goal, who it is for, why now.
 *
 * The engine has emitted that line since x-craft@6 and linkedin-craft@6, and
 * the portal dropped it on the floor: `metaFields` never listed the three
 * fields, so they never reached the asset and no card could have shown them.
 * A client saw a lane label on X, "why this thread" on Reddit, and nothing at
 * all on LinkedIn.
 *
 * The other half of the same rule is what must NOT travel. `formattingNotes`
 * is instruction to whoever formats the post, it reached a client once through
 * this exact list, and nothing in the repo reads it back.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PRODUCT_DELIVERABLE_KINDS } from "../materialize";
import { readFileSync } from "node:fs";
import path from "node:path";

const SOURCE = readFileSync(path.join(process.cwd(), "src/lib/agent-engine/materialize.ts"), "utf8");

/** The `metaFields: [...]` array declared by one materializer, as written. */
function metaFieldsNear(marker: string): string[] {
  const at = SOURCE.indexOf(marker);
  expect(at, `could not find ${marker} in materialize.ts`).toBeGreaterThan(-1);
  const rest = SOURCE.slice(at);
  const m = /metaFields:\s*\[([^\]]*)\]/.exec(rest);
  expect(m, `no metaFields after ${marker}`).not.toBeNull();
  return m![1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

describe("the goal line reaches the asset (D11)", () => {
  it("X carries goal, audience and whyNow", () => {
    const fields = metaFieldsNear('titleWhenAbsent: "X post"');
    for (const k of ["goal", "audience", "whyNow"]) expect(fields, k).toContain(k);
  });

  it("LinkedIn carries goal, audience and whyNow", () => {
    const fields = metaFieldsNear('titleWhenAbsent: "LinkedIn post"');
    for (const k of ["goal", "audience", "whyNow"]) expect(fields, k).toContain(k);
  });

  it("Reddit carries whyThread — a reply has no funnel stage, but it must say why this thread", () => {
    const fields = metaFieldsNear('titleWhenAbsent: "Reddit reply"');
    expect(fields).toContain("whyThread");
  });
});

describe("internal working text stays off the client's card", () => {
  it("formattingNotes is in no materializer's metaFields", () => {
    // Every `metaFields: [...]` in the file, not just LinkedIn's: the point is
    // that it reaches NO asset, whichever product grows a meta list next. The
    // prose comment explaining WHY it was removed is deliberately not what this
    // reads — an assertion over the whole file would fail on its own rationale.
    const lists = [...SOURCE.matchAll(/metaFields:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
    expect(lists.length, "no metaFields lists found — the scan is vacuous").toBeGreaterThanOrEqual(3);
    for (const list of lists) expect(list).not.toContain("formattingNotes");
  });
});

describe("the products are all still mapped", () => {
  it("did not lose a product while editing the meta lists", () => {
    expect(Object.keys(PRODUCT_DELIVERABLE_KINDS)).toHaveLength(16);
  });
});
