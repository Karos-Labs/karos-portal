import "server-only";

import type { ProjectionResult } from "@/lib/agent-engine/context-doc-projection";

/**
 * Re-project a client into the engine workspace because something the portal
 * owns just changed — T-B13 / SCRUM-243.
 *
 * ── WHAT THIS ADDS OVER THE DISPATCH PROJECTION ─────────────────────────────
 *
 * SCRUM-482 put `projectClientToWorkspace` in `dispatchAgentEngineRun`, so a
 * RUN is already guaranteed to read live context; this function is deliberately
 * not a second guarantee of the same thing. It exists for the three cases a
 * dispatch-time projection cannot cover:
 *
 * 1. **A client who has never dispatched.** Their workspace does not exist. Any
 *    engine-side tool that reads it outside a run — and the backfill this ships
 *    with — finds nothing at all.
 * 2. **Inspecting the workspace between runs.** "What would the agent see if I
 *    pressed Run now" was previously unanswerable without pressing Run, which
 *    is a poor way to check whether a correction took.
 * 3. **Anything that reads the workspace and is not a run**, such as the
 *    reconcile-cron knowledge mirror.
 *
 * So: the dispatch projection is the correctness guarantee, and this is the
 * freshness convenience. If the two ever disagree the dispatch one wins, by
 * construction — it runs later.
 *
 * ── WHY IT IS BEST-EFFORT, AND WHY IT SWALLOWS ──────────────────────────────
 *
 * T-B13 is explicit: "a failure must not fail the document save". A client who
 * corrected their brand voice and saw the save error because a bucket in a
 * different project is misconfigured has lost their edit for a reason that has
 * nothing to do with it — and the correction is safe in Firestore either way,
 * because the next dispatch re-projects from there.
 *
 * `projectClientToWorkspace` already returns rather than throws for the two
 * expected misses (no `agentsRepoSlug`, no bucket configured) and catches its
 * own write failures. The try/catch here is for everything before that: a
 * Firestore read that fails, a client that vanished between the save and this
 * call, a dynamic import that cannot resolve. Those are the failures that would
 * otherwise reach the caller.
 *
 * ── AND WHY IT IS NOT AWAITED BY DEFAULT ────────────────────────────────────
 *
 * The dispatch projection is awaited before the publish because the engine
 * reads those files as the run starts and a concurrent write is a race. Nothing
 * reads them the instant a settings form is saved, so the same argument does
 * not apply here: `void` it and the save returns at the speed the person
 * expects. Callers that want the result — the backfill — await it.
 *
 * Dynamic imports throughout, matching the other callers: this pulls in the
 * Firestore layer and the workspace writer, and a settings page that renders
 * without saving should not pay for either.
 */
export async function projectClientOnSave(clientId: string, reason: string): Promise<ProjectionResult> {
  try {
    const [{ projectClientToWorkspace }, { getClient, listClientContextDocs }] = await Promise.all([
      import("@/lib/agent-engine/context-doc-projection"),
      import("@/lib/data"),
    ]);
    const client = await getClient(clientId);
    if (!client) {
      return { projected: false, contextDocs: 0, brand: false, profile: false, reason: "no client record" };
    }
    // The docs are read even for a branding-only save. `projectClientToWorkspace`
    // takes `undefined` to mean "brand and profile only", which is right for the
    // branding refresh that has just rewritten them — but wrong here, where the
    // point is that the whole workspace matches the record after any save. One
    // extra Firestore query on a human-paced path.
    const docs = await listClientContextDocs(clientId);
    const result = await projectClientToWorkspace(client, docs);
    // STRUCTURED, as the ticket asks, and on one line so it is greppable in
    // Cloud Logging: a projection that silently did nothing is the failure mode
    // this whole ticket is about.
    console.info(
      `[project-on-save] ${JSON.stringify({
        clientId,
        slug: client.agentsRepoSlug ?? null,
        reason,
        projected: result.projected,
        contextDocs: result.contextDocs,
        brand: result.brand,
        ...(result.reason ? { skipped: result.reason } : {}),
      })}`,
    );
    return result;
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[project-on-save] ${JSON.stringify({ clientId, reason, projected: false, error: message })}`);
    return { projected: false, contextDocs: 0, brand: false, profile: false, reason: message };
  }
}

/**
 * Fire-and-forget form, for a save handler that must not wait.
 *
 * A named function rather than `void projectClientOnSave(...)` at each call
 * site, because the bare `void` reads as an oversight and the next reader
 * "fixes" it into an await — which is how a settings form acquires a
 * bucket-latency stall nobody asked for.
 */
export function projectClientOnSaveInBackground(clientId: string, reason: string): void {
  void projectClientOnSave(clientId, reason);
}
