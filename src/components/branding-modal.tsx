"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { Button, Label, Input, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { saveBrandingGuidelinesAction, generateBrandingAction } from "@/lib/actions";
import type { BrandColor, BrandingGuidelines } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  clientId: string;
  existing?: BrandingGuidelines;
  /** When true, shows the "Generate from website" button that uses AI to pre-fill the form. */
  hasWebsite?: boolean;
  /**
   * Staff only. Shows the per-color usage-percentage field (CD-E2). Clients
   * never receive the stored values (stripped in toClientPortalView) and the
   * save action re-applies the stored ones for a CLIENT_USER, so a client
   * editing the palette cannot blank the agency's mix.
   */
  allowUsagePct?: boolean;
}

/* ── Color entry (local form state - lighter than full BrandColor) ─────── */

interface ColorEntry {
  id: number;
  hex: string;
  role: string;
  /** "" = not set. Kept as a string so the input can be cleared. */
  usagePct: string;
}

const MAX_COLORS = 4;

let _colorIdCounter = 0;
function nextColorId() { return ++_colorIdCounter; }

/** Synthesise initial color entries from existing guidelines, preferring the new array. */
function getInitialColors(existing?: BrandingGuidelines): ColorEntry[] {
  if (existing?.dominantColors?.length) {
    return existing.dominantColors.map((c) => ({
      id: nextColorId(),
      hex: c.hex,
      role: c.role ?? "",
      usagePct: c.usagePct != null ? String(c.usagePct) : "",
    }));
  }
  // Fall back to legacy scalar fields for pre-migration clients
  const entries: ColorEntry[] = [];
  const add = (hex: string | undefined, role: string) => {
    if (hex) entries.push({ id: nextColorId(), hex, role, usagePct: "" });
  };
  add(existing?.primaryAccent ?? existing?.primaryColor, "Primary accent");
  add(existing?.secondaryAccent ?? existing?.secondaryColor, "Secondary accent");
  add(existing?.brandNeutralDark ?? existing?.uiBackground, "");
  add(existing?.brandNeutralLight ?? existing?.uiText, "");
  return entries;
}

/**
 * The two halves this dialog commits separately (flow audit 2026-09, R14).
 *
 * `look` is what the brand LOOKS like — the palette, the two fonts, the visual
 * style. `words` is how it SOUNDS — the tone chips and the markdown guidelines
 * document. They are edited by different people at different moments, and the
 * one thing they had in common was a single "Save guidelines" that committed
 * all six kinds of data at once, so a reader who came to fix one hex could not
 * tell what else the press was about to change.
 *
 * THE SERVER ACTION IS UNCHANGED, and each Save still sends the WHOLE document,
 * built from the last saved state with only its own half's live edits laid over
 * it (`payloadFor` below).
 *
 * WHY, PRECISELY (review wave, 2026-09) — because the old reason given here was
 * wrong and a wrong reason is how the wrong thing gets "simplified" later.
 * `updateClient` is `set(data, { merge: true })`, and a Firestore merge write
 * DEEP-merges maps: a payload carrying only `{ toneKeywords, guidelines }`
 * would leave the stored palette and fonts exactly where they are, not blank
 * them. What a half payload WOULD do is misfeed the two context documents:
 * `saveBrandingGuidelinesAction` rebuilds `branding-guidelines` and
 * `brand-voice` from the payload alone (`brandingToContextDocContent`), with no
 * read-merge, so the agents' own copy of the brand would come out missing
 * whichever half was not being saved. Sending the whole document keeps those
 * two documents whole; the split is about what a PRESS commits, not about what
 * Firestore can merge.
 *
 * WHICH MAKES `saved` LOAD-BEARING, not bookkeeping. Anything that changes the
 * stored document has to advance it, or the next Save of the OTHER half will
 * write the pre-change value back over the top. Three things do:
 * `generateFromWebsite` (a write, not a proposal), each successful `submit`,
 * and a changed `existing` prop — a server render this dialog did not cause,
 * which the effect beside the state re-seeds from.
 */
type Section = "look" | "words";

/** The full set this dialog owns, as last written to the server. */
interface SavedState {
  colors: ColorEntry[];
  fontHeading: string;
  fontBody: string;
  visualStyle: string;
  toneKeywords: string[];
  guidelines: string;
}

/** The stored guidelines as this dialog's record of the server. */
function savedFrom(existing?: BrandingGuidelines): SavedState {
  return {
    colors: getInitialColors(existing),
    fontHeading: existing?.fontHeading ?? "",
    fontBody: existing?.fontBody ?? "",
    visualStyle: existing?.visualStyle ?? "",
    toneKeywords: existing?.toneKeywords ?? [],
    guidelines: existing?.guidelines ?? "",
  };
}

/** A comparable fingerprint of one half — what "unsaved" is measured against. */
function fingerprint(section: Section, state: SavedState): string {
  return section === "look"
    ? JSON.stringify([
        state.colors.map((c) => [c.hex.trim(), c.role.trim(), c.usagePct.trim()]),
        state.fontHeading,
        state.fontBody,
        state.visualStyle,
      ])
    : JSON.stringify([state.toneKeywords, state.guidelines]);
}

/* ── Component ───────────────────────────────────────────────────────────── */

export function BrandingModal({
  open,
  onClose,
  clientId,
  existing,
  hasWebsite,
  allowUsagePct = false,
}: Props) {
  const router = useRouter();
  /**
   * Which SECTION is mid-save (flow audit 2026-09, R14). One dialog used to own
   * six kinds of data — an AI generation run, a four-colour palette, two fonts,
   * a style taxonomy, a tag editor and a markdown document — behind one "Save
   * guidelines", so a reader who came to fix one hex had to commit all six and
   * could not tell what a press was about to change. The two halves commit
   * separately now.
   */
  const [saving, setSaving] = useState<Section | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<{ source: "ai_generated"; visualStyle?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  /** Set by an attempted close while something is unsaved — see `requestClose`. */
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Dynamic dominance-ranked color palette
  const [colors, setColors] = useState<ColorEntry[]>(getInitialColors(existing));

  // Non-color form fields
  const [form, setForm] = useState({
    fontHeading: existing?.fontHeading ?? "",
    fontBody: existing?.fontBody ?? "",
    toneKeywords: existing?.toneKeywords ?? [] as string[],
    guidelines: existing?.guidelines ?? "",
    visualStyle: existing?.visualStyle ?? "",
  });

  /**
   * What the server currently holds, as far as this dialog knows: the values it
   * opened with, advanced one section at a time by each successful Save (flow
   * audit 2026-09, R14). Both the "Unsaved changes" marks and the other half of
   * every payload are read from here.
   */
  const [saved, setSaved] = useState<SavedState>(() => savedFrom(existing));

  /**
   * AND RE-SEEDED WHEN THE SERVER MOVES UNDER US (review wave, 2026-09).
   *
   * `saved` was seeded once, at mount, and this dialog never unmounts — its
   * opener renders it unconditionally beside the pencil. So every `existing`
   * the parent re-rendered with after that was ignored: a colleague's save
   * arriving on a `router.refresh()`, a staff edit through the client record
   * editor on the same page, this dialog's own generation run reloading the
   * page. The dialog kept believing the document it opened with, marked both
   * halves "Saved" against it, and the next Save wrote that stale half back
   * over whatever had landed in the meantime.
   *
   * Only `saved` is re-seeded, never `form`: unsaved edits in the form are the
   * reader's, and are not ours to throw away. What changes is what they are
   * measured against, which is the point of the field.
   *
   * Keyed on the PROP's own fingerprint, not on `saved`'s: a re-render carrying
   * the same `existing` this component has already seen must be a no-op, or a
   * refresh that has not yet delivered our own write would drag `saved`
   * backwards — the exact revert this state exists to prevent.
   */
  const existingPrint = JSON.stringify(existing ?? null);
  const lastExistingPrint = useRef(existingPrint);
  useEffect(() => {
    if (lastExistingPrint.current === existingPrint) return;
    lastExistingPrint.current = existingPrint;
    setSaved(savedFrom(existing));
  }, [existing, existingPrint]);

  /** The live form as a `SavedState`, for comparison and for building a payload. */
  const live: SavedState = {
    colors,
    fontHeading: form.fontHeading,
    fontBody: form.fontBody,
    visualStyle: form.visualStyle,
    toneKeywords: form.toneKeywords,
    guidelines: form.guidelines,
  };
  const lookDirty = fingerprint("look", live) !== fingerprint("look", saved);
  const wordsDirty = fingerprint("words", live) !== fingerprint("words", saved);
  const anyDirty = lookDirty || wordsDirty;

  function setField<K extends keyof typeof form>(key: K, val: (typeof form)[K]) {
    setForm((s) => ({ ...s, [key]: val }));
  }

  function updateColor(idx: number, patch: Partial<ColorEntry>) {
    setColors((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }

  function removeColor(idx: number) {
    setColors((prev) => prev.filter((_, i) => i !== idx));
  }

  function addColorSlot() {
    if (colors.length < MAX_COLORS) {
      setColors((prev) => [...prev, { id: nextColorId(), hex: "", role: "", usagePct: "" }]);
    }
  }

  /** Sum of the entered usage shares - a mix that does not add to 100 is a
   *  typo far more often than it is intentional, so the form says so. */
  const usageTotal = colors.reduce((sum, c) => {
    const n = Number(c.usagePct);
    return sum + (c.usagePct.trim() && Number.isFinite(n) ? n : 0);
  }, 0);
  const anyUsageSet = colors.some((c) => c.usagePct.trim() !== "");

  /**
   * "Generate with AI" — which is a WRITE, not a proposal.
   *
   * `generateBrandingAction` calls `applyBrandingForClient`, whose last act is
   * `updateClient(clientId, { brandingGuidelines: fullGuidelines })` plus two
   * context-doc upserts. The whole profile — palette, fonts, visual style, tone
   * keywords AND the generated guidelines markdown — is already in Firestore by
   * the time this promise resolves.
   *
   * THAT IS WHY BOTH `form` AND `saved` ARE SET FROM THE RESULT. This dialog
   * re-sends the whole document on every Save (see `payloadFor`), taking the
   * half it is not editing from `saved`. So when generation moved the colours
   * into `form` and left `saved` holding the pre-generation voice, the next
   * "Save palette & typography" wrote that stale voice back over the generated
   * one — a silent revert of a document the client had just paid a model call
   * for. Advancing `saved` in the same breath is the fix: the form shows what
   * was written, and neither Save can un-write it.
   *
   * Fields the result omits are LEFT ALONE rather than blanked: `??` throughout,
   * so a generator that returns no fonts does not clear the ones on file.
   */
  async function generateFromWebsite() {
    setGenerating(true);
    setGenResult(null);
    setError(null);
    try {
      const result = await generateBrandingAction(clientId);
      setGenResult({ source: result.source, visualStyle: result.visualStyle });

      // Pre-fill palette - prefer new array, fall back to legacy scalars
      let generatedColors: ColorEntry[];
      if (result.dominantColors?.length) {
        generatedColors = result.dominantColors.map((c) => ({
          id: nextColorId(),
          hex: c.hex,
          role: c.role ?? "",
          usagePct: c.usagePct != null ? String(c.usagePct) : "",
        }));
      } else {
        generatedColors = [];
        const push = (hex: string, role: string) =>
          generatedColors.push({ id: nextColorId(), hex, role, usagePct: "" });
        if (result.primaryAccent) push(result.primaryAccent, "Primary accent");
        if (result.secondaryAccent) push(result.secondaryAccent, "Secondary accent");
        if (result.brandNeutralDark) push(result.brandNeutralDark, "");
        if (result.brandNeutralLight) push(result.brandNeutralLight, "");
      }
      setColors(generatedColors);

      setForm((s) => ({
        ...s,
        fontHeading: result.fontHeading ?? s.fontHeading,
        fontBody: result.fontBody ?? s.fontBody,
        visualStyle: result.visualStyle ?? s.visualStyle,
        toneKeywords: result.toneKeywords ?? s.toneKeywords,
        guidelines: result.guidelines ?? s.guidelines,
      }));
      // The same values, as the server's own state. Both marks read "Saved"
      // straight after a generation, because they are.
      setSaved((prev) => ({
        colors: generatedColors,
        fontHeading: result.fontHeading ?? prev.fontHeading,
        fontBody: result.fontBody ?? prev.fontBody,
        visualStyle: result.visualStyle ?? prev.visualStyle,
        toneKeywords: result.toneKeywords ?? prev.toneKeywords,
        guidelines: result.guidelines ?? prev.guidelines,
      }));
      // Nothing is pending any more, so a close is not a discard.
      setConfirmDiscard(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate from website");
    } finally {
      setGenerating(false);
    }
  }

  function addToken() {
    const token = tokenInput.trim();
    if (!token || form.toneKeywords.includes(token)) return;
    setField("toneKeywords", [...form.toneKeywords, token]);
    setTokenInput("");
  }

  function removeToken(token: string) {
    setField("toneKeywords", form.toneKeywords.filter((t) => t !== token));
  }

  /** The whole guidelines document, from `next` — the shape the action has always taken. */
  function payloadFor(next: SavedState) {
    const dominantColors: BrandColor[] = next.colors
      .filter((c) => c.hex.trim())
      .map((c, i) => {
        const pct = Number(c.usagePct);
        return {
          hex: c.hex.trim(),
          dominanceRank: i + 1,
          role: c.role.trim() || undefined,
          // Only staff forms carry this; for a client the server re-applies
          // the stored value, so omitting it here can never blank it.
          ...(allowUsagePct && c.usagePct.trim() !== "" && Number.isFinite(pct)
            ? { usagePct: Math.min(100, Math.max(0, Math.round(pct))) }
            : {}),
        };
      });
    return {
      dominantColors,
      // Mirror legacy scalar fields for backward compat
      primaryAccent: dominantColors[0]?.hex,
      secondaryAccent: dominantColors[1]?.hex,
      brandNeutralDark: dominantColors[2]?.hex,
      brandNeutralLight: dominantColors[3]?.hex,
      fontHeading: next.fontHeading,
      fontBody: next.fontBody,
      visualStyle: next.visualStyle,
      toneKeywords: next.toneKeywords,
      guidelines: next.guidelines,
    };
  }

  /**
   * Commit ONE half (flow audit 2026-09, R14): this section's live values laid
   * over everything the server already holds, so the other half is written back
   * exactly as it was rather than as whatever is currently in this form.
   *
   * "Everything the server already holds" is `saved`, and it is only as true as
   * whatever last advanced it — this open, a previous Save, or a generation
   * run. See the module note above.
   */
  async function submit(section: Section) {
    setError(null);
    setSaving(section);
    const next: SavedState =
      section === "look"
        ? {
            ...saved,
            colors,
            fontHeading: form.fontHeading,
            fontBody: form.fontBody,
            visualStyle: form.visualStyle,
          }
        : { ...saved, toneKeywords: form.toneKeywords, guidelines: form.guidelines };
    try {
      await saveBrandingGuidelinesAction(clientId, payloadFor(next));
      setSaved(next);
      setConfirmDiscard(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save guidelines");
    } finally {
      setSaving(null);
    }
  }

  /**
   * Throw the unsaved edits away and put the form back to what the server
   * holds, THEN close.
   *
   * This dialog is mounted unconditionally by its opener
   * (client-context-sections.tsx renders `<BrandingModal open={…} />` beside
   * the rail's pencil), so it never unmounts and no state is ever discarded by
   * React. Closing without this left the discarded edits — and the discard
   * banner itself — sitting in the form for the next time the pencil was
   * pressed, which is a worse lie than the one the banner was added to fix.
   *
   * Re-seeded from `saved` rather than from the `existing` PROP: `saved` is
   * this dialog's record of what the server holds, advanced by every Save and
   * by a generation run, whereas `existing` is a snapshot from whenever the
   * parent last rendered. Discarding to `existing` could resurrect a value the
   * client had already successfully saved in this same session.
   */
  function discardAndClose() {
    setColors(saved.colors);
    setForm({
      fontHeading: saved.fontHeading,
      fontBody: saved.fontBody,
      toneKeywords: saved.toneKeywords,
      guidelines: saved.guidelines,
      visualStyle: saved.visualStyle,
    });
    setTokenInput("");
    setError(null);
    setGenResult(null);
    setConfirmDiscard(false);
    onClose();
  }

  /**
   * Closing, with the discard said out loud (flow audit 2026-09, R14).
   *
   * Edits sit in this form unsaved — that is the point of the split — so the X
   * used to silently throw them away: the exact "Cancel vs Close" ambiguity,
   * on a dialog where one of the pending changes can be a paid model call's
   * output. Nothing is auto-saved; the dialog just refuses to disappear
   * quietly, and names what would go.
   *
   * RETURNS UNCONDITIONALLY while anything is dirty. It used to fall through on
   * the second gesture — `confirmDiscard` was already true — so a double-press
   * of Escape, or a second click on the backdrop, discarded everything without
   * the reader ever having answered the question. The only way past this now is
   * "Discard and close", which is a button that says what it does.
   */
  function requestClose() {
    if (anyDirty) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    onClose();
  }

  // Sentence case, and the same words as the control that opens it: the client
  // rail's pencil is aria-labelled "Edit branding guidelines"
  // (client-context-sections.tsx), so Title Case here made the dialog disagree
  // with its own trigger.
  return (
    <Modal
      open={open}
      onClose={requestClose}
      title={existing ? "Edit branding guidelines" : "Set branding guidelines"}
      description="These guidelines are used by AI agents to produce on-brand content for this client."
      className="max-w-xl"
    >
      <div className="space-y-4">
        {/* Generate from website */}
        {hasWebsite && (
          <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-border bg-surface-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Generate from website</p>
              <p className="text-xs text-muted-2">
                Karos scrapes the site or searches the web to extract real colors, fonts, and brand voice.
              </p>
            </div>
            <Button size="sm" variant="outline" loading={generating} onClick={generateFromWebsite}>
              <Icon name="Sparkles" className="h-4 w-4" />
              {generating ? "Generating…" : "Generate with AI"}
            </Button>
          </div>
        )}

        {/* Generation feedback */}
        {genResult && (
          <div className="flex items-center gap-2 rounded-[8px] border border-neon/30 bg-neon-soft/30 px-3 py-2 text-xs text-neon">
            <Icon name="CircleCheck" className="h-3.5 w-3.5 shrink-0" />
            {/* Says what the run actually DID (flow audit 2026-09, R14). An
                earlier draft of this line said "Nothing is saved yet", which
                was false in the other direction: applyBrandingForClient writes
                the whole profile before this promise resolves. Telling a client
                their generated brand voice is unsaved is how they lose it —
                they close, believing nothing happened, or they edit on top of a
                document they think is a draft. */}
            {`AI Generated from live site/search data${genResult.visualStyle ? ` · ${genResult.visualStyle}` : ""}. This profile is already saved. Edit anything below and save that section again to change it.`}
          </div>
        )}

        {/* ── Section 1 of 2: what the brand LOOKS like (flow audit 2026-09,
            R14) — palette, the two fonts, the visual style, and its own Save.
            Everything from here to that button commits together and commits
            nothing else. ── */}
        <section className="space-y-4 rounded-[10px] border border-border p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">Palette &amp; typography</h3>
          {lookDirty && <span className="text-[11px] text-warning">Unsaved changes</span>}
        </div>

        <div>
          <Label>Dominant color palette</Label>
          <p className="mb-2 text-[11px] text-muted-2">
            Up to 4 colors ordered by visual prominence. Color 1 = most dominant (logo, main CTA). No dark/light constraints.
            {allowUsagePct && " Usage % is internal. Clients see the swatches only."}
          </p>
          <div className="space-y-2">
            {colors.map((entry, idx) => (
              <div key={entry.id} className="flex items-center gap-2">
                {/* The swatch's ordinal — a number, and DM Mono has no 600 to give it. */}
                <span className="stat-number w-5 shrink-0 text-center text-[11px] font-medium text-muted-2">
                  {idx + 1}
                </span>
                <input
                  type="color"
                  value={entry.hex || "#000000"}
                  onChange={(e) => updateColor(idx, { hex: e.target.value })}
                  className="h-9 w-10 shrink-0 cursor-pointer rounded-[8px] border border-border bg-surface-2 p-1"
                />
                <Input
                  value={entry.hex}
                  onChange={(e) => updateColor(idx, { hex: e.target.value })}
                  placeholder="#000000"
                  className="w-28 shrink-0 font-mono text-sm"
                />
                <Input
                  value={entry.role}
                  onChange={(e) => updateColor(idx, { role: e.target.value })}
                  placeholder="Role (e.g. Logo fill, CTA)"
                  className="flex-1 text-xs"
                />
                {allowUsagePct && (
                  <div className="relative shrink-0">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={entry.usagePct}
                      onChange={(e) => updateColor(idx, { usagePct: e.target.value })}
                      placeholder="–"
                      aria-label={`Usage percentage for color ${idx + 1}`}
                      className="w-[72px] pr-5 text-center font-mono text-xs"
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-2">
                      %
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeColor(idx)}
                  className="shrink-0 text-muted-2 transition-colors hover:text-danger"
                  aria-label={`Remove color ${idx + 1}`}
                >
                  <Icon name="X" className="h-4 w-4" />
                </button>
              </div>
            ))}
            {colors.length < MAX_COLORS && (
              <Button type="button" variant="outline" size="sm" onClick={addColorSlot}>
                <Icon name="Plus" className="h-3.5 w-3.5" />
                Add color slot
              </Button>
            )}
            {allowUsagePct && anyUsageSet && (
              <p
                className={
                  usageTotal === 100 ? "text-[11px] text-muted" : "text-[11px] text-warning"
                }
              >
                {/* JSX collapses the newline between these two expressions to
                    nothing, so the warning read "Usage total 87%a brand mix
                    normally adds up to 100%." The separator has to be inside
                    the string that is conditional, or it appears on the line
                    that has nothing to separate. */}
                Usage total {usageTotal}%
                {usageTotal === 100 ? "" : " · a brand mix normally adds up to 100%."}
              </p>
            )}
          </div>
        </div>

        {/* Fonts */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Heading font</Label>
            <Input
              value={form.fontHeading}
              onChange={(e) => setField("fontHeading", e.target.value)}
              placeholder="Inter, Helvetica, etc."
            />
          </div>
          <div>
            <Label>Body font</Label>
            <Input
              value={form.fontBody}
              onChange={(e) => setField("fontBody", e.target.value)}
              placeholder="Inter, Georgia, etc."
            />
          </div>
        </div>

        {/* Visual style */}
        <div>
          <Label>Visual style</Label>
          <select
            value={form.visualStyle}
            onChange={(e) => setField("visualStyle", e.target.value)}
            className="w-full rounded-[8px] border border-border bg-surface-2 px-3 py-2 text-sm text-foreground outline-none focus:border-neon"
          >
            <option value="">(Not set)</option>
            <option value="Minimalist">Minimalist</option>
            <option value="Corporate">Corporate</option>
            <option value="Dark Mode">Dark Mode</option>
            <option value="High-Tech">High-Tech</option>
            <option value="Vibrant">Vibrant</option>
            <option value="Luxury">Luxury</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            loading={saving === "look"}
            disabled={saving !== null || !lookDirty}
            onClick={() => submit("look")}
          >
            Save palette &amp; typography
          </Button>
          {!lookDirty && <span className="text-[11px] text-muted-2">Saved</span>}
        </div>
        </section>

        {/* ── Section 2 of 2: how the brand SOUNDS — the tone chips and the
            markdown document, with their own Save. ── */}
        <section className="space-y-4 rounded-[10px] border border-border p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">Voice &amp; guidelines</h3>
          {wordsDirty && <span className="text-[11px] text-warning">Unsaved changes</span>}
        </div>

        {/* Tone keywords */}
        <div>
          <Label>Tone & voice keywords</Label>
          <div className="flex gap-2">
            <Input
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addToken())}
              placeholder="Bold, Challenger, Transparent…"
              className="flex-1"
            />
            <Button type="button" variant="outline" size="sm" onClick={addToken}>
              Add
            </Button>
          </div>
          {form.toneKeywords.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {form.toneKeywords.map((t) => (
                <span
                  key={t}
                  className="flex items-center gap-1 rounded-full border border-neon/30 bg-neon-soft px-2.5 py-0.5 text-xs font-medium text-neon"
                >
                  {t}
                  <button
                    onClick={() => removeToken(t)}
                    className="ml-0.5 text-neon/60 hover:text-neon"
                    aria-label={`Remove ${t}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Freeform guidelines */}
        <div>
          <Label>Guidelines text (markdown)</Label>
          <Textarea
            value={form.guidelines}
            onChange={(e) => setField("guidelines", e.target.value)}
            placeholder={"## Brand Voice\nWe are bold, transparent, and challenger-focused...\n\n## Do's and Don'ts\n- Do: Lead with data and specifics\n- Don't: Use corporate jargon"}
            className="h-40 font-mono text-xs"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            loading={saving === "words"}
            disabled={saving !== null || !wordsDirty}
            onClick={() => submit("words")}
          >
            Save voice &amp; guidelines
          </Button>
          {!wordsDirty && <span className="text-[11px] text-muted-2">Saved</span>}
        </div>
        </section>

        {error && <p className="text-xs text-danger">{error}</p>}

        {/* The two-step inline confirm this codebase already uses for a
            destructive press (client-key-inline.tsx, client-seat-remove.tsx),
            applied to the one that was silent: closing on unsaved work. */}
        {confirmDiscard && (
          <div className="rounded-[8px] border border-warning/30 bg-warning/10 px-3 py-2.5">
            <p className="text-xs text-warning">
              {lookDirty && wordsDirty
                ? "The palette, typography, voice and guidelines you changed have not been saved."
                : lookDirty
                  ? "The palette and typography you changed have not been saved."
                  : "The voice and guidelines you changed have not been saved."}{" "}
              Close and lose them?
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
              <Button size="sm" variant="ghost" onClick={discardAndClose}>
                Discard and close
              </Button>
            </div>
          </div>
        )}

        <div className="flex justify-end pt-1">
          <Button variant="outline" onClick={requestClose} disabled={saving !== null}>
            {anyDirty ? "Close" : "Done"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
