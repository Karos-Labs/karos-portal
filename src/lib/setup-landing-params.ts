/**
 * THE TWO THINGS EVERY LADDER LANDING DOES WITH THE URL (round 6 review, E14).
 *
 * The ladder sends a client to a surface with `?<key>=…&for=<stepId>`
 * (`setup-ladder.ts`'s `profileFieldHref` / `contextDocHref`). Every landing
 * surface then has to answer the same two questions — "was I actually sent
 * here?" and "how do I take the params back off the URL once I have answered?"
 * — and `client-profile-panel.tsx` and `client-documents.tsx` had grown a copy
 * of each: two `SETUP_STEP_IDS.some(...)` expressions and two
 * `new URL(location.href)` / `history.replaceState` blocks that differed only
 * in WHICH keys they deleted. Two copies of a rule about the URL is how one of
 * them ends up preserving the hash and the other dropping it.
 *
 * Deliberately a separate module from `setup-ladder.ts`: these two functions
 * touch `window`, and `setup-ladder.ts` is imported by server components that
 * resolve the ladder. Importing the keys rather than restating them keeps the
 * rename-in-one-place property `SETUP_LANDING_KEYS` exists for.
 */

import { SETUP_LANDING_KEYS, SETUP_STEP_IDS } from "@/lib/setup-ladder";

/**
 * The read side of `useSearchParams()`, structurally — so this module works for
 * a `URLSearchParams`, Next's `ReadonlyURLSearchParams`, or anything else that
 * answers `get`. Nothing here needs to write to the bag.
 */
type ReadableParams = { get(name: string): string | null };

/**
 * Did the ladder send this client here? `for=` has to name a REAL step id, so a
 * stale or hand-typed link lands on the ordinary tab rather than opening a form
 * nobody asked for — the same "fail open" rule the calendar's own params follow.
 */
export function landedFromLadder(params: ReadableParams): boolean {
  const from = params.get(SETUP_LANDING_KEYS.for);
  return SETUP_STEP_IDS.some((id) => id === from);
}

/**
 * Drop the given landing keys from the current URL without a navigation, so the
 * band and its outline do not come back on the next render or a Back press.
 *
 * `for=` is not implied: each caller names every key it owns, because the only
 * thing this function may safely assume about a URL is what it was told. The
 * hash is preserved — the documents landing is reached at `#documents`, and
 * rewriting the URL without it would scroll-jump the client away from the
 * section they were just sent to.
 */
export function dropLandingParams(keys: readonly string[]): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const key of keys) url.searchParams.delete(key);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
