/**
 * Per-slot notes — the pure half (Phase 3 §4.3, CD-A3).
 *
 * A note is the client saying something about ONE day: "make Thursday's about
 * the launch". It is not feedback (that shapes everything the agent writes from
 * here on, §5) and it is not a prompt — it is a single-day instruction with a
 * shelf life, which is why it lives on the slot and dies with it.
 *
 * The consumption contract is what the copy has to be honest about. Three paths
 * exist in the design, in declining fidelity: day-of generation receives the
 * note as a context file; a revision pass rewrites an already-generated draft;
 * or a human applies it. Only the last one ships today, so nothing in the copy
 * may promise the first two.
 */

import type { AgentSlot, AgentSlotNote } from "@/lib/types";

/** Hard length. Clamped server-side, never trusted from the browser. */
export const MAX_SLOT_NOTE_CHARS = 500;

/**
 * Normalize what a client typed into what is stored. Same treatment as agent
 * feedback: control characters survive JSON and reappear as literal escapes
 * inside the markdown an agent reads.
 */
export function clampSlotNote(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_SLOT_NOTE_CHARS);
}

export type SlotNoteBlock =
  | { ok: true }
  | { ok: false; code: "past_day" | "slot_posted" | "slot_skipped"; reason: string };

/**
 * Whether this slot can still take a note.
 *
 * FUTURE DAYS ONLY, and today counts as still open — a client who thinks of
 * something at 9am for a post that has not gone out yet is exactly the case the
 * feature is for. A day that has passed is history: a note on it could never be
 * applied, and accepting one would be a silent no-op dressed as an action.
 */
export function canNoteSlot(
  slot: Pick<AgentSlot, "dateKey" | "status">,
  todayKey: string,
): SlotNoteBlock {
  if (slot.status === "posted") {
    return { ok: false, code: "slot_posted", reason: "This one is already posted." };
  }
  if (slot.status === "skipped") {
    return { ok: false, code: "slot_skipped", reason: "This day was removed from the plan." };
  }
  if (slot.dateKey < todayKey) {
    return { ok: false, code: "past_day", reason: "That day has already passed." };
  }
  return { ok: true };
}

/**
 * The line the client reads back after leaving a note.
 *
 * It promises a HUMAN, because a human is what actually happens today: the note
 * is stored and surfaced to the Karos team, who fold it into that day's post.
 * The design's higher-fidelity paths (day-of generation consuming the note as a
 * context file, or a revision pass) are not wired, and copy that implied the
 * agent had already read the note would be the same class of lie as promising a
 * picker that does not exist.
 */
export function slotNoteEcho(note: Pick<AgentSlotNote, "consumedAt"> | null | undefined): string {
  if (note?.consumedAt) return "Your Karos team applied this to that day's post.";
  return "Noted — your Karos team factors this into that day's post.";
}
