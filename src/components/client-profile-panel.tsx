"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { updateClientProfileAction } from "@/lib/actions";
import type { Client, SocialLinks } from "@/lib/types";

const TEAM_SIZES = ["1–10", "11–50", "51–200", "201–500", "500+"];

// Only channels we actually handle — @-handles.
const SOCIALS: { key: keyof SocialLinks; placeholder: string }[] = [
  { key: "instagram", placeholder: "instagram handle" },
  { key: "x", placeholder: "x / twitter handle" },
  { key: "tiktok", placeholder: "tiktok handle" },
];

/* ── Pill-shaped input ────────────────────────────────────────────────── */

function Pill({
  icon,
  children,
  className,
}: {
  icon: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 focus-within:border-neon/50",
        className,
      )}
    >
      <Icon name={icon} className="h-4 w-4 shrink-0 text-muted-2" />
      {children}
    </div>
  );
}

/* ── Brand Profile slide-in modal ─────────────────────────────────────── */

function BrandProfileModal({ client, onClose }: { client: Client; onClose: () => void }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    brandVoice: client.brandVoice ?? "",
    contactEmail: client.contactEmail ?? "",
    website: client.website ?? "",
    industry: client.industry ?? "",
    domainsCsv: (client.domains ?? []).join(", "),
    description: client.description ?? "",
  });

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  function set(k: keyof typeof form, v: string) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await updateClientProfileAction(client.id, form);
      if (!res.ok) { setError(res.error); return; }
      onClose();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full rounded-[8px] border border-border bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-2 outline-none focus:border-neon/50 transition-colors";
  const labelCls = "mb-1.5 block text-xs font-medium text-muted";

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex justify-end"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-full w-full max-w-[92%] flex-col border-l border-border bg-surface shadow-2xl md:max-w-[420px]">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3.5">
          <div className="flex items-center gap-2">
            <Icon name="Contact" className="h-4 w-4 text-muted-2" />
            <p className="text-sm font-semibold text-foreground">Brand Profile</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            aria-label="Close"
          >
            <Icon name="X" className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className={labelCls}>Brand Voice</label>
            <textarea
              value={form.brandVoice}
              onChange={(e) => set("brandVoice", e.target.value)}
              placeholder="Tone, vocabulary, content rules…"
              rows={4}
              className={cn(inputCls, "resize-none")}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Contact Email</label>
              <input type="email" value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Website</label>
              <input type="url" value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://…" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Industry</label>
              <input value={form.industry} onChange={(e) => set("industry", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Meeting Domain</label>
              <input value={form.domainsCsv} onChange={(e) => set("domainsCsv", e.target.value)} placeholder="company.com" className={inputCls} />
            </div>
          </div>

          <div>
            <label className={labelCls}>About</label>
            <textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Short company description…"
              rows={3}
              className={cn(inputCls, "resize-none")}
            />
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center gap-2 border-t border-border px-6 py-4">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-[8px] bg-neon px-4 py-2 text-sm font-semibold text-[#03110b] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Icon name={saving ? "Loader" : "Check"} className={cn("h-3.5 w-3.5", saving && "animate-spin")} />
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-[8px] px-4 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ClientProfilePanel({ client }: { client: Client }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState(client.category ?? "");
  const [teamSize, setTeamSize] = useState(client.teamSize ?? "");
  const [links, setLinks] = useState<SocialLinks>(client.socialLinks ?? {});
  const [brandProfileOpen, setBrandProfileOpen] = useState(false);

  function setLink(key: keyof SocialLinks, value: string) {
    setLinks((prev) => ({ ...prev, [key]: value }));
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await updateClientProfileAction(client.id, { category, teamSize, socialLinks: links });
      if (res.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  const activeLinks = SOCIALS.filter((s) => (client.socialLinks?.[s.key] ?? "").trim());
  const hasMeta = Boolean(client.category || client.teamSize);
  const inputCls =
    "min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-2 outline-none";

  return (
    <div className="px-1">
      {/* Company header */}
      <div className="mb-2.5 flex items-center gap-2.5">
        {client.logoUrl || client.brandingGuidelines?.logoUrl ? (
          <img
            src={(client.logoUrl || client.brandingGuidelines?.logoUrl)!}
            alt={client.name}
            className="h-8 w-8 shrink-0 rounded-md border border-border bg-surface-2 object-contain"
          />
        ) : (
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold"
            style={{
              background: (client.accentColor ?? "#2dff9e") + "1f",
              color: client.accentColor ?? "#2dff9e",
            }}
          >
            {client.name.slice(0, 2).toUpperCase()}
          </div>
        )}
        <span className="flex-1 truncate text-sm font-semibold text-foreground">{client.name}</span>
        {!editing && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setBrandProfileOpen(true)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
              aria-label="Edit brand profile"
              title="Edit brand profile"
            >
              <Icon name="Contact" className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setEditing(true)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
              aria-label="Edit company profile"
              title="Edit profile"
            >
              <Icon name="Pencil" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {!editing ? (
        <>
          {/* Meta + social chips */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            {hasMeta ? (
              <>
                {client.teamSize && (
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-muted">
                    <Icon name="Users" className="h-4 w-4 text-muted-2" />
                    {client.teamSize}
                  </span>
                )}
                {client.category && (
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-muted">
                    <Icon name="Tag" className="h-4 w-4 text-muted-2" />
                    {client.category}
                  </span>
                )}
              </>
            ) : (
              <button
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-2 transition-colors hover:border-border-strong"
              >
                <Icon name="Plus" className="h-4 w-4" />
                Add team size &amp; category
              </button>
            )}
            {activeLinks.map((s) => {
              const raw = client.socialLinks![s.key]!;
              return (
                <span
                  key={s.key}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-muted"
                >
                  <Icon name="AtSign" className="h-4 w-4 text-muted-2" />
                  {raw.replace(/^@/, "")}
                </span>
              );
            })}
          </div>

          {(client.description || client.brief) && (
            <p className="text-xs leading-relaxed text-muted-2">
              {client.description || client.brief}
            </p>
          )}
        </>
      ) : (
        /* ── Edit form (pill chips) ── */
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <Pill icon="Users">
              <select
                value={teamSize}
                onChange={(e) => setTeamSize(e.target.value)}
                className="bg-transparent text-xs text-foreground outline-none [&>option]:bg-surface"
              >
                <option value="">Team</option>
                {TEAM_SIZES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Pill>
            <Pill icon="Tag" className="flex-1">
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Category…"
                className={inputCls}
              />
            </Pill>
          </div>

          {SOCIALS.map((s) => (
            <Pill key={s.key} icon="AtSign">
              <input
                value={links[s.key] ?? ""}
                onChange={(e) => setLink(s.key, e.target.value)}
                placeholder={s.placeholder}
                className={inputCls}
              />
            </Pill>
          ))}

          {error && <p className="text-[11px] text-danger">{error}</p>}

          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={save}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md bg-neon px-3 py-1.5 text-xs font-semibold text-[#03110b] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Icon name={pending ? "Loader" : "Check"} className={cn("h-3.5 w-3.5", pending && "animate-spin")} />
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setError(null);
                setCategory(client.category ?? "");
                setTeamSize(client.teamSize ?? "");
                setLinks(client.socialLinks ?? {});
              }}
              disabled={pending}
              className="rounded-md px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {brandProfileOpen && (
        <BrandProfileModal client={client} onClose={() => setBrandProfileOpen(false)} />
      )}
    </div>
  );
}
