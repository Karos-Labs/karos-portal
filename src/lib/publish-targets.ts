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

/**
 * clientId → platforms this client has `ClientIntegration.agentAutoPublish`
 * turned on for — the other half `li-drafts-review.tsx`/`x-drafts-review.tsx`
 * need (alongside `agentDraftAutoPublishTarget`) to know whether to suppress
 * their own pick-to-post buttons for a draft (see
 * `agentDraftAutoPublishSuppressesPicker`, agent-draft-auto-publish.ts).
 *
 * Deliberately NOT `pushablePlatformsByClient`: that one filters assets down
 * to `isAssetPublishable`, which an unapproved DRAFT — the exact status this
 * question is asked about, before the human gate — never is. Scoped instead
 * to clients owning at least one `note`, the only asset type
 * `agentDraftAutoPublishTarget` will ever recognise.
 *
 * Also requires the integration to be usable, same as the real door
 * (`autoPublishApprovedAgentDraft`'s own guard) — the flag alone does not
 * mean the door will actually fire. Suppressing the picker for a client whose
 * integration has since expired would leave the draft with no way out at
 * all, which is worse than the double-publish risk this exists to close (see
 * "Agents always deliver").
 */
export async function agentAutoPublishPlatformsByClient(
  assets: Asset[],
): Promise<Record<string, string[]> | undefined> {
  const clientIds = [...new Set(assets.filter((a) => a.type === "note").map((a) => a.clientId))];
  if (clientIds.length === 0) return undefined;
  const perClient = await Promise.all(
    clientIds.map(async (id) => {
      const integrations = await listClientIntegrations(id);
      return [
        id,
        integrations.filter((i) => i.agentAutoPublish === true && integrationIsUsable(i)).map((i) => i.platform),
      ] as const;
    }),
  );
  return Object.fromEntries(perClient);
}
