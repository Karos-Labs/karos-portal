import "server-only";

/**
 * Copy rules for agent text a client will read.
 *
 * These used to live in `agent-service/custom-agent-import.ts`, because the
 * GitHub importer was the first thing that needed them — it was pulling
 * descriptions straight out of lab SKILL.md frontmatter, which is written for
 * the people who build agents rather than the people who buy them. The
 * importer is gone; the rule is not, because it never actually belonged to it.
 * `validateCustomAgentInput` applies it to every agent an admin creates or
 * edits in Agent Studio, which is now the only way agents get here at all.
 */

/**
 * Lab vocabulary that reads as internal notes on a client-facing screen:
 * product codes (`e12)`), the sub-skill/tonemap/FORGE/Path-X machinery.
 *
 * Allow-by-default and deliberately short. Five patterns cannot decide whether
 * a sentence is written in the client's language, and a long list would start
 * rejecting legitimate copy; this catches the specific tells that kept
 * appearing verbatim, and a human reads the rest.
 */
export const LAB_JARGON_RE = /\be\d{1,2}\)|sub-skill|tonemap|FORGE|Path [A-Z]\b/i;

export function containsLabJargon(text: string): boolean {
  return LAB_JARGON_RE.test(text);
}
