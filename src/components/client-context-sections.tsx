"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { BrandFavicon } from "@/components/brand-favicon";
import { cn } from "@/lib/utils";
import { BrandingModal } from "@/components/branding-modal";
import { addCompetitorByNameAction, removeCompetitorAction } from "@/lib/actions";
import { computeTrackedCompetitors, TRACKED_COMPETITOR_LIMIT } from "@/lib/competitor-priority";
import { buildCompetitorRows, type CompetitorAiVisibility } from "@/lib/competitor-rows";
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
  limit = TRACKED_COMPETITOR_LIMIT,
  title = "Competitors",
  aiVisibility = null,
}: {
  competitors: ClientCompetitor[];
  clientId: string;
  isStaff: boolean;
  /**
   * The client's own side of the last SEO/GEO capture (portal feedback round 4,
   * 2026-09), so each row's stored `llmMentions` has something to be a share
   * OF. Resolved on the server from the snapshot this page already read; null
   * whenever there is no snapshot, and the meter simply does not render.
   */
  aiVisibility?: CompetitorAiVisibility | null;
  /**
   * Display cap. Defaults to the rail's original top-5 view; the Account
   * Center Competitors tab passes `null` ("holds everything we gather") —
   * distinct from TRACKED_COMPETITOR_LIMIT, which still governs the SEO/GEO
   * capture roster (lib/intel/pipeline.ts) and is untouched by this prop.
   */
  limit?: number | null;
  title?: string;
}) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [adding, startAdd] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  /**
   * Which row's "Stop tracking" is asking (flow audit 2026-09, R4).
   *
   * A one-off destructive press with no undo behind it — the tracker forgets
   * the competitor's whole history, and re-adding by name starts a fresh
   * analysis — so it takes the two-step inline confirm this codebase already
   * has (`client-key-inline.tsx`, `client-seat-remove.tsx`) rather than the
   * timed undo Home's repeatable X's took. One id, not a set: two open
   * questions in a six-row list is two chances to answer the wrong one.
   */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [, startRemove] = useTransition();

  // Strict top-5 view: manually added competitors always take priority, remaining
  // slots backfill from the highest-priority auto-seeded rivals. Recomputed from
  // whatever's left after a removal so the next-best rival fills the freed slot.
  // Rows added from this rail since the last server render. The sidebar's list
  // is route-scoped context that only the client-page layout refills, so on any
  // other route a refresh can't bring a new row back (QA F62) - we hold it here
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
  /**
   * Two steps, and they answer different questions (portal feedback round 4,
   * 2026-09): `computeTrackedCompetitors` decides which rows survive `limit`,
   * `buildCompetitorRows` decides how the survivors read and in what order.
   * Keeping the cap on the first means the rail's top-5 still drops the same
   * rows it always did; keeping the ordering in the second means the tab can
   * lead with the rivals the engines actually name without touching the
   * measurement roster's own priority maths.
   */
  const displayed = useMemo(
    () => buildCompetitorRows(computeTrackedCompetitors(active, limit), aiVisibility),
    [active, aiVisibility, limit],
  );

  /** Which row's disclosure is open. One at a time: this is a list, not a form. */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /**
   * NO COLLAPSE (review wave, 2026-09). The `collapseTo` prop and its "View all
   * N competitors" disclosure are gone rather than left unused: round 4 already
   * ruled that this list opens on everything it holds ("since it's only
   * competitors now we can show all of them right off the bat"), the tab was
   * its only caller and passed `null`, and a hiding mechanism nothing asks for
   * is a second answer waiting to disagree with the first.
   */
  const rows = displayed;

  function handleRemove(competitorId: string) {
    setRemoveError(null);
    setConfirmingId(null);
    setRemovingId(competitorId);
    // Optimistic: hide immediately so a lower-priority rival backfills without layout shift.
    setRemovedIds((prev) => new Set(prev).add(competitorId));
    startRemove(async () => {
      try {
        await removeCompetitorAction(clientId, competitorId);
      } catch (e) {
        // Roll back on failure.
        setRemovedIds((prev) => {
          const next = new Set(prev);
          next.delete(competitorId);
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
        // "manual") leaves the count unchanged - say so rather than looking
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

  /**
   * A FULL-WIDTH TAB SECTION, NOT A RAIL WIDGET (review wave, 2026-09).
   *
   * Everything here used to be dressed for the 224px client rail it was moved
   * off: a `border-t` hairline standing in for a heading, a 10px all-caps label,
   * and an icon-only 20px "+" as the only way to add a rival. On the Account
   * Center's Competitors tab that read as a leftover strip rather than the tab's
   * subject. It takes the same section heading the tab's other blocks use
   * (Visibility scores, Things only you can do) and an add control that says
   * what it does.
   */
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
          <span className="truncate">{title}</span>
          {/* "How many are we watching" is the first thing a person asks of a
              list they cannot see the bottom of. */}
          {displayed.length > 0 && (
            <span className="shrink-0 rounded-full border border-border bg-surface-2 px-1.5 py-px text-[9px] font-normal tracking-normal text-muted-2">
              {displayed.length}
            </span>
          )}
        </p>
        <button
          onClick={openAdd}
          aria-expanded={addOpen}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
        >
          <Icon name="Plus" className="h-3.5 w-3.5" />
          Add competitor
        </button>
      </div>

      {addOpen && (
        <div className="space-y-1.5">
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
              className="flex h-7 items-center gap-1 rounded-[6px] bg-neon px-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
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
        <p className="text-sm text-muted-2">
          No competitors tracked yet. Use &ldquo;Add competitor&rdquo; to start the list.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-border/50">
          {rows.map((c) => {
            const isRemoving = removingId === c.id;
            const isConfirming = confirmingId === c.id;
            const isExpanded = expandedId === c.id;
            return (
              <li key={c.id}>
              <div
                className="group flex items-start gap-1 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2"
              >
                {/* THE ROW IS THE DISCLOSURE (portal feedback round 4, 2026-09).
                    It used to be an anchor straight to the competitor's site,
                    which made the row's only job "leave the page". The website
                    is still one press away, inside the panel below, and the row
                    itself now opens what we already know about them. A row with
                    nothing behind it stays inert rather than opening an empty
                    box, so the chevron is conditional too. */}
                <button
                  type="button"
                  onClick={() => c.hasDetail && setExpandedId(isExpanded ? null : c.id)}
                  disabled={!c.hasDetail}
                  aria-expanded={c.hasDetail ? isExpanded : undefined}
                  className="flex min-w-0 flex-1 items-start gap-2.5 text-left disabled:cursor-default"
                >
                  <span className="mt-0.5 shrink-0">
                    <CompetitorFavicon url={c.url} company={c.company} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium text-muted group-hover:text-foreground">
                        {c.company}
                      </span>
                      {/* NOT labelled "Tracked": every row on this list is
                          tracked, and the trash beside it says "Stop
                          tracking". What this marks is provenance, which is
                          the real question a client has about a name they do
                          not recognise. Neutral, not accent: the orange is
                          rationed and the meter below already spends it. */}
                      {c.tracked && (
                        <span
                          title="Added to this list by hand, not found by us"
                          className="shrink-0 rounded-full border border-border bg-surface-2 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-2"
                        >
                          Added by hand
                        </span>
                      )}
                    </span>

                    {/* "What they do", in one line, from the positioning the
                        report already stored. No research, no new call. */}
                    {c.summary && (
                      <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted-2">
                        {c.summary}
                      </span>
                    )}

                    {c.chips.length > 0 && (
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        {c.chips.map((chip) => (
                          <span
                            key={chip}
                            className="rounded-[4px] border border-border bg-surface-2 px-1.5 py-px text-[10px] leading-4 text-muted-2"
                          >
                            {chip}
                          </span>
                        ))}
                      </span>
                    )}

                    {/* Share of the AI conversation, from the counts the last
                        SEO/GEO capture already wrote back onto these rows. The
                        bar is drawn against the LARGER of this rival's count
                        and the client's own, so a full bar means "ahead of
                        you" and never "100% of something". */}
                    {c.mentions !== null && (
                      <span className="mt-1 flex items-center gap-2">
                        {c.barPct !== null && (
                          <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-surface-3">
                            <span
                              className="block h-full rounded-full bg-neon"
                              style={{ width: `${c.barPct}%` }}
                            />
                          </span>
                        )}
                        <span className="truncate font-mono text-[10px] text-muted-2">
                          {c.answersMeasured !== null
                            ? `Named in ${c.mentions} of ${c.answersMeasured} AI answers`
                            : `Named in ${c.mentions} AI answers`}
                          {c.clientMentions !== null ? ` · you: ${c.clientMentions}` : ""}
                        </span>
                      </span>
                    )}
                    {/* A row the last capture did not measure (review wave,
                        2026-09). It may still hold a count from an OLDER run,
                        and printing that beside this run's client figure, over
                        this run's denominator, compares two measurements as
                        though they were one. Says so instead. */}
                    {c.notMeasuredThisRun && (
                      <span className="mt-1 block truncate font-mono text-[10px] text-muted-2">
                        Not measured in the latest run
                      </span>
                    )}
                  </span>
                  {c.hasDetail && (
                    <Icon
                      name="ChevronDown"
                      className={cn(
                        "mt-0.5 h-3 w-3 shrink-0 text-muted-2 transition-transform",
                        isExpanded && "rotate-180",
                      )}
                    />
                  )}
                </button>
                {/* Any tracked row is removable by staff and the client alike —
                    it's their tracker, not just their own manual adds.
                    R4 (flow audit 2026-09): the trash ASKS now — it used to
                    commit on the press, and re-adding by name starts a fresh
                    analysis rather than restoring the history it forgot. */}
                <button
                  type="button"
                  onClick={() => setConfirmingId(isConfirming ? null : c.id)}
                  disabled={isRemoving}
                  aria-label={`Stop tracking ${c.company}`}
                  aria-expanded={isConfirming}
                  title="Stop tracking"
                  // Reachable without a pointer: this removes a tracked competitor,
                  // and hover-only reveal hides it entirely on touch (#89's shape).
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-2 opacity-0 transition-colors group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                >
                  {isRemoving ? (
                    <Icon name="Loader" className="h-3 w-3 animate-spin" />
                  ) : (
                    <Icon name="Trash2" className="h-3 w-3" />
                  )}
                </button>
              </div>

              {isExpanded && (
                <div className="mb-1.5 ml-9 mr-2 space-y-2 rounded-md border border-border bg-surface-2/50 px-2.5 py-2">
                  {c.facts.length > 0 && (
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {c.facts.map((f) => (
                        <span key={f.label} className="text-[11px] leading-snug text-muted">
                          <span className="text-muted-2">{f.label}:</span> {f.value}
                        </span>
                      ))}
                    </div>
                  )}
                  {c.strengths.length > 0 && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                        Where they are strong
                      </p>
                      <ul className="mt-0.5 space-y-0.5">
                        {c.strengths.map((s, i) => (
                          <li key={i} className="text-[11px] leading-snug text-muted">
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {c.weaknesses.length > 0 && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                        Where they are weak
                      </p>
                      <ul className="mt-0.5 space-y-0.5">
                        {c.weaknesses.map((s, i) => (
                          <li key={i} className="text-[11px] leading-snug text-muted">
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {c.href && (
                    <a
                      href={c.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-neon"
                    >
                      Visit website
                      <Icon name="ArrowUpRight" className="h-3 w-3" />
                    </a>
                  )}
                </div>
              )}

              {isConfirming && (
                <div className="mx-2 mb-1 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5">
                  <p className="text-[11px] leading-snug text-foreground">
                    Stop tracking {c.company}? Their history goes with them.
                  </p>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleRemove(c.id)}
                      disabled={isRemoving}
                      className="rounded-[4px] border border-warning/40 bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning disabled:opacity-50"
                    >
                      Stop tracking
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      className="rounded-[4px] border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              </li>
            );
          })}
        </ul>
      )}

      {removeError && <p className="text-[11px] text-danger">{removeError}</p>}
    </section>
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
   * a client's payload has no usagePct at all - toClientPortalView strips it.
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
    // Insecure origin, an older browser, or a denied permission - say nothing
    // and leave the tooltip showing the hex, which is still readable and
    // selectable. Claiming a copy that never happened is the worse failure.
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(hex);
      setCopied(index);
    } catch {
      // Same reasoning - no false confirmation.
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
      {/* CD-H2: ONE row, not two. The label, the swatches and the edit control
          share a single line, which is the sanctioned lever for getting both
          rails back under the CD-E3 no-scroll contract without touching any of
          the approved spacing above this section. Nothing is hidden: every
          swatch, its copy behaviour and its tooltip are all still here. */}
      <div className="flex items-center gap-2 px-1">
        <p className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
          Brand Colors
        </p>

        {effective.length > 0 ? (
        /* 20px swatches at a 4px gap is what the STAFF rail can actually give
           this row. w-64 less px-4 is 223px of content - 213px while the rail
           is scrolled, because a classic scrollbar takes its 10px out of the
           content box - and the label (79) + the edit control (20) + two 8px
           gaps leave 98px for four swatches. At the old 28px they overflowed
           by 60px and the rail grew a horizontal scrollbar of its own. */
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {effective.map((color, i) => (
            <div key={i} className="group relative">
              {/* A button, not a div: the hex is the thing people actually want
                  off this panel, and copying it has to be reachable by keyboard
                  too (CD-G11). */}
              <button
                type="button"
                onClick={() => copyHex(color.hex, i)}
                className="block h-5 w-5 shrink-0 rounded-full shadow-sm ring-1 ring-white/10 transition-transform group-hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon"
                style={{ backgroundColor: color.hex }}
                title={color.role ? `${color.role} · ${color.hex}` : color.hex}
                aria-label={`Copy ${color.role ? `${color.role} ` : ""}${color.hex}`}
              />
              {/* Anchored to the near edge, not centred: a centred tooltip on the
                  first swatch ran off the left of the rail. Swatches past the
                  midpoint flip to the right edge for the same reason. */}
              <div
                className={cn(
                  "pointer-events-none absolute bottom-full z-20 mb-2 w-max transition-opacity",
                  // Widest that still clears the rail now that the swatches
                  // start AFTER the label (CD-H2): the binding case is the
                  // second swatch, left-anchored 115px into a 223px staff row.
                  // The label wraps rather than running off-screen - and an
                  // absolutely-positioned tooltip counts toward scrollWidth
                  // even at opacity 0, so overflowing here would put the
                  // horizontal scrollbar straight back.
                  "max-w-[6rem]",
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
                      {/* Internal mix share - staff only; a client's payload
                          never carries the number (CD-E2). It used to be a
                          caption UNDER the swatch, which is the second line
                          this section no longer has (CD-H2); the number itself
                          is unchanged and reads on the same hover that already
                          shows the hex and the role. */}
                      {showUsage && (
                        <span className="ml-1 font-sans text-muted-2">
                          · {color.usagePct != null ? `${color.usagePct}%` : "–"}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        ) : (
          <p className="min-w-0 flex-1 truncate text-xs text-muted-2">No brand colors set yet.</p>
        )}

        <button
          onClick={() => setBrandingOpen(true)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label="Edit branding guidelines"
          title="Edit branding guidelines"
        >
          <Icon name="Pencil" className="h-3 w-3" />
        </button>
      </div>

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
