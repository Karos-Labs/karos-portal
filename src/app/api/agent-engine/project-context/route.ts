import { type NextRequest, NextResponse } from "next/server";
import { listClients, listClientContextDocs } from "@/lib/data";
import { projectClientToWorkspace, selectDocsForProjection } from "@/lib/agent-engine/context-doc-projection";
import { isWorkspaceWriterConfigured } from "@/lib/agent-engine/workspace-writer";
import { requireCronSecret } from "@/lib/cron-auth";

export const maxDuration = 300;

/**
 * T-B13 / SCRUM-243 — the backfill across all clients.
 *
 * ## Why this is a route and not a `scripts/backfill-*.ts`
 *
 * Every other backfill in this repo is a `tsx` script, and this one cannot be:
 * `context-doc-projection.ts` and `workspace-writer.ts` both open with
 * `import "server-only"`, which throws outside a Next server context.
 *
 * The established way out is the one `backfill-brand-role-scalars.ts` took —
 * inline the logic and accept the drift, which its own comment flags as a risk
 * ("there is no test pinning the two against each other"). That trade is fine
 * for four pure colour functions. It is not fine for the projector: it is ~150
 * lines, it defines the exact on-disk contract the engine reads back, and a
 * backfill that wrote a SLIGHTLY different shape from the dispatch path would
 * produce a fleet where some clients' files are subtly wrong and nothing says
 * which. Running inside Next costs one route and duplicates nothing.
 *
 * It also lands where the projection has to work anyway. A script proves the
 * projector runs on a laptop with a service-account key; this proves it runs as
 * the deployed runtime identity, against the bucket that identity can actually
 * write — which, on this system's history, is the half that breaks.
 *
 * ## Invocation
 *
 *   # dry run — reports reach, writes nothing
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        "$PORTAL/api/agent-engine/project-context"
 *
 *   # write
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        "$PORTAL/api/agent-engine/project-context?apply=1"
 *
 *   # one client
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        "$PORTAL/api/agent-engine/project-context?apply=1&clientId=abc123"
 *
 * DRY RUN IS THE DEFAULT, matching every backfill script in this repo: the
 * credentials behind this route point at a real environment's bucket, and the
 * dry run answers the question that actually matters before a write — how many
 * clients this reaches, and how many are skipped for want of an
 * `agentsRepoSlug`. The write itself is idempotent and derived entirely from
 * the client record, so a second `--apply` is a no-op rather than a risk.
 *
 * ## Not scheduled
 *
 * Deliberately not on a cron. Every path that MATTERS now projects on its own —
 * `dispatchAgentEngineRun` before each run (SCRUM-482), and the save actions
 * through `project-on-save.ts`. A sweep on top of those would re-derive the
 * same bytes for every client every tick to fix a staleness window that no
 * longer exists. This is a backfill: run it once per environment to seed the
 * clients who predate the projector, and after that when something has clearly
 * drifted.
 */
export async function GET(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const apply = req.nextUrl.searchParams.get("apply") === "1";
  const onlyClientId = req.nextUrl.searchParams.get("clientId");

  if (!isWorkspaceWriterConfigured()) {
    // A 200 with `configured: false`, not a 500. "The bucket is not set in this
    // environment" is a true and complete answer to the question asked, and a
    // backfill that reports it as a server error gets retried forever.
    return NextResponse.json(
      { ok: true, configured: false, reason: "AGENT_ENGINE_WORKSPACE_BUCKET is not set", applied: false, clients: [] },
      { status: 200 },
    );
  }

  const all = await listClients();
  const clients = onlyClientId ? all.filter((c) => c.id === onlyClientId) : all;

  const results: Array<{
    clientId: string;
    slug: string | null;
    projected: boolean;
    contextDocs: number;
    brand: boolean;
    reason?: string;
  }> = [];

  for (const client of clients) {
    // Reported rather than filtered out. A client with no `agentsRepoSlug` has
    // no workspace to write to, and that is the single most likely reason a
    // backfill "succeeded" while a particular client's agents kept reading
    // nothing — so it belongs in the output, named, not silently dropped from
    // the denominator. (See the lab-clients/profileSource incident.)
    if (!client.agentsRepoSlug) {
      results.push({ clientId: client.id, slug: null, projected: false, contextDocs: 0, brand: false, reason: "no agentsRepoSlug" });
      continue;
    }
    try {
      const docs = await listClientContextDocs(client.id);
      if (!apply) {
        // The dry run answers with what a write WOULD produce, computed by the
        // projector's own selector rather than by counting `docs` — the
        // difference between "this client has 14 documents" and "5 of them are
        // in C1's set at a tier the engine reads" is the entire question.
        const selected = selectDocsForProjection(docs);
        results.push({
          clientId: client.id,
          slug: client.agentsRepoSlug,
          projected: false,
          contextDocs: selected.length,
          brand: Boolean(client.brandingGuidelines) || (client.forbiddenTerms ?? []).length > 0,
          reason: "dry run",
        });
        continue;
      }
      const result = await projectClientToWorkspace(client, docs);
      results.push({
        clientId: client.id,
        slug: client.agentsRepoSlug,
        projected: result.projected,
        contextDocs: result.contextDocs,
        brand: result.brand,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    } catch (e) {
      // Per client, so one unreadable record does not end the backfill at
      // whatever alphabetical position it happens to sit in.
      results.push({
        clientId: client.id,
        slug: client.agentsRepoSlug,
        projected: false,
        contextDocs: 0,
        brand: false,
        reason: `error: ${e instanceof Error ? e.message : "unknown"}`,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    configured: true,
    applied: apply,
    total: clients.length,
    projected: results.filter((r) => r.projected).length,
    skippedNoSlug: results.filter((r) => r.reason === "no agentsRepoSlug").length,
    failed: results.filter((r) => r.reason?.startsWith("error:")).length,
    clients: results,
  });
}
