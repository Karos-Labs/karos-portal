import { contextDocLabel } from "@/lib/context-doc-copy";
import type { AssetContextGrounding } from "@/lib/types";

/**
 * SCRUM-404 — reading agent-engine's context-grounding marker off a deliverable.
 *
 * ## Why this is one generic read and not eleven typed fields
 *
 * agent-engine spreads the marker onto the deliverable under a single
 * `contextGrounding` key, identically for every grounded agent — see each
 * workflow's persist step (`...(contextGrounding.decision === "degraded" ?
 * { contextGrounding: contextGrounding.marker } : {})`), which is the same two
 * lines in `intel-report-agent`, `instagram-agent` and `branded-shorts-agent`.
 * It is deliberately NOT part of any product's own deliverable shape.
 *
 * `materialize.ts` parses deliverables into narrow typed shapes
 * (`InstagramCarouselDeliverable` and siblings), and the obvious fix — declare
 * `contextGrounding` on each of them — would be wrong twice over: it is eleven
 * edits for one concept, and it silently omits every product added later, which
 * is exactly how the marker came to be dropped in the first place. The marker
 * is cross-cutting, so it is read once, generically, before any per-product
 * branch runs.
 *
 * ## Why it is validated rather than cast
 *
 * This value crossed a service boundary from a separately-deployed repo, so it
 * gets the same treatment as every other value that does (`isEngineId`,
 * `toRoutableRecommendation`). A malformed or partial marker must not become a
 * client-visible label claiming a specific missing document — and an *absent*
 * marker is the normal case, not an error, so this returns `undefined` and never
 * throws.
 */
export function readContextGroundingMarker(deliverable: unknown): AssetContextGrounding | undefined {
  if (typeof deliverable !== "object" || deliverable === null) return undefined;
  const marker = (deliverable as { contextGrounding?: unknown }).contextGrounding;
  if (typeof marker !== "object" || marker === null) return undefined;

  const { contextGroundingStatus, agentId, missingDocTypes, reason } = marker as {
    contextGroundingStatus?: unknown;
    agentId?: unknown;
    missingDocTypes?: unknown;
    reason?: unknown;
  };

  // The status literal is the discriminator, so an unrecognised value is
  // dropped rather than coerced: a future engine-side third state must not
  // render through the degraded treatment's copy until this repo has decided
  // what to say about it.
  if (contextGroundingStatus !== "degraded") return undefined;
  if (typeof agentId !== "string" || agentId === "") return undefined;
  if (typeof reason !== "string" || reason === "") return undefined;

  // `missingDocTypes` is the one field the label quotes item by item, so a
  // non-array (or an array with a non-string in it) is narrowed to the strings
  // present rather than rendered as `[object Object]`. An empty list is
  // legitimate — the marker is still a true statement about the run.
  const docTypes = Array.isArray(missingDocTypes) ? missingDocTypes.filter((doc): doc is string => typeof doc === "string" && doc !== "") : [];

  return { status: "degraded", agentId, missingDocTypes: docTypes, reason };
}

/**
 * One context-doc type as it reads INSIDE a sentence.
 *
 * Reuses `@/lib/context-doc-copy`'s map rather than keeping a second one — that
 * module already owns the `ContextDocType` → NAME register for prose (activity
 * titles, ledger reasons, copilot headings), and a doc type added to the union
 * without a label there is a compile error. A private copy here would be the
 * third, and would silently disagree the first time one is renamed.
 *
 * Two adjustments, both because of WHERE this copy sits:
 *
 *  * That map is Sentence case, because its own call sites read the name at the
 *    start of a sentence ("Brand voice corrected"). This one lands mid-sentence
 *    ("drafted without your market strategy"), so the first letter is lowered.
 *  * Its fallback returns the stored kebab identifier, which that module calls
 *    "the defect this module exists to remove" while rightly keeping it — a row
 *    predating the union still has to say something. It is the wrong fallback
 *    for client-facing prose, where a kebab-case identifier is a Firestore enum
 *    used as prose, so dashes become spaces here. The doc still appears in the
 *    list either way: the count a client reads has to stay honest even when the
 *    label map is behind the engine.
 */
function proseDocLabel(docType: string): string {
  const label = contextDocLabel(docType);
  const readable = label === docType ? docType.replace(/[-_]/g, " ") : label;
  return readable.charAt(0).toLowerCase() + readable.slice(1);
}

/** "your market strategy and target audience" — a list a sentence can absorb. */
export function contextDocList(docTypes: readonly string[]): string {
  const labels = docTypes.map(proseDocLabel);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]!}`;
}
