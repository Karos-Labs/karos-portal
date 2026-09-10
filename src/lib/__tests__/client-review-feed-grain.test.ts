import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NotificationBell } from "@/components/notification-bell";
import { visibleActionItems,
  actionItemKey,
  reviewFeedRows,
  unreadNotificationCount,
} from "@/lib/notification-rows";
import { resolveMaxJobs } from "@/lib/runway";
import { stripComments } from "./source-scan";
import type { ActionItemNotification, AgentReviewNotification } from "@/lib/types";

/**
 * THE CLOSED QUESTION: can a client-facing feed ever render more than one row
 * per generation batch?
 *
 * A runway sweep tops one client up with a whole horizon of jobs inside a
 * minute, and every one lands in `review`. Rendered per job, that is a column
 * of identically-stamped rows on the chrome of EVERY page — the plainest
 * statement the product could make that a fortnight of content came out of one
 * fire (A3/A4). data.ts said exactly this in a comment and then applied a cap
 * of 15 to a batch of 14, so the scenario the comment described was entirely
 * unmitigated.
 *
 * The batch size below is READ FROM THE DEPLOY, not typed here: cloudbuild.yaml
 * substitutes RUNWAY_MAX_JOBS_PER_CLIENT on every release and runway.ts's own
 * `resolveMaxJobs` turns it into the number the sweep uses. The row count is
 * asked of the feed builder. Neither end of the comparison is a literal.
 *
 * A cap is deliberately NOT the thing under test. Capping cannot answer this
 * question — a cap that bites still yields several same-stamped rows — so the
 * assertions below hold at every size, on both sides of the payload bound
 * data.ts keeps. That is strictly stronger than "the cap is lower than the
 * batch", and it cannot rot the way that comparison did.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** Comment-stripped, so prose in a docstring cannot satisfy a source assertion. */
const code = (rel: string) => stripComments(read(rel));

const BELL = "src/components/notification-bell.tsx";
const RAIL = "src/components/client-rail.tsx";
const SIDEBAR = "src/components/sidebar.tsx";
const DATA = "src/lib/data.ts";

/** Jobs one runway sweep dispatches for one client, as the deploy configures it. */
function deployedBatchSize(): number {
  const yaml = read("cloudbuild.yaml");
  const raw = yaml.match(/^\s*_RUNWAY_MAX_JOBS_PER_CLIENT:\s*"(\d*)"/m)?.[1];
  // Empty substitution hands the decision back to the code default, which is
  // what resolveMaxJobs returns for undefined.
  return resolveMaxJobs(raw === "" ? undefined : raw);
}

/** The payload bound data.ts keeps on the client review feed. */
function clientFeedCap(): number {
  const src = code(DATA);
  const start = src.indexOf("export async function listReviewJobs(");
  const end = src.indexOf("export async function listReviewJobsForClients(", start);
  const body = src.slice(start, end);
  const cap = body.match(/\.slice\(0, opts\?\.limit \?\? (\d+)\)/)?.[1];
  return Number(cap);
}

/** One sweep's worth of review jobs, minted seconds apart like the real thing. */
function sweep(n: number): AgentReviewNotification[] {
  const stamp = Date.UTC(2026, 7, 1, 9, 14);
  return Array.from({ length: n }, (_, i) => ({
    jobId: `job-${i}`,
    title: `Post ${i + 1}`,
    agentName: "Social posts",
    updatedAt: stamp + i * 1000,
    clientId: "client-1",
  }));
}

function renderBell(opts: { viewerIsClient: boolean; jobs: AgentReviewNotification[] }): string {
  return renderToStaticMarkup(
    createElement(NotificationBell, {
      actionItems: [],
      reviewJobs: opts.jobs,
      taskAlerts: [],
      viewerIsClient: opts.viewerIsClient,
      dismissals: { dismissed: new Set<string>(), dismiss: () => {} },
    }),
  );
}


/** Every `<NotificationBell …/>` element in a file, whitespace-normalised. */
function bellMounts(source: string): string[] {
  const flat = source.replace(/\s+/g, " ");
  return [...flat.matchAll(/<NotificationBell\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

/**
 * The VALUE a JSX boolean prop carries at a mount, normalised — `p`, `p={true}`
 * and `p={x}` are three spellings of the same question and only the value
 * decides anything. Returns null when the prop is absent.
 */
function jsxPropValue(mount: string, name: string): string | null {
  const m = new RegExp(`\\b${name}(?:=\\{([^}]*)\\}|="([^"]*)")?`).exec(mount);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "true").trim();
}

describe("a client's review feed renders no rows at all, whatever the batch", () => {
  // round 6: the collapse became a removal. One stampless summary row answered
  // the batch tell (#118) and left an inert row behind — it named work, carried
  // no count and led nowhere, because nothing a client can open lists a draft.
  // Albert's ruling is that every notification row must lead somewhere, so the
  // fact stays on Home's attention card ("N deliverables in review"), where the
  // count and the rows can sit together, and the bell stops carrying it.
  //
  // The questions below are unchanged in SHAPE: they still hold at every batch
  // size and on both sides of the payload bound data.ts keeps, so neither end of
  // the comparison is a literal and neither can rot.
  it("renders nothing for a whole deployed sweep", () => {
    const batch = deployedBatchSize();
    expect(batch, "a sweep of one makes this test vacuous").toBeGreaterThan(1);

    expect(reviewFeedRows(sweep(batch), { viewerIsClient: true })).toEqual([]);
  });

  it("holds on both sides of the payload cap, so the cap decides nothing", () => {
    const cap = clientFeedCap();
    expect(cap, `${DATA} no longer bounds the client review feed`).toBeGreaterThan(0);
    for (const n of [1, deployedBatchSize(), cap, cap * 4]) {
      expect(
        reviewFeedRows(sweep(n), { viewerIsClient: true }),
        `${n} jobs in review`,
      ).toHaveLength(0);
    }
    expect(reviewFeedRows([], { viewerIsClient: true })).toHaveLength(0);
  });

  it("leaves staff the per-job rows they actually work from", () => {
    // The over-apply this must not become: the batch shape is the agency's own
    // machinery, and a reviewer needs the job, its stamp and its /jobs link.
    const batch = deployedBatchSize();
    const rows = reviewFeedRows(sweep(batch), { viewerIsClient: false });
    expect(rows).toHaveLength(batch);
    expect(rows.map((r) => r.kind)).toEqual(Array(batch).fill("job"));
  });

  it("does not move the badge on every page at all, let alone by a fortnight", () => {
    // The badge is chrome: it is on screen before anything is opened, so a
    // number that tracks the batch publishes the batch by itself. round 6: with
    // no client row to count, a sweep moves a client's badge by zero and the
    // bell shows no badge at all.
    const batch = deployedBatchSize();
    expect(renderBell({ viewerIsClient: true, jobs: sweep(batch) })).toContain(
      'aria-label="Notifications"',
    );
    expect(renderBell({ viewerIsClient: false, jobs: sweep(batch) })).toContain(
      `aria-label="Notifications (${batch} unread)"`,
    );
    expect(renderBell({ viewerIsClient: true, jobs: [] })).toContain('aria-label="Notifications"');
  });

  it("is reached by every bell the client shell mounts", () => {
    // The collapse is keyed to the viewer, so a mount that forgets to say who
    // is looking silently un-fixes this. The client rail is the client shell:
    // its mounts must answer "true", not merely mention the prop.
    const mounts = bellMounts(code(RAIL));
    expect(mounts.length).toBeGreaterThan(0);
    for (const mount of mounts) expect(jsxPropValue(mount, "viewerIsClient")).toBe("true");

    // The staff shell serves both — a CLIENT_USER with no clientId falls
    // through to it — so its mounts must carry the role-derived answer rather
    // than a hard-wired off.
    const sidebar = code(SIDEBAR);
    // KEYED TO THE WHOLE DECLARATION, not to a prefix of it. `toContain` on the
    // opening of the line is satisfied by
    // `const viewerIsClient = user.role === "CLIENT_USER" && false;` — a real
    // defect, because the app layout falls through to Sidebar for a CLIENT_USER
    // whose `getClient` returns null, and that viewer's feeds are NOT empty.
    // Anchored on the statement's own terminator so nothing can be appended to
    // the test it passes.
    expect(sidebar, "the staff shell no longer derives the viewer's role").toMatch(
      /const viewerIsClient = user\.role === "CLIENT_USER";/,
    );
    const staffMounts = bellMounts(sidebar);
    expect(staffMounts.length).toBeGreaterThan(0);
    for (const mount of staffMounts) {
      expect(jsxPropValue(mount, "viewerIsClient")).toBe("viewerIsClient");
    }
  });
});

const ITEM_A: ActionItemNotification = {
  transcriptId: "t-1",
  transcriptTitle: "Kickoff",
  itemIndex: 0,
  text: "Send the brand deck",
  meetingDate: Date.UTC(2026, 6, 30),
  clientId: "client-1",
};
const ITEM_B: ActionItemNotification = { ...ITEM_A, itemIndex: 1, text: "Book the shoot" };

/**
 * #105 — dismissing a row used to decrement the bell and leave the badge that
 * summoned it standing. Three surfaces added the three feeds up independently
 * (the bell's own badge, the client rail's mobile tab dot, the staff sidebar's
 * avatar + hamburger dots) and only the bell subtracted the viewer's
 * dismissals. The rule is now written once and asked three times.
 */
describe("one dismissal, one count", () => {
  it("subtracts a dismissed item from the number every badge prints", () => {
    const feeds = { actionItems: [ITEM_A, ITEM_B], reviewJobs: [], taskAlerts: [] };
    expect(
      unreadNotificationCount(feeds, { viewerIsClient: true, dismissed: new Set() }),
    ).toBe(2);
    expect(
      unreadNotificationCount(feeds, {
        viewerIsClient: true,
        dismissed: new Set([actionItemKey(ITEM_A)]),
      }),
    ).toBe(1);
  });

  it("keys the dismissal to the item, so a sibling index survives it", () => {
    // Both items live on one transcript; a key that dropped the index would
    // clear the whole meeting from the feed on one click.
    expect(actionItemKey(ITEM_A)).not.toBe(actionItemKey(ITEM_B));
  });

  it("is the only derivation left in the bell or either shell", () => {
    for (const rel of [BELL, RAIL, SIDEBAR]) {
      const src = code(rel);
      expect(src, `${rel} no longer asks for the shared count`).toContain(
        "unreadNotificationCount(",
      );
      // The shape that caused it, not the symptom: any hand-rolled sum over the
      // feeds. Comment-stripped, so the explanation above a fix cannot pass it.
      expect(src.match(/(actionItems|reviewJobs|taskAlerts)\.length\s*\+/) ?? null, rel).toBeNull();
    }
  });

  it("hands one set to every bell a shell mounts", () => {
    for (const rel of [RAIL, SIDEBAR]) {
      const src = code(rel);
      // One set per shell — two would be two answers again.
      expect(src.match(/useNotificationDismissals\(\)/g) ?? [], rel).toHaveLength(1);
      const mounts = bellMounts(src);
      expect(mounts.length, rel).toBeGreaterThan(0);
      for (const mount of mounts) expect(jsxPropValue(mount, "dismissals")).toBe("dismissals");
    }
    // And no mount may skip it: the prop is required, so tsc — not this file —
    // is what actually stops a new bell being wired to its own private set.
    expect(code(BELL)).toContain("dismissals: NotificationDismissals;");
  });
});

// The bell reaches the actions barrel for the dismiss write; nothing under test
// calls it, and the barrel is server-only.
vi.mock("@/lib/actions", () => ({ dismissAssignedActionItemAction: async () => {} }));


/**
 * #105's OTHER HALF. The count side was guarded; the LIST side was not.
 *
 * `visibleActionItems(actionItems, dismissed)` took an OPTIONAL set, so
 * `visibleActionItems(actionItems)` compiled, ran, and left every test green —
 * and that is #105 in mirror image: the badge and both shell dots subtract the
 * dismissal (they route through `unreadNotificationCount`, which passes the set)
 * while the dismissed row stays on screen in the panel. A count and a list
 * disagreeing about one dismissal is the finding, whichever side drops it.
 *
 * The real repair is that BOTH parameters are now required, so an omission is a
 * compile error rather than a silent half-fix — the compiler is the guard and
 * these assertions are the behaviour behind it.
 */
describe("a dismissal reaches the list, not only the count", () => {
  const items = [
    { transcriptId: "t1", itemIndex: 0, text: "Send the brief", clientId: "c1", meetingTitle: "Kickoff", createdAt: 1 },
    { transcriptId: "t1", itemIndex: 1, text: "Approve the draft", clientId: "c1", meetingTitle: "Kickoff", createdAt: 2 },
  ] as unknown as Parameters<typeof visibleActionItems>[0];

  it("drops a dismissed row from the list", () => {
    const key = actionItemKey(items[0]!);
    expect(visibleActionItems(items, new Set([key])).map((n) => n.text)).toEqual([
      "Approve the draft",
    ]);
  });

  it("keeps every row when nothing is dismissed", () => {
    expect(visibleActionItems(items, new Set()).length).toBe(2);
  });

  it("moves the count and the list by the SAME dismissal", () => {
    // The closed question: not "does each side work" but "do they agree". They
    // disagreed by exactly one, silently, for as long as the set was optional.
    const key = actionItemKey(items[0]!);
    const feeds = { actionItems: [...items], reviewJobs: [], taskAlerts: [] };
    const before = unreadNotificationCount(feeds, { viewerIsClient: true, dismissed: new Set() });
    const after = unreadNotificationCount(feeds, { viewerIsClient: true, dismissed: new Set([key]) });
    expect(before - after).toBe(1);
    expect(
      visibleActionItems(items, new Set()).length - visibleActionItems(items, new Set([key])).length,
    ).toBe(1);
  });
});


/**
 * THE FOOTER RULE HAD NO ASSERTION AT ALL.
 *
 * `showWorkspaceLink = taskAlerts.length > 0 || (reviewRows.length > 0 && !viewerIsClient)`
 * was the mechanical form of the comment above it: for a CLIENT the drafts
 * those review rows stand for are provably not on any screen they can open, so
 * the footer must not offer a destination for them. Dropping `&& !viewerIsClient`
 * restored "View workspace →" under a client's summary row — the dead end the
 * comment claimed to close — and nothing in the diff noticed.
 *
 * RENAMED AND NARROWED 2026-08: the Workspace board is gone entirely, so the
 * task-alert half of the OR (task alerts always had a board link, for either
 * viewer) has nothing left to link to — TaskAlertRow is a status line now, same
 * ruling as ReviewJobRow's client branch. `showJobsLink` is what remains: a
 * staff-only link to `/jobs`, the aggregate review queue these AgentReviewNotification
 * rows are drawn from. The viewer gate this test exists to pin is now the WHOLE
 * expression rather than half of an OR, but it is exactly as easy to silently
 * drop, so it is still asked here rather than assumed.
 *
 * Read off the assignment's own right-hand side rather than the file, because
 * `viewerIsClient` appears a dozen times in this component.
 */
describe("the bell offers a client no destination for work they cannot open", () => {
  it("gates the jobs link on the viewer, not only on the review rows", () => {
    const bell = code(BELL);
    const at = bell.indexOf("const showJobsLink");
    expect(at, "showJobsLink is gone — the footer rule moved").toBeGreaterThan(-1);
    const rhs = bell.slice(bell.indexOf("=", at) + 1, bell.indexOf(";", at));
    // Viewer-conditioned: a client's whole review queue collapses to one
    // stampless summary row with no /jobs to offer them.
    expect(rhs, "a client is offered a jobs link for review rows again").toMatch(
      /reviewRows[\s\S]*!viewerIsClient|!viewerIsClient[\s\S]*reviewRows/,
    );
  });
});
