import { Badge } from "@/components/ui";
import { platformLabel } from "@/lib/integrations/platforms";
import { relativeTime } from "@/lib/utils";
import type { MonthlyPerformance } from "@/lib/client-performance";

/**
 * WHAT LAST MONTH'S POSTS DID, ON THE CLIENT'S OWN REPORTING TAB.
 *
 * The renewal question, answered where the client already goes to ask it. The
 * tab holds visibility scores (are we findable) and now holds this (did the
 * work land) — two halves of one question that were split across a staff-only
 * block and a page nobody could reach.
 *
 * ## Copy rules, because a client reads this
 *
 * No engine vocabulary, no score without a scale beside it, and a refusal is a
 * SENTENCE rather than a blank panel: "nothing was published in the last 30
 * days" and "the numbers have not come back yet" are different facts, and only
 * one of them asks anybody to do something.
 *
 * Post titles are the client's own words, so they declare their direction.
 */
export function ClientPostPerformance({ performance }: { performance: MonthlyPerformance }) {
  const { posts, best, median, followers, refusal } = performance;

  return (
    <section className="space-y-3">
      <p className="font-label text-[10px] uppercase tracking-[0.08em] text-muted">Last 30 days</p>

      {followers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {followers.map((movement) => (
            <div key={movement.platform} className="rounded-lg border border-border bg-surface px-3 py-2">
              <p className="text-[11px] text-muted-2">{platformLabel(movement.platform)} followers</p>
              <p className="text-sm font-medium tabular-nums">
                {movement.to.toLocaleString()}{" "}
                <span className={movement.change > 0 ? "text-success" : movement.change < 0 ? "text-warning" : "text-muted-2"}>
                  {movement.change > 0 ? "+" : ""}
                  {movement.change.toLocaleString()}
                </span>
              </p>
            </div>
          ))}
        </div>
      )}

      {refusal ? (
        <p className="text-sm text-muted">{refusal}</p>
      ) : (
        <>
          {best && (
            <p className="text-sm text-muted">
              Your strongest post was{" "}
              <span dir="auto" className="font-medium text-foreground">
                {best.title}
              </span>{" "}
              on {platformLabel(best.platform)}, {relativeTime(best.publishedAt)}
              {median !== undefined && best.score > median ? `, scoring ${Math.round(best.score)} against your usual ${Math.round(median)}.` : "."}
            </p>
          )}
          <ul className="space-y-1">
            {posts.map((post) => (
              <li key={post.assetId} className="flex flex-wrap items-baseline gap-2 rounded-md border border-border/60 bg-surface px-3 py-2 text-sm">
                <span dir="auto" className="min-w-0 flex-1 truncate">
                  {post.title}
                </span>
                <Badge tone="neutral">{platformLabel(post.platform)}</Badge>
                <span className="tabular-nums text-muted">{Math.round(post.score)}</span>
                <span className="text-xs text-muted-2">{relativeTime(post.publishedAt)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-2">
            The number beside each post is its engagement out of 100, measured against the same scale on every channel.
          </p>
        </>
      )}
    </section>
  );
}
