import Link from "next/link";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { relativeTime } from "@/lib/utils";
import { assetStatusLabel } from "@/lib/asset-status-copy";
import { ASSET_TYPE_LABEL } from "@/lib/asset-type-copy";
import { clientDeliveryStamp, isInClientArchive } from "@/lib/asset-visibility";
import { clientArchiveLink } from "@/lib/agent-intake-links";
import { postKind } from "@/lib/calendar-kind";
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
 * `assets` MUST arrive already redacted for client viewers — the page passes
 * getClientLibraryAssets(assets, { forClient: true }), so locked (future-dated)
 * posts surface here only as whitelist placeholders (template name as title,
 * type, status — no content/image/meta). Titles are rendered verbatim below, so
 * an un-redacted future title would leak; the redaction stays at the page.
 */
export function ClientHomeOverview({
  clientId,
  tasks,
  assets,
  viewerIsClient = false,
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
  /** Whose "Recent activity" this is — see the list below (A3/A4). */
  viewerIsClient?: boolean;
}) {
  const archive = clientArchiveLink({ clientId, isStaff: !viewerIsClient });
  // Counted off the deliverables themselves, not off agent runs in `review` —
  // the row links into the deliverable archive, so the number has to describe
  // the same data the client is about to see.
  const deliverablesInReview = assets.filter((a) => a.status === "draft");
  const reviewPendingTasks = tasks.filter((t) => t.status === "review_pending");
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  // A scheduled post the publish cron couldn't push (rate limit, expired
  // integration, upstream error) used to be silent — status stays "scheduled"
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

  // Date.now() intentional: the archive is a time-windowed view (30 days) and a
  // future-dated post is not in it yet, so "does this row have a destination"
  // can only be answered against the current moment. Read once per render.
  //
  // The directive has to be the LAST line before the statement — it applies to
  // the next SOURCE line, so with the explanation underneath it was suppressing
  // a comment and the rule fired anyway (an error in the tree since this
  // comment was written, and the "unused directive" warning beside it).
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  // A3/A4, the treatment its siblings already carry (archive-view, the agent
  // detail page). Two things were wrong with this list for a client.
  //
  // The set: it listed DRAFTS. A draft has not reached the client — approval is
  // staff-only (approveAssetAction calls requireStaff) — and the drafts of one
  // fire are minted in one second, so five rows read "Untitled · 3 hours ago"
  // and published the shape of the generation run on the client's home screen.
  // Their own row above already reports them, in the one honest way: a count,
  // and who is holding them. Stamping alone could not have fixed this: a
  // draft's delivery stamp IS the fire, because nothing has moved it since.
  //
  // The stamp: `updatedAt ?? createdAt` on the rows that remain. Delivered work
  // carries its posting time, or the moment it was approved — the same
  // clientDeliveryStamp the archive sorts, ages and prints by, so a row here
  // and the same row one screen over cannot disagree about when it arrived.
  //
  // Membership is the archive's own predicate, which is also what decides
  // whether the row links (below) — so a client's rows are now exactly the rows
  // with somewhere to go. Staff keep every asset, stamped at generation.
  const stampOf = (a: Asset) => (viewerIsClient ? clientDeliveryStamp(a) : a.updatedAt ?? a.createdAt);
  const recentAssets = [...assets]
    .filter((a) => !viewerIsClient || isInClientArchive(a, now))
    .sort((a, b) => stampOf(b) - stampOf(a))
    .slice(0, 5);

  return (
    /* CD-H4: `min-w-0` on the cards, not decoration. A grid item's automatic
       minimum size is its MIN-CONTENT, so at 375 the track stayed 343 while the
       cards sized themselves to the longest deliverable title — 465px here,
       381px in the reviewer's capture — and the status badges and "Open
       archive" were cut off by the shell's overflow-x-clip. With the floor at 0
       the card takes the track and the rows' existing min-w-0/truncate chain
       does the shortening it was always meant to do. */
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Needs your attention */}
      <Card className="min-w-0">
        <div className="mb-4 flex items-center justify-between">
          <CardTitle>Needs your attention</CardTitle>
          {attentionCount > 0 && (
            <Badge tone="warning">
              {attentionCount} item{attentionCount === 1 ? "" : "s"}
            </Badge>
          )}
        </div>

        {attentionCount === 0 ? (
          <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success/10">
              <Icon name="CircleCheck" className="h-4 w-4 text-success" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">All caught up</p>
              <p className="text-xs text-muted-2">Nothing is waiting on you right now.</p>
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            {failedPublishes.length > 0 && (
              <AttentionRow
                tone="danger"
                href="/calendar"
                icon="TriangleAlert"
                label={`${failedPublishes.length} post${failedPublishes.length === 1 ? "" : "s"} failed to publish`}
                hint={
                  failedPublishes.length === 1
                    ? (failedPublishes[0]!.publishError ?? "Review it on the calendar.")
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
                // so it does not contain these either — the count and every
                // candidate destination are provably disjoint. The hint already
                // says the right thing: they show up once the team is done.
                icon="Sparkles"
                label={`${deliverablesInReview.length} deliverable${deliverablesInReview.length === 1 ? "" : "s"} in review`}
                hint="Your Karos team is reviewing these — they'll appear in your archive when ready."
              />
            )}
            {reviewPendingTasks.length > 0 && (
              <AttentionRow
                href={taskBoardHref(reviewPendingTasks)}
                icon="Eye"
                label={`${reviewPendingTasks.length} task${reviewPendingTasks.length === 1 ? "" : "s"} ready for review`}
                hint="Completed work waiting for your sign-off."
              />
            )}
            {pendingTasks.length > 0 && (
              <AttentionRow
                href={taskBoardHref(pendingTasks)}
                icon="Circle"
                label={`${pendingTasks.length} pending task${pendingTasks.length === 1 ? "" : "s"}`}
                hint="Open items on your workspace board."
              />
            )}
          </ul>
        )}
      </Card>

      {/* Recent activity */}
      <Card className="min-w-0">
        <div className="mb-4 flex items-center justify-between">
          <CardTitle>Recent activity</CardTitle>
          <Link
            href={archive.href}
            className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline"
          >
            Open archive
          </Link>
        </div>

        {recentAssets.length === 0 ? (
          <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3">
              <Icon name="FolderOpen" className="h-4 w-4 text-muted-2" />
            </div>
            <div>
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
              // item they clicked. This used to test `status !== "draft"` — one
              // of the archive's four rules — so a future-dated post, a launch
              // deliverable, or a post already aged past the 30-day window all
              // rendered as links to a list they are not in. One predicate,
              // asked here instead of re-derived.
              const inArchive = isInClientArchive(a, now);
              const body = (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{a.title}</p>
                    <p className="mt-0.5 text-xs text-muted-2">
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
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-2">{hint}</p>
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
