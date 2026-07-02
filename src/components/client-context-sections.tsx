"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { BrandingModal } from "@/components/branding-modal";
import { addCompetitorByNameAction } from "@/lib/actions";
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
  const [showAll, setShowAll] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [adding, startAdd] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);

  const threatOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const sorted = [...competitors].sort(
    (a, b) => (threatOrder[a.threatLevel ?? ""] ?? 3) - (threatOrder[b.threatLevel ?? ""] ?? 3),
  );

  const highThreat = sorted.filter((c) => c.threatLevel === "HIGH");
  const rest = sorted.filter((c) => c.threatLevel !== "HIGH");
  const defaultItems = highThreat.slice(0, 3);
  const extraItems = [...highThreat.slice(3), ...rest];
  const displayed = showAll ? [...defaultItems, ...extraItems] : defaultItems;

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

      {competitors.length === 0 ? (
        <p className="px-1 py-1 text-xs text-muted-2">
          No competitors tracked yet. Click + to add one.
        </p>
      ) : defaultItems.length === 0 ? (
        <p className="px-1 py-1 text-xs text-muted-2">No high-priority competitors identified.</p>
      ) : null}

      {displayed.length > 0 && (
        <ul className="space-y-0.5">
          {displayed.map((c) => {
            const href = c.url
              ? c.url.startsWith("http")
                ? c.url
                : `https://${c.url}`
              : null;
            const inner = (
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
              <li key={c.id}>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2"
                  >
                    {inner}
                  </a>
                ) : (
                  <div className="group flex items-center gap-2.5 rounded-md px-2 py-1.5">
                    {inner}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {extraItems.length > 0 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="mt-1.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
        >
          <Icon name={showAll ? "ChevronUp" : "ChevronDown"} className="h-3 w-3" />
          {showAll ? "Show less" : `+${extraItems.length} more`}
        </button>
      )}
    </div>
  );
}

/* ── Brand preview helpers ───────────────────────────────────────────── */

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

function clampHex(n: number) {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
}

function applyBrandPreview(hex: string): void {
  const rgb = hexToRgb(hex);
  if (!rgb) return;
  const { r, g, b } = rgb;
  const el = document.documentElement;
  el.style.setProperty("--neon", hex);
  el.style.setProperty("--neon-bright", `#${clampHex(r + 30)}${clampHex(g + 30)}${clampHex(b + 30)}`);
  el.style.setProperty("--neon-dim", `#${clampHex(r - 30)}${clampHex(g - 30)}${clampHex(b - 30)}`);
  el.style.setProperty("--neon-glow", `rgba(${r},${g},${b},0.35)`);
  el.style.setProperty("--neon-soft", `rgba(${r},${g},${b},0.12)`);
}

function clearBrandPreview(): void {
  const el = document.documentElement;
  el.style.removeProperty("--neon");
  el.style.removeProperty("--neon-bright");
  el.style.removeProperty("--neon-dim");
  el.style.removeProperty("--neon-glow");
  el.style.removeProperty("--neon-soft");
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
  const [previewActive, setPreviewActive] = useState(false);

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

  // The color that drives the preview — first dominant or legacy primary accent
  const primaryColor =
    colors[0]?.hex ?? guidelines?.primaryAccent ?? null;

  // Reset preview whenever the active client changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreviewActive(false);
    clearBrandPreview();
  }, [clientId]);

  // Always clean up on unmount so stale overrides never bleed into other views
  useEffect(() => {
    return () => clearBrandPreview();
  }, []);

  function togglePreview() {
    if (!primaryColor) return;
    const next = !previewActive;
    setPreviewActive(next);
    if (next) {
      applyBrandPreview(primaryColor);
    } else {
      clearBrandPreview();
    }
  }

  return (
    <div className="border-t border-border pt-4">
      <div className="mb-2.5 flex items-center justify-between px-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
          Brand Colors
        </p>
        <div className="flex items-center gap-1">
          {/* Brand preview toggle */}
          <button
            onClick={togglePreview}
            disabled={!primaryColor}
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-[4px] transition-colors",
              previewActive
                ? "bg-neon-soft text-neon"
                : "text-muted-2 hover:bg-surface-2 hover:text-foreground",
              !primaryColor && "cursor-not-allowed opacity-40",
            )}
            aria-label={previewActive ? "Exit brand preview" : "Preview brand colors"}
            title={previewActive ? "Exit brand preview" : "Preview brand colors in the UI"}
          >
            <Icon name="Palette" className="h-3 w-3" />
          </button>
          {/* Edit branding guidelines */}
          <button
            onClick={() => setBrandingOpen(true)}
            className="flex h-5 w-5 items-center justify-center rounded-[4px] text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
            aria-label="Edit branding guidelines"
            title="Edit branding guidelines"
          >
            <Icon name="Pencil" className="h-3 w-3" />
          </button>
        </div>
      </div>

      {effective.length > 0 ? (
        <div className="flex items-center gap-2 px-1">
          {effective.map((color, i) => (
            <div key={i} className="group relative">
              <div
                className={cn(
                  "h-7 w-7 rounded-full shadow-sm ring-1 ring-white/10 transition-transform group-hover:scale-110",
                  previewActive && i === 0 && "ring-2 ring-neon/60",
                )}
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
          {previewActive && (
            <span className="ml-1 text-[10px] font-medium text-neon">Live</span>
          )}
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
