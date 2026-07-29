import { listClientIntegrations } from "@/lib/data";
import { integrationIsUsable } from "@/lib/integration-status";
import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import type { Asset } from "@/lib/types";

/**
 * F107 — the approve panel's "Manual push" tier tells staff they push the post
 * live themselves, so every surface that shows an approved post needs the
 * control. Same shape as the calendar's builder: staff only
 * (publishAssetNowAction is requireStaff), read only for clients that actually
 * own a pushable post, and platform ids only — never integration records, which
 * carry decrypted tokens.
 *
 * Shared by /assets and the job detail page so the "is this pushable" predicate
 * cannot drift between them: the job page rendered AssetCard with no
 * connectedPlatforms at all, so Publish Now never appeared there.
 */
export async function pushablePlatformsByClient(
  assets: Asset[],
): Promise<Record<string, string[]> | undefined> {
  const pushableClientIds = [
    ...new Set(
      assets
        .filter(
          (a) =>
            (a.status === "approved" || a.status === "scheduled") &&
            a.publishMode !== "placeholder" &&
            (PUBLISHABLE_PLATFORMS[a.type] ?? []).length > 0,
        )
        .map((a) => a.clientId),
    ),
  ];
  if (pushableClientIds.length === 0) return undefined;
  const perClient = await Promise.all(
    pushableClientIds.map(async (id) => {
      const integrations = await listClientIntegrations(id);
      return [id, integrations.filter(integrationIsUsable).map((i) => i.platform)] as const;
    }),
  );
  return Object.fromEntries(perClient);
}
