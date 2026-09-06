import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ReviewJobRow } from "@/components/notification-bell";
import { stripComments } from "./source-scan";
import type { AgentReviewNotification } from "@/lib/types";

/**
 * The bell must agree with the nav it is mounted in.
 *
 * On the 30 Jul call the product owner, in View as Client, clicked a review row
 * and landed on /jobs — an admin page that the very shell he was in had
 * deliberately removed (`clientViewNav` has no Jobs tab). The row's link was
 * gated on `viewerIsClient`, which the staff shell never passes, so Client View
 * kept the admin link while the nav around it hid the destination.
 *
 * `viewerIsClient` could not simply be reused: it ALSO rewrites the row's
 * status line to "Your Karos team is reviewing it", and a staff member IS the
 * Karos team — that copy would hide work they own. The link behaviour therefore
 * has its own prop, `allowJobDeepLinks`, and the two are pinned apart below.
 */

const src = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
/** Source read for wiring assertions is whitespace-normalised — JSX props
 *  reflow with formatting, and a line break is not a behaviour change. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const bell = src("components/notification-bell.tsx");
const sidebar = src("components/sidebar.tsx");
const rail = src("components/client-rail.tsx");

/** Every `<NotificationBell …/>` element in a file, whitespace-normalised.
 *  Lazy to the closing `/>` rather than "not a `>`" — prop values are arrow
 *  functions, and `=>` would end the match on the first callback. */
function bellMounts(source: string): string[] {
  return [...flat(source).matchAll(/<NotificationBell\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

const JOB: AgentReviewNotification = {
  jobId: "job-77",
  title: "Three posts for the launch week",
  agentName: "X agent",
  updatedAt: Date.UTC(2026, 6, 30),
  clientId: "client-1",
};

function renderRow(props: { viewerIsClient: boolean; deepLink: boolean }): string {
  return renderToStaticMarkup(
    createElement(ReviewJobRow, {
      job: JOB,
      now: JOB.updatedAt,
      onNavigate: () => {},
      ...props,
    }),
  );
}

describe("a review row never leads where the surrounding nav does not go", () => {
  it("drops the /jobs link in Client View, for staff as well as clients", () => {
    // Staff in Client View: the shell withdrew the destination.
    expect(renderRow({ viewerIsClient: false, deepLink: false })).not.toContain("/jobs/");
    // A real client: unchanged, and unchanged for the original reason.
    expect(renderRow({ viewerIsClient: true, deepLink: false })).not.toContain("/jobs/");
  });

  it("keeps the /jobs link for staff outside Client View", () => {
    // The thing the fix must not break: on the admin nav, /jobs is a tab and
    // the job page is where a reviewer actually works.
    expect(renderRow({ viewerIsClient: false, deepLink: true })).toContain('href="/jobs/job-77"');
  });

  it("hands a client no link even if a caller passes allowJobDeepLinks", () => {
    // /jobs is staff-only (requireUser(["KAROS_ADMIN","KAROS_EMPLOYEE"])), so
    // the flag describing the VIEWER outranks the flag describing the shell —
    // and the row is wired to that combined answer, not to either flag alone.
    const b = flat(bell);
    expect(b).toContain("const jobDeepLinks = allowJobDeepLinks && !viewerIsClient");
    expect(b).toContain("deepLink={jobDeepLinks}");
  });

  it("still tells a staff member in Client View that the review is theirs", () => {
    // The over-apply this prop split exists to prevent: withdrawing the link
    // must not also swap in the client's reassurance copy.
    const staffInClientView = renderRow({ viewerIsClient: false, deepLink: false });
    expect(staffInClientView).toContain("Waiting for your review");
    expect(staffInClientView).not.toContain("Your Karos team is reviewing it");

    // And the client's line is untouched.
    expect(renderRow({ viewerIsClient: true, deepLink: false })).toContain(
      "Your Karos team is reviewing it",
    );
  });

  it("only offers a hover affordance when the row is actually clickable", () => {
    expect(renderRow({ viewerIsClient: false, deepLink: true })).toContain("hover:bg-surface-2");
    expect(renderRow({ viewerIsClient: false, deepLink: false })).not.toContain(
      "hover:bg-surface-2",
    );
  });
});

/**
 * WHAT A CLIENT'S BELL HOLDS AFTER ROUND 6 (2026-09).
 *
 * Albert: every notification row must be clickable and lead somewhere. Three of
 * the four row kinds a client could see were inert — two task summary lines and
 * one review summary line, each naming work with nowhere to go — and the header
 * carried a static "N unread" chip beside the badge that had just been pressed
 * to open the panel. What is left is the meeting action items, which have a real
 * destination, and an empty state that offers one.
 *
 * Read from source for the same reason the wiring assertions below are: the
 * panel only mounts after a click on the trigger, which a node test run cannot
 * perform, and `NotificationBell` renders it closed.
 */
describe("a client's bell holds only rows that lead somewhere", () => {
  const b = flat(bell);
  /**
   * Comment-stripped, for the assertions that say a thing is GONE: this
   * component explains at length what it used to do and why it stopped, and
   * prose above a fix must not satisfy a test that the fix happened.
   */
  const code = flat(stripComments(bell));

  it("has no inert summary row left to render", () => {
    // Deleted rather than hidden: a component nobody mounts is how the last
    // three of these came back.
    expect(code).not.toContain("ReviewSummaryRow");
    expect(code).not.toContain("TaskSummaryRow");
  });

  it("makes the meeting action item a whole-row link with one trailing chevron", () => {
    // It used to hover as one surface while only the 11px meeting title inside
    // it was clickable (rule 1: the whole surface is the target).
    expect(b).toContain('href={`/transcripts/${n.transcriptId}`}');
    expect(b).toMatch(/href=\{`\/transcripts\/\$\{n\.transcriptId\}`\}[\s\S]*?focus-ring/);
    expect(b).toMatch(/name="ChevronRight"[^>]*text-muted-2/);
    // Static: no slide and no colour change on the glyph.
    expect(b).not.toContain("group-hover:translate-x");
  });

  it("names the completion control instead of an X that says delete", () => {
    // The row's one control was an X whose tooltip read "Mark complete" — a
    // destructive glyph for a completion, and a hint hidden in a `title`.
    expect(code).toContain("> Done <");
    expect(code).not.toContain('aria-label="Mark complete and dismiss"');
    expect(b).toContain("dismissals.dismiss(n.transcriptId, n.itemIndex)");
  });

  it("prints one number, the badge's", () => {
    // The "N unread" chip was a second number for the same set, beside the
    // control the reader had just pressed. Think-home §3.2 replaces it with
    // "Mark all as read", which needs a persisted seen-marker; no such field
    // exists, so the chip is gone rather than replaced by a control that could
    // not honour itself.
    expect(code).not.toContain("{badgeLabel} unread");
    expect(code).not.toContain("Mark all as read");
  });

  it("offers somewhere to go when there is nothing to show", () => {
    expect(code).toContain("Nothing needs you right now.");
    expect(code).not.toContain("All caught up!");
    // Client only: /calendar is the client route, and a staff member's calendar
    // is per client. Staff keep their own footer links, asserted below.
    expect(code).toMatch(/viewerIsClient && \( <Link href="\/calendar"/);
  });
});

/**
 * Wiring assertions read source text on purpose: both shells are "use client"
 * modules whose import graph reaches the Admin SDK, so they cannot be imported
 * into a node test run (same constraint as shell-chrome.test.ts).
 */
describe("every shell tells the bell which shell it is", () => {
  it("passes allowJobDeepLinks at every staff mount", () => {
    // FOUR now, not three (parity pass 2026-09, ruling D7): the drawer's row,
    // the account menu's, the Company sheet's, and the client's own rail bell,
    // which the client-context arm mounts beside the credits pill exactly where
    // client-rail.tsx puts it. That fourth one is the one most at risk of
    // missing this prop — it was copied from the CLIENT's rail, which has no
    // business passing a staff-only flag and therefore does not.
    const mounts = bellMounts(sidebar);
    expect(mounts).toHaveLength(4);
    for (const mount of mounts) {
      expect(mount).toContain("allowJobDeepLinks={allowJobDeepLinks}");
    }
    // The menu mount is one component deep, so the prop has to be threaded.
    expect(flat(sidebar)).toContain("allowJobDeepLinks={allowJobDeepLinks} />");
  });

  it("binds that flag to the same condition that picks the nav", () => {
    const s = flat(sidebar);
    // Client View is chosen once, for both the nav and the bell.
    expect(s).toContain("const clientCtx = isStaff && activeClient ? activeClient : null");
    expect(s).toContain("const allowJobDeepLinks = clientCtx === null");
    // …and the nav it must agree with genuinely has no Jobs tab.
    const clientNav = /function clientViewNav\([\s\S]*?\n\}/.exec(sidebar)?.[0] ?? "";
    expect(clientNav).not.toBe("");
    expect(clientNav).not.toContain("/jobs");
    // The route itself stays staff-gated — this fix changes the offer, not the gate.
    expect(src("app/(app)/jobs/page.tsx")).toContain(
      'requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"])',
    );
  });

  it("keeps viewerIsClient on both client-rail mounts", () => {
    const mounts = bellMounts(rail);
    expect(mounts).toHaveLength(2);
    for (const mount of mounts) {
      expect(mount).toMatch(/\bviewerIsClient\b/);
      // The client shell has no business claiming a staff-only destination.
      expect(mount).not.toContain("allowJobDeepLinks");
    }
  });
});

/**
 * WHAT THE STAFF BELL IS ALLOWED TO READ, AND FOR WHOM (review wave, 2026-09).
 *
 * The feed itself was correct for an admin and quietly wrong for everybody
 * else: the layout read the newest 200 tasks agency-wide and then kept the ones
 * belonging to the viewer's clients. An employee is fenced to their
 * assignments, so at a busy agency every one of their clients' tasks could sit
 * outside that global window — an empty bell and an "All caught up!" that was
 * simply false. And the OTHER arm of the same fence handed raw task documents
 * to a CLIENT_USER who had fallen through to this shell.
 */
describe("the staff bell reads the viewer's own scope", () => {
  const appLayout = src("app/(app)/layout.tsx");

  it("fences an employee's task read in the QUERY, not after it", () => {
    const a = flat(appLayout);
    // The scope reaches listClientTasks, and only for the role that has one.
    expect(a).toMatch(
      /user\.role === "KAROS_EMPLOYEE" \? \{ clientIds: \[\.\.\.staffClientNames\.keys\(\)\] \}/,
    );
    // The same key set the review feed is fenced with — one scope, two feeds.
    expect(a).toContain("listReviewJobsForClients([...staffClientNames.keys()]");
    // An admin keeps the single global read: their scope IS every client, and
    // 30-at-a-time `in` queries over the whole roster would be strictly worse.
    expect(a).toMatch(/listClientTasks\(\{ \.\.\.\(user\.role === "KAROS_EMPLOYEE"/);
  });

  it("gives listClientTasks a chunked clientIds filter that fails closed", () => {
    const data = flat(src("lib/data.ts"));
    // Firestore caps an `in` list; a wider scope is split rather than truncated.
    expect(data).toContain("const TASK_CLIENT_SCOPE_CHUNK = 30;");
    expect(data).toContain('q.where("clientId", "in", scope)');
    // An EMPTY scope is an empty answer, never "everything" — the fence has to
    // fail closed or an employee with no assignments would see every client.
    expect(data).toContain("if (scope.length === 0) return [];");
    // The cap is applied to the merged, re-sorted union, not per chunk.
    expect(data).toMatch(
      /pages \.flat\(\) \.sort\(\(a, b\) => b\.createdAt - a\.createdAt\) \.slice\(0, opts\.limit \?\? 200\)/,
    );
  });

  it("narrows a client viewer's task rows on BOTH branches of the shell split", () => {
    // `clientSafeTaskAlerts` was applied to the resolvable-client branch only.
    // The other branch is a CLIENT_USER whose client document would not load —
    // they fall through to the staff Sidebar, which is "use client", so a raw
    // ClientTask there is in their RSC payload whether or not a row paints it.
    expect(appLayout.match(/clientSafeTaskAlerts\(/g) ?? []).toHaveLength(2);
    expect(flat(appLayout)).toContain(": clientSafeTaskAlerts(taskAlerts);");
    expect(flat(appLayout)).toContain("taskAlerts={clientSafeTaskAlerts(taskAlerts)}");
    // And the prop the staff shell declares is the narrow row type, so the
    // wide one cannot come back without a type change in the open.
    expect(flat(sidebar)).toContain("taskAlerts?: TaskAlert[];");
  });
});

describe("a bell inside a dismissible container closes it", () => {
  it("closes its own container from every mount that sits in one", () => {
    // The rule is "a bell inside something that covers the page dismisses it",
    // not a count: the staff shell has TWO such containers — the Company sheet
    // (useCompanySheet) and the `fixed inset-0` mobile drawer, which closes
    // only from explicit handlers and so strands every navigation, not just a
    // same-route tap. Each mount is handed its own setter rather than reaching
    // for global state.
    const closers = /onNavigate=\{\(\) => set(CompanyOpen|Open)\(false\)\}/;
    for (const source of [rail, sidebar]) {
      const inContainer = bellMounts(source).filter((m) => m.includes("onNavigate"));
      expect(inContainer.length).toBeGreaterThan(0);
      for (const mount of inContainer) expect(mount).toMatch(closers);
    }
    // The client shell has exactly one such container; the staff shell has two.
    expect(bellMounts(rail).filter((m) => m.includes("onNavigate"))).toHaveLength(1);
    expect(bellMounts(sidebar).filter((m) => m.includes("onNavigate"))).toHaveLength(2);
    expect(rail).toContain("useCompanySheet");
    expect(sidebar).toContain("useCompanySheet");
  });

  it("runs that callback on navigation, not on dismissing the panel", () => {
    const b = flat(bell);
    // One helper, used by every row and footer link that navigates.
    expect(b).toContain("function closeAfterNavigate() { setOpen(false); onNavigate?.(); }");
    // A same-route link performs no navigation, so nothing but this callback
    // can close the sheet — every navigable element must run it.
    //
    // Task rows used to be a Link with their own onClose here — the Workspace
    // board they opened is gone entirely (2026-08), so TaskAlertRow is a status
    // line now (same F97 × F149 ruling as ReviewJobRow's client branch) and
    // takes no close callback at all: `onClose={closeAfterNavigate}` no longer
    // appears anywhere in this file.
    expect(b).not.toContain("onClose={closeAfterNavigate}");
    // round 6: FOUR now, not three. The meeting action item became a whole-row
    // link (rule 1 — the row was hovering as one surface while only the 11px
    // title inside it was clickable), and the empty state gained the quiet
    // "Open your calendar" link that replaced "All caught up!" with somewhere
    // to go. Both navigate, so both run the one closer.
    expect(b.match(/onClick=\{closeAfterNavigate\}/g) ?? []).toHaveLength(4); // meeting row + calendar + 2 footer
    expect(b).toContain("onNavigate={closeAfterNavigate}"); // review rows
    // Closed loop: every Link in the file runs one of those two handlers left
    // (the row/footer's onClick, or ReviewJobRow's own onNavigate — the one row
    // component still capable of navigating). So no navigable element can close
    // the panel and leave the sheet standing.
    expect(b.match(/<Link\b/g) ?? []).toHaveLength(5); // 4 in the panel + ReviewJobRow's
    expect(b.match(/onClick=\{(closeAfterNavigate|onClose|onNavigate)\}/g) ?? []).toHaveLength(5);

    // Dismissal is NOT navigation: the backdrop closes the panel and leaves the
    // sheet where it was, or a stray tap would tear down the whole sheet.
    expect(b).toContain('<div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />');
  });
});

// The bell reaches the actions barrel for the dismiss write; nothing under test
// calls it, and the barrel is server-only.
vi.mock("@/lib/actions", () => ({ dismissAssignedActionItemAction: async () => {} }));
