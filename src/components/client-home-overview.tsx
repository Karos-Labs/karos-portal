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
 */
export function ClientHomeOverview({
  clientId,
  tasks,
  assets,
  viewerIsClient = false,
  agentLabelByAssetId,
  recentActivityLimit = 5,
  tasksHitLimit = false,
}: {
  /**
   * Whose account this page is. Needed only so the archive links resolve for a
   * STAFF reader: `?tab=archive` is read by ProgressView alone, and TasksBody
   * mounts ProgressView only with a client in scope, so the flat
   * `/tasks?tab=archive` these two links used to carry dropped a staff viewer
   * onto the cross-client board with no archive at all — the same defect as #90
   * on the three agent intake pages, found by grepping its shape rather than
   * its symptom.
   *
   * The attention rows below were long read as NOT that shape, on the grounds
   * that the board does hold this client's tasks. It holds them on one of two
   * disjoint OWNER TABS, and a bare `/tasks` picks the wrong one for half of
   * them — see `taskBoardHref` at the foot of this file (#101). Nothing in this
   * card is staff-reachable in practice: the page hands `tasks` an empty array
   * for a staff viewer, so every attention row is a client's.
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
    deliverablesInReview.length + reviewPendingTasks.length + pendingTasks.length + failedPublishes.length;
  /**
   * "+" when the number is a floor rather than a total (see `tasksHitLimit`).
   * Applied only to the two counts derived from the capped `tasks` array —
   * deliverables and failed publishes come from `assets`, which is fetched
   * whole, and must not be marked as if they were windowed.
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
  const stampOf = (a: Asset) => (viewerIsClient ? clientDeliveryStamp(a) : a.updatedAt ?? a.createdAt);
  const recentAssets = [...assets]
    .filter((a) => !viewerIsClient || isInClientArchive(a, now))
    .sort((a, b) => stampOf(b) - stampOf(a))
    .slice(0, recentActivityLimit);

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
      <Card className="min-w-0">
        {/* gap + min-w-0 + a shrink-0 badge: the title truncates, the chip does
            not, and neither pushes the other off the card. */}
        <div className="mb-4 flex items-center justify-between gap-2">
          <CardTitle className="min-w-0 truncate">Needs your attention</CardTitle>
          {attentionCount > 0 && (
            <Badge tone="warning">
              {attentionCount}
              {more} item{attentionCount === 1 && !more ? "" : "s"}
            </Badge>
          )}
        </div>

        {attentionCount === 0 ? (
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
          <ul className="space-y-2">
            {failedPublishes.length > 0 && (
              <AttentionRow
                tone="danger"
                // The calendar this reader can actually use. A bare `/calendar`
                // is the CROSS-CLIENT overview for staff, so a staff reader on
                // this client's dashboard clicking "3 posts failed to publish"
                // landed on every client's grid and had to find them again —
                // the same wrong-surface defect `clientArchiveLink` above fixes
                // for the archive, and `taskBoardHref` below for the board. A
                // client has no client-scoped route (the staff one redirects
                // them straight back), so theirs stays flat.
                href={viewerIsClient ? "/calendar" : `/clients/${clientId}/calendar`}
                icon="TriangleAlert"
                label={`${failedPublishes.length} post${failedPublishes.length === 1 ? "" : "s"} failed to publish`}
                // ONE failure quotes the stored reason; several cannot, so they
                // get the destination instead. For a client the stored reason is
                // the one client-safe sentence (it already names the way out:
                // Karos can get it posted), and the row lands them on the
                // calendar chip whose panel repeats it beside the only publish
                // control a client has — "Mark as posted", for the case they
                // posted it themselves. Staff keep the exception: it is the
                // whole diagnostic value of the row.
                hint={
                  failedPublishes.length === 1
                    ? failedPublishText(failedPublishes[0]!, viewerIsClient)
                    : "Review them on the calendar."
                }
              />
            )}
            {deliverablesInReview.length > 0 && (
              <AttentionRow
                // Approval is staff-only by design (approveAssetAction calls
                // requireStaff so a client can't approve and arm auto-publish),
                // so this row reports status rather than asking for a sign-off.
                //
                // Deliberately NOT a link (F97 × F149). It counts drafts, and no
                // surface a client can reach lists a draft: the archive excludes
                // them by design (asset-visibility.ts getClientArchiveAssets),
                // the calendar filters them out, and /assets redirects clients
                // to /tasks. The Workspace board holds tasks, not deliverables,
                // so it does not contain these either - the count and every
                // candidate destination are provably disjoint. The hint already
                // says the right thing: they show up once the team is done.
                icon="Sparkles"
                label={`${deliverablesInReview.length} deliverable${deliverablesInReview.length === 1 ? "" : "s"} in review`}
                hint="Your Karos team is reviewing these. They'll appear in your archive when ready."
              />
            )}
            {reviewPendingTasks.length > 0 && (
              <AttentionRow
                href={taskBoardHref(reviewPendingTasks)}
                icon="Eye"
                label={`${reviewPendingTasks.length}${more} task${reviewPendingTasks.length === 1 && !more ? "" : "s"} ready for review`}
                hint="Completed work waiting for your sign-off."
              />
            )}
            {pendingTasks.length > 0 && (
              <AttentionRow
                href={taskBoardHref(pendingTasks)}
                icon="Circle"
                label={`${pendingTasks.length}${more} pending task${pendingTasks.length === 1 && !more ? "" : "s"}`}
                hint="Open items on your workspace board."
              />
            )}
          </ul>
        )}
      </Card>

      {/* Recent activity */}
      <Card className="min-w-0">
        <div className="mb-4 flex items-center justify-between gap-2">
          <CardTitle className="min-w-0 truncate">Recent activity</CardTitle>
          <Link
            href={archive.href}
            className="shrink-0 whitespace-nowrap text-xs text-muted underline-offset-2 hover:text-foreground hover:underline"
          >
            Open archive
          </Link>
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
          <ul className="space-y-2">
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
                    <Link href={archive.href} className={`${base} transition-colors hover:border-border-strong`}>
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
      </Card>
    </div>
  );
}

const ATTENTION_ROW_BASE =
  "flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5";

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

/**
 * The Workspace board, opened on a tab that actually holds this row's work (#101).
 *
 * The board has TWO tabs, split by task owner, and they are disjoint by
 * construction: `?owner=client` selects the client tab and anything else — a bare
 * `/tasks` included — selects "karos". So these rows counted tasks of either
 * owner and then sent the client to the karos tab, which for a client whose
 * review-pending work is all client-owned holds none of it. QA F64 fixed exactly
 * this in the notification bell and left it here.
 *
 * KEYED TO A TASK, NOT TO AN OWNER, and that is the point rather than a
 * shorthand. `?task=` makes the board resolve the tab itself
 * (`ownerTab(inferOwner(linkedTask))`), and it OUTRANKS `?owner=` whenever the
 * task resolves — so the decision is asked of the surface that owns it. Building
 * `?owner=` here would mean copying TWO rules that are each already spelled more
 * than once: owner→tab (tasks-board.tsx and notification-bell.tsx) and
 * owner-inference for a task whose `owner` field is unset (tasks-board.tsx,
 * task-dedup.ts, execution-engine.ts, task-sync.ts). Neither of those is this
 * card's to own, and a copy of either is the kind of duplicate this campaign
 * keeps paying for.
 *
 * TWO RESIDUALS, because a promise a file cannot keep is worse than a stated
 * limit:
 *
 *  - The row is a COUNT and the link is singular. When a row's tasks span both
 *    owners, no single link opens a tab holding all of them; this opens the tab
 *    holding the FIRST — the same tab the bell would open for that card — and
 *    the ticket with it. Splitting the row per owner needs the mapping written
 *    here after all.
 *  - "The board holds this task" is not guaranteed, only overwhelmingly likely.
 *    Both surfaces read `listClientTasks` for this client, but with different
 *    windows: this page takes the 50 newest pending/review_pending, the board
 *    the 200 newest of every status. A client with more than 200 live tasks can
 *    therefore have a row whose task the board's page does not contain — and
 *    then `?task=` resolves to nothing and the board opens on its default tab,
 *    which is exactly today's behaviour. It degrades to the bug, never past it.
 *
 * Exported for test: the rule is which PARAM the board is keyed on, and that is
 * a fact about the returned string, not about anything rendered.
 */
export function taskBoardHref(tasks: ClientTask[]): string {
  const first = tasks[0];
  return first ? `/tasks?task=${encodeURIComponent(first.id)}` : "/tasks";
}

/**
 * `href` is optional: a row whose items have no screen a client can open is
 * rendered as a plain status line, with no arrow and no hover affordance, so it
 * does not promise a destination it cannot deliver (F97 × F149).
 */
function AttentionRow({
  href,
  icon,
  label,
  hint,
  tone = "warning",
}: {
  href?: string;
  icon: string;
  label: string;
  hint: string;
  tone?: "warning" | "danger";
}) {
  const body = (
    <>
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone === "danger" ? "bg-danger/10" : "bg-warning/10"}`}>
        <Icon name={icon} className={`h-4 w-4 ${tone === "danger" ? "text-danger" : "text-warning"}`} />
      </div>
      <div className="min-w-0 flex-1">
        {/* `truncate` on the label, `line-clamp-2` on the hint: the label is a
            count sentence that must stay on one line to be readable at a
            glance, and the hint is the part that may lose its tail. */}
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
        <p className="line-clamp-2 text-xs text-muted-2">{hint}</p>
      </div>
      {href && <Icon name="ArrowRight" className="h-3.5 w-3.5 shrink-0 text-muted-2" />}
    </>
  );

  return (
    <li>
      {href ? (
        <Link href={href} className={`${ATTENTION_ROW_BASE} transition-colors hover:border-border-strong`}>
          {body}
        </Link>
      ) : (
        <div className={ATTENTION_ROW_BASE}>{body}</div>
      )}
    </li>
  );
}
