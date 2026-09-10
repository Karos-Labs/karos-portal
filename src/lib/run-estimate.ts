/**
 * The run's `estimate` field on launch profiles and products — data, not copy.
 *
 * No client-facing sentence quotes a duration any more (Albert, 2026-09-10:
 * "Audit everywhere we say it's ready in X minutes: it's never true"). It said
 * "about 30 minutes" and was never measured. Measured off agentEngineRuns, the
 * agent's own work takes about 1.7 min (LinkedIn) to 5.6 min (Instagram); the
 * rest of the old half hour was the human gate after it. Run surfaces show a
 * moving progress bar instead, which answers "how long" without a promise.
 */
export const RUN_ESTIMATE = "a few minutes";
