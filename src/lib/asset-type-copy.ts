/**
 * Copy for WHAT KIND of deliverable something is — the asset-type register
 * (pure, client-safe: imports nothing but the type).
 *
 * `AssetType` is stored snake_case (`instagram_post`, `social_post`), so any
 * surface that prints it raw shows a client a database identifier. This map was
 * a component-local `ASSET_TYPE_LABEL` in client-home-overview.tsx while the
 * copilot's system prompt interpolated the raw enum into a heading the model
 * paraphrases back — the same "one rule, two homes" shape the asset-status
 * registers were consolidated to fix.
 *
 * ONE register, not two per reader: unlike publish STATUS — where staff are owed
 * "Awaiting review" for the work they hold and a client is owed "Draft" — the
 * kind of thing a post is does not change with who is looking at it. An
 * Instagram post is an Instagram post. If a viewer split is ever needed here,
 * add it as a second register in this file rather than a second map elsewhere.
 *
 * SCOPE — stated, not counted. This module owns the `AssetType` → NAME map.
 * It does not own:
 *  - `calendar-body.tsx`'s singular/plural noun pairs, which exist to be
 *    composed into sentences ("2 posts this week") and are a grammar table, not
 *    a label lookup;
 *  - `run-calendar.tsx`'s POST_KIND_LABEL / `calendar-kind.ts`, keyed by
 *    `CalendarAssetKind` (`placeholder`, `failed`, `held` are not asset types);
 *  - the per-type ICON maps in asset-card / asset-detail-modal /
 *    campaign-capsules, which are presentation and belong with their component.
 * Consolidating those is a separate change with its own copy decisions.
 */

import type { AssetType } from "@/lib/types";

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  instagram_post: "Instagram post",
  social_post: "Social post",
  email: "Email",
  article: "Article",
  note: "Note",
};

/**
 * The rendered name for one asset type, falling back to the stored value for a
 * type Firestore holds and the union does not (which is why the parameter is
 * `string`). One fallback, here, so the same unknown type cannot read one way on
 * a card and another way in a model prompt.
 *
 * HONEST LIMIT of that fallback: for an unrecognised type it returns the stored
 * string, so this function guarantees a label for every type it KNOWS, not that
 * no caller can ever print an identifier. It matches `assetStatusLabel`'s
 * fallback deliberately — one behaviour across both registers beats a second
 * rule here — and the write paths keep the set closed (the agent-service webhook
 * validates against `VALID_HINT_TYPES`).
 */
export function assetTypeLabel(type: string): string {
  return ASSET_TYPE_LABEL[type as AssetType] ?? type;
}
