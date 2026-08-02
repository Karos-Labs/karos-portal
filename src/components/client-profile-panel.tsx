"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { BrandFavicon } from "@/components/brand-favicon";
import { SocialPlatformMark, type SocialPlatform } from "@/components/agent-identity";
import { socialAccount, socialHandleValue } from "@/lib/social-handles";
import { updateClientProfileAction } from "@/lib/actions";
import type { Client, SocialLinks } from "@/lib/types";

/**
 * The Client fields this panel renders or edits — its whole contract, stated
 * rather than implied by taking the document.
 *
 * Both shells mount it from a PROJECTION now (toClientPortalView for the client
 * rail, toStaffShellView for the staff Company sheet), and neither ships a full
 * client document to the browser. Asking for `Client` here would have forced
 * one of them to widen again just to satisfy a signature — for fields this file
 * never reads.
 */
export type ClientProfileFields = Pick<
  Client,
  | "id"
  | "name"
  | "logoUrl"
  | "accentColor"
  | "brandingGuidelines"
  | "website"
  | "industry"
  | "category"
  | "teamSize"
  | "brief"
  | "description"
  | "brandVoice"
  | "contactEmail"
  | "domains"
  | "socialLinks"
>;

const TEAM_SIZES = ["1–10", "11–50", "51–200", "201–500", "500+"];

/**
 * The social accounts this panel shows and edits (AF-4).
 *
 * `key` doubles as the platform id for the mark and the handle parser — the
 * SocialLinks field names and `SocialPlatform` agree on all six, so a row's
 * logo, its @handle and the profile it opens all come from the same word and
 * cannot drift apart. (`website` is the seventh SocialLinks field and is not a
 * social account; it renders in the company header, not here.)
 *
 * LinkedIn earns its place beside the original three because it is the one
 * whose stored value is most often a full link — /in/ for a person, /company/
 * for a page — which is exactly the shortening AF-4 asked for.
 */
const SOCIALS: { key: keyof SocialLinks & SocialPlatform; placeholder: string }[] = [
  { key: "instagram", placeholder: "instagram handle" },
  { key: "x", placeholder: "x / twitter handle" },
  { key: "tiktok", placeholder: "tiktok handle" },
  { key: "linkedin", placeholder: "linkedin handle" },
];

/** Anything already stored for the other platforms still renders. */
const DISPLAY_SOCIALS: (keyof SocialLinks & SocialPlatform)[] = [
  "instagram",
  "x",
  "tiktok",
  "linkedin",
  "youtube",
  "facebook",
];

/** For the row's tooltip and its accessible name — the mark itself is decorative. */
const PLATFORM_NAME: Record<keyof SocialLinks & SocialPlatform, string> = {
  instagram: "Instagram",
  x: "X",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  facebook: "Facebook",
};

/* ── Pill-shaped input ────────────────────────────────────────────────── */

function Pill({
  icon,
  mark,
  children,
  className,
}: {
  icon?: string;
  /** A platform logo, for the rows that have one — see `SOCIALS`. */
  mark?: React.ReactNode;
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
      {mark ?? <Icon name={icon ?? "AtSign"} className="h-4 w-4 shrink-0 text-muted-2" />}
      {children}
    </div>
  );
}

/* ── Brand Profile slide-in modal ─────────────────────────────────────── */

function BrandProfileModal({
  client,
  onClose,
}: {
  client: ClientProfileFields;
  onClose: () => void;
}) {
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

/**
 * `compact` is the height-constrained mount — the desktop client rail and the
 * staff sidebar's client-context panel, both no-scroll fixed layouts (CD-E3).
 * It tightens spacing and clamps the description to two lines, so a long
 * "about" cannot push Competitor Track and Brand Colors off the viewport. The
 * mobile Company sheet scrolls, so it mounts WITHOUT compact and keeps the
 * full text.
 *
 * It was previously never passed at any mount, so every surface rendered the
 * unbounded text and the desktop rail's no-scroll contract was decorative —
 * which is the wall of text the product owner hit in the client lens on the
 * 30 July call.
 */
export function ClientProfilePanel({
  client,
  compact = false,
}: {
  client: ClientProfileFields;
  compact?: boolean;
}) {
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
    // Shorten on the way IN, not only on the way out (AF-4): a link pasted here
    // is stored as the handle, so the field stops accumulating the five spellings
    // the display parser exists to absorb. Unparseable text is written back
    // trimmed and otherwise untouched.
    const normalized: SocialLinks = { ...links };
    for (const key of DISPLAY_SOCIALS) {
      const value = links[key];
      if (value != null) normalized[key] = socialHandleValue(key, value);
    }
    startTransition(async () => {
      const res = await updateClientProfileAction(client.id, { category, teamSize, socialLinks: normalized });
      if (res.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  // Parsed once, in the order DISPLAY_SOCIALS declares, so a row's logo, handle
  // and destination are one decision. `socialAccount` returns null only for
  // empty text, which is the same filter this line has always applied.
  const activeLinks = DISPLAY_SOCIALS.map((key) => ({
    key,
    account: socialAccount(key, client.socialLinks?.[key] ?? ""),
  })).filter((row): row is { key: SocialPlatform & keyof SocialLinks; account: NonNullable<typeof row.account> } =>
    row.account !== null,
  );
  const hasMeta = Boolean(client.category || client.teamSize);
  const inputCls =
    "min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-2 outline-none";

  return (
    <div className="px-1">
      {/* Company header */}
      <div className={cn("flex items-center gap-2.5", compact ? "mb-2.5 py-1" : "mb-2.5")}>
        <BrandFavicon
          src={client.logoUrl || client.brandingGuidelines?.logoUrl}
          website={client.website}
          name={client.name}
          accentColor={client.accentColor ?? "#2dff9e"}
          faviconSize={64}
          className={cn("rounded-md text-xs", compact ? "h-8 w-8" : "h-8 w-8")}
          imgClassName="border border-border bg-surface-2 object-contain"
        />
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
          {/* nowrap in the rail: a second chip row is exactly the kind of
              content-dependent growth the no-scroll contract cannot absorb. */}
          <div
            className={cn(
              "flex gap-1.5",
              compact ? "mb-0 flex-nowrap overflow-hidden" : "mb-2 flex-wrap",
            )}
          >
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
            {/* THE PLATFORM'S LOGO + @username, and the row opens the profile
                (AF-4). Same affordance as the brand-colour swatches beneath:
                a real control, keyboard-reachable, that does the obvious thing
                with the value it is showing.
                The mark is the one the agent surfaces and the marketing site
                use (SocialPlatformMark) — a client's Instagram row and their
                Instagram agent carry the same logo. An account whose stored
                text yields no URL still renders, as a plain chip: the handle is
                the client's own and a panel is not the place to correct it. */}
            {activeLinks.map(({ key, account }) =>
              account.url ? (
                <a
                  key={key}
                  href={account.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`Open ${account.handle} on ${PLATFORM_NAME[key]}`}
                  aria-label={`Open ${account.handle} on ${PLATFORM_NAME[key]} in a new tab`}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon"
                >
                  <SocialPlatformMark platform={key} className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{account.handle}</span>
                </a>
              ) : (
                <span
                  key={key}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-muted"
                >
                  <SocialPlatformMark platform={key} className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{account.handle}</span>
                </span>
              ),
            )}
          </div>

          {/* Free text of unbounded length, in a rail that must keep a
              DETERMINISTIC height (the no-scroll contract, CD-E3). Two lines
              and an ellipsis give both: the client still sees what their
              profile says, and a long "about" cannot push Competitor Track and
              Brand Colors off the viewport. The mobile Company sheet scrolls,
              so it keeps the full text. */}
          {(client.description || client.brief) && (
            <p
              className={cn(
                "text-xs leading-relaxed text-muted-2",
                compact && "line-clamp-2",
              )}
            >
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

          {/* The same mark the row will carry once saved, so the field a person
              is typing into is labelled by the logo rather than by a generic
              @-sign repeated four times. */}
          {SOCIALS.map((s) => (
            <Pill
              key={s.key}
              mark={
                <SocialPlatformMark platform={s.key} className="h-4 w-4 shrink-0 text-muted-2" />
              }
            >
              <input
                value={links[s.key] ?? ""}
                onChange={(e) => setLink(s.key, e.target.value)}
                placeholder={s.placeholder}
                aria-label={`${PLATFORM_NAME[s.key]} handle`}
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
