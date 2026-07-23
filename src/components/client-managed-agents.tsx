"use client";

import { useState } from "react";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentIdentity, AgentPlatformBadges } from "@/components/agent-identity";
import { Modal } from "@/components/modal";
import { formatDate } from "@/lib/utils";
import type { ManagedTaskType } from "@/lib/types";

/**
 * One template/format this client has received under a managed product. Built
 * server-side (see the client agents page) — every field is a plain, client-safe
 * value: the preview is drawn ONLY from already-unlocked content, and the count
 * and next-upcoming date are metadata (never post content).
 */
export interface ProductTemplateSummary {
  key: string;
  name: string;
  /** First sentence of an unlocked post's about text, or a generic line. Never upcoming content. */
  preview: string;
  /** Posts of this template in the client's plan (locked + unlocked). */
  count: number;
  /** Soonest strictly-future scheduled slot for this template (epoch millis), or null. Date only. */
  nextUpcomingAt: number | null;
}

/** Per managed-product status for one client, computed server-side from assets + jobs. */
export interface ClientProductStatus {
  taskType: ManagedTaskType;
  name: string;
  tagline: string;
  /** lucide icon name (see components/icon.tsx). */
  icon: string;
  /** icon chip hex color. */
  color: string;
  /** ≥1 asset maps to this product (productForAsset), or a non-failed agent-service job exists for it. */
  live: boolean;
  assetCount: number;
  lastAssetAt: number | null;
  /** Soonest strictly-future scheduled slot across this product's templates (epoch millis), or null. */
  nextUpcomingAt: number | null;
  templates: ProductTemplateSummary[];
}

/**
 * Client-facing view of the managed AI agents (karos-agents lab products).
 *
 * Products that have already produced content render as LIVE cards — no Run
 * button (clients never launch managed products; that stays a staff, credit-free
 * action) — with a clickable detail listing the templates set up for this
 * client. Products that have not produced anything render as muted,
 * non-interactive placeholders, shown only once at least one product is live (a
 * brand-new client with nothing live sees nothing here and keeps the page's
 * existing empty state).
 *
 * Purely presentational: all summaries arrive pre-computed from the server, and
 * previews are derived from unlocked content only — no upcoming content or raw
 * Asset ever crosses the RSC boundary.
 */
export function ClientManagedAgents({
  products,
  heading = "Your content agents",
  subheading = "The managed AI agents producing content for your brand. Open one to see the formats in your plan.",
}: {
  products: ClientProductStatus[];
  heading?: string;
  subheading?: string;
}) {
  const [active, setActive] = useState<ClientProductStatus | null>(null);

  const liveProducts = products.filter((p) => p.live);
  if (liveProducts.length === 0) return null;
  const dormantProducts = products.filter((p) => !p.live);

  return (
    <section className="mt-10">
      <div className="mb-4">
        <h2 className="text-xl text-foreground">{heading}</h2>
        <p className="mt-0.5 text-sm text-muted">{subheading}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {liveProducts.map((product) => (
          <LiveProductCard key={product.taskType} product={product} onOpen={() => setActive(product)} />
        ))}
        {dormantProducts.map((product) => (
          <DormantProductCard key={product.taskType} product={product} />
        ))}
      </div>

      {active && <TemplatesModal product={active} onClose={() => setActive(null)} />}
    </section>
  );
}

/* ── Live card (clickable → template detail) ─────────────────────────── */

function LiveBadge() {
  return (
    <Badge tone="success">
      <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-neon" aria-hidden="true" /> Live
    </Badge>
  );
}

function LiveProductCard({
  product,
  onOpen,
}: {
  product: ClientProductStatus;
  onOpen: () => void;
}) {
  const templateCount = product.templates.length;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card-grad group relative flex min-h-52 flex-col overflow-hidden rounded-[var(--radius)] border border-border p-5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lg"
    >
      <span className="absolute inset-x-0 top-0 h-0.5 opacity-45 transition-opacity group-hover:opacity-80" style={{ background: product.color }} aria-hidden="true" />
      <div className="flex items-start gap-3">
        <AgentIdentity identity={`${product.name} ${product.tagline}`} icon={product.icon} color={product.color} />
        <div className="min-w-0 flex-1">
          <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-2">Managed agent</p>
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium">{product.name}</p>
            <LiveBadge />
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted">{product.tagline}</p>
        </div>
      </div>

      <div className="mt-3">
        <AgentPlatformBadges identity={`${product.name} ${product.tagline}`} />
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-4">
        <p className="text-xs text-muted-2">
          {product.assetCount} post{product.assetCount !== 1 ? "s" : ""} · {templateCount} template
          {templateCount !== 1 ? "s" : ""}
          {product.nextUpcomingAt != null && (
            <span className="ml-1.5">· next {formatDate(product.nextUpcomingAt)}</span>
          )}
        </p>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted">
          View templates <Icon name="ChevronRight" className="h-3.5 w-3.5" />
        </span>
      </div>
    </button>
  );
}

/* ── Dormant card (informational only — never a run affordance) ──────── */

function DormantProductCard({ product }: { product: ClientProductStatus }) {
  return (
    <div className="flex min-h-48 flex-col rounded-[var(--radius)] border border-dashed border-border p-5 opacity-70">
      <div className="flex items-start gap-3">
        <AgentIdentity identity={`${product.name} ${product.tagline}`} icon={product.icon} color={product.color} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-muted">{product.name}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-2">{product.tagline}</p>
        </div>
      </div>
      <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">Not set up yet</p>
    </div>
  );
}

/* ── Template detail modal ───────────────────────────────────────────── */

function TemplatesModal({
  product,
  onClose,
}: {
  product: ClientProductStatus;
  onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose} title={product.name} description={product.tagline}>
      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <LiveBadge />
          <span className="text-xs text-muted">
            {product.assetCount} post{product.assetCount !== 1 ? "s" : ""} in your plan
          </span>
        </div>

        {product.templates.length === 0 ? (
          <p className="rounded-md border border-border bg-surface-2 px-3 py-3 text-sm text-muted">
            Your first posts are being produced - the formats will appear here as they land on your calendar.
          </p>
        ) : (
          <div className="space-y-2">
            {product.templates.map((t) => (
              <div key={t.key} className="rounded-md border border-border bg-surface-2 px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge tone="neon">{t.name}</Badge>
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
                    {t.count} post{t.count !== 1 ? "s" : ""}
                    {t.nextUpcomingAt != null && ` · next ${formatDate(t.nextUpcomingAt)}`}
                  </span>
                </div>
                <p className="mt-1.5 text-xs text-muted">{t.preview}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
