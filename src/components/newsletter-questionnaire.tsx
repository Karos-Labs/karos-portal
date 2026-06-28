"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Label, Input, Textarea, Select, Button, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  saveNewsletterConfigAction,
  setNewsletterOptInAction,
  deleteContextItemAction,
} from "@/lib/actions";
import { missingBrandFields } from "@/lib/newsletter/brand";
import type {
  BrandCta,
  BrandFont,
  BrandLogo,
  BrandPalette,
  BrandSender,
  ContentFoundation,
  NewsletterBrand,
  NewsletterConfig,
} from "@/lib/newsletter/types";
import type { ContextItem } from "@/lib/types";

const MAX_BYTES = 4 * 1024 * 1024;

const LOCALES = ["en", "pt-BR", "es", "fr", "de", "it"] as const;
const SEND_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const CADENCES = ["weekly", "biweekly", "monthly"] as const;
const REGISTERS = ["formal", "conversational", "challenger", "warm"] as const;

/** Friendly labels for the readiness banner's dotted field paths. */
const FIELD_LABELS: Record<string, string> = {
  "_meta.company_name": "Company name",
  "palette.navy": "Primary colour",
  "palette.cream": "Surface colour",
  "palette.gold": "Accent colour",
  "fonts.display.stack": "Display font",
  "fonts.body.stack": "Body font",
  "fonts.mono.stack": "Mono font",
  "fonts.google_fonts_href": "Google Fonts URL",
  site_url: "Website URL",
  locale: "Language",
  "compliance.disclaimer_pt": "Legal footer disclaimer",
};

const PALETTE_SLOTS: { key: keyof BrandPalette; label: string }[] = [
  { key: "navy", label: "Primary / dark" },
  { key: "navy_2", label: "Primary alt" },
  { key: "cream", label: "Surface / light" },
  { key: "cream_2", label: "Surface alt" },
  { key: "gold", label: "Accent" },
  { key: "line", label: "Hairline / border" },
];

/* ------------------------------- fields ------------------------------- */

function TextField({
  label, value, onChange, placeholder, type, hint,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; hint?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input value={value} type={type} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="mt-1 text-[11px] text-muted-2">{hint}</p>}
    </div>
  );
}

function AreaField({
  label, value, onChange, placeholder, rows, hint,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; rows?: number; hint?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Textarea value={value} rows={rows} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="mt-1 text-[11px] text-muted-2">{hint}</p>}
    </div>
  );
}

/** A list edited as one-item-per-line; empty lines are dropped on save by the composer. */
function ListField({
  label, value, onChange, placeholder, hint,
}: {
  label: string; value: string[]; onChange: (v: string[]) => void;
  placeholder?: string; hint?: string;
}) {
  return (
    <AreaField
      label={label}
      value={value.join("\n")}
      onChange={(v) => onChange(v.split("\n"))}
      placeholder={placeholder}
      hint={hint ?? "One per line."}
    />
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const swatch = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={swatch}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} colour picker`}
          className="h-9 w-10 shrink-0 cursor-pointer rounded-[8px] border border-border bg-surface-2 p-0.5"
        />
        <Input value={value} placeholder="#000000" onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <Card className="space-y-4">
      <div>
        <CardTitle>{title}</CardTitle>
        {desc && <p className="mt-1 text-sm text-muted-2">{desc}</p>}
      </div>
      {children}
    </Card>
  );
}

/* ----------------------------- uploads card --------------------------- */

function UploadGroup({
  clientId, purpose, title, desc, items,
}: {
  clientId: string;
  purpose: "newsletter_reference" | "image_pool";
  title: string;
  desc: string;
  items: ContextItem[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList) {
    setError(null);
    const list = Array.from(files);
    const tooBig = list.find((f) => f.size > MAX_BYTES);
    if (tooBig) {
      setError(`“${tooBig.name}” is larger than 4 MB.`);
      return;
    }
    setBusy(true);
    try {
      for (const file of list) {
        const body = new FormData();
        body.append("file", file);
        body.append("purpose", purpose);
        const res = await fetch(`/api/clients/${clientId}/context`, { method: "POST", body });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `Upload failed for ${file.name}`);
        }
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(item: ContextItem) {
    if (!confirm(`Remove “${item.name}”?`)) return;
    await deleteContextItemAction(item.id);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-[11px] text-muted-2">{desc}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} loading={busy}>
          <Icon name="Upload" className="h-3.5 w-3.5" /> Upload
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => e.target.files && e.target.files.length > 0 && upload(e.target.files)}
        />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {items.length === 0 ? (
        <p className="text-xs text-muted-2">Nothing uploaded yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-[10px] border border-border">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <a href={it.url} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-2 text-sm hover:text-neon">
                <Icon name={it.kind === "image" ? "Image" : "FileText"} className="h-4 w-4 shrink-0 text-muted-2" />
                <span className="truncate">{it.name}</span>
              </a>
              <button onClick={() => remove(it)} className="shrink-0 text-muted-2 hover:text-danger" aria-label="Remove">
                <Icon name="Trash2" className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ----------------------------- main form ------------------------------ */

export function NewsletterQuestionnaire({
  clientId, config, references, imagePool,
}: {
  clientId: string;
  config: NewsletterConfig;
  references: ContextItem[];
  imagePool: ContextItem[];
}) {
  const router = useRouter();
  const [brand, setBrand] = useState<NewsletterBrand>(config.brand);
  const [foundation, setFoundation] = useState<ContentFoundation>(config.foundation);
  const [optIn, setOptIn] = useState<boolean>(config.optIn ?? false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const missing = missingBrandFields(brand);
  const ready = missing.length === 0;

  /* nested-field updaters (keep onChange handlers short + type-safe) */
  const setMeta = (k: "company_name" | "source", v: string) => setBrand((b) => ({ ...b, _meta: { ...b._meta, [k]: v } }));
  const setTop = (k: "site_url" | "locale", v: string) => setBrand((b) => ({ ...b, [k]: v }));
  const setPalette = (k: keyof BrandPalette, v: string) => setBrand((b) => ({ ...b, palette: { ...b.palette, [k]: v } }));
  const setFont = (which: "display" | "body" | "mono", k: keyof BrandFont, v: string) =>
    setBrand((b) => ({ ...b, fonts: { ...b.fonts, [which]: { ...b.fonts[which], [k]: v } } }));
  const setFontsHref = (v: string) => setBrand((b) => ({ ...b, fonts: { ...b.fonts, google_fonts_href: v } }));
  const setLogo = (k: keyof BrandLogo, v: string) => setBrand((b) => ({ ...b, logo: { ...b.logo, [k]: v } }));
  const setVoice = (k: "archetype" | "language", v: string) => setBrand((b) => ({ ...b, voice: { ...b.voice, [k]: v } }));
  const setVoiceRules = (arr: string[]) => setBrand((b) => ({ ...b, voice: { ...b.voice, hard_rules: arr } }));
  const setCompliance = (k: "disclaimer_pt" | "regulatory_line", v: string) =>
    setBrand((b) => ({ ...b, compliance: { ...b.compliance, [k]: v } }));
  const setNever = (arr: string[]) => setBrand((b) => ({ ...b, compliance: { ...b.compliance, never: arr } }));
  const setBannedExtra = (arr: string[]) => setBrand((b) => ({ ...b, compliance: { ...b.compliance, banned_extra: arr } }));
  const setSender = (k: keyof BrandSender, v: string) => setBrand((b) => ({ ...b, sender: { ...b.sender, [k]: v } }));
  const setNl = (k: "name" | "cadence" | "send_day", v: string) =>
    setBrand((b) => ({ ...b, newsletter: { ...b.newsletter, [k]: v } }));
  const setCta = (k: keyof BrandCta, v: string) =>
    setBrand((b) => ({ ...b, newsletter: { ...b.newsletter, default_cta: { ...b.newsletter.default_cta, [k]: v } } }));
  const setBlog = (k: "index_title" | "index_dek" | "meta_description", v: string) =>
    setBrand((b) => ({ ...b, blog: { ...b.blog, [k]: v } }));
  const setF = (k: "whoTheyAre" | "audience" | "voiceRegister" | "keywordTargets" | "complianceConstraints" | "cadenceNotes", v: string) =>
    setFoundation((f) => ({ ...f, [k]: v }));
  const setFList = (k: "voiceHardRules" | "pillars" | "seedTopics", arr: string[]) =>
    setFoundation((f) => ({ ...f, [k]: arr }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveNewsletterConfigAction(clientId, { brand, foundation });
      setSavedAt(Date.now());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function toggleOptIn() {
    const next = !optIn;
    setOptIn(next);
    try {
      await setNewsletterOptInAction(clientId, next);
      router.refresh();
    } catch (e) {
      setOptIn(!next); // revert on failure
      setError(e instanceof Error ? e.message : "Could not update opt-in");
    }
  }

  return (
    <div className="space-y-6 pb-24">
      {/* readiness + opt-in */}
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Badge tone={ready ? "neon" : "warning"}>{ready ? "Ready to generate" : "Draft"}</Badge>
          {ready ? (
            <p className="text-sm text-muted-2">All required brand fields are filled.</p>
          ) : (
            <p className="text-sm text-muted-2">
              {missing.length} required field{missing.length === 1 ? "" : "s"} left:{" "}
              <span className="text-muted">{missing.map((m) => FIELD_LABELS[m] ?? m).join(", ")}</span>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={toggleOptIn}
          className="inline-flex items-center gap-2 text-sm"
          aria-pressed={optIn}
        >
          <span className={`relative h-5 w-9 rounded-full transition-colors ${optIn ? "bg-neon" : "bg-surface-3"}`}>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${optIn ? "left-[18px]" : "left-0.5"}`} />
          </span>
          <span className={optIn ? "text-foreground" : "text-muted"}>Weekly newsletter opt-in</span>
        </button>
      </Card>

      {/* ---- Section A: Brand & identity ---- */}
      <Section title="A · Brand & identity" desc="The visual/identity layer. Mostly extractable from their site + brand guide; confirm here.">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Company / brand name" value={brand._meta.company_name} onChange={(v) => setMeta("company_name", v)} />
          <div>
            <Label>Primary language</Label>
            <Select
              value={brand.locale}
              onChange={(e) => { setTop("locale", e.target.value); setVoice("language", e.target.value); }}
            >
              {LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
            </Select>
          </div>
          <TextField label="Website URL" value={brand.site_url} onChange={(v) => setTop("site_url", v)} placeholder="https://client.com" />
          <TextField label="Newsletter name" value={brand.newsletter.name} onChange={(v) => setNl("name", v)} placeholder="The Northwind Journal" />
          <div>
            <Label>Send day</Label>
            <Select value={brand.newsletter.send_day} onChange={(e) => setNl("send_day", e.target.value)}>
              {SEND_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
            </Select>
          </div>
          <div>
            <Label>Cadence</Label>
            <Select value={brand.newsletter.cadence} onChange={(e) => setNl("cadence", e.target.value)}>
              {CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Default CTA label" value={brand.newsletter.default_cta.label} onChange={(v) => setCta("label", v)} placeholder="Book a call" />
          <TextField label="Default CTA URL" value={brand.newsletter.default_cta.url} onChange={(v) => setCta("url", v)} placeholder="https://client.com/contact" />
        </div>

        <div>
          <Label>Brand colours</Label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {PALETTE_SLOTS.map((s) => (
              <ColorField key={s.key} label={s.label} value={brand.palette[s.key]} onChange={(v) => setPalette(s.key, v)} />
            ))}
          </div>
          <TextField label="Colour-usage rule" value={brand.palette.rule} onChange={(v) => setPalette("rule", v)} hint="e.g. 60/30/10: base, type/surface, accent." />
        </div>

        <div className="space-y-3">
          <Label>Fonts</Label>
          {(["display", "body", "mono"] as const).map((which) => (
            <div key={which} className="grid gap-3 sm:grid-cols-2">
              <TextField label={`${which} — family`} value={brand.fonts[which].family} onChange={(v) => setFont(which, "family", v)} placeholder="Playfair Display" />
              <TextField label={`${which} — CSS stack`} value={brand.fonts[which].stack} onChange={(v) => setFont(which, "stack", v)} placeholder="'Playfair Display', Georgia, serif" />
            </div>
          ))}
          <TextField label="Google Fonts <link> href" value={brand.fonts.google_fonts_href} onChange={setFontsHref} placeholder="https://fonts.googleapis.com/css2?family=…&display=swap" />
        </div>

        <div className="space-y-3">
          <TextField label="Logo wordmark" value={brand.logo.wordmark} onChange={(v) => setLogo("wordmark", v)} />
          <AreaField label="Logo mark — inline SVG (dark)" value={brand.logo.inline_mark_svg} onChange={(v) => setLogo("inline_mark_svg", v)} rows={3} placeholder="<svg …></svg>" />
          <AreaField label="Logo mark — inline SVG (light/inverse)" value={brand.logo.inline_mark_svg_inverse} onChange={(v) => setLogo("inline_mark_svg_inverse", v)} rows={3} placeholder="<svg …></svg>" />
        </div>

        <div className="space-y-3">
          <TextField label="Brand voice — archetype / persona" value={brand.voice.archetype} onChange={(v) => setVoice("archetype", v)} placeholder="Senior advisor who has seen every cycle. Challenger, not arrogant." />
          <ListField label="Brand voice — hard rules (render + humanizer)" value={brand.voice.hard_rules} onChange={setVoiceRules} hint="One per line. e.g. No em dashes. No exclamation points." />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Sender name" value={brand.sender.from_name} onChange={(v) => setSender("from_name", v)} />
          <TextField label="From email" value={brand.sender.from_email} onChange={(v) => setSender("from_email", v)} type="email" placeholder="hello@client.com" />
          <TextField label="Reply-to email" value={brand.sender.reply_to} onChange={(v) => setSender("reply_to", v)} type="email" />
          <TextField label="“Why you got this” line" value={brand.sender.reason_line} onChange={(v) => setSender("reason_line", v)} />
        </div>

        <AreaField label="Legal footer disclaimer (in the client's language)" value={brand.compliance.disclaimer_pt} onChange={(v) => setCompliance("disclaimer_pt", v)} rows={3} hint="The locked footer. The compliance gate never scans this — it may say 'not financial advice', etc." />
        <TextField label="Regulatory / registration line (optional)" value={brand.compliance.regulatory_line} onChange={(v) => setCompliance("regulatory_line", v)} />
        <ListField label="Phrases that must NEVER appear" value={brand.compliance.never} onChange={setNever} hint="One per line. e.g. promised returns for a fintech, medical claims for health." />
        <ListField label="Extra banned literals (hard-blocked by the gate)" value={brand.compliance.banned_extra} onChange={setBannedExtra} />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Blog index title" value={brand.blog.index_title} onChange={(v) => setBlog("index_title", v)} />
          <TextField label="Blog one-line description" value={brand.blog.index_dek} onChange={(v) => setBlog("index_dek", v)} />
        </div>
        <TextField label="Blog meta description (under 155 chars)" value={brand.blog.meta_description} onChange={(v) => setBlog("meta_description", v)} />
      </Section>

      {/* ---- Section B: Editorial brain ---- */}
      <Section title="B · Editorial brain" desc="What lets the engine write in their voice about the right things. Becomes CONTENT-FOUNDATION.md.">
        <AreaField label="Who are you, in one paragraph?" value={foundation.whoTheyAre} onChange={(v) => setF("whoTheyAre", v)} rows={3} />
        <AreaField label="Who is your audience?" value={foundation.audience} onChange={(v) => setF("audience", v)} rows={3} hint="Their level (beginner / informed / expert) and what they're deciding on." />
        <div>
          <Label>How should you sound? (dominant register)</Label>
          <Select value={foundation.voiceRegister} onChange={(e) => setF("voiceRegister", e.target.value)}>
            <option value="">— pick one —</option>
            {REGISTERS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </div>
        <ListField label="Hard voice rules" value={foundation.voiceHardRules} onChange={(a) => setFList("voiceHardRules", a)} hint="One per line. e.g. sentence length 8–15 words; open with a fact, never a rhetorical question." />
        <ListField label="Content pillars (4–6 themes you want to be known for)" value={foundation.pillars} onChange={(a) => setFList("pillars", a)} placeholder={"Pillar — what it covers and why it builds trust"} />
        <ListField label="Seed topic pool (8–15 concrete topics)" value={foundation.seedTopics} onChange={(a) => setFList("seedTopics", a)} placeholder={"Topic — pillar"} />
        <AreaField label="Keyword & GEO targets (for the blog)" value={foundation.keywordTargets} onChange={(v) => setF("keywordTargets", v)} rows={3} hint="Keyword clusters + the questions real readers and AI assistants ask." />
        <AreaField label="Compliance / hard constraints" value={foundation.complianceConstraints} onChange={(v) => setF("complianceConstraints", v)} rows={3} hint="Mirror the strict never-say phrases into the brand's NEVER list above so the code gate enforces them." />
        <AreaField label="Cadence notes / seasonal exceptions (optional)" value={foundation.cadenceNotes} onChange={(v) => setF("cadenceNotes", v)} rows={2} />
      </Section>

      {/* ---- Section C: Assets ---- */}
      <Section title="C · Assets (uploads)" desc="Voice anchors and imagery. Optional — the engine degrades gracefully if there are none.">
        <UploadGroup
          clientId={clientId}
          purpose="newsletter_reference"
          title="Past newsletters (3–5)"
          desc="Used for voice matching — the agent + humanizer learn their rhythm and tone."
          items={references}
        />
        <UploadGroup
          clientId={clientId}
          purpose="image_pool"
          title="Image pool"
          desc="Hero images for issues / blog covers, referenced by URL."
          items={imagePool}
        />
      </Section>

      {/* sticky save bar */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-6 py-3">
          <div className="min-w-0 text-xs text-muted-2">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : savedAt ? (
              <span className="text-neon">Saved.</span>
            ) : (
              <span>Changes are saved when you click Save.</span>
            )}
          </div>
          <Button onClick={save} loading={saving}>
            <Icon name="Save" className="h-4 w-4" /> Save setup
          </Button>
        </div>
      </div>
    </div>
  );
}
