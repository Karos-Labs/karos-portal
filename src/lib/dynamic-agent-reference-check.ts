/**
 * Dangling `{{inputs.KEY}}` / `{{outputs.STEP_ID}}` references across a
 * dynamic agent's pipeline. Pure, no Firestore, no auth — same split as
 * dynamic-agent-validation.ts, and used by two callers with different
 * severity: the free-text generator's validation (a dangling reference is a
 * HARD failure, retried once) and the manual Pipeline save path (a
 * NON-BLOCKING warning only, so this never breaks a spec that already
 * exists — see dynamic-agent-actions.ts's updateDynamicAgentSpecAction).
 *
 * A dangling reference does not error at runtime: step-runner.ts's
 * `interpolate` leaves an unresolved `{{...}}` as literal text in the
 * composed prompt, which is the single hardest failure to diagnose (the
 * agent silently "writes" from a placeholder string instead of the data an
 * admin thought they wired up) — this is the one static check that can catch
 * it before a client ever runs the agent.
 */

import type { DynamicAgentInputDef, DynamicAgentStepDef } from "@/lib/types";

const REFERENCE_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * Every `{{inputs.KEY}}` / `{{outputs.STEP_ID}}` reference found in one AI
 * step's prompt, in appearance order. Only the first two dotted segments
 * matter (`inputs`/`outputs` + the key/stepId) — a longer path like
 * `outputs.research.summary` still resolves against the step id `research`
 * at runtime (resolvePath in step-runner.ts walks the rest), so this only
 * checks that first segment.
 */
function referencesIn(prompt: string): Array<{ kind: "inputs" | "outputs"; key: string }> {
  const found: Array<{ kind: "inputs" | "outputs"; key: string }> = [];
  for (const match of prompt.matchAll(REFERENCE_RE)) {
    const path = match[1];
    if (!path) continue;
    const [root, key] = path.split(".");
    if ((root === "inputs" || root === "outputs") && key) found.push({ kind: root, key });
  }
  return found;
}

/**
 * Returns one plain-English message per dangling reference found — empty
 * when every reference resolves. Only AI steps are scanned: a code step
 * receives the full run context on stdin as JSON, never through `{{}}`
 * interpolation, so a literal `{{...}}` in its `code` string is just a
 * string the script's own author wrote, not a reference this repo resolves.
 */
export function checkDanglingReferences(
  inputSchema: DynamicAgentInputDef[],
  steps: DynamicAgentStepDef[],
): string[] {
  const inputKeys = new Set(inputSchema.map((f) => f.key));
  const orderedSteps = [...steps].sort((a, b) => a.order - b.order);
  const messages: string[] = [];

  orderedSteps.forEach((step, index) => {
    if (step.type !== "ai") return;
    const earlierStepIds = new Set(orderedSteps.slice(0, index).map((s) => s.id));

    for (const ref of referencesIn(step.prompt)) {
      if (ref.kind === "inputs") {
        if (!inputKeys.has(ref.key)) {
          messages.push(`Step "${step.id}" references {{inputs.${ref.key}}}, but there is no input field with that key.`);
        }
      } else if (ref.kind === "outputs") {
        if (ref.key === step.id) {
          messages.push(`Step "${step.id}" references {{outputs.${ref.key}}}, its own output — a step cannot reference itself.`);
        } else if (!earlierStepIds.has(ref.key)) {
          const isLater = orderedSteps.some((s) => s.id === ref.key);
          messages.push(
            isLater
              ? `Step "${step.id}" references {{outputs.${ref.key}}}, which is a LATER step — a step can only reference an earlier step's output.`
              : `Step "${step.id}" references {{outputs.${ref.key}}}, but no step with that id exists.`,
          );
        }
      }
    }
  });

  return messages;
}
