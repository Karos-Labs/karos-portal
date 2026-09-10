"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/ui";
import { AssetCard } from "@/components/asset-card";
// The staff register. These words were a local const here; they are unchanged
// byte for byte, and this is now the only place they are written down — the
// analytics chart was printing a third, drifted set of them to the same reader
// (see asset-status-copy.ts).
import { STAFF_ASSET_STATUS_LABEL } from "@/lib/asset-status-copy";
import { ASSET_TYPE_LABEL } from "@/lib/asset-type-copy";
import { deliverableStamp } from "@/lib/asset-visibility";
import { GENERATED_TODAY_TITLE, generatedToday } from "@/lib/generated-today";
import { platformLabel } from "@/lib/integrations/platforms";
// The parser lives beside the function that WRITES `?status=`, so the two
// cannot drift on what the param may contain - see content-status-links.ts.
import type { StatusFilter } from "@/lib/content-status-links";
import type { Asset } from "@/lib/types";

const STATUS_ORDER: Asset["status"][] = ["draft", "approved", "scheduled", "delivered", "published"];
/**
 * The type tabs' order, DERIVED from the label register rather than listed
 * again (SCRUM-423). A sixth AssetType gets a tab the day it is added, and its
 * label comes from the one place that writes these words down.
 */
const TYPE_ORDER = Object.keys(ASSET_TYPE_LABEL) as Asset["type"][];
const STATUS_TONE: Record<Asset["status"], "warning" | "success" | "info"> = {
  draft: "warning",
  approved: "success",
  scheduled: "info",
  delivered: "success",
  published: "success",
};

/**
 * Assets library view. Calendar moved to the dedicated /calendar route so all
 * calendar interactions and post detail modal behavior live in one source.
 */
export function AssetsView({
  assets,
  canApprove = false,
  clientNames,
  connectedPlatformsByClient,
  initialStatus = "all",
  now: nowProp,
}: {
  assets: Asset[];
  /** Staff-only: show approve/schedule controls on each card. Clients never approve. */
  canApprove?: boolean;
  /** Present on the staff-wide view so cards retain their client context. */
  clientNames?: Record<string, string>;
  /**
   * Staff-only, keyed by client: the platforms a post can actually be pushed to.
   * Without it AssetCard's "Publish Now" can never render, so the approve panel's
   * "Manual push" tier names a control that does not exist on this list (F107).
   * Platform ids only - never integration records, which carry decrypted tokens.
   */
  connectedPlatformsByClient?: Record<string, string[]>;
  /**
   * The status this list opens on, seeded from `?status=` by the page (2026-09).
   *
   * A REINTRODUCTION WITH ITS PRODUCER, which is the condition archive-view.tsx's
   * own note sets. A `?status=` reader lived here until 2026-07-31 and was
   * deleted because the one link that fed it had been re-pointed a week earlier,
   * leaving a code path nothing exercised. The producer this time is the
   * dashboard's "Content by status" chart (client-analytics.tsx's `statusHref`),
   * whose whole purpose is to open this list filtered, and both halves are
   * pinned by content-status-deeplink.test.ts.
   *
   * SEED ONLY, not a controlled value: the dropdown owns the filter after the
   * first paint. Re-reading the param on every render would fight the reader,
   * who would change the select and watch it snap back.
   */
  initialStatus?: StatusFilter;
  /**
   * The moment "today" is measured from, resolved SERVER-side by the page.
   * Required rather than defaulted: a default would be the browser's clock, and
   * this list must agree with Home's widget about which day it is.
   */
  now: number;
}) {
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const channels = useMemo(
    () => [...new Set(assets.flatMap((asset) => asset.channels ?? []))].sort(),
    [assets],
  );
  const [channel, setChannel] = useState("all");
  /**
   * SCRUM-423: "instead of the dropdown menu for each type of output, they
   * should all be in that top bar and you click on them to select only that
   * type."
   *
   * THERE WAS NO TYPE DROPDOWN TO REPLACE, which is the interesting half of
   * that report: this page had a STATUS select and a CHANNEL select and no way
   * to filter by what a deliverable IS. A dropdown hides the shape of a
   * collection; tabs show it, and "jumbled mess" is mostly that shape being
   * hidden. So the tabs are new rather than moved, and only the types this list
   * actually holds get one - a tab that always finds nothing is a worse lie
   * than no tab.
   */
  const [type, setType] = useState<Asset["type"] | "all">("all");
  const typesPresent = useMemo(
    () => TYPE_ORDER.filter((t) => assets.some((asset) => asset.type === t)),
    [assets],
  );
  /**
   * THE SERVER'S CLOCK, and it has to be. This is a "use client" component, so
   * `Date.now()` here is an impure read during render (the lint says so) and,
   * worse, it would make the browser's timezone decide which day "today" is -
   * while `runDayKey`, the helper the selector shares with Home's widget, is
   * documented as a SERVER-local calendar day. Two surfaces answering "today"
   * from two different clocks is the drift the shared selector exists to stop,
   * so the page that renders this passes the moment down.
   */
  const now = nowProp;
  const { todayAssets, groupedAssets } = useMemo(() => {
    const matching = assets
      .filter((asset) => status === "all" || asset.status === status)
      .filter((asset) => channel === "all" || asset.channels?.includes(channel))
      .filter((asset) => type === "all" || asset.type === type)
      // SORTED BY THE STAMP THE CARD PRINTS. It was `updatedAt ?? createdAt`
      // while AssetCard prints `relativeTime(asset.createdAt)`, so a deliverable
      // edited today but generated last month sat at the top reading "1 month
      // ago" — the tiles were visibly out of sequence with their own timestamps,
      // which is the reported defect ("even the dates are not in order").
      //
      // archive-view already states this rule and says why in the same words;
      // `deliverableStamp` is the exported form of it. `false` rather than a
      // prop because this route has no client viewer to ask: the page redirects
      // a CLIENT_USER away ("this route stays the staff review surface"), and a
      // staff stamp IS the generation instant.
      .sort((a, b) => deliverableStamp(b, false) - deliverableStamp(a, false));

    /**
     * TODAY IS LIFTED OUT, so the page answers "what just happened" before it
     * answers "what do we have" - the reported order of those two questions.
     * The same selector Home's widget uses (`generatedToday`), because two
     * hand-rolled date filters is how one surface says three things were made
     * today and the other says four.
     *
     * LIFTED, NOT COPIED. A card in both places would double every count on
     * the page. Nothing is hidden by the lift: each row in the Today section
     * carries its own status badge, so a draft made this morning is still
     * visibly a draft, it is just promoted above the library.
     */
    const todayAssets = generatedToday(matching, now);
    const lifted = new Set(todayAssets.map((asset) => asset.id));
    const rest = matching.filter((asset) => !lifted.has(asset.id));

    return {
      todayAssets,
      groupedAssets: STATUS_ORDER.flatMap((groupStatus) => {
        const items = rest.filter((asset) => asset.status === groupStatus);
        return items.length ? [{ status: groupStatus, items }] : [];
      }),
    };
  }, [assets, channel, status, type, now]);

  return assets.length === 0 ? (
    <EmptyState
      icon={<Icon name="FolderOpen" className="h-7 w-7" />}
      title="Nothing here yet"
      description="Your deliverables will show up here as your team creates them."
    />
  ) : (
    <div className="space-y-6">
      {/* THE TYPE TABS, in the top bar, one press per type (SCRUM-423).
          `role="tablist"` is deliberate over a segmented row of plain buttons:
          these select what the page below shows, which is what a tab list IS,
          and it gives a keyboard reader the group semantics a row of buttons
          does not have. Rendered only when there is more than one type to
          choose between - a single tab beside "All" is a control with no
          choice in it. */}
      {typesPresent.length > 1 && (
        <div
          role="tablist"
          aria-label="Filter deliverables by type"
          className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-surface-2 p-1.5"
        >
          {(["all", ...typesPresent] as const).map((option) => {
            const selected = type === option;
            return (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setType(option)}
                /* Round 6, rule 3: the SELECTED tab carries the fill, the rest
                   are quiet and hover muted to foreground. The accent ration is
                   about controls, and exactly one of these is active. */
                className={`focus-ring rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  selected
                    ? "bg-surface text-foreground shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {option === "all" ? "All" : ASSET_TYPE_LABEL[option]}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 p-2">
        <span className="px-1 text-[10px] font-mono font-medium uppercase tracking-[0.12em] text-muted-2">Filter</span>
        <select
          aria-label="Filter assets by status"
          value={status}
          onChange={(event) => setStatus(event.target.value as StatusFilter)}
          className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
        >
          <option value="all">All statuses</option>
          {STATUS_ORDER.map((option) => <option key={option} value={option}>{STAFF_ASSET_STATUS_LABEL[option]}</option>)}
        </select>
        {channels.length > 0 && (
          <select
            aria-label="Filter assets by channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
          >
            <option value="all">All channels</option>
            {/*
              `platformLabel`, not the bare id under CSS `capitalize` — which
              title-cases the first letter of each word and so printed "Linkedin"
              and "Tiktok", misspelling both brands. That is QA F122, recorded
              against the connected-channels card and fixed there; this filter was
              the copy that was missed. The class went with the id: it cannot stay
              once the text is a real label, or "X (Twitter)" would be re-cased too.
            */}
            {channels.map((option) => (
              <option key={option} value={option}>
                {platformLabel(option)}
              </option>
            ))}
          </select>
        )}
        {/* "Newest first" over a list GROUPED BY STATUS claimed an order the page
            does not have: the sections run in lifecycle order (draft first,
            published last), so a published post from today sits below a draft
            from last month. archive-view's identical chip is honest because its
            groups are ordered by their own newest item; these are not, and the
            lifecycle order is the point of them. So the chip says which order it
            is describing instead. */}
        {/* "Newest first" over a list GROUPED BY STATUS claimed an order the
            page does not have, and this chip is the honest version of it. It
            now also has to be true of the Today section above, which is newest
            first within itself - so the sentence describes the rule both
            sections follow rather than either one's position. */}
        <span className="ml-auto px-1 text-[11px] text-muted-2">Newest first in each section</span>
      </div>

      {/* WHAT JUST HAPPENED, before what do we have. Its own section with a
          real heading, above the library rather than mixed into it - "clear
          indication of that upon generating" is the reported ask, and this is
          the LANDING side of it (the run dock owns the completion signal).

          It respects the filters above, because it is a section of this list
          and not a second list: filtering to Drafts and finding a Today section
          full of published posts would be the page disagreeing with its own
          control. */}
      {todayAssets.length > 0 && (
        <section aria-label={GENERATED_TODAY_TITLE}>
          <div className="mb-3 flex items-center gap-2">
            <Badge tone="info">{GENERATED_TODAY_TITLE}</Badge>
            <span className="text-xs text-muted-2">{todayAssets.length}</span>
          </div>
          <div className="grid items-start gap-3 lg:grid-cols-2">
            {todayAssets.map((asset) => (
              <div key={asset.id}>
                {clientNames?.[asset.clientId] && (
                  <div className="mb-1"><Badge tone="neutral">{clientNames[asset.clientId]}</Badge></div>
                )}
                <AssetCard
                  asset={asset}
                  canApprove={canApprove}
                  {...(connectedPlatformsByClient?.[asset.clientId]
                    ? { connectedPlatforms: connectedPlatformsByClient[asset.clientId] }
                    : {})}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {groupedAssets.length === 0 && todayAssets.length === 0 ? (
        <EmptyState
          icon={<Icon name="SearchX" className="h-7 w-7" />}
          title="No matching assets"
          description="Try clearing a filter to see more deliverables."
        />
      ) : (
        groupedAssets.map((group) => (
          <section key={group.status} aria-label={STAFF_ASSET_STATUS_LABEL[group.status]}>
            <div className="mb-3 flex items-center gap-2">
              <Badge tone={STATUS_TONE[group.status]}>{STAFF_ASSET_STATUS_LABEL[group.status]}</Badge>
              <span className="text-xs text-muted-2">{group.items.length}</span>
            </div>
            <div className="grid items-start gap-3 lg:grid-cols-2">
              {group.items.map((asset) => (
                <div key={asset.id}>
                  {clientNames?.[asset.clientId] && (
                    <div className="mb-1"><Badge tone="neutral">{clientNames[asset.clientId]}</Badge></div>
                  )}
                  <AssetCard
                    asset={asset}
                    canApprove={canApprove}
                    {...(connectedPlatformsByClient?.[asset.clientId]
                      ? { connectedPlatforms: connectedPlatformsByClient[asset.clientId] }
                      : {})}
                  />
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
