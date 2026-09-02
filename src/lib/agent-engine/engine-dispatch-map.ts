/**
 * WHICH (client, agent) PAIRS ACTUALLY DISPATCH TO AGENT-ENGINE — resolved on
 * the server, carried to the run dialog as data.
 *
 * `clientId` → `agent.key` → engine product id. An entry exists ONLY where a
 * run submitted right now would really reach agent-engine. A missing entry
 * means "this run falls through to the legacy agent-service path"; it does NOT
 * mean "unknown, work it out", and nothing on the client side may fall back to
 * a second opinion about it.
 *
 * ## Why this type exists at all (T-B21)
 *
 * The real gate is `resolveDispatchedAgentEngineProductId` (./health.ts): the
 * three-part predicate `submit-custom.ts` applies per run — dispatch enabled,
 * AND this client on `AGENT_ENGINE_CUSTOM_AGENT_CLIENTS`, AND the agent key
 * routable. That module is `import "server-only"` and reads `process.env`, so
 * a `"use client"` run dialog cannot ask it and must be told the answer.
 *
 * Before this, the dialog asked `resolveAgentEngineProductIdForCustomAgent(
 * agent.key)` — the KEY-ONLY question, which answers "does agent-engine have a
 * workflow for this agent at all" and is blind to both flags. So for every
 * client not yet cut over (the normal state mid-migration) the dialog painted
 * the two engine-only fields `withEngineRunFields` appends — "Direction for
 * this run (optional)" and, on the media products, "Source media" — for a run
 * that then went to agent-service, which reads neither. Both answers were
 * silently dropped.
 *
 * That is the same defect SCRUM-249/T-B5 closed in the copilot chat route,
 * which had asked the key-only question about a client's uploaded file and then
 * told them it was attached. health.ts's doc comment is emphatic that its
 * function IS the definition of "would actually dispatch to the engine", not a
 * description of it to be re-derived at a second call site. This module is how
 * that one definition reaches a surface that cannot call it.
 *
 * Keyed by `client.id` rather than `agentsRepoSlug` because that is what the
 * dialog's picker selects by — the server does the slug lookup while it still
 * has the client record.
 *
 * Deliberately plain data in a plain module: no React, no `server-only`, so the
 * server page that builds it, the client components that carry it and the tests
 * that pin the two together all speak the same shape.
 */
export type EngineDispatchMap = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * The engine product this exact pair dispatches to, or `undefined` for the
 * legacy path — the lookup every reader of the map goes through, so "absent
 * means legacy" is stated once rather than re-implemented per call site.
 */
export function engineProductIdForPair(
  engineDispatch: EngineDispatchMap,
  clientId: string,
  agentKey: string,
): string | undefined {
  return engineDispatch[clientId]?.[agentKey];
}

/**
 * Build the map from a resolver, for a set of (client, agent) pairs.
 *
 * `resolve` is always `resolveDispatchedAgentEngineProductId` in app code —
 * taken as a parameter only because this module must stay free of
 * `server-only` so client components can import the type from it. Rows and
 * columns with no dispatching pair are omitted entirely rather than written as
 * empty objects, so "an entry exists only where it dispatches" is true of the
 * built map and not merely of how it is read.
 */
export function buildEngineDispatchMap(
  clients: ReadonlyArray<{ id: string; agentsRepoSlug?: string | null }>,
  agentKeys: readonly string[],
  resolve: (agentKey: string, clientSlug: string | undefined) => string | undefined,
): EngineDispatchMap {
  const map: Record<string, Record<string, string>> = {};
  for (const client of clients) {
    const row: Record<string, string> = {};
    for (const agentKey of agentKeys) {
      const productId = resolve(agentKey, client.agentsRepoSlug ?? undefined);
      if (productId) row[agentKey] = productId;
    }
    if (Object.keys(row).length > 0) map[client.id] = row;
  }
  return map;
}
