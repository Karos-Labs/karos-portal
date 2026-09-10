import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { matchingBrace, stripComments } from "./source-scan";

/**
 * #116 — REASSIGNING AN ACTION ITEM TOOK THE MEETING LINK WITH IT.
 *
 * `visible` filters on `i.assigneeUserId === currentUserId`, so the instant the
 * reassign write lands the row leaves the list — and THE ROW WAS THE ONLY THING
 * CARRYING THE LINK to the transcript it came from. The one thing a person does
 * next (open the meeting, or undo a mis-click on a 150px select) had nowhere to
 * start.
 *
 * WHY THIS IS A SOURCE SCAN AND NOT A RENDER. `MyActionItems` is a client
 * component whose row imports four server actions; the notice is raised by a
 * callback that only fires after one of them resolves, so a node render cannot
 * reach the state that paints it. What CAN be asserted mechanically is the
 * structure the fix depends on — and each assertion below is keyed to the
 * property that would actually break, not to a sentence:
 *
 *   · the memo is held ABOVE the row, because the row is what unmounts;
 *   · the notice is OUTSIDE the empty-state branch, because handing over your
 *     last item is exactly when losing the link hurts most;
 *   · it carries a real link to the transcript, not just prose about one;
 *   · it is raised only when the item actually LEAVES this list.
 *
 * Comments are stripped: this file's own subject is a link and a callback, and
 * the component's docstrings name both. A raw scan would be satisfied by the
 * prose describing the thing it is looking for — the trap that shipped twice in
 * this campaign.
 */

const FILE = join(process.cwd(), "src", "components", "my-action-items.tsx");
const src = stripComments(readFileSync(FILE, "utf8"));

/** The body of the named function component, past its parameter list. */
function bodyOf(name: string): string {
  const at = src.indexOf(`function ${name}(`);
  expect(at, `${name} is gone — it moved or was renamed`).toBeGreaterThan(-1);
  // Past the parameter list: the brace after the NAME opens the destructured
  // params, not the body. Slicing from there reads almost nothing.
  const parens = src.indexOf("(", at);
  let depth = 0;
  let closeParen = -1;
  for (let i = parens; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) {
      closeParen = i;
      break;
    }
  }
  const open = src.indexOf("{", closeParen);
  return src.slice(open, matchingBrace(src, open) + 1);
}

describe("reassigning an item leaves the thread back to its meeting", () => {
  it("holds the memo in the list, not in the row that unmounts", () => {
    // The whole defect is that the row disappears. State kept on the row cannot
    // outlive it, which is what the pre-fix `paused`-style flag got wrong on the
    // calendar too — same shape, same file-level answer.
    const list = bodyOf("MyActionItems");
    expect(list, "the reassigned memo is not held by the list").toMatch(
      /setReassigned|const \[reassigned/,
    );
    const row = bodyOf("ActionItemRow");
    expect(row, "the row holds the memo it is about to take with it").not.toMatch(
      /const \[reassigned/,
    );
  });

  it("raises it only when the item really leaves this list", () => {
    // Reassigning to yourself keeps the row, and a notice about a row still on
    // screen is its own small lie. Keyed to the guard, not to its wording.
    const row = bodyOf("ActionItemRow");
    const at = row.indexOf("onReassigned(");
    expect(at, "the row never tells the list the item left").toBeGreaterThan(-1);
    const before = row.slice(Math.max(0, at - 400), at);
    expect(before, "the notice fires even when the item stays with you").toMatch(
      /userId !== currentUserId/,
    );
  });

  it("carries a real link to the meeting, not prose about one", () => {
    const list = bodyOf("MyActionItems");
    expect(list, "the trace names the meeting without linking to it").toMatch(
      /href=\{`\/transcripts\/\$\{reassigned\.transcriptId\}`\}/,
    );
  });

  it("survives handing over the last item you had", () => {
    // The notice must not live inside the `visible.length === 0` branch, or the
    // case it matters most in is the one case it does not render.
    const list = bodyOf("MyActionItems");
    const emptyAt = list.indexOf("visible.length === 0");
    const noticeAt = list.indexOf("reassigned && (");
    expect(emptyAt, "the empty-state branch moved").toBeGreaterThan(-1);
    expect(noticeAt, "the trace is gone").toBeGreaterThan(-1);
    // The empty branch closes before the notice opens — asked as a containment
    // question rather than as a distance.
    const emptyOpen = list.indexOf("(", emptyAt);
    let depth = 0;
    let emptyClose = -1;
    for (let i = emptyOpen; i < list.length; i++) {
      if (list[i] === "(") depth++;
      else if (list[i] === ")" && --depth === 0) {
        emptyClose = i;
        break;
      }
    }
    expect(noticeAt, "the trace renders inside the empty state").toBeGreaterThan(emptyClose);
  });

  it("announces itself, because the control that changed vanishes", () => {
    const list = bodyOf("MyActionItems");
    expect(list).toMatch(/role="status"/);
    expect(list).toMatch(/aria-live="polite"/);
  });
});
