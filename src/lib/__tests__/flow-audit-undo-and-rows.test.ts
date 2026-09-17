import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchingBrace, matchingParen, readSource, stripComments } from "./source-scan";
import { taskAlertRows, unreadNotificationCount } from "@/lib/notification-rows";
import type { TaskAlert } from "@/lib/notification-rows";

/**
 * THE TWO RULES THE FLOW AUDIT (2026-09) ADDED TO THE CLIENT PORTAL, and the
 * two it settled by fiat.
 *
 *  · R4 — a destructive press a client makes repeatedly gets an UNDO, not a
 *    confirm, and the server write happens at the END of the window rather than
 *    at the press. (NN/g *Confirmation Dialogs*: "prefer undo over confirmation
 *    for anything repetitive".)
 *  · R8 — one row affordance: a row that opens something is the whole row,
 *    carries `row-lift` and ends in ONE trailing `ChevronRight`; a row that
 *    opens nothing carries neither. (F12 counted four patterns, three trailing
 *    glyphs and two hover treatments for one meaning.)
 *  · R10 — a notification a client cannot act on is not shaped like a link.
 *  · R11 — `/team` is reachable at desktop width, not only from a `md:hidden`
 *    sheet.
 *
 * SOURCE TEXT for the rendering rules, on purpose: this suite runs in a node
 * environment with no DOM and no testing-library, so "the timer fires the write
 * and the Undo button cancels it" cannot be driven by a click here. What CAN be
 * pinned mechanically is the shape that makes those claims true — where the
 * commit is called from, and which classes and glyphs each kind of row carries
 * — and those are exactly the things a later edit would silently undo. The one
 * rule that is a pure function (`taskAlertRows`) is tested as one.
 */

const src = (rel: string) => readSource(path.resolve(__dirname, "../..", rel));
/** JSX and wiring only — the docstrings above these rules name the very words
 *  and classes the rules forbid. */
const code = (rel: string) => stripComments(src(rel));

/**
 * The body of a top-level `function Name(` / `export function Name(`.
 *
 * The PARAMETER LIST is matched before the body is looked for, and that is not
 * pedantry: a naive "first `{` after the first `)`" reads a destructured
 * options parameter (`{ windowMs = …, commitOnUnmount = false }`) as the
 * function body and hands every assertion below the wrong text — silently, and
 * green in the direction that matters least.
 */
function functionBody(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  expect(at, `${name} is gone — this rule moved`).toBeGreaterThan(-1);
  const params = matchingParen(source, source.indexOf("(", at));
  expect(params, `${name} has an unbalanced parameter list`).toBeGreaterThan(-1);
  const open = source.indexOf("{", params);
  const close = matchingBrace(source, open);
  expect(close, `${name} has an unbalanced body`).toBeGreaterThan(-1);
  return source.slice(open, close + 1);
}

const row = code("components/home-task-row.tsx");
const getSetUp = code("components/home-get-set-up.tsx");

describe("R4 · the undo window, not a confirm and not an immediate delete", () => {
  it("is one window, defined once, and it is six seconds", () => {
    // Two windows would be two promises. NOTHING MOUNTS THE HOOK TODAY — both
    // lists it was built for left Home in the round-4 pass (see the note on
    // useUndoableDismiss) — so what is pinned here is the RULE's shape, ready
    // for the next list that has a skip.
    expect(row).toContain("export const UNDO_WINDOW_MS = 6000");
    expect(row).toContain("export function useUndoableDismiss(");
    expect(row).toContain("export function HomeTaskUndoRow(");
  });

  it("commits when the window expires and NOWHERE else", () => {
    const hook = functionBody(row, "useUndoableDismiss");
    // TWO call sites of the caller's commit and no more: the expiring timer,
    // and the opt-in unmount flush guarded by `flushOnUnmountRef`. Counted
    // rather than merely located, because "the write also happens over here"
    // is the whole class of defect this rule exists to stop.
    const calls = [...hook.matchAll(/commitRef\.current\(/g)];
    expect(calls, "the commit is called from somewhere new").toHaveLength(2);
    const timeout = hook.slice(hook.indexOf("setTimeout("));
    expect(timeout, "the commit no longer runs from the timer").toContain("commitRef.current(id)");
    // The press itself must not write. `dismiss` arms a timer; that is all, so
    // nothing before the `setTimeout(` may reach the commit.
    const armed = hook.slice(hook.indexOf("const dismiss"), hook.indexOf("const undo"));
    expect(armed).toContain("setTimeout(");
    expect(
      armed.slice(0, armed.indexOf("setTimeout(")),
      "the X writes on the press again",
    ).not.toContain("commitRef.current(");
  });

  it("cancels rather than compensates", () => {
    const hook = functionBody(row, "useUndoableDismiss");
    const undo = hook.slice(hook.indexOf("const undo"));
    expect(undo).toContain("clearTimeout(");
    // Undo must not fire a SECOND write to reverse the first — there is no
    // restore action for `deleteTaskAction`, which is the whole reason the
    // window is in front of the write instead of behind it.
    expect(undo, "undo writes something").not.toContain("commitRef.current(");
  });

  it("lets each list say what an unmount means, and defaults to cancel", () => {
    // ONE ANSWER FOR BOTH LISTS WAS WRONG FOR ONE OF THEM. "Next actions" has a
    // <Link> as its other control, so X-ing three rows and then pressing "Let's
    // do this" on a fourth unmounted the hook mid-window — and a blanket cancel
    // silently un-skipped all three, putting rows the client was told were gone
    // back on Home. Recommended tasks must keep cancelling: its commit is a
    // hard delete.
    const hook = functionBody(row, "useUndoableDismiss");
    expect(hook, "the per-list option is gone").toContain("commitOnUnmount");
    expect(row, "the default is no longer the conservative one").toContain(
      "commitOnUnmount = false",
    );
    // The cleanup clears first and only then flushes, so a surviving timer can
    // never make the commit run twice.
    const cleanup = hook.slice(hook.indexOf("return () => {"));
    const cleared = cleanup.indexOf("clearTimeout(t)");
    const flushed = cleanup.indexOf("commitRef.current(id)");
    expect(cleared, "the unmount no longer clears its timers").toBeGreaterThan(-1);
    expect(flushed, "the unmount can no longer flush").toBeGreaterThan(-1);
    expect(flushed, "the flush runs before the clear").toBeGreaterThan(cleared);
    expect(cleanup).toContain("if (flushOnUnmountRef.current)");
  });

  it("hands the undo back to a keyboard, which the X had just taken it from", () => {
    // Pressing the X unmounts the focused button, so focus fell to <body> and a
    // control with a six-second life was several Tab presses away from a place
    // the reader no longer was. Announced AND focused: the live region is for
    // the reader who is not looking, the focus move is what makes the control
    // operable at all without a pointer.
    const undoRow = functionBody(row, "HomeTaskUndoRow");
    expect(undoRow, "the undo row announces nothing").toContain('role="status"');
    expect(undoRow, "focus is not returned to the undo control").toContain(
      "undoRef.current?.focus()",
    );
    // On mount only — an empty dependency list. Re-running it would drag focus
    // back on every re-render of the list.
    expect(undoRow).toMatch(/undoRef\.current\?\.focus\(\);\s*\}, \[\]\);/);
    expect(undoRow).toContain("ref={undoRef}");
  });

  it("leaves Home's one list with no skip to undo", () => {
    // PORTAL FEEDBACK ROUND 4, 2026-09. "Get set up" replaced both lists this
    // rule was written for, and it offers no X at all: every one of its six
    // steps is a real gate the server refuses on, so a skip would let a client
    // dismiss the thing that is blocking them and then stop being asked. The
    // shared row's dismiss prop is simply never passed.
    expect(getSetUp, "the setup ladder grew a skip").not.toContain("dismiss:");
    expect(getSetUp, "the setup ladder grew an undo window").not.toContain(
      "useUndoableDismiss",
    );
    expect(getSetUp, "the setup ladder must render the shared row").toContain("<HomeTaskRow");
  });

  it("gives the one-off destructive presses the two-step confirm instead", () => {
    // Not the undo window: a removed logo, avatar or competitor has no stored
    // previous state to put back, so the question is asked BEFORE the write.
    // Same block shape as client-key-inline.tsx, which is where it came from.
    for (const rel of [
      "components/avatar-uploader.tsx",
      "components/client-profile-panel.tsx",
      "components/client-context-sections.tsx",
    ]) {
      const c = code(rel);
      expect(c, `${rel} has no confirm state`).toMatch(/setConfirming/);
      expect(c, `${rel} offers no way out of the confirm`).toContain("Cancel");
    }
    // …and the press that used to commit now only opens the question.
    expect(code("components/avatar-uploader.tsx")).toContain("onClick={() => setConfirming(true)}");
    expect(code("components/client-profile-panel.tsx")).toContain(
      "onClick={() => setConfirmingLogo(true)}",
    );
  });
});

describe("R8 · one row affordance", () => {
  /** A row that opens something. */
  const OPENERS = [
    "components/client-agents/agent-archive-rows.tsx",
    "components/home-calendar-preview.tsx",
  ];
  /** A row that opens nothing. */
  const INERT = [
    "components/client-agents/client-agent-run-history.tsx",
    // round 6 (§2.1): `home-task-row.tsx` LEFT this list. It was inert because
    // the setup ladder's rows had no destinations — four of six were not
    // clickable at all — and the round-6 ruling is that every incomplete step
    // is a link to its own landing. The row now has BOTH shapes, mutually
    // exclusive, and the test below pins the split rather than the old half.
  ];

  it("makes the whole row the trigger, with row-lift and one chevron", () => {
    for (const rel of OPENERS) {
      const c = code(rel);
      const at = c.indexOf("row-lift");
      expect(at, `${rel} lost row-lift`).toBeGreaterThan(-1);
      // The trigger is the row, not a control inside it — and it is a <button>,
      // so it is reachable by keyboard and announces itself.
      const opens = c.lastIndexOf("<button", at);
      expect(opens, `${rel}: the row is not the trigger`).toBeGreaterThan(-1);
      // ONE trailing glyph inside the row element. Counted in the row, not in
      // the file: an empty state's own control is a different row.
      const rowEl = c.slice(opens, c.indexOf("</button>", at));
      const chevrons = [...rowEl.matchAll(/name="ChevronRight"/g)];
      expect(chevrons.length, `${rel}'s row has ${chevrons.length} trailing chevrons, want 1`).toBe(
        1,
      );
    }
  });

  it("has no secondary CTA left inside an archive row", () => {
    // The pattern NN/g's *Cards* guidance argues against: a row plus a button
    // that does the only thing the row could do.
    const c = code("components/client-agents/agent-archive-rows.tsx");
    expect(c, "the View-output button is back").not.toContain("View output");
    expect(c, "the row grew a second control again").not.toContain("<Button");
    // The modal mount stays — it is what the row opens.
    expect(c).toContain("<AssetDetailModal");
  });

  // round 6 (§2.1, rule 3): the shared Home row is a link when it has somewhere
  // to go and a plain container when its own control is the affordance. Both
  // halves obey the same rule; what must never happen is one wearing the
  // other's shell, or an anchor holding a control inside it.
  it("gives the shared Home row exactly two shapes, and never mixes them", () => {
    const c = code("components/home-task-row.tsx");
    // The link half: whole-row anchor, one fill-and-hairline hover, one static
    // chevron, one focus rule.
    const splitAt = c.lastIndexOf("return (");
    const linkBranch = c.slice(c.indexOf("if (href && !start && !dismiss)"), splitAt);
    expect(linkBranch).toContain("<Link");
    expect(linkBranch).toContain("row-lift focus-ring");
    expect([...linkBranch.matchAll(/name="ChevronRight"/g)]).toHaveLength(1);
    // The static half: no lift, no chevron, no hover treatment on the row.
    const staticBranch = c.slice(splitAt);
    expect(staticBranch).not.toContain("row-lift");
    expect(staticBranch).not.toContain('name="ChevronRight"');
    expect(staticBranch).not.toContain("hover:border-border-strong");
  });

  it("leaves an inert row dressed as one: no lift, no chevron, no hover", () => {
    for (const rel of INERT) {
      const c = code(rel);
      expect(c, `${rel} lights up on hover with nowhere to go`).not.toContain("row-lift");
      expect(c, `${rel} promises a destination with a chevron`).not.toContain(
        'name="ChevronRight"',
      );
      expect(c, `${rel} kept the second hover treatment F12 counted`).not.toContain(
        "hover:border-border-strong",
      );
    }
  });

  it("lets a one-way disclosure back, wherever it opened a list", () => {
    // R19's shape, and the same rule the competitor list already keeps: a
    // "show all" that turns into nothing leaves a reader scrolling a list they
    // did not ask to open.
    const history = code("components/client-agents/client-agent-run-history.tsx");
    expect(history).toContain("Show fewer");
    expect(history).toContain("setExpanded((e) => !e)");
    expect(history, "the control is hidden once pressed again").not.toContain("!expanded &&");
  });

  it("uses one trailing glyph on Home's overview rows, not three", () => {
    const overview = code("components/client-home-overview.tsx");
    const attention = functionBody(overview, "AttentionRow");
    expect(attention, "AttentionRow still ends in an arrow").not.toContain('name="ArrowRight"');
    expect(attention).toContain('name="ChevronRight"');
  });
});

const ALERT = (over: Partial<TaskAlert>): TaskAlert => ({
  id: "t-1",
  title: "Draft the launch post",
  status: "pending",
  priority: "medium",
  createdAt: 1,
  ...over,
});

describe("R10 · the bell says nothing a client cannot act on in the shape of a link", () => {
  // round 6: R10 collapsed a client's task rows into one summary line per
  // status group; Albert's ruling that every notification row must lead
  // somewhere finishes the job, because that line led nowhere either. Sign-off
  // is staff-only (`approveAssetAction` calls `requireStaff`) and the counts
  // still live on Home's attention card, so a client's bell carries no task
  // feed at all now.
  it("gives a client no task rows at all, whatever the statuses", () => {
    const alerts = [
      ALERT({ id: "a", status: "pending" }),
      ALERT({ id: "b", status: "pending" }),
      ALERT({ id: "c", status: "review_pending" }),
    ];
    expect(taskAlertRows(alerts, { viewerIsClient: true })).toEqual([]);
    expect(taskAlertRows([ALERT({ status: "pending" })], { viewerIsClient: true })).toEqual([]);
    expect(taskAlertRows([], { viewerIsClient: true })).toEqual([]);
  });

  it("leaves staff the per-task rows they work from", () => {
    const alerts = [ALERT({ id: "a" }), ALERT({ id: "b" }), ALERT({ id: "c" })];
    const rows = taskAlertRows(alerts, { viewerIsClient: false });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.kind)).toEqual(["task", "task", "task"]);
  });

  it("moves the badge by the rows the panel renders, not by the records", () => {
    // The #105 rule, in a third place: a badge that counted a swarm's whole
    // task set while the panel showed two lines is the same lie.
    const feeds = {
      actionItems: [],
      reviewJobs: [],
      taskAlerts: [ALERT({ id: "a" }), ALERT({ id: "b" }), ALERT({ id: "c" })],
    };
    const opts = { dismissed: new Set<string>() };
    // round 6: zero for a client, because the panel renders no task row for
    // them. Staff are untouched: one row per task, one count per row.
    expect(unreadNotificationCount(feeds, { ...opts, viewerIsClient: true })).toBe(0);
    expect(unreadNotificationCount(feeds, { ...opts, viewerIsClient: false })).toBe(3);
  });

  it("offers a client no aggregate destination the portal cannot honour", () => {
    const bell = code("components/notification-bell.tsx");
    // /transcripts had three inconsistent reachability states for a client and
    // this footer was the one that came and went with the feed (R11 · F14).
    const at = bell.indexOf("const showMeetingsLink");
    expect(at, "showMeetingsLink is gone — the footer rule moved").toBeGreaterThan(-1);
    const rhs = bell.slice(bell.indexOf("=", at) + 1, bell.indexOf(";", at));
    expect(rhs, "a client is offered the meetings list from the bell again").toContain(
      "!viewerIsClient",
    );
    // round 6: the summary line it used to also pin is gone rather than
    // softened — `TaskSummaryRow` and `ReviewSummaryRow` are deleted, so the
    // assertion is that neither can come back as a component either.
    expect(bell).not.toContain("TaskSummaryRow");
    expect(bell).not.toContain("ReviewSummaryRow");
  });
});

describe("R7/R11 · one vocabulary, and a desktop route to /team", () => {
  it("keeps ONE pin control, on the agent's page, in R7's words", () => {
    // round 6: R7's ruling was that the rail's star and the agent page's button
    // must not narrate one flag with two verbs. The rail no longer has the
    // control at all (think-agents §3), which settles the vocabulary question by
    // removing the second voice — so what is pinned here is the absence, plus
    // the surviving control's wording.
    const nav = code("components/client-rail-agents-nav.tsx");
    expect(nav, "the rail pins agents again").not.toMatch(/`(Un)?[PpSs]\w+ \$\{agent\.name\}/);
    expect(nav).not.toContain("aria-pressed");
    const button = code("components/client-agents/agent-star-button.tsx");
    expect(button).toContain("Pin to sidebar");
    expect(button).toContain("Unpin from sidebar");
  });

  it("keeps one noun for the archive in prose as well as on controls", () => {
    // The control label was unified first; these are the sentences that still
    // called the same place "your archive" — three surfaces a client reads in
    // one session (the bell's summary line, Home's attention hint, the
    // mark-as-posted note).
    for (const rel of [
      "components/notification-bell.tsx",
      "components/client-home-overview.tsx",
      "components/mark-posted-row.tsx",
    ]) {
      expect(code(rel), `${rel} still says "your archive"`).not.toContain("your archive");
    }
    // And the checklist row that sends a client to the pin control says "Pin".
    const actions = code("lib/action-list.ts");
    expect(actions).toContain("Pin the agents you use most");
    expect(actions, "the checklist still says Star").not.toContain("Star the agents");
  });

  it("renders the archive control identically wherever it appears", () => {
    // Same words AND the same glyph: the agent page and Home offer one
    // destination, and differing by an ArrowRight is the F12 half of the same
    // finding the naming was the F11 half of.
    for (const rel of [
      "app/(app)/clients/[id]/agents/[agentId]/page.tsx",
      "components/client-home-overview.tsx",
    ]) {
      const c = code(rel);
      const at = c.indexOf("{archive.linkLabel}");
      expect(at, `${rel} no longer renders the shared archive label`).toBeGreaterThan(-1);
      // The glyph beside it, within the same element.
      const around = c.slice(at, at + 200);
      expect(around, `${rel}'s archive control uses a different glyph`).toContain(
        'name="ChevronRight"',
      );
    }
  });

  it("gives the support dialog one label at every trigger", () => {
    expect(code("components/contact-us-modal.tsx")).toContain('label = "Support"');
    expect(code("components/seo-geo/flag-button.tsx")).toContain('label = "Support"');
    // No trigger renames it. The context belongs in the copy around the
    // control, not in a fifth name for one dialog.
    for (const rel of [
      "components/account-menu.tsx",
      "components/client-rail.tsx",
      "components/credits-panel.tsx",
      "components/seo-geo-panel.tsx",
      // R17 added two more triggers — the intake surfaces' run-failure notice
      // and the "Coming soon" channel tile — on copy that already told the
      // client to contact their Karos team. Both are in this loop rather than
      // beside it: a new mount is exactly where a sixth name for one dialog
      // gets introduced.
      "components/intake-run-error.tsx",
      "components/integrations-tab.tsx",
    ]) {
      const mounts = [
        ...code(rel).matchAll(/<(ContactUsButton|FlagButton)\b[\s\S]*?\/>/g),
      ].map((m) => m[0]);
      expect(mounts.length, `${rel} mounts no support trigger`).toBeGreaterThan(0);
      for (const mount of mounts) {
        expect(mount, `${rel} renames the support dialog`).not.toMatch(/\blabel=/);
      }
    }
  });

  it("puts Team in the desktop account menu under the same condition as the sheet", () => {
    const menu = code("components/account-menu.tsx");
    expect(menu).toContain("user.isGroupAdmin");
    expect(menu).toContain('href="/team"');
    // The mobile sheet's copy is unchanged — this is a second reachable place
    // for one destination, not a move.
    expect(code("components/client-rail.tsx")).toContain('href="/team"');
  });
});
