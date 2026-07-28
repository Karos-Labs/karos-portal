"use client";

import { useState } from "react";
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
}

/* ── Color entry (local form state — lighter than full BrandColor) ─────── */

interface ColorEntry {
  id: number;
  hex: string;
  role: string;
}

const MAX_COLORS = 4;

let _colorIdCounter = 0;
function nextColorId() { return ++_colorIdCounter; }

/** Synthesise initial color entries from existing guidelines, preferring the new array. */
function getInitialColors(existing?: BrandingGuidelines): ColorEntry[] {
  if (existing?.dominantColors?.length) {
    return existing.dominantColors.map((c) => ({ id: nextColorId(), hex: c.hex, role: c.role ?? "" }));
  }
  // Fall back to legacy scalar fields for pre-migration clients
  const entries: ColorEntry[] = [];
  const add = (hex: string | undefined, role: string) => {
    if (hex) entries.push({ id: nextColorId(), hex, role });
  };
  add(existing?.primaryAccent ?? existing?.primaryColor, "Primary accent");
  add(existing?.secondaryAccent ?? existing?.secondaryColor, "Secondary accent");
  add(existing?.brandNeutralDark ?? existing?.uiBackground, "");
  add(existing?.brandNeutralLight ?? existing?.uiText, "");
  return entries;
}

/* ── Component ───────────────────────────────────────────────────────────── */

export function BrandingModal({ open, onClose, clientId, existing, hasWebsite }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<{ source: "ai_generated"; visualStyle?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");

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
    if (colors.length < MAX_COLORS) setColors((prev) => [...prev, { id: nextColorId(), hex: "", role: "" }]);
  }

  async function generateFromWebsite() {
    setGenerating(true);
    setGenResult(null);
    setError(null);
    try {
      const result = await generateBrandingAction(clientId);
      setGenResult({ source: result.source, visualStyle: result.visualStyle });

      // Pre-fill palette — prefer new array, fall back to legacy scalars
      if (result.dominantColors?.length) {
        setColors(result.dominantColors.map((c) => ({ id: nextColorId(), hex: c.hex, role: c.role ?? "" })));
      } else {
        const newColors: ColorEntry[] = [];
        if (result.primaryAccent) newColors.push({ id: nextColorId(), hex: result.primaryAccent, role: "Primary accent" });
        if (result.secondaryAccent) newColors.push({ id: nextColorId(), hex: result.secondaryAccent, role: "Secondary accent" });
        if (result.brandNeutralDark) newColors.push({ id: nextColorId(), hex: result.brandNeutralDark, role: "" });
        if (result.brandNeutralLight) newColors.push({ id: nextColorId(), hex: result.brandNeutralLight, role: "" });
        setColors(newColors);
      }

      setForm((s) => ({ ...s, visualStyle: result.visualStyle ?? s.visualStyle }));
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

  async function submit() {
    setError(null);
    setLoading(true);
    try {
      const dominantColors: BrandColor[] = colors
        .filter((c) => c.hex.trim())
        .map((c, i) => ({
          hex: c.hex.trim(),
          dominanceRank: i + 1,
          role: c.role.trim() || undefined,
        }));

      await saveBrandingGuidelinesAction(clientId, {
        dominantColors,
        // Mirror legacy scalar fields for backward compat
        primaryAccent: dominantColors[0]?.hex,
        secondaryAccent: dominantColors[1]?.hex,
        brandNeutralDark: dominantColors[2]?.hex,
        brandNeutralLight: dominantColors[3]?.hex,
        ...form,
      });
      onClose();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save guidelines");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? "Edit Branding Guidelines" : "Set Branding Guidelines"}
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
            {`AI Generated from live site/search data${genResult.visualStyle ? ` · ${genResult.visualStyle}` : ""}. Review the values below and save.`}
          </div>
        )}

        {/* Dynamic dominant color palette */}
        <div>
          <Label>Dominant color palette</Label>
          <p className="mb-2 text-[10px] text-muted-2">
            Up to 4 colors ordered by visual prominence. Color 1 = most dominant (logo, main CTA). No dark/light constraints.
          </p>
          <div className="space-y-2">
            {colors.map((entry, idx) => (
              <div key={entry.id} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-center font-mono text-[10px] font-semibold text-muted-2">
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

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" loading={loading} onClick={submit}>
            Save guidelines
          </Button>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
