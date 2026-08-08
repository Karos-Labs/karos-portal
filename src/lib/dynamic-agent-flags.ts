import "server-only";

/**
 * // DECISION: code-step execution ships behind a
 * feature flag, default OFF, so an AI-only dynamic agent is fully usable
 * while the sandbox has not yet had a security review. agent-service reads
 * the SAME env var name on its own side (runner/src/dynamic/code-sandbox.ts)
 * to gate actual execution — this only gates whether the Portal lets an
 * admin author a code step at all.
 */
export function isDynamicCodeStepsEnabled(): boolean {
  return process.env.DYNAMIC_CODE_STEPS_ENABLED === "true";
}
