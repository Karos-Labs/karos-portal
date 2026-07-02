"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { updateClientProfileAction, generateClientBriefAction } from "@/lib/actions";
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
        "flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 focus-within:border-foreground/25",
        className,
      )}
    >
      <Icon name={icon} className="h-4 w-4 shrink-0 text-muted-2" />
      {children}
    </div>
  );
}

export function ClientProfilePanel({ client, hasDocs }: { client: Client; hasDocs: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState(client.category ?? "");
  const [teamSize, setTeamSize] = useState(client.teamSize ?? "");
  const [links, setLinks] = useState<SocialLinks>(client.socialLinks ?? {});

  // Auto-generate the company brief once, when docs exist but no brief is cached.
  const [briefing, startBrief] = useTransition();
  const briefStarted = useRef(false);
  useEffect(() => {
    if (client.brief || !hasDocs || briefStarted.current) return;
    briefStarted.current = true;
    startBrief(async () => {
      const res = await generateClientBriefAction(client.id);
      if (res.ok) router.refresh();
    });
  }, [client.brief, client.id, hasDocs, router]);

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
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold"
          style={{
            background: (client.accentColor ?? "#FF6B2C") + "1f",
            color: client.accentColor ?? "#FF6B2C",
          }}
        >
          {client.name.slice(0, 2).toUpperCase()}
        </div>
        <span className="flex-1 truncate text-sm font-semibold text-foreground">{client.name}</span>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
            aria-label="Edit company profile"
            title="Edit profile"
          >
            <Icon name="Pencil" className="h-3.5 w-3.5" />
          </button>
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

          {/* Auto-generated brief */}
          {client.brief ? (
            <p className="text-xs leading-relaxed text-muted-2">{client.brief}</p>
          ) : briefing ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-2">
              <Icon name="Loader" className="h-3.5 w-3.5 animate-spin" />
              Generating description…
            </p>
          ) : null}
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
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
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
    </div>
  );
}
