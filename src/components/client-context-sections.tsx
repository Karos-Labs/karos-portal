/* eslint-disable @next/next/no-img-element */

"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { BrandingModal } from "@/components/branding-modal";
import { addCompetitorByNameAction, removeCompetitorAction } from "@/lib/actions";
import { computeTrackedCompetitors } from "@/lib/competitor-priority";
import type { BrandColor, BrandingGuidelines, ClientCompetitor } from "@/lib/types";

/* ── Competitor favicon with fallback ────────────────────────────────── */

export function CompetitorFavicon({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);

  if (!url || failed) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <Icon name="Building2" className="h-3.5 w-3.5 text-muted-2" />
      </span>
    );
  }

  let domain: string;
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    domain = new URL(normalized).hostname;
  } catch {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <Icon name="Building2" className="h-3.5 w-3.5 text-muted-2" />
      </span>
    );
  }

  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=16`}
      alt=""
      width={16}
      height={16}
      className="h-4 w-4 shrink-0 rounded-[3px]"
      onError={() => setFailed(true)}
    />
  );
}

/* ── Competitor Track section ────────────────────────────────────────── */

export function CompetitorTrack({
  competitors,
  clientId,
  isStaff,
}: {
  competitors: ClientCompetitor[];
  clientId: string;
  isStaff: boolean;
}) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [adding, startAdd] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [, startRemove] = useTransition();

  // Strict top-5 view: manually added competitors always take priority, remaining
  // slots backfill from the highest-priority auto-seeded rivals. Recomputed from
  // whatever's left after a removal so the next-best rival fills the freed slot.
  const active = useMemo(
    () => competitors.filter((c) => !removedIds.has(c.id)),
    [competitors, removedIds],
  );
  const displayed = useMemo(() => computeTrackedCompetitors(active), [active]);

  function handleRemove(competitor: ClientCompetitor) {
    setRemoveError(null);
    setRemovingId(competitor.id);
    // Optimistic: hide immediately so a lower-priority rival backfills without layout shift.
    setRemovedIds((prev) => new Set(prev).add(competitor.id));
    startRemove(async () => {
      try {
        await removeCompetitorAction(clientId, competitor.id);
      } catch (e) {
        // Roll back on failure.
        setRemovedIds((prev) => {
          const next = new Set(prev);
          next.delete(competitor.id);
          return next;
        });
        setRemoveError(e instanceof Error ? e.message : "Failed to remove competitor");
        setRemovingId(null);
        return;
      }
      setRemovingId(null);
      router.refresh();
    });
  }

  function openAdd() {
    setAddOpen(true);
    setAddName("");
    setAddError(null);
  }

  function handleAdd() {
    const trimmed = addName.trim();
    if (!trimmed) {
      setAddError("Enter a competitor name");
      return;
    }
    setAddError(null);
    startAdd(async () => {
      try {
        await addCompetitorByNameAction(clientId, trimmed);
        setAddName("");
        setAddOpen(false);
        router.refresh();
      } catch (e) {
        setAddError(e instanceof Error ? e.message : "Failed to add competitor");
      }
    });
  }

  return (
    <div className="border-t border-border pt-4">
      <div className="mb-2 flex items-center justify-between px-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
          Competitor Track
        </p>
        <button
          onClick={openAdd}
          className="flex h-5 w-5 items-center justify-center rounded-[4px] text-muted-2 transition-colors hover:bg-surface-2 hover:text-neon"
          aria-label="Add competitor"
          title="Add competitor"
        >
          <Icon name="Plus" className="h-3 w-3" />
        </button>
      </div>

      {addOpen && (
        <div className="mb-2 space-y-1.5 px-1">
          <div className="flex items-center gap-1.5">
            <input
              value={addName}
              onChange={(e) => {
                setAddName(e.target.value);
                setAddError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
                if (e.key === "Escape") {
                  setAddOpen(false);
                  setAddName("");
                }
              }}
              disabled={adding}
              placeholder="Competitor name…"
              autoFocus
              className="flex-1 rounded-[6px] border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-2 outline-none transition-colors focus:border-neon/50 disabled:opacity-50"
            />
            <button
              onClick={handleAdd}
              disabled={adding}
              className="flex h-7 items-center gap-1 rounded-[6px] bg-neon px-2 text-xs font-semibold text-[#03110b] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {adding ? (
                <Icon name="Loader" className="h-3 w-3 animate-spin" />
              ) : (
                <Icon name="Plus" className="h-3 w-3" />
              )}
              Add
            </button>
          </div>
          {adding && (
            <p className="text-[11px] text-muted-2">
              {isStaff ? "Analyzing competitor profile…" : "Saving competitor…"}
            </p>
          )}
          {addError && <p className="text-[11px] text-danger">{addError}</p>}
        </div>
      )}

      {active.length === 0 && (
        <p className="px-1 py-1 text-xs text-muted-2">
          No competitors tracked yet. Click + to add one.
        </p>
      )}

      {displayed.length > 0 && (
        <ul className="space-y-0.5">
          {displayed.map((c) => {
            const href = c.url
              ? c.url.startsWith("http")
                ? c.url
                : `https://${c.url}`
              : null;
            const isRemoving = removingId === c.id;
            const linkContent = (
              <>
                <CompetitorFavicon url={c.url} />
                <span className="flex-1 truncate text-xs text-muted group-hover:text-foreground">
                  {c.company}
                </span>
                {href && (
                  <Icon
                    name="ExternalLink"
                    className="h-3 w-3 shrink-0 text-muted-2 opacity-0 transition-opacity group-hover:opacity-100"
                  />
                )}
              </>
            );
            return (
              <li
                key={c.id}
                className="group flex items-center gap-1 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2"
              >
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-w-0 flex-1 items-center gap-2.5"
                  >
                    {linkContent}
                  </a>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">{linkContent}</div>
                )}
                {(isStaff || c.source === "manual") && (
                <button
                  type="button"
                  onClick={() => handleRemove(c)}
                  disabled={isRemoving}
                  aria-label={`Stop tracking ${c.company}`}
                  title="Stop tracking"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-2 opacity-0 transition-colors group-hover:opacity-100 hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                >
                  {isRemoving ? (
                    <Icon name="Loader" className="h-3 w-3 animate-spin" />
                  ) : (
                    <Icon name="Trash2" className="h-3 w-3" />
                  )}
                </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {removeError && <p className="mt-1 px-1 text-[11px] text-danger">{removeError}</p>}
    </div>
  );
}

/* ── Brand Colors + Branding Guidelines edit ─────────────────────────── */

export function BrandColorsSection({
  guidelines,
  clientId,
  hasWebsite,
}: {
  guidelines: BrandingGuidelines | undefined;
  clientId: string;
  hasWebsite: boolean;
}) {
  const [brandingOpen, setBrandingOpen] = useState(false);

  const colors: BrandColor[] = guidelines?.dominantColors?.slice(0, 4) ?? [];
  const effective: { hex: string; role?: string }[] =
    colors.length > 0
      ? colors
      : (
          [
            { hex: guidelines?.primaryAccent, role: "Primary" },
            { hex: guidelines?.secondaryAccent, role: "Secondary" },
            { hex: guidelines?.brandNeutralDark, role: "Neutral dark" },
            { hex: guidelines?.brandNeutralLight, role: "Neutral light" },
          ] as { hex: string | undefined; role: string }[]
        ).filter((c): c is { hex: string; role: string } => Boolean(c.hex));

  return (
    <div className="border-t border-border pt-4">
      <div className="mb-2.5 flex items-center justify-between px-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
          Brand Colors
        </p>
        <button
          onClick={() => setBrandingOpen(true)}
          className="flex h-5 w-5 items-center justify-center rounded-[4px] text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label="Edit branding guidelines"
          title="Edit branding guidelines"
        >
          <Icon name="Pencil" className="h-3 w-3" />
        </button>
      </div>

      {effective.length > 0 ? (
        <div className="flex items-center gap-2 px-1">
          {effective.map((color, i) => (
            <div key={i} className="group relative">
              <div
                className="h-7 w-7 rounded-full shadow-sm ring-1 ring-white/10 transition-transform group-hover:scale-110"
                style={{ backgroundColor: color.hex }}
                title={color.role ? `${color.role} · ${color.hex}` : color.hex}
              />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100">
                <div className="rounded-md border border-border bg-surface-3 px-2 py-1 text-[10px] font-mono text-foreground shadow-lg">
                  {color.hex}
                  {color.role && (
                    <span className="ml-1 font-sans text-muted-2">· {color.role}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-1 py-1 text-xs text-muted-2">No brand colors set yet.</p>
      )}

      <BrandingModal
        open={brandingOpen}
        onClose={() => setBrandingOpen(false)}
        clientId={clientId}
        existing={guidelines}
        hasWebsite={hasWebsite}
      />
    </div>
  );
}
