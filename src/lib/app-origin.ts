import "server-only";

/**
 * The two origins this app builds URLs from, and the one place each is read.
 *
 * There are exactly two questions, and they are not the same one:
 *   - where does the agent service CALL BACK to  -> webhookCallbackOrigin
 *   - what do links we send a human point at     -> appLinkBase
 *
 * Nine call sites answered them by hand before SCRUM-332 (AU49) surfaced it,
 * and the two that had drifted were both reading `NEXT_PUBLIC_APP_URL` - a
 * variable wired in neither cloudbuild file nor as a build arg, so `undefined`
 * in every deployed environment.
 */

/**
 * The origin the agent service calls back to when a job finishes.
 *
 * WHY THIS IS A FUNCTION AND NOT FOUR COPIES (SCRUM-332 / AU49 follow-up).
 * Four call sites wrote the same three lines by hand -
 * `run-custom-agent.ts`, `submit-managed.ts`, and `submit-custom.ts` TWICE -
 * and one of the four had drifted:
 *
 *     AGENT_SERVICE_CALLBACK_URL ?? APP_URL                 x3
 *     AGENT_SERVICE_CALLBACK_URL ?? NEXT_PUBLIC_APP_URL     x1  <- submit-custom.ts:1117
 *
 * `NEXT_PUBLIC_APP_URL` is wired NOWHERE: not in cloudbuild.yaml, not in
 * cloudbuild.promote.yaml, not as a build arg. So in every deployed
 * environment it is `undefined`, and that one call site had no fallback at
 * all - its own error message named the variable that could never be set. The
 * two correct spellings sat 700 lines apart in the same file.
 *
 * .env.example already explains why `APP_URL` is deliberately NOT
 * `NEXT_PUBLIC_`-prefixed: a `NEXT_PUBLIC_` variable is inlined into the
 * bundle at `next build`, and production is promoted from an already-built
 * prep image, so it would carry whatever URL was baked in at build time
 * whatever the deploy sets. Reading the `NEXT_PUBLIC_` name here was never a
 * second, deliberate URL - it was a typo with three witnesses.
 *
 * `||` AND NOT `??`, which is the second half of the same bug. Prep sets
 * `_AGENT_SERVICE_CALLBACK_URL: ""` in cloudbuild.yaml, so the deploy sets the
 * variable to the EMPTY STRING - which is not nullish. `??` therefore answers
 * `""` and the `APP_URL` fallback is never reached, at all four sites, even
 * the three that named the right variable. `||` treats an empty deploy value
 * as absent, which is what it is.
 */

/** The callback origin, or the sentence to hand back when neither is set. */
export type CallbackOrigin = { origin: string } | { error: string };

/**
 * ONE sentence for all four callers, and it names both variables an operator
 * could set. It used to name `NEXT_PUBLIC_APP_URL` at one site, sending
 * whoever read it to set a variable that does nothing.
 */
export const CALLBACK_ORIGIN_MISSING =
  "AGENT_SERVICE_CALLBACK_URL (or APP_URL) must be set for webhook callbacks.";

export function webhookCallbackOrigin(
  env: Record<string, string | undefined> = process.env,
): CallbackOrigin {
  // `||`: see the header note. An empty deploy value means absent.
  // STRIPPED BEFORE THE CHECK, not after. `\/+$` rather than `\/$`, because a
  // value ending in "//" left one slash behind and produced a double-slashed
  // callback path - but stripping AFTER the emptiness check let APP_URL="/"
  // through as a truthy value that becomes "" the moment it is trimmed, so the
  // callback would have been posted to "/api/agent-service/webhook" with no
  // host at all. That is the same class of failure this module exists to end,
  // reintroduced inside the fix; a test found it.
  const origin = (env.AGENT_SERVICE_CALLBACK_URL || env.APP_URL || "").replace(/\/+$/, "");
  if (!origin) return { error: CALLBACK_ORIGIN_MISSING };
  return { origin };
}


/**
 * The base for a link we put in front of a person - an email, a Jira issue, a
 * digest.
 *
 * FOUR PRIVATE COPIES OF THIS EXISTED and all four were correct:
 * `job-alerts.ts`, `user-actions.ts`, `daily-digest/route.ts` and `oauth.ts`.
 * The fifth reader, `jira.ts`, was not - it interpolated
 * `process.env.NEXT_PUBLIC_APP_URL ?? ""`, so every Jira issue we filed from a
 * meeting carried a link with NO ORIGIN: "/transcripts/<id>", relative to
 * nothing, in a system that is not this app. It failed silently because `?? ""`
 * makes an unset variable render as an empty string rather than an error.
 *
 * The localhost default is what the four copies already did, and it is right:
 * this is a link base, not a credential, and a developer running locally wants
 * a working link rather than a thrown error.
 *
 * Trailing slashes: `\/+$`, which is what three of the four stripped.
 * `oauth.ts` stripped only one, so an APP_URL ending in "//" produced a
 * double-slashed callback path there; stripping all of them is a superset of
 * every previous behaviour.
 */
export function appLinkBase(env: Record<string, string | undefined> = process.env): string {
  // Trimmed BEFORE the fallback, for the reason webhookCallbackOrigin gives:
  // APP_URL="/" is truthy and trims to nothing, so falling back only on a
  // falsy raw value would return an empty base - which is precisely the
  // jira.ts symptom ("/transcripts/<id>", relative to nothing).
  const trimmed = (env.APP_URL ?? "").replace(/\/+$/, "");
  return trimmed || "http://localhost:3000";
}
