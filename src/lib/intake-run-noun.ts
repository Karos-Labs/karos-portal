/**
 * What each agent family PRODUCES, in the client's own words (pure,
 * client-safe: imports one type).
 *
 * WHY A REGISTER. The word is read by the intake run-history card's empty state
 * ("your articles land in your archive") and was hand-spelled at each of the six
 * mounts. Five spellings for six surfaces, with `reputation` and `reddit` both
 * saying "replies" by coincidence rather than by rule, and nothing anywhere
 * stating that newsletter's is singular-per-run on purpose.
 *
 * NOT THE OTHER TWO NOUN TABLES, and they are easy to confuse:
 *  - `app/(app)/calendar/calendar-body.tsx`'s `OUTPUT_NOUN` is singular/plural
 *    PAIRS, composed into sentences ("2 posts this week"). A grammar table.
 *  - `components/client-agents/agent-detail-panel.tsx`'s `OUTPUT_NOUN` is keyed
 *    by `AgentArchetype`, which is not the intake family.
 * This one is keyed by `IntakeFamily` and is always plural, because its one
 * reader is a sentence that already has "your" in front of it.
 *
 * A seventh family is a compile error here, which is the whole point: the noun
 * is not optional copy that a new intake page can quietly leave blank.
 */

import type { IntakeFamily } from "@/lib/agent-intake-links";

const INTAKE_RUN_NOUN: Record<IntakeFamily, string> = {
  linkedin: "posts",
  x: "posts",
  reddit: "replies",
  reputation: "replies",
  newsletter: "issues",
  blog: "articles",
};

export const ALL_INTAKE_FAMILIES = Object.keys(INTAKE_RUN_NOUN) as IntakeFamily[];

/** Plural, and always read after a possessive: "your {noun} land in the archive". */
export function intakeRunNoun(family: IntakeFamily): string {
  return INTAKE_RUN_NOUN[family];
}
