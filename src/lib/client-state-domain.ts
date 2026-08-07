/**
 * WHICH STATES A CLIENT'S OWN SURFACES MAY OFFER THEM — derived from the
 * projections those surfaces render from, never from a list anyone types.
 *
 * HISTORY, kept because the mechanism this module builds still depends on it.
 * A filter, a legend or a chart that offers a state the viewer's data cannot be
 * in is at best a control that can only ever empty the list, and at worst a
 * disclosure: it told the client that state existed somewhere in their account.
 * Three surfaces once had exactly that defect:
 *
 *  • The Workspace archive's status filter offered "Draft". `isInClientArchive`
 *    rejects a draft outright, so selecting it could only ever produce "No
 *    matching deliverables". STILL TRUE TODAY — the archive is unaffected by the
 *    reversal below and still withholds "Draft" from a client.
 *  • The calendar legend offered a client a "Draft" chip (directive A3) and the
 *    Performance tab's "Content by status" chart drew a Draft ROW WITH A COUNT,
 *    with the "Deliverables" tile counting the same set (directive A4) — so a
 *    client could read off exactly how many unapproved drafts their team was
 *    holding. BOTH DIRECTIVES WERE DELIBERATELY REVERSED: a client's calendar and
 *    dashboard now show the same pending work staff see, drafts included —
 *    `isClientCalendarStatus` (calendar-kind.ts) always returns `true`, and its
 *    docstring records the decision. What used to be "the fix" for A3/A4 is now
 *    the thing this module's tests pin as the CURRENT, intended behaviour for
 *    those two surfaces; only the archive keeps the old rule.
 *
 * PROBED, NOT DECLARED, and that is the whole design. The answer for each
 * surface is computed by running that surface's own membership rule over every
 * status the union has, so the rule and the control cannot disagree: widen
 * `isInClientArchive` and the archive filter gains an option on its own; narrow
 * it and the option disappears. A hand-written list is a claim about a predicate,
 * checked at most by a test someone has to remember to update.
 *
 * THE PROBE IS AN UPPER BOUND, deliberately, and in the safe direction. Each
 * probe asset is the BEST case for its status — undated, unflagged, just
 * touched — so a status is withheld only when NO asset in that state could pass.
 * Getting that wrong hides a filter a client needed; the opposite bound would
 * offer a control that cannot work. The same argument `calendar-kind`'s
 * unmatchable-key derivation makes about ignoring the RSC redaction.
 *
 * WHAT THIS MODULE DOES NOT OWN. It does not decide membership — `asset-
 * visibility` and `calendar-kind` do, and they are asked rather than restated, so
 * the rule for what a client may see (the archive still excludes drafts; the
 * calendar and dashboard no longer do) is not spelled again here. It does not
 * name a status either: that is `asset-status-copy`'s two registers, and this
 * module only reads their KEYS (a `Record<Asset["status"], string>` tsc keeps
 * total, so reading the keys IS the union — the same device status-render-sweep
 * uses).
 */

import { CLIENT_ASSET_STATUS_LABEL } from "@/lib/asset-status-copy";
import { isInClientArchive } from "@/lib/asset-visibility";
import { isClientCalendarStatus } from "@/lib/calendar-kind";
import type { Asset } from "@/lib/types";

/**
 * Every asset status, in the register's declaration order.
 *
 * DERIVED: `CLIENT_ASSET_STATUS_LABEL` is a `Record<Asset["status"], string>`,
 * which tsc keeps total, so a status added to the type reaches this array with
 * nobody editing this file. The ORDER is the register's, which is also the order
 * the archive's filter used to hard-code (`draft, approved, scheduled,
 * published, delivered`) — so the dropdown reads exactly as it did, minus the
 * option it could never fill.
 */
export const ALL_ASSET_STATUSES = Object.keys(CLIENT_ASSET_STATUS_LABEL) as Asset["status"][];

/**
 * Any instant. The probes below are built relative to it, so the answer does not
 * depend on which one — and taking it as a parameter would be an optional
 * argument a caller could drop, which is how a derived answer quietly becomes a
 * different one at one call site.
 */
const PROBE_AT = 1_700_000_000_000;

/**
 * The BEST-case asset in a given state: no `meta` (so neither the launch-
 * deliverable nor the test-run exclusion bites), no `scheduledAt` (so the
 * future-content lock does not), and touched now (so the archive's 30-day window
 * does not). Anything this shape fails, every real asset in that state fails.
 */
function probe(status: Asset["status"]): Parameters<typeof isInClientArchive>[0] {
  return { status, createdAt: PROBE_AT, updatedAt: PROBE_AT };
}

/**
 * The client-facing surfaces that OFFER an asset state, each paired with the
 * projection that decides what its data can hold.
 *
 * A `Record` over the surface union rather than a bag of functions: adding a
 * surface is a compile error until it names its projection, and the tripwire
 * loops these entries, so a fourth surface is covered the moment it is
 * registered. What that does NOT do is notice a surface nobody registers —
 * stated rather than implied away, because the honest bound of a registry is the
 * registry.
 */
export type ClientStateSurface = "archive" | "performance";

const ADMITS: Record<ClientStateSurface, (status: Asset["status"]) => boolean> = {
  /**
   * Workspace → Archive. The list itself is built by `getClientArchiveAssets`
   * server-side, so `isInClientArchive` is literally the set the filter narrows.
   */
  archive: (status) => isInClientArchive(probe(status), PROBE_AT),
  /**
   * Dashboard → Performance. Its subject is "your content", and what a client
   * HAS is the union of the two projections that define it: the archive, and the
   * calendar's own status filter for the forward-looking half (an approved post
   * dated next month is theirs, and is not in the archive yet).
   *
   * NO LONGER A PROPER SUBSET OF `ALL_ASSET_STATUSES`, by the same product
   * decision recorded on `isClientCalendarStatus`: a client's calendar and
   * dashboard now show the same pending work staff see, drafts included. That
   * function always returns `true` now, so this union is unconditionally `true`
   * regardless of `archive` — kept as an explicit disjunct rather than collapsed
   * to a bare `true`, because the archive half is still real (it is what backs
   * `isClientStateFor("archive", …)`, which stays a proper subset) and because a
   * future narrowing of the calendar half should not have to be reinvented here.
   */
  performance: (status) =>
    isInClientArchive(probe(status), PROBE_AT) || isClientCalendarStatus(status),
};

/** Every registered surface — for the tripwire's loop, and derived from the map. */
export const ALL_CLIENT_STATE_SURFACES = Object.keys(ADMITS) as ClientStateSurface[];

/**
 * Can this surface's own data, for a CLIENT, be in this state?
 *
 * FAILS CLOSED ON A STATUS THE UNION HAS NEVER HEARD OF. The parameter is
 * `string` because the callers derive theirs from stored data, and a Firestore
 * document holding an unrecognised status is not something a client may be shown
 * — `assetStatusLabel` falls back to printing the stored value, which would put
 * a raw database enum on a client's chart. Staff still see it: the callers ask
 * this only for a client viewer.
 */
export function isClientStateFor(surface: ClientStateSurface, status: string): boolean {
  if (!Object.hasOwn(CLIENT_ASSET_STATUS_LABEL, status)) return false;
  return ADMITS[surface](status as Asset["status"]);
}

/**
 * The states this surface may OFFER this viewer, in register order.
 *
 * Staff get the whole union: they read the internal library, and withholding a
 * filter from an operator would be solving a client's disclosure problem by
 * blinding the person who fixes it. The viewer is a REQUIRED argument — a
 * defaulted one is how a client surface silently acquires the staff answer.
 */
export function offeredStatesFor(
  surface: ClientStateSurface,
  viewerIsClient: boolean,
): Asset["status"][] {
  if (!viewerIsClient) return ALL_ASSET_STATUSES;
  return ALL_ASSET_STATUSES.filter((status) => ADMITS[surface](status));
}

/**
 * The rows this surface may COUNT for this viewer.
 *
 * The other half of the same rule, and it has to be the same rule: a chart whose
 * legend omits Draft while its total still counts drafts has moved the
 * disclosure from a label to a number. Both the "Content by status" rows and the
 * "Deliverables" tile go through here.
 */
export function assetsInClientState<T extends { status: string }>(
  surface: ClientStateSurface,
  assets: readonly T[],
  viewerIsClient: boolean,
): T[] {
  if (!viewerIsClient) return [...assets];
  return assets.filter((a) => isClientStateFor(surface, a.status));
}
