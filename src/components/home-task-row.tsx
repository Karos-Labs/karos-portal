"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icon";
import { buttonClass } from "@/components/ui";
import { cn } from "@/lib/utils";

/** The one row shell — shared by the live row and by the undo row that stands
 *  in its place, so a skipped row does not change size or colour under the
 *  reader's cursor. */
const ROW_BASE =
  "flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5";

/**
 * THE ACCENT CONTROL, AND WHY IT IS AN ANCHOR (round 6, rule 2).
 *
 * `Button variant="accent"` in components/ui.tsx renders a `<button>`, and this
 * control NAVIGATES — the ladder's one press opens the field, the document or
 * the run panel that completes the step. So it is a Link wearing the accent
 * recipe, the same device impl-brief §3.E asks for on Reporting ("`Button
 * variant="outline"` as a Link"): a real anchor keeps middle-click, copy-link
 * and the browser's own focus behaviour, which a click handler on a button
 * throws away.
 *
 * The recipe itself is READ, not restated: `buttonClass` (ui.tsx, added for
 * this handoff) is the same function `Button` calls, so a change to the accent
 * voice reaches this anchor for free. `shrink-0` is the only thing this call
 * site adds, because it sits in a flex row beside the row's own text.
 */
const ACCENT_LINK = buttonClass({ variant: "accent", size: "sm", className: "shrink-0" });

/**
 * How long a skipped row stays undoable (flow audit 2026-09, R4).
 *
 * Exported so both lists and their tests read ONE number: the window is the
 * whole of the promise the "Undo" affordance makes, and a widget that picked
 * its own would make that promise twice with two different answers.
 */
export const UNDO_WINDOW_MS = 6000;

/**
 * "Undo instead of confirm", built once for Home's two lists (flow audit
 * 2026-09, R4 · NN/g *Confirmation Dialogs*: "prefer undo over confirmation for
 * anything repetitive").
 *
 * ── NOTHING MOUNTS THIS TODAY, AND IT STAYS ANYWAY (portal feedback round 4,
 * 2026-09) ───────────────────────────────────────────────────────────────
 *
 * Both lists it was built for left Home in the same pass: "Next actions" and
 * "Recommended tasks" were replaced by the setup ladder (home-get-set-up.tsx),
 * and that list has no skip at all — none of its six steps is optional, so
 * offering an X would let a client dismiss the very thing blocking them. R4 is
 * a standing product rule about destructive presses rather than a feature of
 * two particular widgets, and the audit's own follow-up ("More ways to get
 * value", the later-value rows, once the ladder is complete) is a list that
 * WILL have a skip. Deleting the hook would mean re-deriving the ordering
 * argument below from scratch when it lands. Its behaviour is still pinned by
 * flow-audit-undo-and-rows.test.ts.
 *
 * Both X's used to commit on the single press — Home's recommended-task X went
 * straight to `deleteTaskAction`, a HARD DELETE, and "Not relevant for me"
 * wrote a permanent skip. Neither asked, neither could be taken back, and both
 * are pressed several times in a row while a client works through a list, which
 * is exactly the case Nielsen says must not be a dialog.
 *
 * THE ORDER MATTERS AND IS THE POINT: the row leaves the list the instant the X
 * is pressed (nothing to wait for, nothing to read), an "Undo" row takes its
 * place, and the SERVER WRITE ONLY HAPPENS WHEN THAT ROW EXPIRES. Firing the
 * write immediately and "undoing" it with a second write would need a restore
 * action for a hard delete — there isn't one, and inventing one would put a
 * resurrection path on a destructive server action for the sake of a UI
 * affordance.
 *
 * Timers are keyed by row id in a ref (not state) so a re-render cannot lose or
 * duplicate one.
 *
 * ── WHAT AN UNMOUNT MEANS IS THE CALLER'S CALL (`commitOnUnmount`) ───────
 *
 * It was one answer for both lists — cancel everything — and that was wrong for
 * one of them in a way a client meets immediately: X three rows in "Next
 * actions", then press the primary control on a fourth, and the navigation unmounts
 * this hook mid-window and silently un-skips all three. The three rows are back
 * on Home when they return, having been told they were gone.
 *
 * The right answer differs because the two writes differ, so the caller says
 * which it wants:
 *
 *  · `commitOnUnmount: false` (default) — Recommended tasks. The commit is
 *    `deleteTaskAction`, a HARD DELETE with no restore path. Leaving on a
 *    half-open window must not destroy a proposal the client never saw
 *    disappear, and the cost of being wrong is one row reappearing.
 *  · `commitOnUnmount: true` — Next actions. The commit is
 *    `markActionNotRelevantAction`, a reversible per-client flag on a checklist
 *    row, and this list's own primary control NAVIGATES — so
 *    an unmount inside the window is the ordinary case here rather than an
 *    abandonment, and the honest reading of the X is "I meant it".
 *
 * Neither direction is safe in general, which is exactly why there is no
 * default that covers both.
 */
export function useUndoableDismiss(
  /** Runs when the window expires — or, with `commitOnUnmount`, on unmount.
   *  The caller's own optimistic removal (the `removedIds` set, the status
   *  override) belongs in here, not at press time — the row is already off the
   *  list by then. */
  commit: (id: string) => void,
  {
    windowMs = UNDO_WINDOW_MS,
    commitOnUnmount = false,
  }: {
    windowMs?: number;
    /** See the note above. Default false: cancel, because the conservative
     *  direction for an unknown write is not to perform it. */
    commitOnUnmount?: boolean;
  } = {},
) {
  const [pendingIds, setPendingIds] = useState<readonly string[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Latest commit without re-arming timers: the callers pass an inline closure
  // that changes identity on every render, and a dependency on it would restart
  // the window each time the list re-renders.
  const commitRef = useRef(commit);
  // Written in an effect, not during render: a ref assignment in the render
  // body is what `react-hooks/refs` forbids, and the timer that reads it only
  // ever fires after a commit has painted anyway.
  useEffect(() => {
    commitRef.current = commit;
  });

  // Read through a ref for the same reason `commit` is: the cleanup below runs
  // with an empty dependency list, and re-arming it on a prop that never
  // changes would tear down and rebuild every live timer.
  const flushOnUnmountRef = useRef(commitOnUnmount);
  useEffect(() => {
    flushOnUnmountRef.current = commitOnUnmount;
  });

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const [id, t] of pending) {
        // Always clear first: a timer that survived the unmount would call the
        // commit a second time, and one of these commits deletes a document.
        clearTimeout(t);
        if (flushOnUnmountRef.current) commitRef.current(id);
      }
      pending.clear();
    };
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      if (timers.current.has(id)) return;
      setPendingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setPendingIds((prev) => prev.filter((x) => x !== id));
          commitRef.current(id);
        }, windowMs),
      );
    },
    [windowMs],
  );

  const undo = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setPendingIds((prev) => prev.filter((x) => x !== id));
  }, []);

  return { pendingIds, dismiss, undo };
}

/**
 * What stands where a skipped row was, for `UNDO_WINDOW_MS` (R4).
 *
 * Same shell, same height, muted: the list must not reflow under the reader
 * while the window is open, or the Undo button moves out from under the cursor
 * that is going for it.
 *
 * ── REACHABLE WITHOUT A POINTER, WHICH IT WAS NOT ────────────────────────
 *
 * Pressing the X unmounts the very button that was focused, so a keyboard
 * reader's focus fell to `<body>` and the undo — a control with a six-second
 * life — was several Tab presses away from a place they no longer were. The
 * same press said nothing at all to a screen reader.
 *
 * Two fixes, and both are needed: `role="status"` announces the row when it
 * replaces the task (polite, so it does not interrupt), and focus MOVES to the
 * Undo button, which is the only way a control that expires is operable at all
 * without a mouse. This is the same rule the live row keeps — see the note on
 * `HomeTaskRow`: a control a keyboard or touch reader cannot reach is a control
 * that is not in the product.
 */
export function HomeTaskUndoRow({
  title,
  onUndo,
}: {
  /** The row's own title, so "Skipped" names something rather than nothing. */
  title: string;
  onUndo: () => void;
}) {
  const undoRef = useRef<HTMLButtonElement>(null);
  // On mount only: this row appears exactly when the X that had focus was
  // unmounted, so it is taking focus back rather than stealing it.
  useEffect(() => {
    undoRef.current?.focus();
  }, []);

  return (
    <div role="status" className={cn(ROW_BASE, "opacity-60")}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3">
        <Icon name="Undo2" className="h-3.5 w-3.5 text-muted-2" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-muted">
          Skipped · <span className="text-muted-2">{title}</span>
        </p>
      </div>
      <button
        ref={undoRef}
        type="button"
        onClick={onUndo}
        // round 6: the outline voice, in ink. It tinted its border orange and
        // turned its label orange on hover, which spends the one rationed
        // colour on an undo.
        className="focus-ring shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/[0.04]"
      >
        Undo
      </button>
    </div>
  );
}

/**
 * The row chrome Home's lists share.
 *
 * TODAY THERE IS ONE READER: the setup ladder (home-get-set-up.tsx). It was
 * written for two — "Next actions" (home-action-list.tsx) and "Recommended
 * tasks" (home-recommended-tasks.tsx) — and both were deleted in portal feedback
 * round 4 when the ladder replaced them, so this docstring's own account of why
 * the row is shared had outlived the sharing (review wave, 2026-09). It stays a
 * component rather than being folded into its one caller for the same reason
 * `useUndoableDismiss` above stays: the audit's follow-up list ("More ways to
 * get value", once the ladder is complete) is the second reader, and the rules
 * below are what it has to match.
 *
 * PORTAL FEEDBACK ROUND 2, 2026-09. The product owner's ruling collapsed the
 * lists onto the same two gestures: "It shouldn't be just Approve or Skip: it
 * should be an X-out or a button that starts it". Two lists that sit inches
 * apart on the same screen and offer the same pair of gestures must not render
 * them at two sizes, in two orders or with two hover behaviours — so the row is
 * built ONCE here and the widgets pass data into it, rather than each keeping
 * its own copy to drift.
 *
 * THE CONTROLS ARE ALWAYS VISIBLE. The previous "Next actions" row revealed its
 * buttons on `group-hover` with an `[@media(hover:none)]` fallback, which meant
 * a keyboard or touch reader had to discover them. The primary gesture of the
 * row is now one of these two buttons (the row itself is no longer a link), so
 * a hidden control is a hidden feature. Any change here must keep them
 * reachable without a pointer.
 */
export function HomeTaskRow({
  icon,
  title,
  description,
  meta,
  error,
  muted = false,
  trailing,
  dismiss,
  start,
  href,
  busy = false,
}: {
  /** Lucide icon name, rendered in the leading disc. Omit for a disc-less row. */
  icon?: string;
  title: string;
  /** Two lines at most — a proposal's rationale, never a second title. */
  description?: string;
  /** The executor/platform chip, above the title. */
  meta?: ReactNode;
  error?: string;
  /** Done / snoozed rows: same chrome, dimmed, usually with no controls. */
  muted?: boolean;
  /** A status word ("Not started", "After step 3") shown where a control would be. */
  trailing?: ReactNode;
  /** The X. `label` is the accessible name — the button is icon-only. */
  dismiss?: { label: string; onClick: () => void };
  /**
   * The row's one accent control: a Link, because it navigates to the inputs
   * that finish the step. `label` names the action and the missing thing
   * ("Add a short description"), never one phrase for every row.
   */
  start?: { href: string; label: string };
  /**
   * THE WHOLE ROW IS THE LINK (round 6, rule 3 · §2.1).
   *
   * Passed instead of `start` on a row that has a destination but not the
   * press: it renders as one `<Link>` over the whole row, hovers one fill step
   * with the accent hairline (`row-lift`), and ends in ONE static
   * `ChevronRight`. Four of the ladder's six rows were not clickable at all
   * before this, while the module that built them claimed every row was a
   * destination.
   *
   * MUTUALLY EXCLUSIVE WITH `start` AND `dismiss`, deliberately: an anchor may
   * not contain interactive content, so a row-wide link with a button inside it
   * would be the nested-control problem the old hover overlay was invented for.
   * The current step keeps the button and stays a static container; every other
   * incomplete step is the link.
   */
  href?: string;
  busy?: boolean;
}) {
  const body = (
    <>
      {icon && (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3">
          <Icon name={icon} className="h-3.5 w-3.5 text-muted-2" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        {meta && <div className="mb-1 flex flex-wrap items-center gap-1.5">{meta}</div>}
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        {description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-2">{description}</p>}
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
    </>
  );

  if (href && !start && !dismiss) {
    return (
      <Link
        href={href}
        className={cn(ROW_BASE, "row-lift focus-ring", muted && "opacity-60")}
      >
        {body}
        {trailing && (
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-2">{trailing}</span>
        )}
        {/* The product's one trailing glyph: static, `muted-2`, no slide and no
            colour change on hover (rule 3). */}
        <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" />
      </Link>
    );
  }

  return (
    <div
      className={cn(
        // NO HOVER TREATMENT (flow audit 2026-09, R8). This branch is the row
        // that opens nothing by itself — a done row, or the current step, whose
        // own control is the affordance — and the rule is that a row which
        // opens something is the whole row (the branch above), while a row that
        // opens nothing carries no fill change, no hairline and no chevron.
        ROW_BASE,
        muted && "opacity-60",
      )}
    >
      {body}
      <div className="flex shrink-0 items-center gap-1.5">
        {trailing && (
          <span className="whitespace-nowrap text-xs text-muted-2">{trailing}</span>
        )}
        {dismiss && (
          <button
            type="button"
            aria-label={dismiss.label}
            title={dismiss.label}
            onClick={dismiss.onClick}
            disabled={busy}
            className="focus-ring rounded p-1.5 text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:opacity-40"
          >
            <Icon name="X" className="h-3.5 w-3.5" />
          </button>
        )}
        {start && (
          <Link href={start.href} className={ACCENT_LINK}>
            {start.label}
          </Link>
        )}
      </div>
    </div>
  );
}
