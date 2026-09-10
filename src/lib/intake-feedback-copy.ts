/**
 * Copy for the intake FEEDBACK box (pure, client-safe: imports one type).
 *
 * The box itself is one component — `components/intake-feedback-box.tsx` — read
 * by the LinkedIn and X intake surfaces, which used to hold a 135-line copy
 * each. Those two copies differed in exactly four places: the view types (byte
 * identical), the server action, the DOM id prefix, and this one placeholder
 * sentence. Three of the four are structure and belong in the component's
 * props. The fourth is COPY, and copy in this codebase lives in a register.
 *
 * WHY THE PLACEHOLDER IS THE ONLY ENTRY. It is the only string in that box whose
 * right wording depends on the platform: LinkedIn's failure mode is sounding too
 * corporate and X's is sounding too salesy, and a client reading the wrong one
 * gets a prompt about a problem their channel does not have. Every other
 * sentence in the box — the intro, the sent confirmation, the archive link — says
 * the same true thing on both, so it stays in the component rather than being
 * duplicated into a table with two identical rows.
 *
 * WHY NOT KEYED BY THE WHOLE `IntakeFamily`. There are six intake families and
 * only two mount this box. A `Record<IntakeFamily, string>` would force four
 * invented placeholders for boxes that do not exist, which is a table lying
 * about its own coverage. `Extract` derives the two from the six instead, so
 * renaming a family in `agent-intake-links.ts` is still a compile error here.
 */

import type { IntakeFamily } from "@/lib/agent-intake-links";

/** The intake families that mount a feedback box. Derived, never re-spelled. */
export type IntakeFeedbackFamily = Extract<IntakeFamily, "linkedin" | "x">;

const INTAKE_FEEDBACK_PLACEHOLDER: Record<IntakeFeedbackFamily, string> = {
  linkedin:
    "Explain the problem or the win. Too corporate? Wrong topics? A draft style you want more of? Write it like you would to a teammate.",
  x: "Explain the problem or the win. Too salesy? Wrong topics? A draft style you want more of? Write it like you would to a teammate.",
};

/** Every family this register answers for, for the tests and for exhaustiveness. */
export const ALL_INTAKE_FEEDBACK_FAMILIES = Object.keys(
  INTAKE_FEEDBACK_PLACEHOLDER,
) as IntakeFeedbackFamily[];

/** What the free-text note field prompts for on this family's intake page. */
export function intakeFeedbackPlaceholder(family: IntakeFeedbackFamily): string {
  return INTAKE_FEEDBACK_PLACEHOLDER[family];
}

/**
 * The DOM id for a field inside the feedback box.
 *
 * Derived rather than passed as a prefix prop. Two intake pages never render at
 * once today, but the ids were hand-spelled `lf-account` and `xf-account` in
 * files that shared nothing, so a third mount would have had to invent a third
 * prefix and hope. `htmlFor` on the label and `id` on the control now come from
 * the same call, which is the pairing that actually has to hold.
 */
export function intakeFeedbackFieldId(family: IntakeFeedbackFamily, field: string): string {
  return `${family}-feedback-${field}`;
}
