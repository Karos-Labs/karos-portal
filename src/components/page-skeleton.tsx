import { Skeleton } from "@/components/ui";

/**
 * The loading placeholder for a route segment, in the SHAPE of the page behind
 * it.
 *
 * One skeleton served all thirty-three routes, and it was the dashboard's: four
 * KPI tiles over two wide panels. Every list page therefore flashed a grid of
 * tiles and then re-laid itself out as a table, every detail page flashed the
 * same tiles and became a column, and the calendar flashed them and became a
 * grid. A placeholder whose job is to stop the layout jumping was itself the
 * jump.
 *
 * Three shapes, because three is what the app actually has. Not one per route:
 * a skeleton is a silhouette, and a silhouette that tracks every page exactly
 * is a second copy of the layout to keep in step. These are deliberately
 * coarse — the right number of blocks in the right places, and nothing else.
 */
export type PageShape = "dashboard" | "list" | "detail";

function Header() {
  return (
    <div className="mb-6 space-y-2">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-72" />
    </div>
  );
}

export function PageSkeleton({ shape = "dashboard" }: { shape?: PageShape }) {
  if (shape === "list") {
    // Jobs, assets, clients, transcripts, team: a header and rows. The rows are
    // full width and evenly spaced, which is what makes the real table land on
    // top of them rather than beside them.
    return (
      <div className="animate-fade-in">
        <Header />
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  if (shape === "detail") {
    // One subject with a column of panels beside it: a job, a client, an agent,
    // a transcript. The wide block is the thing being read; the narrow column
    // is its metadata.
    return (
      <div className="animate-fade-in">
        <Header />
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="space-y-4">
            <Skeleton className="h-40 w-full rounded-md" />
            <Skeleton className="h-64 w-full rounded-md" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-28 w-full rounded-md" />
            <Skeleton className="h-44 w-full rounded-md" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <Header />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-md" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-48 w-full rounded-md" />
        <Skeleton className="h-48 w-full rounded-md" />
      </div>
    </div>
  );
}
