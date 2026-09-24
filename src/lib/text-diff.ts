/**
 * WHAT THE PERSON CHANGED, AS SPANS A READER CAN SEE.
 *
 * The portal already keeps the agent's own text: the first human edit of an
 * engine draft stashes it on `meta.engineOriginalContent` and every edit after
 * that leaves the stash alone (`updateAssetAction`). Nothing has ever SHOWN
 * it. §09 of the audit asks for the comparison at review time, and gives the
 * reason that matters more than the convenience: *"it is also what makes the
 * learning loop visible"* — the edit pair is the strongest voice signal the
 * system gets, it is already being sent to the next draft, and until now
 * nobody could see the thing their own edits were teaching.
 *
 * ## Words, not characters
 *
 * A character diff on prose marks the inside of words and reads as noise;
 * "colour" → "color" is one word changed, not three characters moved. So the
 * unit is a word with its trailing whitespace, which keeps the rendering
 * faithful to the original spacing without a second pass.
 *
 * ## Plain LCS, and a ceiling on it
 *
 * The longest-common-subsequence table is O(n·m). A caption is a few hundred
 * words and that is nothing; a pasted blog article against its rewrite is not,
 * and a review surface must never be the thing that hangs a reviewer's browser.
 * Past the ceiling the answer is honest rather than absent: the two texts come
 * back as one removal and one addition, which is what a wholesale rewrite IS.
 */

export type DiffKind = "same" | "added" | "removed";

export interface DiffSegment {
  kind: DiffKind;
  text: string;
}

/** Word pairs above this and the diff is not worth computing — see the note above. */
export const DIFF_WORD_CEILING = 1200;

/** Words WITH their trailing whitespace, so joining the segments reproduces the text exactly. */
function tokenize(text: string): string[] {
  return text.match(/\S+\s*/gu) ?? [];
}

/** Comparison ignores the trailing space: "word" and "word " are the same word. */
const key = (token: string): string => token.trim();

/**
 * The segments between two texts, in reading order.
 *
 * Adjacent segments of the same kind are merged, so a renderer gets one span
 * per run rather than one per word — the difference between a readable
 * paragraph and a wall of `<span>`s.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return [{ kind: "added", text: b.join("") }];
  if (b.length === 0) return [{ kind: "removed", text: a.join("") }];
  if (a.length * b.length > DIFF_WORD_CEILING * DIFF_WORD_CEILING) {
    return [
      { kind: "removed", text: a.join("") },
      { kind: "added", text: b.join("") },
    ];
  }

  // lcs[i][j] — the length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = key(a[i]!) === key(b[j]!) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffSegment[] = [];
  const push = (kind: DiffKind, text: string): void => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (key(a[i]!) === key(b[j]!)) {
      // The LATER text's spacing wins on an unchanged word: what is on screen
      // is what the post will carry.
      push("same", b[j]!);
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push("removed", a[i]!);
      i += 1;
    } else {
      push("added", b[j]!);
      j += 1;
    }
  }
  while (i < a.length) {
    push("removed", a[i]!);
    i += 1;
  }
  while (j < b.length) {
    push("added", b[j]!);
    j += 1;
  }
  return out;
}

export interface DiffSummary {
  added: number;
  removed: number;
  /** True when nothing changed — the caller shows the text once rather than twice. */
  identical: boolean;
}

/** How much was changed, in words, for the one line above the comparison. */
export function summarizeDiff(segments: readonly DiffSegment[]): DiffSummary {
  const words = (text: string): number => (text.match(/\S+/gu) ?? []).length;
  let added = 0;
  let removed = 0;
  for (const segment of segments) {
    if (segment.kind === "added") added += words(segment.text);
    if (segment.kind === "removed") removed += words(segment.text);
  }
  return { added, removed, identical: added === 0 && removed === 0 };
}
