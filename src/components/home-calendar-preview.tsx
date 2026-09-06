"use client";

import Link from "next/link";
import { useState } from "react";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import { SocialPlatformMark, type SocialPlatform } from "@/components/agent-identity";
import { Badge, buttonClass, Card, CardTitle, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ASSET_TYPE_LABEL } from "@/lib/asset-type-copy";
import { postKind, postKindLabel } from "@/lib/calendar-kind";
import { platformForAsset } from "@/lib/content-platform";
import type { Asset } from "@/lib/types";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `Button variant="outline"`'s own recipe, for the one place here that needs it
 *  on an anchor. READ from `buttonClass` (round 6) rather than restated, so a
 *  change to the outline voice reaches this link too. */
const OUTLINE_LINK_CLASS = buttonClass({ variant: "outline", size: "sm" });

/**
 * How many dates the preview shows.
 *
 * Exported so the page can sort and cap BEFORE it resolves an identity per row
 * (review wave, 2026-09) — it was resolving one for every upcoming post a client
 * has and then handing all of them over for this component to throw away five
 * rows' worth of work later. The widget still sorts and caps what it is given:
 * a caller that passes more is not a bug, and a second definition of "five"
 * would be.
 */
export const CALENDAR_PREVIEW_ROWS = 5;

function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAY[d.getDay()]} ${d.getDate()}`;
}

/**
 * The clock face for a slot, or null when the slot carries only a DAY.
 *
 * Portal feedback round 4, 2026-09: "Thu 3" alone does not say whether a post
 * goes out with the morning or at close of business, and the schedule already
 * knows. There is no per-client timezone stored anywhere (the chain writes epoch
 * millis and the calendar renders them in whatever zone the reader is in), so
 * this is the BROWSER's local time — the same zone `dayLabel` above has always
 * printed the weekday in, which is what keeps the two halves of this column
 * agreeing with each other.
 *
 * Midnight reads as "no time recorded" rather than as "00:00". A day-only slot
 * is stored as the start of its day (`startOfDayMs`, lib/scheduling), so the two
 * are indistinguishable in the data; printing "12:00 AM" for the whole bulk-
 * uploaded backlog would be a time the client was never promised. The cost is
 * the rare post genuinely booked for midnight showing as day-only, which is the
 * safe direction of the two.
 */
function timeLabel(ms: number): string | null {
  const d = new Date(ms);
  if (d.getHours() === 0 && d.getMinutes() === 0) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * WHAT THE POST IS, once its platform is known.
 *
 * "Social post" was the whole answer this widget gave, and the product owner's
 * reading of it (portal feedback round 4, 2026-09) is the finding: *"What is
 * 'Social post' here?"* — the client's Instagram agent, their X agent and their
 * TikTok agent all delivered rows that read the same, on a card whose entire job
 * is to say what is coming.
 *
 * Keyed by `SocialPlatform` as an exhaustive Record, so a platform added to the
 * mark set is a compile error here rather than a row that silently falls back to
 * the generic noun.
 *
 * Reddit says "reply", not "post": one Reddit run drafts ONE reply and a human
 * posts it from their own account (the draft-only product rule). Naming it a
 * post would promise a thing the product deliberately does not do.
 */
const PLATFORM_NOUN: Record<SocialPlatform, string> = {
  instagram: "Instagram post",
  tiktok: "TikTok post",
  x: "X post",
  linkedin: "LinkedIn post",
  facebook: "Facebook post",
  youtube: "YouTube video",
  reddit: "Reddit reply",
};

/**
 * The nouns for the deliverables that have no platform to be named after — read
 * off the managed task type the asset records, which is the same field
 * `agent-identity-map` resolves a content family from.
 *
 * Not merged into ASSET_TYPE_LABEL: that register is keyed by `AssetType`, and
 * `email` covers more than a newsletter issue while `landing_page` is not an
 * asset type at all. This is the calendar row's own reading of `meta.taskType`,
 * and it degrades to the type register below when the field is absent (which it
 * is on every client-redacted row — `redactLockedAsset` drops `meta`).
 */
const TASK_TYPE_NOUN: Record<string, string> = {
  newsletter_issue: "Newsletter issue",
  blog_article: "Blog article",
  landing_page: "Landing page",
};

function contentNoun(asset: Asset, platform: SocialPlatform | null): string {
  if (platform) return PLATFORM_NOUN[platform];
  const taskType = asset.meta?.taskType;
  if (typeof taskType === "string" && TASK_TYPE_NOUN[taskType]) return TASK_TYPE_NOUN[taskType];
  return ASSET_TYPE_LABEL[asset.type] ?? asset.type;
}

/**
 * One row of the preview: the post, plus the identity of the agent that
 * produced it as the PAGE resolved it.
 *
 * Both agent fields are facts the page looked up, not decisions — the label the
 * archive's headings already print (`contentLabelsByAsset`'s resolver), and the
 * platform that identity resolves to. They are threaded rather than resolved
 * here because resolving an identity needs the client's umbrella agents, their
 * jobs and the UNREDACTED asset, none of which belongs in the browser.
 *
 * NO `agentKey` (review wave, 2026-09). The row used to carry the umbrella's lab
 * repo name ("karos-instagram-tiktok-content-agent") so this file could sniff a
 * platform out of it, which shipped an internal identifier to the browser to
 * re-derive an answer the server already had. The page now runs that same
 * exact-key rung (`platformForAgentIdentity`) itself and sends the token.
 */
export interface CalendarPreviewRow {
  asset: Asset;
  /** The ONE name this content's producing agent goes by ("Instagram Agent"). */
  agentLabel?: string;
  /** The producing agent's platform, resolved on the page from its umbrella. */
  agentPlatform?: string;
}

/**
 * The mark this row leads with, or null when nothing recorded names a platform.
 *
 * `platformForAsset` is the shared ladder (scheduledPlatform → declared channels
 * → the producing agent's platform → an asset type that names a platform → the
 * producing agent's label) — the same resolver the calendar's own chips draw
 * themselves with, so one post cannot carry two logos on two screens. Rung 3 is
 * where the page's resolved `agentPlatform` lands, which is why this file no
 * longer needs a fallback call of its own.
 *
 * Null is a first-class answer and the row simply renders no mark. A wrong logo
 * claims in one glyph that Thursday's work is going somewhere it is not, which
 * is worse than the generic row this feedback replaced.
 */
function rowPlatform(row: CalendarPreviewRow): SocialPlatform | null {
  return platformForAsset(row.asset, row.agentPlatform ? { platform: row.agentPlatform } : null);
}

/**
 * Home's "Calendar Preview" widget (portal revamp, Surface 02) — the next few
 * scheduled dates, in place of the old "Scheduled" counter tile. Clean empty
 * state on day one, same as the calendar itself.
 *
 * ── WHAT IT MEANS BY "UPCOMING" IS NOT THIS FILE'S DECISION (2026-09) ────
 *
 * The caller filters with `isUpcomingPost` (lib/calendar-kind), the predicate
 * the calendar page's own chips are derived from. It used to be a local
 * `a.status === "scheduled" && a.scheduledAt > now` at the page, and that cost
 * a client their whole widget: `postKind` admits `approved` and `draft` with a
 * date too, so a production client with thirteen future-dated APPROVED
 * placeholders on their calendar read "Nothing scheduled yet" here. See
 * `isUpcomingPost` for the full account.
 *
 * This component still trusts its input — it sorts and caps, it does not
 * re-filter — because a second filter here is how the widget and the page came
 * to disagree in the first place.
 *
 * ── THE ROWS OPEN (flow audit 2026-09, R8/F8) ────────────────────────────
 *
 * They were inert, and identical in shape to the rows one screen over that are
 * not: a client reading "Tue 17 · Social post · Instagram" here could open that
 * exact post from the calendar's chip and not from this list. That is the dead
 * end F8 counted. It is fixed as a MOUNT, not a feature — the same
 * `AssetDetailModal` eight other surfaces already open, on the same asset, with
 * the same viewer flag — so a future-dated post shows exactly what the calendar
 * chip shows for it (`asset.locked` renders the "created on its scheduled day"
 * panel and no controls). The set this widget receives is ALREADY
 * client-redacted by the page (`getClientLibraryAssets(..., forClient: true)`),
 * which is what makes it safe for these documents to cross into a "use client"
 * component at all.
 *
 * ── EVERY ROW NOW HAS AN IDENTITY (portal feedback round 4, 2026-09) ─────
 *
 * *"What is 'Social post' here? We should see the logos of which agents."* The
 * rows carried a type name and, at best, a lowercase-ish platform word, so five
 * posts from three different agents read as five copies of one thing. Each row
 * leads with the platform's own mark, names the post in that platform's noun,
 * captions it with the agent that made it, prints the hour beside the day, and
 * carries the calendar's kind chip so a draft does not look like a booked slot.
 *
 * THE REDACTION RULE IS UNCHANGED, and this is the line it draws: a row shows
 * its real TITLE only when the asset is not locked for this viewer. A client's
 * upcoming posts arrive whitelist-redacted (`redactLockedAsset`), and a locked
 * row prints the noun instead — never the stand-in title that copy carries, and
 * never a real one, because a real one never crosses. Everything else the row
 * draws off the asset comes from fields that copy deliberately keeps: `type`,
 * `channels`, `scheduledAt`, `status` and the placeholder marker.
 *
 * THE IDENTITY IS NOT ONE OF THOSE FIELDS, and reading it off the redacted copy
 * was a real defect (review wave, 2026-09): `redactLockedAsset` nulls `jobId`
 * and drops `meta`, so a locked row's producing agent resolved through the
 * weakest rung there is — "the client's live umbrella that owns this content
 * family" — and a client with two live umbrellas in one family got the other
 * one's name and mark on every upcoming post. The page resolves identity from
 * the UNREDACTED asset now and threads the answer onto the redacted row, so the
 * caption is a fact about the post rather than a guess made after the facts were
 * taken away.
 */
export function CalendarPreviewWidget({
  upcoming,
  calendarHref = "/calendar",
  agentsHref,
  viewerIsClient,
}: {
  /**
   * Upcoming posts, any order — this widget sorts and caps them.
   *
   * "Upcoming" is `isUpcomingPost` (lib/calendar-kind), asked by the CALLER.
   * Not "status is scheduled": see the note above for the client whose widget
   * that spelling emptied.
   */
  upcoming: CalendarPreviewRow[];
  /**
   * Where "Open calendar" links to. Defaults to the flat /calendar route,
   * which only resolves to this one client's own calendar for a real
   * CLIENT_USER (its `isClient` branch scopes by `user.clientId`). A staff
   * viewer hits the cross-client overview there instead, so callers
   * rendering this widget for staff must pass the scoped
   * `/clients/[id]/calendar` route explicitly.
   */
  calendarHref?: string;
  /**
   * Where the EMPTY state's control goes — the client's own agent roster
   * (flow audit 2026-09, R9 · NN/g *Empty States*: an empty region must give a
   * direct control that starts the task which would populate it). Nothing here
   * is scheduled until an agent is running, so "See your agents" is that
   * control. Optional only because the caller owns the route: omit it and the
   * empty state renders as it always did rather than guessing a URL.
   */
  agentsHref?: string | undefined;
  /**
   * Which register the kind chip reads. REQUIRED, no default — the same device
   * every other viewer-split component here uses, because a defaulted viewer
   * flag is how a client surface silently acquires the staff vocabulary.
   */
  viewerIsClient: boolean;
}) {
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const next = [...upcoming]
    .filter((row) => typeof row.asset.scheduledAt === "number")
    .sort((a, b) => (a.asset.scheduledAt ?? 0) - (b.asset.scheduledAt ?? 0))
    .slice(0, CALENDAR_PREVIEW_ROWS);

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <CardTitle className="min-w-0 truncate">Calendar</CardTitle>
        <Link
          href={calendarHref}
          className="focus-ring shrink-0 whitespace-nowrap text-xs text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          Open calendar
        </Link>
      </div>
      {next.length === 0 ? (
        <EmptyState
          icon={<Icon name="CalendarClock" className="h-6 w-6" />}
          title="Nothing scheduled yet"
          description="Once your agents start posting, upcoming dates show up here."
          {...(agentsHref
            ? {
                action: (
                  /* The `outline` button's own look, borrowed by a Link (round
                     6): `Button` renders a real <button> and an anchor cannot
                     nest one. It was a fourth hand-rolled outline recipe whose
                     hover turned the border and the label orange, and it carried
                     a chevron after a button label. Both go: rule 2. */
                  <Link href={agentsHref} className={OUTLINE_LINK_CLASS}>
                    See your agents
                  </Link>
                ),
              }
            : {})}
        />
      ) : (
        <ul className="space-y-2">
          {next.map((row) => {
            const a = row.asset;
            const at = a.scheduledAt as number;
            // Every kind is chipped now, the plain scheduled post included: the
            // chip used to be suppressed for it on the reasoning that it is what
            // the card is about, which left a draft and a booked slot looking
            // identical apart from a word the client had to already know.
            const kind = postKind(a);
            const chip = kind ? postKindLabel(kind, viewerIsClient) : null;
            const platform = rowPlatform(row);
            const noun = contentNoun(a, platform);
            // THE redaction line — see the module note. `locked` is set by
            // `redactLockedAsset`, so it is the asset's own answer to "may this
            // viewer read my title", not a re-derivation of the churn rule here.
            const title = a.locked ? noun : (a.title?.trim() || noun);
            // The caption is the agent, so a row says WHO made it. Dropped when
            // it would only repeat the line above it.
            const caption = row.agentLabel && row.agentLabel !== title ? row.agentLabel : null;
            const time = timeLabel(at);
            return (
              <li key={a.id}>
                {/* R8: the whole row is the trigger, it carries `row-lift`, and
                    it ends in one trailing ChevronRight. */}
                <button
                  type="button"
                  onClick={() => setOpenAssetId(a.id)}
                  aria-label={`Open ${title} on ${dayLabel(at)}${time ? ` at ${time}` : ""}`}
                  className="row-lift focus-ring flex w-full items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-left"
                >
                  {/* `suppressHydrationWarning`: both halves are formatted in the
                      reader's own zone (see timeLabel), so the server's render
                      and the browser's legitimately differ. The browser's is the
                      correct one and React keeps it. */}
                  <span className="w-16 shrink-0 leading-tight" suppressHydrationWarning>
                    <span className="block text-xs font-medium text-muted-2">{dayLabel(at)}</span>
                    {time && (
                      <span className="block text-[11px] tabular-nums text-muted">{time}</span>
                    )}
                  </span>
                  {platform && (
                    <SocialPlatformMark
                      platform={platform}
                      className="h-4 w-4 shrink-0 text-foreground/70"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{title}</span>
                    {caption && (
                      <span className="block truncate text-[11px] text-muted">{caption}</span>
                    )}
                  </span>
                  {chip && <Badge tone="neutral">{chip}</Badge>}
                  <Icon name="ChevronRight" className="h-3.5 w-3.5 shrink-0 text-muted-2" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* The eighth opener of the ONE deliverable reader (R8). Same component,
          same viewer flag, same asset — the calendar's chip already opens this
          modal on these very rows. */}
      <AssetDetailModal
        asset={next.find((row) => row.asset.id === openAssetId)?.asset ?? null}
        open={openAssetId != null}
        onClose={() => setOpenAssetId(null)}
        viewerIsClient={viewerIsClient}
      />
    </Card>
  );
}
