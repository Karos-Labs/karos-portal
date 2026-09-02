import { ALL_ASSET_STATUSES, isClientStateFor } from "@/lib/client-state-domain";
import type { Asset } from "@/lib/types";

/**
 * WHERE A CONTENT-STATUS NUMBER OPENS THE CONTENT IT COUNTS (2026-09).
 *
 * One function, because there are now two producers of the same deep link and
 * a second spelling is how they come to disagree: the dashboard's "Content by
 * status" chart (client-analytics.tsx) and the KPI card's published-content
 * cell (home-kpis.tsx, via clients/[id]/page.tsx). Both mean "show me the
 * deliverables in this state", and both have to resolve it to the surface THIS
 * reader reviews content on:
 *
 *  • STAFF go to the client's Library, `/clients/[id]/assets?status=…`, which is
 *    where approving happens.
 *  • A CLIENT goes to Account Center's Archive tab,
 *    `?tab=archive&status=…`, their own list of delivered work.
 *
 * RETURNS NULL rather than a link for a status a client's archive cannot hold,
 * which is the F97 × F149 rule the dashboard's attention rows already follow: a
 * link is only honest if the list behind it can contain the rows the number
 * counted. The chart's rows come from `assetsInClientState("performance", …)`,
 * which admits drafts for a client by a deliberate 2026-08 reversal, while
 * `isInClientArchive` still rejects them — so "Draft: 4" is a legitimate bar
 * whose only candidate destination provably excludes every row behind it. The
 * question is asked of `client-state-domain` rather than answered here, so
 * widening either projection moves this with it.
 *
 * THE `?status=` PARAM HAS A LIVE PRODUCER AGAIN, which is the condition
 * archive-view.tsx's own long note sets for its reintroduction: it deleted the
 * previous pair of readers in 2026-07 precisely because their producer had been
 * re-pointed a week earlier, and asks that any revival ship WITH its producer
 * and a test. This module is that producer; `content-status-deeplink.test.ts`
 * is that test, and it pins both ends.
 */
export function contentStatusHref(
  status: string,
  clientId: string,
  viewerIsClient: boolean,
): string | null {
  const q = encodeURIComponent(status);
  if (!viewerIsClient) return `/clients/${clientId}/assets?status=${q}`;
  if (!isClientStateFor("archive", status)) return null;
  return `/clients/${clientId}/settings?tab=archive&status=${q}`;
}

/** The status filter's own value: a stored status, or the unfiltered default. */
export type StatusFilter = Asset["status"] | "all";

/**
 * A `?status=` value from the URL, as a filter one of these lists can hold.
 *
 * FAILS OPEN, deliberately: an unrecognised param yields the unfiltered list,
 * never an empty one. A typo'd or stale deep link that silently emptied the
 * library would read as "this client has no content", which is the worst
 * available answer to a bad parameter.
 *
 * LIVES HERE, next to the function that WRITES the param, so the producer and
 * the parser cannot drift apart on what the param may contain. It is also why
 * this module has to stay free of `server-only` transitively: the parser is
 * called from a client component (assets-view.tsx) and the writer from server
 * ones, and `client-state-domain` is pure by its own design.
 *
 * The accepted set is `ALL_ASSET_STATUSES`, which is derived from a
 * `Record<Asset["status"], string>` and so gains a status the moment the type
 * does. A CLIENT surface narrows further, at its own boundary, through
 * `offeredStatesFor` — this function answers "is that a status", not "may this
 * reader filter by it".
 */
export function statusFilterFromParam(param: string | undefined): StatusFilter {
  return param && (ALL_ASSET_STATUSES as string[]).includes(param)
    ? (param as Asset["status"])
    : "all";
}
