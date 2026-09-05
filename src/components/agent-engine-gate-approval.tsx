"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { normalizeDashes } from "@/lib/text-utils";
import { resolveAgentEngineGateAction } from "@/lib/actions";
import type { AgentEngineStyleEdit } from "@/lib/agent-engine/types";

/**
 * The human-approval action for an agent-engine run paused at
 * `awaiting_gate` — Task 3's "paused runs render human approval actions
 * triggering gate resolution via agent-engine." Distinct from the legacy
 * `ApprovePanel` (which approves an already-finished `Asset`, post
 * completion): this approves/rejects a run that is mid-flight, still
 * holding a Pub/Sub-derived `agentEngineRunId`, before it can continue.
 *
 * IT USED TO SHOW THE REVIEWER NOTHING TO REVIEW. The whole component was one
 * line — "This run is paused waiting on your review of gate
 * '15-batch-review'" — plus Approve and Reject. Every workflow that opens a
 * gate already puts the thing being decided in the gate's own `payload`
 * (x-agent: the topic, the lane, the angle and the drafted post text;
 * linkedin: topic and archetype; reddit: the target thread; intel: the
 * dimension scores and SWOT), `readAgentEngineRun` already fetches that whole
 * record to decide the run is paused, and the panel then passed only the
 * `gateId` down. So an account manager pressed Approve on a draft they had
 * never seen, and the run recorded their name against it.
 *
 * THE RENDERER IS GENERIC ON PURPOSE, not a per-product table. Eleven products
 * open gates of six different `kind`s with six different payload shapes, and a
 * lookup table keyed by product would silently show nothing for the twelfth.
 * Three rules cover all of them: `preview` (the convention every drafting
 * workflow uses for the actual deliverable text) renders as the prose block a
 * reviewer reads first; every other scalar renders as a labelled fact; anything
 * structured renders as collapsed JSON. A payload key nobody anticipated still
 * reaches the screen.
 */

/**
 * Already shown in the page header and the run panel, or rendered by a
 * dedicated block below — repeating any of these as a generic row costs space
 * and tells the reviewer nothing. `slideTemplates`/`images` have their own
 * sections. `renderTokens`/`styleDirectiveOutcome`/`styleVariation`
 * (IGSTYLE-6, §2.5) are the Design block and its two banners, below.
 */
const SUPPRESSED_KEYS = new Set([
  "runId",
  "preview",
  "client",
  "slideTemplates",
  "images",
  "copy",
  "renderTokens",
  "styleDirectiveOutcome",
  "styleVariation",
]);

/** The three roles the Design block actually exposes controls for — `AgentEngineStyleEdit` has seven, matching agent-engine's own `StyleEditSchema`, but a reviewer picks a background, a text colour, and an accent; the rest exist so a hand-authored override and a reviewer's pick are indistinguishable to the engine. */
const DESIGN_ROLES = [
  { key: "ground", label: "Background" },
  { key: "fg", label: "Text" },
  { key: "accent", label: "Accent" },
] as const satisfies ReadonlyArray<{ key: keyof AgentEngineStyleEdit; label: string }>;

/** Same pattern as agent-engine's own `HEX_COLOR` (`packages/core/src/types/gate.ts`) — 3/4/6/8-digit hex, `#` required. Validated here too so a reviewer sees a bad hex immediately rather than after a round-trip to the server. */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * The gate payload's `renderTokens` (IGSTYLE-6, §2.5) — what this round is
 * ACTUALLY rendering with right now (Layer 0+1+2 merged), so the Design
 * block's inputs seed from the real current colours rather than from
 * nothing. Read defensively, like every other payload field here: an engine
 * build that does not yet send this key is not an error, it is "this block
 * doesn't render" (the acceptance line this satisfies verbatim).
 */
function readRenderTokens(value: unknown): AgentEngineStyleEdit | undefined {
  if (!isRecord(value)) return undefined;
  const out: AgentEngineStyleEdit = {};
  for (const role of ["ground", "surface", "fg", "fg2", "line", "accentInk", "accent"] as const) {
    const v = value[role];
    if (typeof v === "string") out[role] = v;
  }
  return out;
}

/**
 * One refusal from `StyleRefusal` (agent-engine's `style-directive.ts`),
 * read defensively — same shape, not imported (separate repos).
 */
interface StyleRefusalInfo {
  role: string;
  requested: string;
  reason: string;
  contrastRatio?: number;
}

/**
 * This round's resolved style directive (IGSTYLE-3's `styleDirectiveOutcome`
 * gate-payload field) — "loud refusals" made visible here rather than only
 * in the run's own event log, which is the whole point of IGSTYLE-3's own
 * §2.3 requirement carried through to the reviewer's screen.
 */
interface StyleDirectiveOutcomeInfo {
  source: string;
  refusals: StyleRefusalInfo[];
}

function readStyleDirectiveOutcome(value: unknown): StyleDirectiveOutcomeInfo | undefined {
  if (!isRecord(value) || typeof value["source"] !== "string") return undefined;
  const refusalsRaw = value["refusals"];
  const refusals: StyleRefusalInfo[] = Array.isArray(refusalsRaw)
    ? refusalsRaw.flatMap((r) => {
        if (!isRecord(r) || typeof r["role"] !== "string" || typeof r["requested"] !== "string" || typeof r["reason"] !== "string") return [];
        return [
          {
            role: r["role"],
            requested: r["requested"],
            reason: r["reason"],
            ...(typeof r["contrastRatio"] === "number" ? { contrastRatio: r["contrastRatio"] } : {}),
          },
        ];
      })
    : [];
  return { source: value["source"], refusals };
}

/**
 * IGSTYLE-10's own variation report, rendered here (IGSTYLE-6, §2.5) even
 * though nothing produces it yet — the same "shape now, wire later" move
 * this whole programme has made repeatedly (e.g. IGSTYLE-1's unwired
 * `renderTokens.accent`). Absent payload key, absent banner; no engine
 * change required for this ticket to ship.
 */
interface StyleVariationEntry {
  role: string;
  prior: string;
  used: string;
  reason: string;
}

function readStyleVariation(value: unknown): StyleVariationEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (!isRecord(v) || typeof v["role"] !== "string" || typeof v["prior"] !== "string" || typeof v["used"] !== "string" || typeof v["reason"] !== "string") {
      return [];
    }
    return [{ role: v["role"], prior: v["prior"], used: v["used"], reason: v["reason"] }];
  });
}

/**
 * The editable projection an instagram-agent gate carries under `copy`
 * (Phase 2 in-place review editing): the caption plus each slide's prose
 * fields. Absent for every other product — the editor simply doesn't render.
 */
interface EditableSlide {
  n: number;
  template?: string;
  fields: Record<string, string>;
}

function readEditableCopy(value: unknown): { caption?: string; slides: EditableSlide[] } | undefined {
  if (!isRecord(value)) return undefined;
  const slidesRaw = value["slides"];
  const slides: EditableSlide[] = Array.isArray(slidesRaw)
    ? slidesRaw.flatMap((raw) => {
        if (!isRecord(raw) || typeof raw["n"] !== "number" || !isRecord(raw["fields"])) return [];
        const fields = Object.fromEntries(
          Object.entries(raw["fields"]).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
        return [{ n: raw["n"], ...(typeof raw["template"] === "string" ? { template: raw["template"] } : {}), fields }];
      })
    : [];
  if (slides.length === 0) return undefined;
  return { ...(typeof value["caption"] === "string" ? { caption: value["caption"] } : {}), slides };
}

/**
 * Prose fields in a reading order a reviewer expects — headline first, body
 * second, everything else (quoteText, leftLabel, …) alphabetically after.
 */
function orderedFieldKeys(fields: Record<string, string>): string[] {
  const preferred = ["headline", "body", "kicker"];
  const keys = Object.keys(fields);
  return [...preferred.filter((k) => keys.includes(k)), ...keys.filter((k) => !preferred.includes(k)).sort()];
}

const FONT_SCALES = ["s", "m", "l"] as const;
const TEXT_ALIGNS = ["start", "center", "end"] as const;
type FontScale = (typeof FONT_SCALES)[number];
type TextAlign = (typeof TEXT_ALIGNS)[number];

/**
 * One rendered slide, from the gate payload's `images` convention — the same
 * "any drafting workflow may use this key" idea `preview` already is, just
 * for a deliverable that IS pictures (a carousel) rather than only text.
 *
 * `url` is only sometimes a browser-loadable `https://` link: the engine
 * signs one when its runtime credentials allow it and falls back to a bare
 * `gs://` URI otherwise (see `GcsArtifactStore.upload`'s own doc comment) —
 * a reviewer sees a real photo in the first case and a labelled placeholder
 * in the second, never a broken `<img>`.
 */
interface SlideImage {
  n: number;
  url?: string;
}

function readImages(value: unknown): SlideImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw["n"] !== "number") return [];
    return [{ n: raw["n"], ...(typeof raw["url"] === "string" ? { url: raw["url"] } : {}) }];
  });
}

/**
 * One slide's template provenance, from the gate payload's `slideTemplates`.
 *
 * Optional everywhere because the payload is arbitrary by contract: a product
 * that does not render templated slides sends none of this, and an older
 * engine build sends slides without ids.
 */
interface SlideTemplateInfo {
  n: number;
  template?: string;
  templateId?: string;
  templateSource?: string;
  isExperimental?: boolean;
}

function readSlideTemplates(value: unknown): SlideTemplateInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw["n"] !== "number") return [];
    return [
      {
        n: raw["n"],
        ...(typeof raw["template"] === "string" ? { template: raw["template"] } : {}),
        ...(typeof raw["templateId"] === "string" ? { templateId: raw["templateId"] } : {}),
        ...(typeof raw["templateSource"] === "string" ? { templateSource: raw["templateSource"] } : {}),
        ...(typeof raw["isExperimental"] === "boolean" ? { isExperimental: raw["isExperimental"] } : {}),
      },
    ];
  });
}

/** The gate `kind`s the engine opens today, in words. An unrecognised kind falls back to its own raw id rather than to silence. */
const GATE_KIND_LABELS: Readonly<Record<string, string>> = {
  batch_review: "Draft review",
  campaign_review: "Campaign review",
  branded_shorts_delivery_review: "Video delivery review",
  prompt_set_review: "Prompt set review",
  fix_generation_review: "Fix generation review",
  publish_approve: "Publish approval",
};

function labelForKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function AgentEngineGateApproval({
  jobId,
  gateId,
  kind,
  payload,
  requiredRole,
}: {
  jobId: string;
  gateId: string;
  /** The gate's own `kind` from its record — what sort of decision this is. */
  kind?: string;
  /** The gate's `payload`, verbatim. Arbitrary by contract, so it is read defensively and never asserted into a shape. */
  payload?: unknown;
  requiredRole?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  /** Per-slide design notes, keyed by slide number. Only sent for slides the reviewer actually wrote about. */
  const [templateNotes, setTemplateNotes] = useState<Record<number, string>>({});
  /** Which experimental templates the reviewer wants kept for future runs. */
  const [promote, setPromote] = useState<Record<number, boolean>>({});
  /** In-place edit state (Phase 2): only DIFFS against the payload's own text are ever submitted. */
  const [editingSlides, setEditingSlides] = useState(false);
  const [captionDraft, setCaptionDraft] = useState<string | null>(null);
  const [fieldDrafts, setFieldDrafts] = useState<Record<number, Record<string, string>>>({});
  const [styleDrafts, setStyleDrafts] = useState<Record<number, { fontScale?: FontScale; textAlign?: TextAlign }>>({});
  /**
   * The Design block's own draft state (IGSTYLE-6, §2.5) — deliberately a
   * flat `role -> typed text` map, not per-slide like `styleDrafts` above
   * (a color pick is for the whole post, not one slide). Holds whatever the
   * reviewer typed, valid or not, so a mid-edit invalid hex stays visible
   * rather than silently reverting — `hasInvalidDesignInput` below is what
   * blocks submission until it's fixed or cleared.
   */
  const [designDrafts, setDesignDrafts] = useState<Partial<Record<(typeof DESIGN_ROLES)[number]["key"], string>>>({});

  const fields = isRecord(payload) ? payload : {};
  const slideTemplates = readSlideTemplates(fields["slideTemplates"]);
  const experimental = slideTemplates.filter((s) => s.isExperimental && s.templateId);
  const images = readImages(fields["images"]);
  const loadableImages = images.filter((img): img is SlideImage & { url: string } => Boolean(img.url?.startsWith("https://")));
  const editableCopy = readEditableCopy(fields["copy"]);
  const imageByN = new Map(images.map((img) => [img.n, img]));
  const renderTokens = readRenderTokens(fields["renderTokens"]);
  const styleDirectiveOutcome = readStyleDirectiveOutcome(fields["styleDirectiveOutcome"]);
  const styleVariation = readStyleVariation(fields["styleVariation"]);

  /** A typed-but-invalid hex in the Design block — blocks every decision until fixed or reset, rather than silently dropping the pick server-side. */
  const hasInvalidDesignInput = DESIGN_ROLES.some(({ key }) => {
    const draft = designDrafts[key];
    if (draft === undefined) return false;
    const trimmed = draft.trim();
    return trimmed.length > 0 && !HEX_COLOR_RE.test(trimmed);
  });

  /** Only the roles the reviewer actually changed from the seeded baseline, and only when validly formatted — an invalid draft is excluded here (its own row shows the error; `hasInvalidDesignInput` is what stops the submit entirely). */
  function collectStyleEdits(): AgentEngineStyleEdit | undefined {
    const style: AgentEngineStyleEdit = {};
    for (const { key } of DESIGN_ROLES) {
      const draft = designDrafts[key];
      if (draft === undefined) continue;
      const trimmed = draft.trim();
      if (trimmed.length === 0 || !HEX_COLOR_RE.test(trimmed)) continue;
      if (trimmed === (renderTokens?.[key] ?? "")) continue;
      style[key] = trimmed;
    }
    return Object.keys(style).length > 0 ? style : undefined;
  }

  /**
   * The edits object to submit — undefined when nothing actually changed.
   * `style` is included regardless of `decision`; which decisions actually
   * forward it is `resolveAgentEngineGateAction`'s own call (IGSTYLE-6,
   * §2.5 point 3 — `caption`/`slides` approve-only, `style` approve+revise),
   * not this component's.
   */
  function collectEdits():
    | { caption?: string; slides?: Array<{ n: number; fields?: Record<string, string>; fontScale?: FontScale; textAlign?: TextAlign }>; style?: AgentEngineStyleEdit }
    | undefined {
    const style = collectStyleEdits();
    if (!editableCopy) return style !== undefined ? { style } : undefined;
    const slides: Array<{ n: number; fields?: Record<string, string>; fontScale?: FontScale; textAlign?: TextAlign }> = [];
    for (const slide of editableCopy.slides) {
      const changedFields = Object.fromEntries(
        Object.entries(fieldDrafts[slide.n] ?? {}).filter(([key, value]) => value !== slide.fields[key] && value.trim().length > 0),
      );
      const slideStyle = styleDrafts[slide.n] ?? {};
      const entry = {
        n: slide.n,
        ...(Object.keys(changedFields).length > 0 ? { fields: changedFields } : {}),
        ...(slideStyle.fontScale !== undefined ? { fontScale: slideStyle.fontScale } : {}),
        ...(slideStyle.textAlign !== undefined ? { textAlign: slideStyle.textAlign } : {}),
      };
      if (Object.keys(entry).length > 1) slides.push(entry);
    }
    const originalCaption = editableCopy.caption ?? "";
    const caption =
      captionDraft !== null && captionDraft.trim().length > 0 && captionDraft !== originalCaption ? captionDraft : undefined;
    if (caption === undefined && slides.length === 0 && style === undefined) return undefined;
    return {
      ...(caption !== undefined ? { caption } : {}),
      ...(slides.length > 0 ? { slides } : {}),
      ...(style !== undefined ? { style } : {}),
    };
  }

  function slideHasEdits(n: number): boolean {
    const slide = editableCopy?.slides.find((s) => s.n === n);
    if (!slide) return false;
    const changed = Object.entries(fieldDrafts[n] ?? {}).some(([key, value]) => value !== slide.fields[key]);
    const style = styleDrafts[n] ?? {};
    return changed || style.fontScale !== undefined || style.textAlign !== undefined;
  }

  function resolve(decision: "approve" | "revise" | "reject") {
    startTransition(async () => {
      // Only slides with a real id AND a written note are sent — an empty box
      // is not feedback, and the engine's schema requires a non-empty note.
      const templateFeedback = slideTemplates
        .filter((s) => s.templateId && (templateNotes[s.n] ?? "").trim().length > 0)
        .map((s) => ({
          slide: s.n,
          templateId: s.templateId!,
          // A design note given alongside a revision request is itself a
          // request to change the design; alongside an approval it is praise.
          verdict: decision === "approve" ? ("approved" as const) : ("revise" as const),
          note: templateNotes[s.n]!.trim(),
          promote: decision === "approve" && promote[s.n] === true,
        }));
      // Always collected regardless of `decision` — `caption`/`slides` only
      // matter on `approve` (a redraft supersedes hand edits) and `style`
      // matters on `approve` AND `revise` (IGSTYLE-6, §2.5); which of those
      // actually reach the engine is `resolveAgentEngineGateAction`'s own
      // per-field, per-decision split, not this component's job to encode.
      const edits = collectEdits();
      const result = await resolveAgentEngineGateAction(jobId, gateId, {
        decision,
        ...(notes ? { notes } : {}),
        ...(templateFeedback.length > 0 ? { templateFeedback } : {}),
        ...(edits !== undefined ? { edits } : {}),
      });
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  const preview = typeof fields["preview"] === "string" ? fields["preview"].trim() : "";
  const facts: Array<[string, string]> = [];
  const structured: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (SUPPRESSED_KEYS.has(key) || value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      facts.push([labelForKey(key), String(value)]);
    } else {
      structured.push([labelForKey(key), value]);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="Eye" className="h-4 w-4 shrink-0 text-warning" />
        <span className="text-sm font-medium">{kind ? (GATE_KIND_LABELS[kind] ?? labelForKey(kind)) : "Review"}</span>
        <Badge tone="neutral">{gateId}</Badge>
        {requiredRole && <Badge tone="neutral">{labelForKey(requiredRole)}</Badge>}
      </div>

      {/* The rendered slides, when the gate carried any — a carousel IS its
          photos, and a reviewer approving one sight-unseen is exactly the gap
          this whole component exists to close (see the file header). Images
          that came back as a bare `gs://` URI (signing unavailable on this
          deploy) render as a labelled placeholder rather than a broken tile,
          so the gap is visible instead of silent. */}
      {images.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-2">
            {loadableImages.length} of {images.length} slide{images.length > 1 ? "s" : ""} rendered
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {images
              .slice()
              .sort((a, b) => a.n - b.n)
              .map((image) =>
                image.url?.startsWith("https://") ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a
                  // signed GCS URL, re-signed per run; not a Next/Image asset.
                  <img
                    key={image.n}
                    src={image.url}
                    alt={`Slide ${image.n}`}
                    className="aspect-square w-full rounded-md border border-border object-cover"
                  />
                ) : (
                  <div
                    key={image.n}
                    className="flex aspect-square w-full items-center justify-center rounded-md border border-dashed border-border/60 bg-surface-2/40 text-center text-xs text-muted-2"
                  >
                    Slide {image.n}
                    <br />
                    not viewable here
                  </div>
                ),
              )}
          </div>
        </div>
      )}

      {/* The deliverable itself, when the gate carried one. Deliberately not a
          disclosure and deliberately first: it is the thing being approved, and
          a reviewer should not have to open anything to see it. */}
      {preview && (
        <div className="rounded-md border border-border bg-surface p-3">
          <p className="mb-1.5 text-xs text-muted-2">Awaiting your approval</p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{normalizeDashes(preview)}</p>
        </div>
      )}

      {/* The Design block (IGSTYLE-6, §2.5) — ground/text/accent colour
          controls, seeded from `renderTokens` (what this round is ACTUALLY
          rendering with, Layers 0+1+2 merged). Renders only when the
          payload carries that key — an engine build that doesn't send it
          yet leaves this exactly as it was before this ticket, per that
          field's own read helper. Unlike the copy editor below, `style`
          ships on `revise` too, so this block is not gated behind an
          approve-only disclosure. */}
      {renderTokens && (
        <div className="space-y-2 rounded-md border border-border bg-surface p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Design</span>
            {styleDirectiveOutcome && styleDirectiveOutcome.source !== "none" && (
              <Badge tone="neutral">{labelForKey(styleDirectiveOutcome.source)}</Badge>
            )}
          </div>

          {/* Loud refusals (IGSTYLE-3, §2.3) made visible to the person who
              can actually act on them, not only the run's own event log. */}
          {styleDirectiveOutcome && styleDirectiveOutcome.refusals.length > 0 && (
            <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-2">
              {styleDirectiveOutcome.refusals.map((r, i) => (
                <p key={i} className="text-xs text-warning">
                  {labelForKey(r.role)} &ldquo;{r.requested}&rdquo; refused — {r.reason}
                  {r.contrastRatio !== undefined ? ` (contrast ${r.contrastRatio.toFixed(2)}:1)` : ""}. Kept the previous colour.
                </p>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            {DESIGN_ROLES.map(({ key, label }) => {
              const baseline = renderTokens[key] ?? "";
              const draft = designDrafts[key];
              const current = draft ?? baseline;
              const trimmed = current.trim();
              const valid = trimmed.length === 0 || HEX_COLOR_RE.test(trimmed);
              return (
                <div key={key} className="flex flex-wrap items-center gap-2">
                  <span className="w-20 shrink-0 text-xs text-muted-2">{label}</span>
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : "#000000"}
                    onChange={(e) => setDesignDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                    disabled={pending}
                    className="h-8 w-10 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
                    aria-label={`${label} colour picker`}
                  />
                  <input
                    type="text"
                    value={current}
                    onChange={(e) => setDesignDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                    placeholder="#000000"
                    disabled={pending}
                    className={`w-28 rounded-md border p-1.5 text-xs ${valid ? "border-border bg-surface-2" : "border-danger bg-danger/10"}`}
                    aria-label={`${label} hex value`}
                  />
                  {draft !== undefined && draft !== baseline && (
                    <button
                      type="button"
                      className="text-xs text-muted-2 underline"
                      disabled={pending}
                      onClick={() =>
                        setDesignDrafts((prev) => {
                          const next = { ...prev };
                          delete next[key];
                          return next;
                        })
                      }
                    >
                      Reset
                    </button>
                  )}
                  {!valid && <span className="text-xs text-danger">Not a valid hex colour</span>}
                </div>
              );
            })}
          </div>

          <p className="text-xs text-muted-2">
            Applies to this post — sent with Approve or Request changes — and is remembered so future drafts lean
            toward it.
          </p>

          {/* IGSTYLE-10's variation report — nothing produces this yet, but
              the payload key is read defensively so this banner lights up
              the moment a future engine build starts sending it, with no
              portal change required. */}
          {styleVariation.length > 0 && (
            <p className="text-xs text-muted-2">
              Varied from the usual pick:{" "}
              {styleVariation.map((v, i) => (
                <span key={i}>
                  {i > 0 ? "; " : ""}
                  {labelForKey(v.role)} {v.prior} → {v.used} ({v.reason})
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {/* In-place editing (Phase 2): the gate's `copy` projection is the
          actual text behind the pixels. Edits ship VERBATIM with an approve —
          the slides re-render engine-side — so a wording or type-size
          preference no longer costs a full model redraft round. Collapsed by
          default: most reviews approve as-is, and eight open editors would
          bury the decision buttons. */}
      {editableCopy && (
        <div className="space-y-2 rounded-md border border-border bg-surface p-3">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            onClick={() => setEditingSlides((v) => !v)}
            disabled={pending}
          >
            <Icon name={editingSlides ? "ChevronDown" : "ChevronRight"} className="h-4 w-4 shrink-0 text-muted" />
            <span className="text-sm font-medium">Edit before approving</span>
            <span className="text-xs text-muted-2">
              text and typography, applied exactly as written{collectEdits() !== undefined ? " · edited" : ""}
            </span>
          </button>

          {editingSlides && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-2">Caption</label>
                <textarea
                  value={captionDraft ?? editableCopy.caption ?? ""}
                  onChange={(e) => setCaptionDraft(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-border bg-surface-2 p-2 text-sm"
                  disabled={pending}
                />
              </div>

              {editableCopy.slides.map((slide) => {
                const image = imageByN.get(slide.n);
                const style = styleDrafts[slide.n] ?? {};
                return (
                  <div key={slide.n} className="space-y-2 rounded-md border border-border/60 bg-surface-2/40 p-2.5">
                    <div className="flex items-center gap-2">
                      {image?.url?.startsWith("https://") ? (
                        // eslint-disable-next-line @next/next/no-img-element -- signed GCS URL, not a Next/Image asset.
                        <img src={image.url} alt={`Slide ${slide.n}`} className="h-12 w-12 shrink-0 rounded border border-border object-cover" />
                      ) : (
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-dashed border-border/60 text-[10px] text-muted-2">
                          {slide.n}
                        </div>
                      )}
                      <span className="text-xs font-medium">Slide {slide.n}</span>
                      {slideHasEdits(slide.n) && <Badge tone="neon">edited</Badge>}
                    </div>

                    {orderedFieldKeys(slide.fields).map((key) => (
                      <div key={key} className="space-y-0.5">
                        <label className="text-xs text-muted-2">{labelForKey(key)}</label>
                        <textarea
                          value={fieldDrafts[slide.n]?.[key] ?? slide.fields[key]}
                          onChange={(e) =>
                            setFieldDrafts((prev) => ({ ...prev, [slide.n]: { ...prev[slide.n], [key]: e.target.value } }))
                          }
                          rows={key === "body" ? 3 : 1}
                          className="w-full rounded-md border border-border bg-surface p-2 text-sm"
                          disabled={pending}
                        />
                      </div>
                    ))}

                    <div className="flex flex-wrap items-center gap-4">
                      <div className="flex items-center gap-1">
                        <span className="mr-1 text-xs text-muted-2">Text size</span>
                        {FONT_SCALES.map((scale) => (
                          <Button
                            key={scale}
                            size="sm"
                            variant={style.fontScale === scale ? "primary" : "outline"}
                            disabled={pending}
                            onClick={() =>
                              setStyleDrafts((prev) => ({
                                ...prev,
                                [slide.n]: { ...prev[slide.n], fontScale: prev[slide.n]?.fontScale === scale ? undefined : scale },
                              }))
                            }
                          >
                            {scale.toUpperCase()}
                          </Button>
                        ))}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="mr-1 text-xs text-muted-2">Align</span>
                        {TEXT_ALIGNS.map((align) => (
                          <Button
                            key={align}
                            size="sm"
                            variant={style.textAlign === align ? "primary" : "outline"}
                            disabled={pending}
                            onClick={() =>
                              setStyleDrafts((prev) => ({
                                ...prev,
                                [slide.n]: { ...prev[slide.n], textAlign: prev[slide.n]?.textAlign === align ? undefined : align },
                              }))
                            }
                          >
                            {labelForKey(align)}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}

              <p className="text-xs text-muted-2">
                Edits apply exactly as written when you approve, the slides re-render with them, and your changes are
                remembered so future drafts match your preferences. Requesting changes instead sends your note to the
                agent for a redraft.
              </p>
            </div>
          )}
        </div>
      )}

      {facts.length > 0 && (
        <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-2">{label}</dt>
              <dd className="truncate text-sm" title={value}>
                {/* A landing page's `previewUrl`/`pageUrl` (RFC-11) is the thing
                    the reviewer is asked to judge; a link they can open beats a
                    string they have to copy. Only https:// values, never http. */}
                {value.startsWith("https://") ? (
                  <a href={value} target="_blank" rel="noreferrer" className="text-neon underline-offset-2 hover:underline">
                    {value.replace(/^https:\/\//, "")}
                  </a>
                ) : (
                  normalizeDashes(value)
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {structured.map(([label, value]) => (
        <details key={label} className="rounded-md border border-border/60 bg-surface-2/40">
          <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium text-muted">{label}</summary>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border/60 p-2.5 text-[11px] leading-relaxed text-muted">
            {stringify(value)}
          </pre>
        </details>
      ))}

      {!preview && images.length === 0 && facts.length === 0 && structured.length === 0 && (
        <p className="text-xs text-muted-2">
          This gate carried no payload — approve or reject on the run&apos;s step history above.
        </p>
      )}

      {/* Experimental templates used on this run.
          A layout nobody has signed off on rendered one of these slides, and
          the reviewer is the first person to see it. Surfacing it here (rather
          than leaving it inside the collapsed JSON) is the difference between
          a design decision getting reviewed and one getting rubber-stamped. */}
      {experimental.length > 0 && (
        <div className="space-y-2 rounded-md border border-neon/40 bg-neon/5 p-3">
          <div className="flex items-center gap-2">
            <Icon name="Sparkles" className="h-4 w-4 shrink-0 text-neon" />
            <span className="text-sm font-medium">
              New custom template used on slide{experimental.length > 1 ? "s" : ""}{" "}
              {experimental.map((s) => s.n).join(", ")}
            </span>
          </div>
          <p className="text-xs text-muted-2">
            This layout has not been approved before. Tell us what you think of the LAYOUT, and tick
            &ldquo;keep it&rdquo; to add it to the template library for future runs — for this post&apos;s colours, use
            the Design panel {renderTokens ? "above" : "controls, when available"} instead.
          </p>
          {experimental.map((slide) => (
            <div key={slide.n} className="space-y-1.5 rounded-md border border-border/60 bg-surface p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">Slide {slide.n}</span>
                {slide.template && <Badge tone="neutral">{slide.template}</Badge>}
                {slide.templateSource && <Badge tone="neutral">{labelForKey(slide.templateSource)}</Badge>}
              </div>
              {/* IGSTYLE-6, §2.5 point 4 — retitled from "Feedback on slide
                  N's design", which read as an invitation to describe THIS
                  post's colours here; this note only ever steers which
                  LAYOUT future runs pick for this archetype. */}
              <label className="text-xs text-muted-2" htmlFor={`template-note-${slide.n}`}>
                Note on this template — steers which layouts future runs get
              </label>
              <textarea
                id={`template-note-${slide.n}`}
                value={templateNotes[slide.n] ?? ""}
                onChange={(e) => setTemplateNotes((prev) => ({ ...prev, [slide.n]: e.target.value }))}
                placeholder="What did you think of this layout? (optional)"
                rows={2}
                className="w-full rounded-md border border-border bg-surface-2 p-2 text-sm"
                disabled={pending}
              />
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={promote[slide.n] === true}
                  onChange={(e) => setPromote((prev) => ({ ...prev, [slide.n]: e.target.checked }))}
                  disabled={pending}
                />
                Keep this template for future runs
              </label>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What should change? (required to request changes, optional when approving)"
          rows={3}
          className="w-full rounded-md border border-border bg-surface p-2 text-sm"
          disabled={pending}
        />
        {/* Stated because it changes what typing here is FOR: this text is not
            a private note, it steers the next draft and is remembered for
            future runs. */}
        <p className="text-xs text-muted-2">
          Saved to this client&apos;s memory either way, so future runs learn from it.
        </p>
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={pending || hasInvalidDesignInput} onClick={() => resolve("approve")}>
          {pending ? <Spinner className="h-4 w-4" /> : "Approve"}
        </Button>
        {/* The middle path, and the reason this panel exists in this shape:
            "close, but change X" used to have to be spelled Reject, which
            threw the whole run away. */}
        <Button
          variant="outline"
          disabled={pending || notes.trim().length === 0 || hasInvalidDesignInput}
          onClick={() => resolve("revise")}
        >
          {pending ? <Spinner className="h-4 w-4" /> : "Request changes"}
        </Button>
        <Button
          variant="danger"
          disabled={pending || notes.trim().length === 0 || hasInvalidDesignInput}
          onClick={() => resolve("reject")}
        >
          {pending ? <Spinner className="h-4 w-4" /> : "Reject"}
        </Button>
      </div>
      {notes.trim().length === 0 && (
        <p className="text-xs text-muted-2">
          Requesting changes or rejecting needs a note above.
        </p>
      )}
      {hasInvalidDesignInput && (
        <p className="text-xs text-danger">Fix or reset the invalid colour above before continuing.</p>
      )}
    </div>
  );
}
