import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

/**
 * The runner's shared Claude Agent SDK option plumbing.
 *
 * Both helpers below were moved here VERBATIM out of `main.ts` so the Dynamic
 * Agent Studio's step runner can reuse the exact same plumbing rather than
 * growing a second, parallel copy — Phase 7 asks for the dynamic AI step to
 * "reuse the current options/`options.agents` plumbing", and `main.ts` ends in
 * `void main()`, so importing from it would launch a run as a side effect.
 * Extracting is the only way to share them.
 *
 * This is a pure move: no behaviour change to the hardcoded path, which still
 * calls both functions with the same arguments and gets the same results
 * (pinned by the existing runner suite plus `test/sdk-options.test.ts`).
 */

/**
 * Turns a task config's `stepModels` (from brief.step_models, see
 * resolveTaskConfig) into the SDK's `options.agents` shape — one
 * AgentDefinition per named step. `description`/`prompt` are required by
 * AgentDefinition but are inert placeholders here: this call exists purely to
 * carry a model override for a subagent name the skill's own steps must
 * already delegate to via the Task tool for it to have any effect (see
 * docs/one-pagers/x-agent-v2-integration-contract.md). Reusable verbatim once
 * other agents adopt the same named-subagent-step convention.
 *
 * Every generated definition also gets `effort: "low"` — anything reached
 * through this mechanism is, by construction, a named research/data-gathering
 * fan-out step (never the main creative thread, which keeps its own effort
 * from the task config), so a lighter reasoning budget costs nothing the
 * skill's own synthesis of already-fetched data actually needs.
 */
export function buildStepAgentDefinitions(
  stepModels: Record<string, string> | undefined,
): Record<string, AgentDefinition> | undefined {
  if (!stepModels || Object.keys(stepModels).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(stepModels).map(([step, model]) => [
      step,
      {
        description: `Step "${step}" (model routed via CustomAgent.stepModels)`,
        prompt: `You are the "${step}" step of this run. Follow the skill's own instructions for this step.`,
        model,
        effort: "low",
      } satisfies AgentDefinition,
    ]),
  );
}

/**
 * Environment for the SDK subprocess (and therefore every Bash child the
 * agent spawns). Explicit allowlist: JOB_SPEC_B64 / JOB_SPEC_REF_B64 (runner
 * token) must never reach the sandbox, and nothing beyond what tools
 * legitimately need does.
 * ANTHROPIC_API_KEY has to be present for the CLI itself — proxy-side key
 * injection is the follow-up that removes it from the sandbox entirely.
 * APIFY_TOKEN is optional (skills that read it degrade gracefully when unset);
 * it reaches os.environ for Python skills only because it is allowlisted here.
 */
export function sdkEnv(): Record<string, string> {
  const KEEP = [
    "PATH",
    "HOME",
    "LANG",
    "TERM",
    "NODE_USE_ENV_PROXY",
    "ANTHROPIC_API_KEY",
    // The same key under the name the newsletter scan reads. See buildRunnerEnv.
    "CLAUDE_API_KEY",
    "XAI_API_KEY",
    "APIFY_TOKEN",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
  const env: Record<string, string> = {};
  for (const key of KEEP) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
