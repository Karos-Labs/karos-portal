import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  getClient,
  getClientCredits,
  listAssets,
  listContextItems,
  listCustomAgents,
  listJobs,
} from "@/lib/data";
import { availableCredits, isBillableClientActor } from "@/lib/credits";
import { Button, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ManagedProducts } from "@/components/managed-products";
import {
  ClientManagedAgents,
  type ClientProductStatus,
  type ProductTemplateSummary,
} from "@/components/client-managed-agents";
import {
  ClientCustomAgents,
  type CustomAgentRunRow,
  type RunnableAgentSummary,
} from "@/components/custom-agents";
import { LabImportButton } from "@/components/lab-import";
import { ReplanCalendarButton } from "@/components/replan-calendar-button";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { isLabOutputsConfigured } from "@/lib/lab-outputs";
import {
  AGENT_SERVICE_AGENT_ID,
  MANAGED_PRODUCTS,
} from "@/lib/agent-service/products";
import {
  isAssetUnlockedForClient,
  isReferenceDocAsset,
  isReferenceDocSlug,
  productForAsset,
  templateForAsset,
} from "@/lib/post-chain";
import type { Asset, CustomAgent, Job, ManagedTaskType } from "@/lib/types";

/** Strip an agent to the client-safe summary — never the instructions/skill paths. */
function toSummary(agent: CustomAgent): RunnableAgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    icon: agent.icon,
    color: agent.color,
    creditCost: agent.creditCost ?? null,
  };
}

/** Custom-agent runs as slim rows; `withLinks` adds staff-only /jobs targets. */
function toRunRows(jobs: Job[], withLinks: boolean): CustomAgentRunRow[] {
  return jobs
    .filter((j) => j.agentId === "agent-service" && j.external?.taskType === "custom")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8)
    .map((j) => ({
      id: j.id,
      agentName: j.agentName,
      status: j.status,
      createdAt: j.createdAt,
      ...(j.input.prompt ? { prompt: j.input.prompt } : {}),
      ...(withLinks ? { href: `/jobs/${j.id}` } : {}),
    }));
}

/** Shown when a template has no unlocked post to preview yet — never leaks upcoming content. */
const GENERIC_TEMPLATE_PREVIEW = "New posts in this format land on your calendar automatically.";

/** First sentence of a block of text, whitespace-collapsed and length-capped — a client-safe one-liner. */
function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const match = clean.match(/^.*?[.!?](?=\s|$)/);
  let sentence = match ? match[0].trim() : clean;
  if (sentence.length > 160) sentence = `${sentence.slice(0, 157).trimEnd()}…`;
  return sentence;
}

/** A non-failed agent-service job for this product (a run in progress or completed) marks it live. */
function hasActiveManagedJob(jobs: Job[], taskType: ManagedTaskType): boolean {
  return jobs.some(
    (j) => j.agentId === AGENT_SERVICE_AGENT_ID && j.external?.taskType === taskType && j.status !== "failed",
  );
}

/** Task types this client is "live" on: any asset maps to the product, or a non-failed job exists. */
function liveTaskTypesFor(assets: Asset[], jobs: Job[]): ManagedTaskType[] {
  return MANAGED_PRODUCTS.filter(
    (product) =>
      assets.some((a) => productForAsset(a) === product.taskType) ||
      hasActiveManagedJob(jobs, product.taskType),
  ).map((product) => product.taskType);
}

/**
 * Build the client-facing managed-product status list — ALL summarising happens
 * here, server-side, so only plain values (never raw Asset objects) cross the
 * RSC boundary. Liveness is asset-based (lab-imported content has no job yet
 * still counts) OR a non-failed agent-service job. Template previews are drawn
 * ONLY from already-unlocked content; counts and next-upcoming dates are
 * metadata, so upcoming posts contribute their date but never their content.
 */
function buildProductStatuses(assets: Asset[], jobs: Job[], now: number): ClientProductStatus[] {
  return MANAGED_PRODUCTS.map((product) => {
    // Reference docs (template-ideas overviews) are documentation, not posts —
    // they neither count nor appear as templates, but any produced content
    // (docs included) still marks the product live.
    const allProductAssets = assets.filter((a) => productForAsset(a) === product.taskType);
    const productAssets = allProductAssets.filter((a) => !isReferenceDocAsset(a));
    const live = allProductAssets.length > 0 || hasActiveManagedJob(jobs, product.taskType);

    // Canonical template keys already stamped on assets — passed to templateForAsset
    // so one-off run slugs collapse onto the series they belong to.
    const knownKeys = [
      ...new Set(
        productAssets
          .map((a) => a.templateKey)
          .filter((k): k is string => typeof k === "string" && k.length > 0),
      ),
    ];

    // Group this product's assets by template (locked posts included — the template
    // name and count are metadata; only the preview is gated to unlocked content).
    const byTemplate = new Map<string, { name: string; assets: Asset[] }>();
    for (const a of productAssets) {
      const template = templateForAsset(a, knownKeys);
      if (!template) continue;
      // Overview/explainer items ("template-ideas") describe the templates —
      // they are not templates themselves and never appear in the plan list.
      if (isReferenceDocSlug(template.key)) continue;
      const bucket = byTemplate.get(template.key);
      if (bucket) bucket.assets.push(a);
      else byTemplate.set(template.key, { name: template.name, assets: [a] });
    }

    const templates: ProductTemplateSummary[] = [...byTemplate.entries()].map(
      ([key, { name, assets: templateAssets }]) => {
        // Preview: first sentence of the earliest UNLOCKED post's about text. Upcoming
        // (locked) posts are excluded entirely so future content never leaks.
        const about = templateAssets
          .filter((a) => isAssetUnlockedForClient(a, now))
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .map((a) => a.meta?.about)
          .find((v): v is string => typeof v === "string" && v.trim().length > 0);
        const preview = (about ? firstSentence(about) : "") || GENERIC_TEMPLATE_PREVIEW;
        // Next upcoming date (date only — never content).
        const nextUpcomingAt =
          templateAssets
            .map((a) => a.scheduledAt)
            .filter((s): s is number => typeof s === "number" && s > now)
            .sort((a, b) => a - b)[0] ?? null;
        return { key, name, preview, count: templateAssets.length, nextUpcomingAt };
      },
    );
    templates.sort((a, b) => a.name.localeCompare(b.name));

    const lastAssetAt =
      productAssets.length > 0 ? Math.max(...productAssets.map((a) => a.createdAt)) : null;
    const nextUpcomingAt =
      templates
        .map((t) => t.nextUpcomingAt)
        .filter((s): s is number => s != null)
        .sort((a, b) => a - b)[0] ?? null;

    return {
      taskType: product.taskType,
      name: product.name,
      tagline: product.tagline,
      icon: product.icon,
      color: product.color,
      live,
      assetCount: productAssets.length,
      lastAssetAt,
      nextUpcomingAt,
      templates,
    };
  });
}

/**
 * A client's AI Agents page. Staff launch the managed lab products and any
 * custom agent here; client users see (and fire, billed in credits) only the
 * custom agents an admin granted them in client settings.
 */
export default async function ClientAgentsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const agentServiceConfigured = isAgentServiceConfigured();

  // Client users: their granted custom agents (if any) — otherwise the
  // "your team is on it" state. Managed products stay staff-launched.
  if (!isStaff) {
    const allowedIds = new Set(client.customAgentIds ?? []);
    const [allAgents, jobs, contextItems, credits, assets] = await Promise.all([
      allowedIds.size > 0 ? listCustomAgents() : Promise.resolve([]),
      listJobs({ clientId: id }),
      listContextItems({ clientId: id }),
      getClientCredits(id),
      listAssets({ clientId: id }),
    ]);
    const agents = allAgents.filter((a) => a.enabled && allowedIds.has(a.id)).map(toSummary);
    // Client viewers see only runs of agents they're allowed — not the
    // history of staff-fired agents outside their allowlist.
    const allowedNames = new Set(agents.map((a) => a.name));
    const runs = toRunRows(jobs, false).filter((r) => allowedNames.has(r.agentName));
    // Impersonating admins see the client view but never spend real credits —
    // show the gate only to billable client actors.
    const spendable = isBillableClientActor(user) ? availableCredits(credits) : undefined;
    // Managed products that have already produced content for this client render
    // as LIVE cards (no Run button — clients never launch managed products).
    // Liveness is asset-based, so it holds even when the agent service is
    // unconfigured; every summary is built server-side (no raw Asset crosses).
    const productStatuses = buildProductStatuses(assets, jobs, Date.now());
    const anyProductLive = productStatuses.some((p) => p.live);

    return (
      <>
        <PageHeader
          title="AI Agents"
          description="Your Karos team runs AI agents that research, produce, and deliver content for you."
        />
        {anyProductLive && <ClientManagedAgents products={productStatuses} />}
        {agents.length > 0 && agentServiceConfigured ? (
          <ClientCustomAgents
            clientId={id}
            agents={agents}
            runs={runs}
            contextItems={contextItems}
            viewerIsClient
            {...(spendable !== undefined ? { availableCredits: spendable } : {})}
          />
        ) : anyProductLive ? null : (
          <EmptyState
            icon={<Icon name="Bot" className="h-7 w-7" />}
            title="Your team is on it"
            description="Karos runs managed AI agents for your account. Deliverables appear in your Library once they're approved."
            action={
              <Link href="/assets">
                <Button>Open Library</Button>
              </Link>
            }
          />
        )}
      </>
    );
  }

  const [jobs, contextItems, customAgents, assets] = await Promise.all([
    listJobs({ clientId: id }),
    listContextItems({ clientId: id }),
    listCustomAgents(),
    listAssets({ clientId: id }),
  ]);
  const labImportAvailable = isLabOutputsConfigured();
  // Same asset-OR-job liveness the client sees, so the staff "Live" badge lights
  // up for lab-imported products (which have no job) too. Run stays for staff.
  const liveTaskTypes = liveTaskTypesFor(assets, jobs);
  // Staff get the same clickable live-product cards (template detail included)
  // the client sees — and they must render even when the agent service is not
  // configured: visibility of produced content never depends on the run service.
  const productStatuses = buildProductStatuses(assets, jobs, Date.now());
  const anyProductLive = productStatuses.some((p) => p.live);

  return (
    <>
      <PageHeader
        title="AI Agents"
        description="Run managed lab agents for this client and track their deliverables."
        action={
          <div className="flex items-center gap-3">
            <ReplanCalendarButton clientId={id} />
            {labImportAvailable && <LabImportButton clientId={id} />}
            <a
              href={`/clients/${id}/settings`}
              className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
            >
              Manage integrations →
            </a>
          </div>
        }
      />
      {anyProductLive && (
        <ClientManagedAgents
          products={productStatuses}
          heading="Live for this client"
          subheading="What the managed agents have set up and produced. Open one to see its templates and upcoming deliveries."
        />
      )}
      {agentServiceConfigured ? (
        <>
          <ManagedProducts
            clientId={id}
            contextItems={contextItems}
            jobs={jobs}
            liveTaskTypes={liveTaskTypes}
          />
          <ClientCustomAgents
            clientId={id}
            agents={customAgents.filter((a) => a.enabled).map(toSummary)}
            runs={toRunRows(jobs, true)}
            contextItems={contextItems}
            viewerIsClient={false}
          />
        </>
      ) : (
        <EmptyState
          icon={<Icon name="Bot" className="h-7 w-7" />}
          title="Agent service not configured"
          description="Run controls are unavailable until the agent-service environment variables are set. Existing deliverables and calendars above are unaffected."
        />
      )}
    </>
  );
}
