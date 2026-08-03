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
 *  - `app/(app)/calendar/calendar-body.tsx`'s `OUTPUT_NOUN` singular/plural
 *    pairs, which exist to be composed into sentences ("2 posts this week") and
 *    are a grammar table, not a label lookup;
 *  - `calendar-kind.ts`'s `POST_KIND_LABEL`, keyed by `CalendarAssetKind`
 *    (`placeholder`, `failed`, `held` are not asset types) and read through
 *    `postKindLabel`;
 *  - the per-type `TYPE_ICON` maps in asset-card / asset-detail-modal /
 *    campaign-capsules, which are presentation and belong with their component.
 * Consolidating those is a separate change with its own copy decisions.
 *
 * Those are POINTERS, and a pointer that has drifted is worse than none: two of
 * these had. `POST_KIND_LABEL` was attributed to run-calendar.tsx, which now
 * only names it in a comment, and the noun table was named by bare filename
 * while an unrelated `OUTPUT_NOUN` (keyed by `AgentArchetype`) sits in
 * client-agents/agent-detail-panel.tsx. Name the file that holds the symbol.
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
 * `string`).
 *
 * NOT the only site that spells that fallback — the sibling claim in
 * job-status-copy.ts said "one fallback, here" and was false, so this one is
 * checked rather than repeated. client-home-overview.tsx:225 reads the map with
 * its own `?? a.type`. It gives the SAME answer, so an unknown type does read the
 * same on that card as in a model prompt — but it holds by the two spellings
 * agreeing, not by there being one, and a reworded fallback here would not reach
 * it. That is the whole reader set: client-home-overview.tsx is the only file that
 * takes the MAP, and copilot-context.ts and ai/prompts/proactive-assistant.ts take
 * this accessor. Checked by asking which files import this module, not by memory —
 * the first draft of this very note named two files that read the STATUS registers
 * instead, which is the pointer defect one line up.
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
