/**
 * Client-facing labels for the lab's own batch headings.
 *
 * The agent writes its production vocabulary into the deliverable — LANE
 * headings ("Avenue 3 · News-reaction (live)", "Post 2 · POV thread") and
 * ACCOUNT headings ("# Account 2 · Albert Kattan (seat 1, handle pending)") —
 * and the readers printed both verbatim as the first thing a client reads
 * (QA F70, #87). Nobody outside the lab knows what an Avenue is, and a seat
 * number is bookkeeping.
 *
 * This module is the ONE home for that humanising, and the rule it exists to
 * express is: HUMANISE ON THE WAY TO A CLIENT, NEVER ON THE WAY TO STORAGE. Both
 * strings are join keys — a lane heading is the tail of the `draftRef` the
 * feedback log joins on, and an account heading is the `account` that same log
 * scopes by (x-agent-context's feedbackSection matches on it) — so a write path
 * that called in here would split a client's history across two namespaces.
 *
 * SCOPE. These are label functions and nothing more. They do not decide which
 * fields cross to a client — the projections do (`client-agent-rows.ts`,
 * `agent-intake-views.ts`) — and a REF that must cross as a join key still
 * carries an account heading inside itself; see `toClientXOption`.
 */

const LANE_COPY: Record<string, string> = {
  "build-in-public": "Building in public",
  "build in public": "Building in public",
  "knowledge/explainer": "Explainer",
  knowledge: "Explainer",
  explainer: "Explainer",
  "news-reaction": "Reacting to the news",
  "news reaction": "Reacting to the news",
  "quote-comment": "Quote reply",
  "quote comment": "Quote reply",
  reply: "Reply",
  "pov single": "Your point of view",
  "pov-single": "Your point of view",
  pov: "Your point of view",
  "pov thread": "Your point of view (thread)",
  "pov-thread": "Your point of view (thread)",
};

/**
 * The lab's slot ordinal, on either heading kind: "Avenue 2 · ", "Post 1 · ",
 * "Draft 3 · ", "Account 1 · ", "Seat 2 · ".
 *
 * One pattern for both because it is one shape — an ordinal slot number the
 * batch numbers its sections with — and forbidding the shape rather than the
 * spellings is what stops the next section word arriving on a client's screen.
 *
 * The separator is optional at the END of the string: a heading that is only an
 * ordinal ("Avenue 9") names no lane, and matching it only when a lane follows
 * would print the word Avenue to a client — the whole defect.
 */
const SLOT_PREFIX = /^\s*(?:avenue|post|draft|account|seat)\s*\d+\s*(?:[·:\-–—]\s*|$)/i;

/** A social handle: the one token inside an account heading a client knows it by. */
const HANDLE = /@[A-Za-z0-9_.]{1,30}/;

/**
 * What a lane label falls back to when a heading names no lane.
 *
 * "Draft" works as a CARD HEADING — the review panes title a draft card with it
 * — and is wrong inside a client's sentence, where it reads as an internal
 * status word ("You chose the Draft post for today", #155). Sentence-shaped
 * callers take `laneLabelOrNull` and print nothing instead.
 */
const NO_LANE = "Draft";

/** "Avenue 3 · News-reaction (live)" → "Reacting to the news · live" */
export function laneLabel(heading: string): string {
  return laneLabelOrNull(heading) ?? NO_LANE;
}

/**
 * The same label, but null rather than "Draft" when the heading names no lane.
 *
 * The whole of `laneLabel`'s work lives here so the two answers cannot drift.
 */
export function laneLabelOrNull(heading: string): string | null {
  const raw = (heading ?? "").trim();
  if (!raw) return null;

  // Drop the lab's slot prefix ("Avenue 2 · ", "Post 1 · ", "Draft 3 · ").
  const withoutPrefix = raw.replace(SLOT_PREFIX, "").trim();
  if (!withoutPrefix) return null;

  // "(live)" and friends are freshness flags, not part of the lane name.
  const flagMatch = withoutPrefix.match(/\(([^)]+)\)\s*$/);
  const flag = flagMatch?.[1]?.trim();
  const base = withoutPrefix.replace(/\s*\([^)]*\)\s*$/, "").trim();

  const mapped = LANE_COPY[base.toLowerCase()];
  const label = mapped ?? sentenceCase(base);
  if (!label) return null;
  return flag ? `${label} · ${flag.toLowerCase()}` : label;
}

/**
 * The lane inside a full draft ref — `${accountTitle} · ${lane}` — as a client
 * may read it, or null when the ref names no lane.
 *
 * The ref convention is `account · lane`, so the head is DROPPED rather than
 * humanised: callers that want the account print it themselves. A ref with no
 * head to drop yields nothing, because a single segment cannot be told apart
 * from an account title, and printing an account heading as an angle is the
 * defect this module exists to stop.
 */
export function refLaneLabel(ref: string): string | null {
  const parts = (ref ?? "")
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return laneLabelOrNull(parts.slice(1).join(" · "));
}

/**
 * A batch's account heading as a client may read it, or null when nothing in it
 * is theirs to recognise.
 *
 * REMOVED: the slot ordinal above, and every parenthetical. Parentheticals on
 * these headings carry the lab's bookkeeping — "(seat 1, handle pending)" is
 * the shape the contract's own example uses — and the shape is forbidden rather
 * than the spellings, so a parenthetical nobody has written client copy for
 * cannot reach a client's option picker. An unclosed one is treated the same
 * way. An @handle survives: a handle is what a client recognises an account BY.
 *
 * KEPT, verbatim: everything else. "Company page @getkaros" is the deliverable
 * contract's own wording for the company section and reads correctly as it is;
 * a seat section carries the person's name, which is also the client's own.
 *
 * Null when that leaves nothing — the honest answer for a heading that was all
 * bookkeeping is to print no account, not to dress a seat number up as copy.
 */
export function accountLabel(title: string): string | null {
  let raw = (title ?? "").trim();
  for (let previous = ""; previous !== raw; ) {
    previous = raw;
    raw = raw.replace(SLOT_PREFIX, "").trim();
  }

  const handle = raw.match(HANDLE)?.[0] ?? null;
  const cleaned = raw
    .replace(/\([^)]*\)/g, " ")
    .replace(/\([^)]*$/, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[·:,;–—-]+$/, "")
    .trim();

  if (!cleaned) return handle;
  if (handle && !cleaned.includes(handle)) return `${cleaned} ${handle}`;
  return cleaned;
}

function sentenceCase(value: string): string {
  const spaced = value.replace(/[_/-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return "";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
