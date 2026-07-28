"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { BrandFavicon } from "@/components/brand-favicon";
import { cn } from "@/lib/utils";
import { BrandingModal } from "@/components/branding-modal";
import { addCompetitorByNameAction, removeCompetitorAction } from "@/lib/actions";
import { computeTrackedCompetitors } from "@/lib/competitor-priority";
import type { BrandColor, BrandingGuidelines, ClientCompetitor } from "@/lib/types";

/* ── Competitor favicon with fallback ────────────────────────────────── */

export function CompetitorFavicon({ url, company }: { url?: string; company?: string }) {
  return (
    <BrandFavicon
      website={url}
      /* Two jobs (CD-F2): a name that IS a domain resolves a real favicon when
         the row has no url, and anything left over gets an initials chip
         instead of the anonymous building glyph. */
      name={company}
      accentColor="#ff6b2c"
      faviconSize={32}
      className="h-4 w-4 rounded-[3px] text-[8px]"
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
  // Rows added from this rail since the last server render. The sidebar's list
  // is route-scoped context that only the client-page layout refills, so on any
  // other route a refresh can't bring a new row back (QA F62) — we hold it here
  // until the server list catches up.
  const [addedRows, setAddedRows] = useState<ClientCompetitor[]>([]);

  const active = useMemo(() => {
    const serverIds = new Set(competitors.map((c) => c.id));
    // Belt and braces on the clientId: the staff rail keeps this component
    // mounted across a client-context switch, and an optimistic row must never
    // appear in another client's list (QA F62 flag; the mount is also keyed).
    const pending = addedRows.filter((c) => c.clientId === clientId && !serverIds.has(c.id));
    return [...competitors, ...pending].filter((c) => !removedIds.has(c.id));
  }, [addedRows, clientId, competitors, removedIds]);
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
        const row = await addCompetitorByNameAction(clientId, trimmed);
        const now = Date.now();
        setAddedRows((prev) => [
          ...prev.filter((c) => c.id !== row.id),
          {
            id: row.id,
            clientId,
            company: row.company,
            ...(row.url ? { url: row.url } : {}),
            marketTier: "Challenger",
            overlap: "Medium",
            deepDive: false,
            keyStrengths: [],
            keyWeaknesses: [],
            source: "manual",
            createdAt: now,
            updatedAt: now,
          },
        ]);
        // A row that was already tracked (or promoted from "report" to
        // "manual") leaves the count unchanged — say so rather than looking
        // like nothing happened.
        if (!row.created) setAddError(`${row.company} is already tracked.`);
        setAddName("");
        setAddOpen(row.created ? false : true);
        router.refresh();
      } catch (e) {
        setAddError(e instanceof Error ? e.message : "Failed to add competitor");
      }
    });
  }

  return (
    <div className="border-t border-border pt-3">
      <div className="mb-1 flex items-center justify-between px-1">
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
        <ul>
          {displayed.map((c) => {
            const href = c.url
              ? c.url.startsWith("http")
                ? c.url
                : `https://${c.url}`
              : null;
            const isRemoving = removingId === c.id;
            const linkContent = (
              <>
                <CompetitorFavicon url={c.url} company={c.company} />
                <span className="flex-1 truncate text-xs text-muted group-hover:text-foreground">
                  {c.company}
                </span>
                {/* CD-G4: the same ↗ the client chip uses, so "opens a site in
                    a new tab" reads identically everywhere in the rail. Shown
                    to staff and clients alike — only the trash beside it is
                    staff-gated. opacity-0 rather than conditional rendering so
                    the row keeps its width on hover and the favicon never
                    shifts. */}
                {href && (
                  <Icon
                    name="ArrowUpRight"
                    className="h-3 w-3 shrink-0 text-muted-2 opacity-0 transition-opacity group-hover:opacity-100"
                  />
                )}
              </>
            );
            return (
              <li
                key={c.id}
                className="group flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-surface-2"
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
  isStaff = false,
}: {
  guidelines: BrandingGuidelines | undefined;
  clientId: string;
  hasWebsite: boolean;
  /**
   * Staff shells only. Gates the internal usage-percentage display and the
   * matching editor field (CD-E2). This is defence in depth, not the boundary:
   * a client's payload has no usagePct at all — toClientPortalView strips it.
   */
  isStaff?: boolean;
}) {
  const [brandingOpen, setBrandingOpen] = useState(false);
  /** Index of the swatch flashing "Copied", or null (CD-G11). */
  const [copied, setCopied] = useState<number | null>(null);

  // Let the confirmation fade by itself, and drop the timer if the rail
  // unmounts mid-flash (switching client context remounts this whole section).
  useEffect(() => {
    if (copied == null) return;
    const t = setTimeout(() => setCopied(null), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  async function copyHex(hex: string, index: number) {
    // Insecure origin, an older browser, or a denied permission — say nothing
    // and leave the tooltip showing the hex, which is still readable and
    // selectable. Claiming a copy that never happened is the worse failure.
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(hex);
      setCopied(index);
    } catch {
      // Same reasoning — no false confirmation.
    }
  }

  const colors: BrandColor[] = guidelines?.dominantColors?.slice(0, 4) ?? [];
  const effective: { hex: string; role?: string; usagePct?: number }[] =
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

  const showUsage = isStaff && effective.some((c) => c.usagePct != null);

  return (
    <div className="border-t border-border pb-1 pt-2.5">
      <div className="mb-2 flex items-center justify-between px-1">
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
        <div className="flex items-start gap-2.5 px-1 pb-0.5">
          {effective.map((color, i) => (
            <div key={i} className="group relative">
              {/* A button, not a div: the hex is the thing people actually want
                  off this panel, and copying it has to be reachable by keyboard
                  too (CD-G11). */}
              <button
                type="button"
                onClick={() => copyHex(color.hex, i)}
                className="block h-7 w-7 rounded-full shadow-sm ring-1 ring-white/10 transition-transform group-hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon"
                style={{ backgroundColor: color.hex }}
                title={color.role ? `${color.role} · ${color.hex}` : color.hex}
                aria-label={`Copy ${color.role ? `${color.role} ` : ""}${color.hex}`}
              />
              {/* Internal mix share — staff only; a client's payload never
                  carries the number (CD-E2). */}
              {showUsage && (
                <p className="mt-1 text-center font-mono text-[11px] leading-none text-muted-2">
                  {color.usagePct != null ? `${color.usagePct}%` : "—"}
                </p>
              )}
              {/* Anchored to the near edge, not centred: a centred tooltip on the
                  first swatch ran off the left of the rail. Swatches past the
                  midpoint flip to the right edge for the same reason. */}
              <div
                className={cn(
                  "pointer-events-none absolute bottom-full z-20 mb-2 w-max transition-opacity",
                  // Widest that still clears the rail from the last swatch's
                  // left edge; the label wraps rather than running off-screen.
                  "max-w-[9.5rem]",
                  i >= 2 ? "right-0" : "left-0",
                  // The confirmation has to hold on its own: a tap has no hover
                  // to keep the tooltip up, and a keyboard user never had one.
                  copied === i
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                )}
              >
                <div className="rounded-md border border-border bg-surface-3 px-2 py-1 font-mono text-[11px] leading-snug text-foreground shadow-lg">
                  {copied === i ? (
                    <span className="flex items-center gap-1">
                      <Icon name="Check" className="h-3 w-3 text-neon" />
                      Copied
                    </span>
                  ) : (
                    <>
                      {color.hex}
                      {color.role && (
                        <span className="ml-1 font-sans text-muted-2">· {color.role}</span>
                      )}
                    </>
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
        allowUsagePct={isStaff}
      />
    </div>
  );
}
