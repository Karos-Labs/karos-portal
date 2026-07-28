import Link from "next/link";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { relativeTime } from "@/lib/utils";
import { clientDeliveryStamp, isInClientArchive } from "@/lib/asset-visibility";
import type { Asset, ClientTask } from "@/lib/types";

const ASSET_TYPE_LABEL: Record<Asset["type"], string> = {
  instagram_post: "Instagram post",
  social_post: "Social post",
  email: "Email",
  article: "Article",
  note: "Note",
};

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
  tasks,
  assets,
  viewerIsClient = false,
}: {
  tasks: ClientTask[];
  assets: Asset[];
  /** Whose "Recent activity" this is — see the list below (A3/A4). */
  viewerIsClient?: boolean;
}) {
  // Counted off the deliverables themselves, not off agent runs in `review` —
  // the row links into the deliverable archive, so the number has to describe
  // the same data the client is about to see.
  const deliverablesInReview = assets.filter((a) => a.status === "draft");
  const reviewPendingTasks = tasks.filter((t) => t.status === "review_pending");
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  const attentionCount =
    deliverablesInReview.length + reviewPendingTasks.length + pendingTasks.length;

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
                href="/tasks"
                icon="Eye"
                label={`${reviewPendingTasks.length} task${reviewPendingTasks.length === 1 ? "" : "s"} ready for review`}
                hint="Completed work waiting for your sign-off."
              />
            )}
            {pendingTasks.length > 0 && (
              <AttentionRow
                href="/tasks"
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
            href="/tasks?tab=archive"
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
                  <Badge tone={ASSET_STATUS_TONE[a.status] ?? "neutral"} className="capitalize">
                    {a.status}
                  </Badge>
                </>
              );
              const base =
                "flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2";
              return (
                <li key={a.id}>
                  {inArchive ? (
                    <Link href="/tasks?tab=archive" className={`${base} transition-colors hover:border-border-strong`}>
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
 * `href` is optional: a row whose items have no screen a client can open is
 * rendered as a plain status line, with no arrow and no hover affordance, so it
 * does not promise a destination it cannot deliver (F97 × F149).
 */
function AttentionRow({
  href,
  icon,
  label,
  hint,
}: {
  href?: string;
  icon: string;
  label: string;
  hint: string;
}) {
  const body = (
    <>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/10">
        <Icon name={icon} className="h-4 w-4 text-warning" />
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
