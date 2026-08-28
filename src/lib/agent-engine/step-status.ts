import type { AgentEngineStepRecord } from "./read-run";

/**
 * How one agent-engine step checkpoint should read in the run panel's status
 * column (AU68 / SCRUM-366 — karosCMO's half).
 *
 * WHY THIS IS A FUNCTION AND NOT A TERNARY. The run panel used to ask
 * `status === "completed" ? Done : Failed`, which was correct while the engine
 * only ever wrote three values. AU67/AU68 widened it to seven, and that
 * ternary's `else` would have painted `content_fail`, `not_available` and
 * `budget_exceeded` bright red as "Failed" — the SAME conflation the engine
 * spent two tickets removing, arriving back through the display.
 *
 * A revision loop ASKS for `content_fail` and retries; `not_available` is a
 * capability deliberately absent; `budget_exceeded` is a ceiling somebody
 * chose. None of those is a fault. `tooling_error` and `failed` are.
 *
 * Pure and client-safe on purpose, so it can be asserted in a unit test rather
 * than inspected in a browser.
 */
export function agentEngineStepStatusBadge(
  step: Pick<AgentEngineStepRecord, "status" | "kind" | "error">,
): { tone: "success" | "info" | "warning" | "danger"; label: string } {
  switch (step.status) {
    case "running":
      // A `gate` step sits at "running" for as long as a person takes to answer
      // it, which is not the same claim as a code step still executing —
      // "Running…" on a human-approval row reads as the machine being busy.
      return step.kind === "gate" ? { tone: "warning", label: "Awaiting review" } : { tone: "info", label: "Running…" };
    case "completed":
      return { tone: "success", label: "Done" };
    case "content_fail":
      return { tone: "warning", label: step.error ?? "Content rejected" };
    case "not_available":
      return { tone: "warning", label: step.error ?? "Not available" };
    case "budget_exceeded":
      return { tone: "warning", label: step.error ?? "Budget exceeded" };
    case "tooling_error":
      return { tone: "danger", label: step.error ?? "Tool failed" };
    case "failed":
      return { tone: "danger", label: step.error ?? "Failed" };
  }
}
