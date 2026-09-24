/**
 * WHERE THE REVIEWER LANDS NEXT.
 *
 * Reviewing drafts one at a time is a queue, and every hard question in a queue
 * is about what happens to the reader's POSITION when the list moves under
 * them. A draft they just approved leaves the list; a sibling session approves
 * another one while they read; a filter above the queue changes what is in it.
 * Get any of those wrong and the reviewer is silently teleported — to the top,
 * to something they already decided on, or past something nobody ever saw.
 *
 * So the arithmetic lives here, pure, rather than as index maths tangled into a
 * component with a keyboard handler and a server action. The component owns the
 * keys and the pixels; this owns where the reviewer ends up.
 *
 * ## The rules, and why each one
 *
 * **No wrap.** Pressing "next" on the last item does nothing rather than
 * jumping to the first. A queue exists to be finished, and a wrap turns "am I
 * done?" into a question the reviewer cannot answer without counting.
 *
 * **A decided item hands its place to whatever took it.** Approve item 3 of 12
 * and the reviewer should land on the NEW item 3 — the one that moved up — not
 * on item 4 (skipping one) and not back at the top (re-reading two).
 *
 * **The end of the list walks backwards.** Approve the last item and there is
 * no "new item at this index"; the reviewer lands on the new last item.
 *
 * **An empty queue is finished, not index 0.** `null` rather than a clamped
 * index, so a caller cannot render "1 of 0".
 */

/** How far a keypress moves: one item forward or one back. */
export type QueueDirection = 1 | -1;

/**
 * The index the reviewer should be on after moving `direction`, clamped to the
 * list rather than wrapped.
 *
 * Returns the same index at either end, which is what lets a caller treat "no
 * movement" as "you are at the end" without a second check.
 */
export function stepIndex(length: number, index: number, direction: QueueDirection): number {
  if (length <= 0) return 0;
  const clamped = Math.min(Math.max(index, 0), length - 1);
  return Math.min(Math.max(clamped + direction, 0), length - 1);
}

/**
 * Where the reviewer lands after the list changed under them — approved,
 * rejected, filtered out, or decided by somebody else in another tab.
 *
 * Reads the ID the reviewer was ON rather than trusting the old index, because
 * an item removed from ABOVE them shifts every index below it: a reviewer on
 * item 5 whose colleague approves item 2 is still reading the same draft, and
 * it is now item 4. Only when their own item is gone does position have to be
 * decided, and then it is decided by where the item WAS.
 *
 * `null` when nothing is left — the queue is finished and should close.
 */
export function indexAfterListChange(
  previousIds: readonly string[],
  nextIds: readonly string[],
  currentIndex: number,
): number | null {
  if (nextIds.length === 0) return null;

  const currentId = previousIds[Math.min(Math.max(currentIndex, 0), previousIds.length - 1)];
  if (currentId !== undefined) {
    const stillThere = nextIds.indexOf(currentId);
    // They are reading the same draft; it may simply have moved.
    if (stillThere !== -1) return stillThere;
  }

  // Their item is gone. Its place goes to whatever took it — and at the end of
  // the list, where no item took it, to the new last item.
  return Math.min(Math.max(currentIndex, 0), nextIds.length - 1);
}

/** "3 of 12" — the counter that makes a queue finishable. */
export function queuePosition(length: number, index: number): string {
  if (length <= 0) return "0 of 0";
  return `${Math.min(Math.max(index, 0), length - 1) + 1} of ${length}`;
}

/**
 * What a keypress means in the queue, or `null` when the key is not ours.
 *
 * Separated from the handler so the bindings are a fact a test can read rather
 * than a chain of `if (e.key === …)` inside a `useEffect`. Both the arrows and
 * `j`/`k` move, because a reviewer who lives in this queue will reach for the
 * latter and one who arrived from the grid will reach for the former.
 *
 * Modified keys are NOT ours: ⌘←, ctrl+K and alt+arrow belong to the browser
 * and to whatever the reader has bound in it.
 */
export function queueKeyAction(key: string, modifiers: { alt?: boolean; ctrl?: boolean; meta?: boolean } = {}):
  | "next"
  | "previous"
  | "close"
  | "approve"
  | null {
  if (modifiers.alt || modifiers.ctrl || modifiers.meta) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case "j":
      return "next";
    case "ArrowLeft":
    case "ArrowUp":
    case "k":
      return "previous";
    case "Escape":
      return "close";
    case "a":
      return "approve";
    default:
      return null;
  }
}

/**
 * Whether a keypress should reach the queue at all.
 *
 * A reviewer editing a draft's text inside the queue types "a" and "j" like
 * anybody else, and a shortcut that approves a post mid-sentence is worse than
 * no shortcut. Anything typed into a field, a textarea or a `contenteditable`
 * belongs to that field.
 */
export function keyEventIsForQueue(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return true;
  if (target.isContentEditable) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT";
}
