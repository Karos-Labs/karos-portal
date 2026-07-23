import Link from "next/link";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { relativeTime } from "@/lib/utils";
import type { Asset, ClientTask, Job } from "@/lib/types";

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
  jobs,
  tasks,
  assets,
}: {
  jobs: Job[];
  tasks: ClientTask[];
  assets: Asset[];
}) {
  const awaitingApproval = jobs.filter((j) => j.status === "review");
  const reviewPendingTasks = tasks.filter((t) => t.status === "review_pending");
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  const attentionCount = awaitingApproval.length + reviewPendingTasks.length + pendingTasks.length;

  const recentAssets = [...assets]
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, 5);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Needs your attention */}
      <Card>
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
              <Icon name="CheckCircle2" className="h-4 w-4 text-success" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">All caught up</p>
              <p className="text-xs text-muted-2">Nothing is waiting on you right now.</p>
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            {awaitingApproval.length > 0 && (
              <AttentionRow
                // Client users cannot open the staff-only Jobs screen. Draft
                // deliverables are reviewed from their library instead.
                href="/assets?view=library&status=draft"
                icon="Sparkles"
                label={`${awaitingApproval.length} post${awaitingApproval.length === 1 ? "" : "s"} awaiting your approval`}
                hint="Review and approve to keep content moving."
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
                hint="Open items on your task board."
              />
            )}
          </ul>
        )}
      </Card>

      {/* Recent activity */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <CardTitle>Recent activity</CardTitle>
          <Link
            href="/tasks"
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
                  href="/tasks"
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
