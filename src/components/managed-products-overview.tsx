import { Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";

/**
 * Read-only overview of the managed lab agents Karos runs for a client. Clients
 * don't launch these themselves (staff do), but they should still SEE the AI
 * agents working on their account rather than an empty page. Purely
 * presentational — safe to render from a server component.
 */
export function ManagedProductsOverview() {
  return (
    <section className="space-y-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Run by your Karos team</p>
        <p className="mt-1 text-sm text-muted">
          These managed AI agents research, produce, and deliver content for your account. Finished
          work lands in your Library for review.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {MANAGED_PRODUCTS.map((p) => (
          <Card key={p.taskType} className="flex gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
              style={{ color: p.color, background: p.color + "1f" }}
            >
              <Icon name={p.icon} className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{p.name}</p>
              <p className="text-xs text-muted">{p.tagline}</p>
              {p.deliverables.length > 0 && (
                <p className="mt-1.5 text-[11px] text-muted-2">{p.deliverables.join(" · ")}</p>
              )}
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
