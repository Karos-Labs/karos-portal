import { listClientIntegrations } from "@/lib/data";
import { integrationIsUsable } from "@/lib/integration-status";
import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import { isAssetPublishable } from "@/lib/asset-visibility";
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
 *
 * The per-asset half of that question is `isAssetPublishable` — the same rule
 * the card, the modal and `publishAssetNowAction` now answer with. This used to
 * hand-roll its own `approved || scheduled` copy, which was a FOURTH answer and
 * a stricter one: a client whose only pushable post was `delivered` got no
 * platform list, so the control the other three surfaces agreed to show could
 * not appear. What stays local is the part this function actually owns — which
 * platforms a TYPE can go to, and which of them the client has connected.
 */
export async function pushablePlatformsByClient(
  assets: Asset[],
): Promise<Record<string, string[]> | undefined> {
  const pushableClientIds = [
    ...new Set(
      assets
        .filter((a) => isAssetPublishable(a) && (PUBLISHABLE_PLATFORMS[a.type] ?? []).length > 0)
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
