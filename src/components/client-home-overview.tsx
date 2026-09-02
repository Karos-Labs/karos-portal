import Link from "next/link";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { relativeTime } from "@/lib/utils";
import { assetStatusLabel } from "@/lib/asset-status-copy";
import { ASSET_TYPE_LABEL } from "@/lib/asset-type-copy";
import { clientDeliveryStamp, isInClientArchive } from "@/lib/asset-visibility";
import { clientArchiveLink } from "@/lib/agent-intake-links";
import { postKind } from "@/lib/calendar-kind";
import { clientSafePublishError } from "@/lib/custom-agent-launch";
import type { Asset, ClientTask } from "@/lib/types";

// ASSET_TYPE_LABEL moved to @/lib/asset-type-copy: the copilot's system prompt
// needs the same words from a server-only module, and a component-local map is
// not reachable from there. Tones stay here — presentation is this file's
// business, the same split asset-status-copy.ts made.
const ASSET_STATUS_TONE: Record<Asset["status"], "warning" | "success" | "info"> = {
  draft: "warning",
  approved: "success",
  scheduled: "info",
  published: "success",
  delivered: "success",
};

/**
 * A glyph for what KIND of deliverable a Recent activity row is (2026-09).
 *
 * Same map asset-card.tsx keeps for the same reason its own note gives: a
 * per-type icon is presentation and belongs with the component that draws one.
 * Two copies of five entries, agreeing, is the shape asset-type-copy.ts's SCOPE
 * note explicitly declines to consolidate.
 */
const TYPE_ICON: Record<string, string> = {
  instagram_post: "Camera",
  email: "Mail",
  article: "Newspaper",
  social_post: "Share2",
  note: "FileText",
};

/** The three inks an attention item can carry, and everything drawn from them. */
const TONE_CLASS = {
  danger: { text: "text-danger", chip: "bg-danger/10", border: "border-danger/30", wash: "bg-danger/[0.06]" },
  warning: { text: "text-warning", chip: "bg-warning/10", border: "border-warning/30", wash: "bg-warning/[0.06]" },
  info: { text: "text-info", chip: "bg-info/10", border: "border-info/30", wash: "bg-info/[0.06]" },
} as const;

type AttentionTone = keyof typeof TONE_CLASS;

/**
 * ONE thing waiting on this reader.
 *
 * A described list rather than five hand-placed JSX blocks, because the card
 * now has to answer "which of these is the most urgent" — and picking a winner
 * out of five conditionals is how the order silently stops matching the
 * priority the copy claims. The array below IS the priority, top to bottom.
 */
interface AttentionItem {
  key: string;
  tone: AttentionTone;
  icon: string;
  /** The count sentence. Wraps; never truncated (see the header note). */
  label: string;
  hint: string;
  /**
   * Where the item is dealt with. OPTIONAL, and the reason is a standing rule
   * rather than an oversight: several of these counts have no screen their
   * reader can open (F97 × F149), so the row reports instead of promising a
   * click it cannot honour. See each item's own comment at the build site.
   */
  href?: string;
  /** The button's words when this item wins the primary slot. */
  action?: string;
}

/**
 * Client-portal welcome widgets: what needs the client's attention right now,
 * plus the latest deliverables produced for them.
 *
 * `assets` MUST arrive already redacted for client viewers - the page passes
 * getClientLibraryAssets(assets, { forClient: true }), so locked (future-dated)
 * posts surface here only as whitelist placeholders (template name as title,
 * type, status - no content/image/meta). Titles are rendered verbatim below, so
 * an un-redacted future title would leak; the redaction stays at the page.
 *
 * THAT SENTENCE IS A CONTRACT, AND ONE FIELD NO LONGER RELIES ON IT.
 * `publishError` holds the platform SDK's own exception, and the attention row
 * below quotes the stored field as its hint. Everything else in this component is a
 * title, a type or a count — a mount that forgot the projection would ship a
 * future title, which is bad; this one would ship a stack-adjacent provider
 * error, and it is the one field with a named client-safe answer. So the row
 * asks `clientSafePublishError` for a client viewer, keyed to this component's
 * own `viewerIsClient` argument.
 *
 * NOT A SECOND RULE — the same function the server boundary calls
 * (lib/asset-visibility applies it to both client asset projections, and that is
 * still what keeps the exception out of the RSC PAYLOAD, which a render can
 * never do). This keeps it off the SCREEN, and the two agree because there is
 * one function rather than two spellings. It is idempotent on an already-safe
 * string, so the doubled call changes nothing on the path that works.
 *
 * ── WHAT THE 2026-09 PASS CHANGED ────────────────────────────────────────
 *
 * The product owner's report on "Needs your attention" was that the widget got
 * cut off and that neither the priority nor the next step was legible: five
 * equal-weight rows, each a single-line-truncated count sentence over a
 * two-line-clamped hint, with no indication which one mattered. So:
 *
 *  • NOTHING IN THE CARD TRUNCATES ANY MORE. Every `truncate` and `line-clamp`
 *    on this card's own copy is gone and the label wraps instead. Truncation was
 *    added when these were single-line counts in a two-column grid; the honest
 *    fix for a sentence too long for its box is to let the box grow, and the
 *    card is in a `space-y` column with nothing under it that a taller card
 *    displaces. (`min-w-0` STAYS — that is CD-H4, a grid-track fix, and is what
 *    stops the card itself from overflowing the shell.)
 *  • THE MOST URGENT ITEM IS RENDERED DIFFERENTLY FROM THE REST: tone-washed
 *    panel, bigger type, and its own action button when it has a destination.
 *    The remainder collapse to compact one-line rows underneath.
 *  • THE COUNT IS IN THE HEADER as "N items", which it already was, plus the
 *    most urgent item's own count inside the panel.
 */
export function ClientHomeOverview({
  clientId,
  tasks,
  assets,
  viewerIsClient = false,
  agentLabelByAssetId,
  recentActivityLimit = 5,
  tasksHitLimit = false,
  channelsNeedingAttention = 0,
  channelsHref,
  draftsHref,
}: {
  /**
   * Whose account this page is. Needed so `clientArchiveLink` resolves the
   * "See all activity" link below for a STAFF reader too — that helper takes
   * the SAME href for either viewer now that Account Center's Archive tab is
   * the one place left to reach it (the Workspace board, and the owner-tab
   * routing `taskBoardHref` used to key into it, are both gone — 2026-08).
   */
  clientId: string;
  tasks: ClientTask[];
  assets: Asset[];
  /** Whose "Recent activity" this is - see the list below (A3/A4). */
  viewerIsClient?: boolean;
  /**
   * assetId → the agent name its row should carry (§7.3 identity, same
   * contentLabelsByAsset join the Workspace archive and Account Center's
   * Archive tab use). Optional — a caller with nothing to join against (no
   * jobs/umbrellas in hand) still gets rows, just without the agent line.
   * Portal revamp: this is what turns "Recent activity" into Home's
   * "Recent Agent Activity" widget (Surface 02).
   */
  agentLabelByAssetId?: Record<string, string>;
  /** How many rows the Recent activity list shows. Default unchanged (5). */
  recentActivityLimit?: number;
  /**
   * Did `tasks` arrive at its query cap? (2026-08)
   *
   * The page fetches with `limit: 50` and every count below is a `.length` of
   * that array, so a client with eighty open items read a flat "50 pending
   * tasks" — a truncation printed as a total, and the two categories eat into
   * one another's share of the same cap. When the cap was hit the counts are
   * suffixed "+", which is the honest reading of a windowed list: at least this
   * many. Optional and defaulting false so a caller that fetches everything
   * (staff, who are handed an empty array anyway) says nothing extra.
   */
  tasksHitLimit?: boolean;
  /**
   * Channels whose token has died (2026-09).
   *
   * INHERITED FROM THE KPI CARD, not invented here. "Your numbers" used to
   * carry a per-channel list with a "N need attention" summary above it, and
   * that list was the duplicate of "Connected channels" the de-duplication pass
   * removed. The list belonged with the detailed card; the WARNING belonged on
   * the card whose entire subject is "what is asking something of you", which
   * is this one. A dead LinkedIn is the most actionable item on the whole
   * dashboard and it now sits at the top of the list that ranks by urgency,
   * with the Settings tab that fixes it one click away.
   *
   * Optional and zero-defaulted so a caller with no integrations in hand simply
   * raises no such row.
   */
  channelsNeedingAttention?: number;
  /** Where a broken channel is reconnected. Required for the row to link. */
  channelsHref?: string;
  /**
   * Where the drafts-in-review row opens, when the reader has such a screen.
   *
   * STAFF ONLY in practice, and that asymmetry is the F97 × F149 rule rather
   * than a missing feature: approval is staff-only (`approveAssetAction` calls
   * `requireStaff`), and no surface a CLIENT can reach lists a draft — the
   * archive excludes them by design and the calendar filters them out — so the
   * count and every candidate client destination are provably disjoint. A
   * caller that passes nothing gets the reporting row it always had.
   */
  draftsHref?: string;
}) {
  const archive = clientArchiveLink({ clientId, isStaff: !viewerIsClient });
  // Counted off the deliverables themselves, not off agent runs in `review` —
  // the row links into the deliverable archive, so the number has to describe
  // the same data the client is about to see.
  const deliverablesInReview = assets.filter((a) => a.status === "draft");
  const reviewPendingTasks = tasks.filter((t) => t.status === "review_pending");
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  // A scheduled post the publish cron couldn't push (rate limit, expired
  // integration, upstream error) used to be silent - status stays "scheduled"
  // forever with only publishError set, and nothing on this page said so.
  // Same "failed" classification the calendar itself renders (calendar-kind.ts)
  // — one predicate, not a second ad hoc copy of it.
  //
  // Which is why an ordering-HELD post is no longer counted here, without a
  // word of it in this file: the cron stores its benign hold in the very same
  // publishError field, so this row used to announce "1 post failed to publish"
  // and then quote the hold sentence as the hint — a red attention row over a
  // paragraph explaining that nothing is wrong. postKind tells the two apart
  // now, and a hold asks nothing of the client, so it belongs on no attention
  // list; the calendar shows it as waiting, which is where it is.
  const failedPublishes = assets.filter((a) => postKind(a) === "failed");
  const attentionCount =
    deliverablesInReview.length +
    reviewPendingTasks.length +
    pendingTasks.length +
    failedPublishes.length +
    channelsNeedingAttention;
  /**
   * "+" when the number is a floor rather than a total (see `tasksHitLimit`).
   * Applied only to the two counts derived from the capped `tasks` array —
   * deliverables, failed publishes and channels come from sets fetched whole,
   * and must not be marked as if they were windowed.
   */
  const more = tasksHitLimit ? "+" : "";

  // Date.now() intentional: the archive is a time-windowed view (30 days) and a
  // future-dated post is not in it yet, so "does this row have a destination"
  // can only be answered against the current moment. Read once per render.
  //
  // The directive has to be the LAST line before the statement - it applies to
  // the next SOURCE line, so with the explanation underneath it was suppressing
  // a comment and the rule fired anyway (an error in the tree since this
  // comment was written, and the "unused directive" warning beside it).
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  /**
   * THE PRIORITY ORDER, and it is the array's order.
   *
   * Ranked by what the item ASKS OF THE READER, not by how many there are:
   * something already broken first, then something the reader must sign off,
   * then work in flight that asks nothing. The two "broken" items are also the
   * two that reliably have a destination, so the primary slot below usually
   * carries a real button — but that is a consequence of the ranking, not the
   * reason for it. Ranking by "has a link" would have put a dead channel below
   * a queue of drafts on the staff branch, which is the wrong answer.
   */
  const items: AttentionItem[] = [];

  if (failedPublishes.length > 0) {
    items.push({
      key: "failed",
      tone: "danger",
      icon: "TriangleAlert",
      label: `${failedPublishes.length} post${failedPublishes.length === 1 ? "" : "s"} failed to publish`,
      // ONE failure quotes the stored reason; several cannot, so they
      // get the destination instead. For a client the stored reason is
      // the one client-safe sentence (it already names the way out:
      // Karos can get it posted), and the row lands them on the
      // calendar chip whose panel repeats it beside the only publish
      // control a client has — "Mark as posted", for the case they
      // posted it themselves. Staff keep the exception: it is the
      // whole diagnostic value of the row.
      hint:
        failedPublishes.length === 1
          ? failedPublishText(failedPublishes[0]!, viewerIsClient)
          : "Review them on the calendar.",
      // The calendar this reader can actually use. A bare `/calendar`
      // is the CROSS-CLIENT overview for staff, so a staff reader on
      // this client's dashboard clicking "3 posts failed to publish"
      // landed on every client's grid and had to find them again —
      // the same wrong-surface defect `clientArchiveLink` above fixes
      // for the archive. A client has no client-scoped route (the
      // staff one redirects them straight back), so theirs stays flat.
      href: viewerIsClient ? "/calendar" : `/clients/${clientId}/calendar`,
      action: "Open calendar",
    });
  }

  if (channelsNeedingAttention > 0) {
    items.push({
      key: "channels",
      tone: "warning",
      icon: "Plug",
      label: `${channelsNeedingAttention} channel${channelsNeedingAttention === 1 ? "" : "s"} need${channelsNeedingAttention === 1 ? "s" : ""} reconnecting`,
      hint: "Posts cannot go out on a channel whose connection has expired.",
      ...(channelsHref ? { href: channelsHref, action: "Reconnect" } : {}),
    });
  }

  if (reviewPendingTasks.length > 0) {
    items.push({
      key: "review-tasks",
      tone: "warning",
      icon: "Eye",
      label: `${reviewPendingTasks.length}${more} task${reviewPendingTasks.length === 1 && !more ? "" : "s"} ready for review`,
      hint: "Completed work waiting for your sign-off.",
      // NOT a link (2026-08): it used to open the Workspace board to this
      // task's own owner tab (`taskBoardHref`), and the board is gone - "The
      // Board is replaced by the action list on Home" (locked decision). The
      // count is still a real, live signal; it just has nowhere left to send
      // the reader, so it reports rather than links. notification-bell.tsx's
      // TaskAlertRow carries the identical ruling for the identical rows.
    });
  }

  if (deliverablesInReview.length > 0) {
    items.push({
      key: "drafts",
      tone: "info",
      icon: "Sparkles",
      label: `${deliverablesInReview.length} deliverable${deliverablesInReview.length === 1 ? "" : "s"} in review`,
      // Approval is staff-only by design (approveAssetAction calls
      // requireStaff so a client can't approve and arm auto-publish),
      // so for a client this row reports status rather than asking for a
      // sign-off, and carries no destination — see `draftsHref`.
      hint: viewerIsClient
        ? "Your Karos team is reviewing these. They'll appear in your archive when ready."
        : "Waiting on your approval before they can be scheduled.",
      ...(draftsHref ? { href: draftsHref, action: "Review drafts" } : {}),
    });
  }

  if (pendingTasks.length > 0) {
    items.push({
      key: "pending-tasks",
      tone: "info",
      icon: "Circle",
      label: `${pendingTasks.length}${more} pending task${pendingTasks.length === 1 && !more ? "" : "s"}`,
      hint: "Your Karos team is working through these.",
      // Same no-destination ruling as the review row above.
    });
  }

  const [primary, ...rest] = items;

  const stampOf = (a: Asset) => (viewerIsClient ? clientDeliveryStamp(a) : a.updatedAt ?? a.createdAt);
  // A3/A4, the treatment its siblings already carry (archive-view, the agent
  // detail page). Two things were wrong with this list for a client.
  //
  // The set: it listed DRAFTS. A draft has not reached the client - approval is
  // staff-only (approveAssetAction calls requireStaff) - and the drafts of one
  // fire are minted in one second, so five rows read "Untitled · 3 hours ago"
  // and published the shape of the generation run on the client's home screen.
  // Their own row above already reports them, in the one honest way: a count,
  // and who is holding them. Stamping alone could not have fixed this: a
  // draft's delivery stamp IS the fire, because nothing has moved it since.
  //
  // The stamp: `updatedAt ?? createdAt` on the rows that remain. Delivered work
  // carries its posting time, or the moment it was approved - the same
  // clientDeliveryStamp the archive sorts, ages and prints by, so a row here
  // and the same row one screen over cannot disagree about when it arrived.
  //
  // Membership is the archive's own predicate, which is also what decides
  // whether the row links (below) - so a client's rows are now exactly the rows
  // with somewhere to go. Staff keep every asset, stamped at generation.
  const eligibleAssets = [...assets]
    .filter((a) => !viewerIsClient || isInClientArchive(a, now))
    .sort((a, b) => stampOf(b) - stampOf(a));
  const recentAssets = eligibleAssets.slice(0, recentActivityLimit);
  const olderCount = eligibleAssets.length - recentAssets.length;

  return (
    /* CD-H4: `min-w-0` on the cards, not decoration. A grid item's automatic
       minimum size is its MIN-CONTENT, so at 375 the track stayed 343 while the
       cards sized themselves to the longest deliverable title - 465px here,
       381px in the reviewer's capture - and the status badges and "Open
       archive" were cut off by the shell's overflow-x-clip. With the floor at 0
       the card takes the track and the rows' existing min-w-0/truncate chain
       does the shortening it was always meant to do. */
    /* `@3xl` (48rem), NOT `lg` (2026-08). Tailwind's `lg:` asks the VIEWPORT,
       and this card sits in a column the 288px rail has already taken a bite
       out of — so at a 1024-1280px window the breakpoint fired on a content
       area barely 700px wide and split it into two ~330px tracks. That is the
       squeezed dashboard in the product owner's capture: "Needs your attention"
       broken over three lines, "16 deliverables in review" wrapping mid-phrase.
       A container query asks the only width that matters here, the one this
       grid actually has, so the same component behaves correctly at every
       window size, zoom level and rail width. */
    <div className="grid gap-6 @4xl:grid-cols-2">
      {/* Needs your attention */}
      <Card className="flex min-w-0 flex-col">
        {/* `flex-wrap`, and the title no longer truncates. The chip is
            `shrink-0`; if the two cannot share a line the chip drops to the
            next one rather than eating the heading. */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex min-w-0 items-center gap-2">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                primary ? TONE_CLASS[primary.tone].chip : "bg-success/10"
              }`}
            >
              <Icon
                name={primary ? "Inbox" : "CircleCheck"}
                className={`h-3.5 w-3.5 ${primary ? TONE_CLASS[primary.tone].text : "text-success"}`}
              />
            </span>
            Needs your attention
          </CardTitle>
          {attentionCount > 0 && (
            <Badge tone={primary ? primary.tone : "neutral"}>
              {attentionCount}
              {more} item{attentionCount === 1 && !more ? "" : "s"}
            </Badge>
          )}
        </div>

        {!primary ? (
          <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success/10">
              <Icon name="CircleCheck" className="h-4 w-4 text-success" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">All caught up</p>
              <p className="text-xs text-muted-2">Nothing is waiting on you right now.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <PrimaryAttention item={primary} />
            {rest.length > 0 && (
              <ul className="space-y-2">
                {rest.map((item) => (
                  <AttentionRow key={item.key} item={item} />
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      {/* Recent activity */}
      <Card className="flex min-w-0 flex-col">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex min-w-0 items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-neon/10">
              <Icon name="Activity" className="h-3.5 w-3.5 text-neon" />
            </span>
            Recent activity
          </CardTitle>
        </div>

        {recentAssets.length === 0 ? (
          <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3">
              <Icon name="FolderOpen" className="h-4 w-4 text-muted-2" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">No deliverables yet</p>
              <p className="text-xs text-muted-2">New assets will show up here as they land.</p>
            </div>
          </div>
        ) : (
          <ul className="mb-3 space-y-2">
            {recentAssets.map((a) => {
              // Same rule as the attention row above: a row links to the
              // archive only when the archive would actually hold it, rather
              // than landing the client on a screen that provably excludes the
              // item they clicked. This used to test `status !== "draft"` - one
              // of the archive's four rules - so a future-dated post, a launch
              // deliverable, or a post already aged past the 30-day window all
              // rendered as links to a list they are not in. One predicate,
              // asked here instead of re-derived.
              const inArchive = isInClientArchive(a, now);
              const agentLabel = agentLabelByAssetId?.[a.id];
              const body = (
                <>
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3">
                    <Icon
                      name={TYPE_ICON[a.type] ?? "FileText"}
                      className="h-4 w-4 text-muted-2"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{a.title}</p>
                    <p className="mt-0.5 text-xs text-muted-2">
                      {agentLabel ? `${agentLabel} · ` : ""}
                      {ASSET_TYPE_LABEL[a.type] ?? a.type} · {relativeTime(stampOf(a))}
                    </p>
                  </div>
                  {/* The register, not the stored enum under CSS `capitalize` —
                      which rendered "Published" to a client whose archive one
                      click away said "Posted", and would have printed any new
                      Firestore status verbatim. The tone map stays: a tone is
                      presentation, a word is copy. */}
                  <Badge tone={ASSET_STATUS_TONE[a.status] ?? "neutral"}>
                    {assetStatusLabel(a.status, viewerIsClient)}
                  </Badge>
                </>
              );
              const base =
                "flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2";
              return (
                <li key={a.id}>
                  {inArchive ? (
                    <Link href={archive.href} className={`${base} row-lift`}>
                      {body}
                    </Link>
                  ) : (
                    <div className={base}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* "See all activity", moved out of the header (2026-09).
            It was a 12px "Open archive" beside the heading — the least
            prominent thing on the card and the only way off it — while the list
            silently stopped at its limit with nothing saying more existed. At
            the foot of a list it reads as the list's continuation, which is
            what it is, and it names how many rows are behind it when it knows.
            `mt-auto` so it sits at the bottom edge whichever card in the pair is
            taller. */}
        <div className="mt-auto border-t border-border pt-3">
          <Link
            href={archive.href}
            className="row-lift flex items-center justify-between gap-2 rounded-md border border-transparent px-3 py-2 text-xs font-medium text-muted hover:text-foreground"
          >
            <span className="min-w-0">
              See all activity
              {olderCount > 0 ? ` (${olderCount} more)` : ""}
            </span>
            <Icon name="ArrowRight" className="h-3.5 w-3.5 shrink-0" />
          </Link>
        </div>
      </Card>
    </div>
  );
}

/**
 * What this reader is told about ONE post that did not go out.
 *
 * Exported for test: the rule is that a client reads no raw provider exception
 * off this row while staff still do, and that is a fact about the returned
 * string rather than about anything rendered around it.
 *
 * The client branch is not a new sentence — it is `clientSafePublishError`, the
 * one that composes the client's answer for every publish surface. On the path
 * that works it is already applied at the server boundary and returns its input
 * unchanged; this is the mechanical version of the docstring at the top of this
 * file, so a mount that hands over un-projected assets loses a title rather than
 * a provider secret.
 *
 * The absent-field branch returns BEFORE the sanitizer rather than falling
 * through it: an in-house fallback line is not a stored publish error, and
 * feeding it to a function whose job is to collapse anything unrecognised would
 * silently replace our own sentence with the generic one. `postKind` makes the
 * branch unreachable for a "failed" post today — it derives that kind FROM the
 * field — and it is kept because "unreachable" is a claim about another module.
 */
export function failedPublishText(asset: Asset, viewerIsClient: boolean): string {
  const stored = asset.publishError;
  if (stored == null) return "Review it on the calendar.";
  return viewerIsClient ? clientSafePublishError(stored) : stored;
}

// `taskBoardHref` (the Workspace board, opened on the tab holding a row's
// work — #101) was removed with the board itself, 2026-08. The two task
// attention items above still count real ClientTask rows; they just report
// rather than link now, since there is nowhere left for them to send the
// reader — see those items' own comments.

/**
 * The most urgent item, rendered as the thing the reader should do next.
 *
 * A washed, tone-bordered panel rather than a fourth identical row: the whole
 * complaint about the old card was that five equal rows communicated no
 * priority, and a badge saying "5 items" over five identical lines does not
 * answer "which one first". The label is `text-base` here and `text-sm` in the
 * rows below, which is the hierarchy doing the work rather than the copy.
 *
 * The button renders only with a destination — see `AttentionItem.href`.
 */
function PrimaryAttention({ item }: { item: AttentionItem }) {
  const tone = TONE_CLASS[item.tone];
  return (
    <div className={`rounded-md border ${tone.border} ${tone.wash} p-3.5`}>
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone.chip}`}>
          <Icon name={item.icon} className={`h-4 w-4 ${tone.text}`} />
        </div>
        <div className="min-w-0 flex-1">
          {/* No truncate, no line-clamp: see the card's own note. */}
          <p className="text-base font-medium leading-snug text-foreground">{item.label}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-2">{item.hint}</p>
        </div>
      </div>
      {item.href && item.action && (
        <Link
          href={item.href}
          className={`mt-3 inline-flex items-center gap-1.5 rounded-md border ${tone.border} bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-neon/50 hover:bg-surface-2`}
        >
          {item.action}
          <Icon name="ArrowRight" className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  );
}

const ATTENTION_ROW_BASE =
  "flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5";

/**
 * A secondary attention item: one compact line, count first.
 *
 * The HINT IS GONE from these rows (2026-09) and that is the "less text-heavy"
 * half of the pass. Below the primary panel the hints were four more sentences
 * of explanation for items the reader has already been told are not the urgent
 * one; the count and its icon are what a scan needs, and the full sentence
 * arrives when the item reaches the top slot. It is kept as the row's `title`
 * so it is still one hover away and reaches a screen reader.
 *
 * `href` is still optional and still honest: a row whose items have no screen
 * this reader can open is a plain status line, with no arrow and no hover
 * affordance, so it does not promise a destination it cannot deliver
 * (F97 × F149).
 */
function AttentionRow({ item }: { item: AttentionItem }) {
  const tone = TONE_CLASS[item.tone];
  const body = (
    <>
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${tone.chip}`}>
        <Icon name={item.icon} className={`h-3.5 w-3.5 ${tone.text}`} />
      </div>
      <p className="min-w-0 flex-1 text-sm text-foreground">{item.label}</p>
      {item.href && <Icon name="ArrowRight" className="h-3.5 w-3.5 shrink-0 text-muted-2" />}
    </>
  );

  return (
    <li>
      {item.href ? (
        <Link href={item.href} title={item.hint} className={`${ATTENTION_ROW_BASE} row-lift`}>
          {body}
        </Link>
      ) : (
        <div title={item.hint} className={ATTENTION_ROW_BASE}>
          {body}
        </div>
      )}
    </li>
  );
}
