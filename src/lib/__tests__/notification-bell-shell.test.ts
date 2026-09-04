import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ReviewJobRow } from "@/components/notification-bell";
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
    expect(b.match(/onClick=\{closeAfterNavigate\}/g) ?? []).toHaveLength(3); // transcript + 2 footer
    expect(b).toContain("onNavigate={closeAfterNavigate}"); // review rows
    // Closed loop: every Link in the file runs one of those two handlers left
    // (the footer/transcript's onClick, or ReviewJobRow's own onNavigate — the
    // one row component still capable of navigating). So no navigable element
    // can close the panel and leave the sheet standing.
    expect(b.match(/<Link\b/g) ?? []).toHaveLength(4); // 3 in the panel + ReviewJobRow's
    expect(b.match(/onClick=\{(closeAfterNavigate|onClose|onNavigate)\}/g) ?? []).toHaveLength(4);

    // Dismissal is NOT navigation: the backdrop closes the panel and leaves the
    // sheet where it was, or a stray tap would tear down the whole sheet.
    expect(b).toContain('<div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />');
  });
});

// The bell reaches the actions barrel for the dismiss write; nothing under test
// calls it, and the barrel is server-only.
vi.mock("@/lib/actions", () => ({ dismissAssignedActionItemAction: async () => {} }));
