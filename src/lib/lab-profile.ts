import type { Client } from "@/lib/types";

/**
 * Lab-owned client profiles — pure and client-safe.
 *
 * A LAB CLIENT is one whose profile was imported from the karos-agents lab:
 * `agentsRepoSlug` names its folder there, and `profileSource: "lab"` records
 * that `scripts/import-lab-client.ts` brought the folder's curated documents,
 * brand and competitors into the portal. For such a client those files are the
 * source of truth, and the intel pipeline must add to them rather than replace
 * them. See `Client.profileSource` for why the slug alone cannot answer this.
 */

/** The value `scripts/import-lab-client.ts` writes to `Client.profileSource`. */
export const LAB_PROFILE_SOURCE = "lab" as const;

/**
 * True when the lab owns this client's profile, and so its internal context
 * documents, its brand and its lab-imported competitors must survive every
 * intel run (`runIntelReportPipeline`'s lab mode).
 */
export function isLabProfileClient(client: Pick<Client, "agentsRepoSlug" | "profileSource">): boolean {
  return Boolean(client.agentsRepoSlug?.trim()) && client.profileSource === LAB_PROFILE_SOURCE;
}
