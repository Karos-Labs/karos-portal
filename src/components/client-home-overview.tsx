import Link from "next/link";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { relativeTime } from "@/lib/utils";
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
}: {
  tasks: ClientTask[];
  assets: Asset[];
}) {
  // Counted off the deliverables themselves, not off agent runs in `review` —
  // the row links into the deliverable archive, so the number has to describe
  // the same data the client is about to see.
  const deliverablesInReview = assets.filter((a) => a.status === "draft");
  const reviewPendingTasks = tasks.filter((t) => t.status === "review_pending");
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  const attentionCount =
    deliverablesInReview.length + reviewPendingTasks.length + pendingTasks.length;

  const recentAssets = [...assets]
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
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
                // /assets bounces client users to /tasks and drops the filter —
                // link straight at the Archive tab where the drafts live.
                href="/tasks?tab=archive"
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
            {recentAssets.map((a) => (
              <li key={a.id}>
                <Link
                  href="/tasks?tab=archive"
                  className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2 transition-colors hover:border-border-strong"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{a.title}</p>
                    <p className="mt-0.5 text-xs text-muted-2">
                      {ASSET_TYPE_LABEL[a.type] ?? a.type} · {relativeTime(a.updatedAt ?? a.createdAt)}
                    </p>
                  </div>
                  <Badge tone={ASSET_STATUS_TONE[a.status] ?? "neutral"} className="capitalize">
                    {a.status}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function AttentionRow({
  href,
  icon,
  label,
  hint,
}: {
  href: string;
  icon: string;
  label: string;
  hint: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5 transition-colors hover:border-border-strong"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/10">
          <Icon name={icon} className="h-4 w-4 text-warning" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-2">{hint}</p>
        </div>
        <Icon name="ArrowRight" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
      </Link>
    </li>
  );
}
