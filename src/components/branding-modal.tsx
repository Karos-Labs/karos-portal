"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { Button, Label, Input, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { saveBrandingGuidelinesAction, generateBrandingAction } from "@/lib/actions";
import type { BrandingGuidelines } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  clientId: string;
  existing?: BrandingGuidelines;
  /** When true, shows the "Generate from website" button that scrapes and pre-fills the form. */
  hasWebsite?: boolean;
}

export function BrandingModal({ open, onClose, clientId, existing, hasWebsite }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<{ source: "ai_generated"; visualStyle?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");

  const [form, setForm] = useState<Omit<BrandingGuidelines, "updatedAt">>({
    primaryColor: existing?.primaryColor ?? "",
    secondaryColor: existing?.secondaryColor ?? "",
    fontHeading: existing?.fontHeading ?? "",
    fontBody: existing?.fontBody ?? "",
    toneKeywords: existing?.toneKeywords ?? [],
    logoUrl: existing?.logoUrl ?? "",
    guidelines: existing?.guidelines ?? "",
    visualStyle: existing?.visualStyle ?? "",
  });

  function setField<K extends keyof typeof form>(key: K, val: (typeof form)[K]) {
    setForm((s) => ({ ...s, [key]: val }));
  }

  async function generateFromWebsite() {
    setGenerating(true);
    setGenResult(null);
    setError(null);
    try {
      const result = await generateBrandingAction(clientId);
      setGenResult({ source: result.source, visualStyle: result.visualStyle });
      // Pre-fill form with scraped values so the user can review and adjust before saving
      // Pre-fill form with AI-generated values so the user can review and adjust before saving.
      setForm((s) => ({
        ...s,
        primaryColor: result.primaryColor ?? s.primaryColor,
        secondaryColor: result.secondaryColor ?? s.secondaryColor,
        visualStyle: result.visualStyle ?? s.visualStyle,
      }));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate from website");
    } finally {
      setGenerating(false);
    }
  }

  function addToken() {
    const token = tokenInput.trim();
    if (!token || form.toneKeywords?.includes(token)) return;
    setField("toneKeywords", [...(form.toneKeywords ?? []), token]);
    setTokenInput("");
  }

  function removeToken(token: string) {
    setField(
      "toneKeywords",
      (form.toneKeywords ?? []).filter((t) => t !== token),
    );
  }

  async function submit() {
    setError(null);
    setLoading(true);
    try {
      await saveBrandingGuidelinesAction(clientId, form);
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
        {/* Generate from website — shown when a website URL is configured */}
        {hasWebsite && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Generate from website</p>
              <p className="text-xs text-muted-2">
                Karos uses AI domain knowledge to generate colors, fonts, and brand voice.
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
          <div className="flex items-center gap-2 rounded-md border border-neon/30 bg-neon-soft/30 px-3 py-2 text-xs text-neon">
            <Icon name="CheckCircle" className="h-3.5 w-3.5 shrink-0" />
            {`AI Generated from Domain Knowledge${genResult.visualStyle ? ` · ${genResult.visualStyle}` : ""}. Review the values below and save.`}
          </div>
        )}

        {/* Colors */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Primary color</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.primaryColor || "#FF6B2C"}
                onChange={(e) => setField("primaryColor", e.target.value)}
                className="h-9 w-12 cursor-pointer rounded-md border border-border bg-surface-2 p-1"
              />
              <Input
                value={form.primaryColor ?? ""}
                onChange={(e) => setField("primaryColor", e.target.value)}
                placeholder="#FF6B2C"
                className="flex-1 font-mono text-sm"
              />
            </div>
          </div>
          <div>
            <Label>Secondary color</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.secondaryColor || "#ffffff"}
                onChange={(e) => setField("secondaryColor", e.target.value)}
                className="h-9 w-12 cursor-pointer rounded-md border border-border bg-surface-2 p-1"
              />
              <Input
                value={form.secondaryColor ?? ""}
                onChange={(e) => setField("secondaryColor", e.target.value)}
                placeholder="#ffffff"
                className="flex-1 font-mono text-sm"
              />
            </div>
          </div>
        </div>

        {/* Fonts */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Heading font</Label>
            <Input
              value={form.fontHeading ?? ""}
              onChange={(e) => setField("fontHeading", e.target.value)}
              placeholder="Inter, Helvetica, etc."
            />
          </div>
          <div>
            <Label>Body font</Label>
            <Input
              value={form.fontBody ?? ""}
              onChange={(e) => setField("fontBody", e.target.value)}
              placeholder="Inter, Georgia, etc."
            />
          </div>
        </div>

        {/* Visual style */}
        <div>
          <Label>Visual style</Label>
          <select
            value={form.visualStyle ?? ""}
            onChange={(e) => setField("visualStyle", e.target.value)}
            className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground outline-none focus:border-neon"
          >
            <option value="">— Not set —</option>
            <option value="Minimalist">Minimalist</option>
            <option value="Corporate">Corporate</option>
            <option value="Dark Mode">Dark Mode</option>
            <option value="High-Tech">High-Tech</option>
            <option value="Vibrant">Vibrant</option>
            <option value="Luxury">Luxury</option>
          </select>
        </div>

        {/* Logo URL */}
        <div>
          <Label>Logo URL</Label>
          <div className="relative">
            <Icon name="Link" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-2" />
            <Input
              value={form.logoUrl ?? ""}
              onChange={(e) => setField("logoUrl", e.target.value)}
              placeholder="https://..."
              className="pl-9"
            />
          </div>
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
          {(form.toneKeywords ?? []).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(form.toneKeywords ?? []).map((t) => (
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
            value={form.guidelines ?? ""}
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
