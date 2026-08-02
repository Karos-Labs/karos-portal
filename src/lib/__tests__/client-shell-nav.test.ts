import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isStringDelimiter, matchingBrace, matchingParen, skipStringLiteral, stripComments } from "./source-scan";
import { staffMainClass } from "@/components/staff-shell-main";

/**
 * THE CLIENT SHELL AGAINST ITSELF — four findings that are all one question
 * asked in different places: does the thing a client is offered match the thing
 * they get?
 *
 *  · #137 The staff Sidebar carried a client-portal nav path built from
 *    `user.clientId`. The app layout hands a CLIENT_USER the ClientRail only
 *    when `getClient(clientId)` RESOLVES, so the sidebar's client rows render
 *    for exactly one viewer: the client whose id is unset or whose document has
 *    gone. Both rows written for them (`/dashboard` remapped to
 *    `/clients/<id>`, plus a spliced AI Agents into the same subtree) route
 *    through `requireVisibleClient`, which `notFound()`s on precisely that
 *    condition. The branch was not dead — it was the only two 404s in the nav.
 *  · #134/AF-1 /transcripts is a built, client-scoped, `excludeHiddenFromClient`
 *    redacted Meetings page with its own client copy, and the client's own
 *    shell had no way in. #134 answered that with a rail row; the product owner
 *    replaced the row with a Settings tab. Both halves are asserted here: the
 *    rail offers it nowhere, and Settings does.
 *  · #141 One route rendered "AI agents" for clients and "AI Agents" for staff,
 *    while the nav labels leading there said "AI Agents".
 *  · #127 The staff `<main>` reserved 112px of bottom scroll space at phone
 *    width for a tab bar and a copilot strip that only render in client-context
 *    mode.
 *
 * Source assertions read text on purpose: both shells are "use client" modules
 * whose import graph reaches the Admin SDK, so they cannot be imported into a
 * node run (same constraint shell-chrome.test.ts and notification-bell-shell.
 * test.ts work under). Everything read is `stripComments`ed first — this file's
 * subject is prose-heavy, and a rule satisfied by a paragraph is not satisfied.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => stripComments(readFileSync(path.join(REPO, rel), "utf8"));
/** Whitespace-normalised — JSX props reflow, and a line break is not a change. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const SIDEBAR = "src/components/sidebar.tsx";
const RAIL = "src/components/client-rail.tsx";
const AGENTS_PAGE = "src/app/(app)/clients/[id]/agents/page.tsx";
const LAYOUT = "src/app/(app)/layout.tsx";
const SETTINGS_PAGE = "src/app/(app)/clients/[id]/settings/page.tsx";

const sidebar = source(SIDEBAR);
const rail = source(RAIL);

/** A flat route's page module. Every route in play here is a literal segment. */
const pageOf = (route: string) => source(`src/app/(app)${route}/page.tsx`);

/**
 * Does this page turn EVERY CLIENT_USER away — a `redirect()` or `notFound()`
 * governed by an unqualified `user.role === "CLIENT_USER"` test?
 *
 * Unqualified is the whole precision. /team's guard reads
 * `user.role === "CLIENT_USER" && !user.isGroupAdmin`, which is the same
 * condition the sidebar's own filter uses to decide whether to show the row —
 * so /team is a legitimate client row and must not be reported. The pattern
 * below requires the closing paren straight after the role test, so a qualified
 * guard does not match.
 *
 * NOT FOLDED INTO `staffOnlyIfRanges`, whose statement walk this mirrors. That
 * function computes EXEMPTED ranges for its callers, so widening what it counts
 * as a guard makes leaks read as guarded — it fails open. This one computes
 * REPORTED ranges: a range it misses is a route that slips through, so the two
 * want opposite treatment at every edge and sharing the condition would tie
 * them together. The string-literal and brace primitives — the part that is
 * genuinely hard and was got wrong four times — are the shared module's.
 */
function redirectsEveryClient(pageSrc: string): boolean {
  for (const g of pageSrc.matchAll(/if\s*\(\s*user\.role\s*===\s*"CLIENT_USER"\s*\)/g)) {
    let from = g.index! + g[0].length;
    while (from < pageSrc.length && /\s/.test(pageSrc[from]!)) from++;
    let to: number;
    if (pageSrc[from] === "{") {
      to = matchingBrace(pageSrc, from);
      if (to < 0) to = pageSrc.length;
    } else {
      // Brace-less: the single statement that follows, ending at the first `;`
      // or line break outside anything it opened.
      let depth = 0;
      to = from;
      for (; to < pageSrc.length; to++) {
        const ch = pageSrc[to]!;
        if (isStringDelimiter(ch)) {
          to = skipStringLiteral(pageSrc, to);
          continue;
        }
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") depth--;
        else if (depth === 0 && (ch === ";" || ch === "\n")) break;
      }
    }
    const governed = pageSrc.slice(from, to);
    if (governed.includes("redirect(") || governed.includes("notFound(")) return true;
  }
  return false;
}

/**
 * Every flat route the STAFF shell can put in front of a CLIENT_USER, read out
 * of the two places that decide it rather than listed here: the `roles` arrays
 * of the NAV table, and the one row the filter admits outside them.
 */
function staffShellClientRoutes(): string[] {
  const table = sidebar.slice(sidebar.indexOf("const NAV: NavItem[] = ["));
  const nav = table.slice(0, table.indexOf("\n];"));
  const fromRoles = [...nav.matchAll(/\{\s*href:\s*"([^"]+)"[^}]*?roles:\s*\[([^\]]*)\]/g)]
    .filter((m) => m[2]!.includes("CLIENT_USER"))
    .map((m) => m[1]!);
  const extra = [
    ...sidebar.matchAll(/n\.href === "([^"]+)"[^;]*?user\.role === "CLIENT_USER"/g),
  ].map((m) => m[1]!);
  // Non-vacuity for both readers: the table has client rows and the filter has
  // exactly one out-of-table admission (/team for a group admin).
  expect(fromRoles.length).toBeGreaterThan(0);
  expect(extra).toHaveLength(1);
  return [...new Set([...fromRoles, ...extra])];
}

/** Every flat route the CLIENT's own shell offers, nav items and links alike. */
function clientRailRoutes(): string[] {
  return [...rail.matchAll(/href[:=]\s*"(\/[^"]*)"/g)].map((m) => m[1]!);
}

describe("#137 · the staff shell's client rows lead where a client can go", () => {
  it("detects the shape it is looking for, in both directions", () => {
    // The detector, exercised on the two rows this fix removed and on the ones
    // it kept — inside the test, so a pattern that silently matches nothing
    // cannot report the suite green.
    expect(redirectsEveryClient(pageOf("/assets"))).toBe(true); // brace-less form
    expect(redirectsEveryClient(pageOf("/dashboard"))).toBe(true); // braced form
    expect(redirectsEveryClient(pageOf("/transcripts"))).toBe(false);
    // Qualified guard: /team refuses only a client who is not a group admin,
    // which is the same condition the sidebar shows the row under.
    expect(redirectsEveryClient(pageOf("/team"))).toBe(false);
  });

  it("offers a client no route whose page turns a client away", () => {
    const routes = staffShellClientRoutes();
    expect(routes.length).toBeGreaterThan(1);
    for (const route of routes) {
      expect(redirectsEveryClient(pageOf(route)), `${route} refuses a CLIENT_USER`).toBe(false);
    }
  });

  it("builds no nav out of a client id this shell cannot resolve", () => {
    // The mechanical form of #137. This shell renders for a CLIENT_USER only
    // when getClient() came back empty, so ANY route built from `user.clientId`
    // here is a notFound() waiting to happen — the remap and the splice both
    // were. Keyed to the argument, not to their spelling.
    expect(sidebar).not.toMatch(/user\.clientId/);
    // And the client-scoped subtree is reachable from this file only through
    // the STAFF client-view nav, which is gated on isStaff.
    expect(flat(sidebar)).toContain("const clientCtx = isStaff && activeClient ? activeClient : null");
  });

  it("points the wordmark at a page the viewer of this shell can open", () => {
    // /dashboard redirects a CLIENT_USER to /clients/<clientId> — a notFound()
    // for the only client who reaches this shell — or to /assets, which bounces
    // on to /tasks. Both wordmarks go through one binding.
    expect(flat(sidebar)).toContain('const homeHref = isStaff ? "/dashboard" : "/tasks";');
    expect(flat(sidebar).match(/<Link href=\{homeHref\}/g) ?? []).toHaveLength(2);
    // The staff arm of that binding is the file's only other /dashboard href.
    expect(sidebar.match(/href="\/dashboard"/g) ?? []).toHaveLength(0);
  });
});

describe("AF-1 · Meetings is reached from Settings, not from the rail", () => {
  /**
   * #134 put a Meetings row in the client rail. The product owner reversed it:
   * keep the feature, move the door. "I like that in the settings."
   *
   * So the assertions below are the inverse of the ones that stood here, plus
   * the one they never had — that the destination #134 was right about (a
   * built, redacted, client-scoped page) is still reachable. A ruling that
   * removed the row AND the route would be a regression wearing a fix's name.
   */
  const settingsPage = source(SETTINGS_PAGE);

  it("offers no Meetings row at either width", () => {
    expect(clientRailRoutes()).not.toContain("/transcripts");
    // The nav table and the phone bar are one list now, so neither can carry it
    // back on its own.
    expect(flat(rail)).toContain("items={tabNav}");
    expect(flat(rail)).not.toContain("railNav");
    expect(rail).not.toContain("meetingsItem");
  });

  it("keeps the sheet clear of it too, where the rail is display:none", () => {
    const open = rail.indexOf("<MobileCompanySheet");
    const close = rail.indexOf("</MobileCompanySheet>");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(rail.slice(open, close)).not.toContain("/transcripts");
  });

  it("keeps the Settings tab that replaced it", () => {
    // This tab predates the branch — it is where the ruling points, not
    // something built to satisfy it — and it renders the client's own calls,
    // each row opening the transcript. Asserted because it is now the WHOLE of
    // a client's route to their meetings: thin it out and the destination goes
    // with it.
    expect(settingsPage).toContain('{ id: "meetings", label: "Meetings"');
    expect(flat(settingsPage)).toContain("href={`/transcripts/${t.id}`}");
  });

  it("leads to a page that is genuinely built for a client", () => {
    // Unchanged by the move, and the reason the feature was kept at all: the
    // entry would be worse than none if it opened the staff view.
    const page = pageOf("/transcripts");
    expect(page).toContain("excludeHiddenFromClient: true");
    expect(page).toContain("Summaries from your calls with the Karos team.");
  });

  it("leaves no route the staff shell offers a client that their own shell withholds", () => {
    // #137's relation, still enforced, with ONE named exemption.
    //
    // /transcripts is the exemption and AF-1 is the reason: a client's meetings
    // are the Settings tab above, so the route itself is deliberately not in
    // their nav. The staff shell keeps its own Meetings row for CLIENT_USER,
    // and that is not an oversight left behind by the ruling — that shell
    // renders for exactly one client, the one whose client document did not
    // resolve, and that client has no /clients/<id>/settings to reach. Two
    // shells, two correct answers.
    //
    // Named rather than derived: an exemption computed from the settings page's
    // hrefs would grow silently the next time a route is linked from it, which
    // is the opposite of what this relation is for.
    const EXEMPT = new Set(["/transcripts"]);
    const railSide = new Set(clientRailRoutes());
    for (const route of staffShellClientRoutes()) {
      if (EXEMPT.has(route)) continue;
      expect(railSide.has(route), `${route} is offered by the staff shell only`).toBe(true);
    }
    // Non-vacuity in both directions: the exemption is live (the staff shell
    // really does still offer it), it is doing exactly one route's worth of
    // work, and the rail really has stopped offering it.
    expect(staffShellClientRoutes()).toContain("/transcripts");
    expect(railSide.has("/transcripts")).toBe(false);
    expect(staffShellClientRoutes().filter((r) => EXEMPT.has(r))).toHaveLength(1);
  });
});

/* ── AF-3 / AF-17: one look for both views ───────────────────────────────── */

describe("AF-3 · View-as-Client and the client's own view are the same view", () => {
  /**
   * "View as Client (staff) and the real client view must look the same: same
   * favicon, same layout, same palette."
   *
   * The palette is not asserted here and that is deliberate: there is exactly
   * one stylesheet and one set of tokens (app/globals.css), so neither shell
   * can have a palette of its own — the charcoal/paper/orange scheme is the
   * brand system, applied app-wide, and it predates this branch entirely. What
   * CAN drift between the two shells, and did, is the chrome each one builds by
   * hand: the nav table and the wordmark.
   */

  /** The labels of a shell's client-context nav, in order. */
  const navLabels = (src: string, marker: string): string[] => {
    const from = src.indexOf(marker);
    expect(from, `${marker} not found`).toBeGreaterThan(-1);
    const table = src.slice(from, src.indexOf("];", from));
    return [...table.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]!);
  };

  it("offers the same destinations in the same order", () => {
    // The divergence AF-1 closed: the branch put a fifth item (Meetings) in the
    // client's rail and not in the staff twin, so the two views of one client
    // had different navigation.
    const client = navLabels(rail, "const tabNav: NavItem[] = [");
    const staff = navLabels(sidebar, "function clientViewNav(");
    expect(client).toEqual(["Dashboard", "AI agents", "Calendar", "Workspace"]);
    expect(staff).toEqual(client);
  });

  it("carries the same wordmark in both shells", () => {
    // AF-17's half of the parity: the mark at the top of the shell.
    const MARK = 'src="/brand/kairos-head-disc-dark.svg"';
    expect(rail).toContain(MARK);
    expect(sidebar).toContain(MARK);
    // Both mounts in each shell — desktop and phone — not just the first.
    expect(rail.match(/kairos-head-disc-dark\.svg/g) ?? []).toHaveLength(2);
    expect(sidebar.match(/kairos-head-disc-dark\.svg/g) ?? []).toHaveLength(2);
  });

  it("takes its favicon from the one place either view can reach", () => {
    // There is a single root layout and no per-route icon override, so the
    // favicon is a file-convention asset that both shells inherit and neither
    // can diverge from. Asserted as the absence of a second source: an `icons`
    // entry in any route's metadata would be exactly that.
    expect(existsSync(path.join(REPO, "src/app/icon.svg"))).toBe(true);
    expect(existsSync(path.join(REPO, "src/app/apple-icon.png"))).toBe(true);
    for (const rel of ["src/app/layout.tsx", LAYOUT]) {
      expect(source(rel)).not.toContain("icons:");
    }
  });
});

describe("#141 · one destination, one spelling", () => {
  const AGENTS = "AI agents";

  it("heads both branches of the agents route the same way", () => {
    const titles = [...source(AGENTS_PAGE).matchAll(/<PageHeader\s+title="([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(titles).toHaveLength(2); // one client branch, one staff branch
    expect([...new Set(titles)]).toEqual([AGENTS]);
  });

  it("labels every nav row leading there with that same heading", () => {
    // The client rail's own item and the staff shell's client-context twin.
    const labels = [
      ...flat(rail).matchAll(/\/agents`, label: "([^"]+)"/g),
      ...flat(sidebar).matchAll(/\/agents`, label: "([^"]+)"/g),
    ].map((m) => m[1]!);
    expect(labels).toHaveLength(2);
    expect([...new Set(labels)]).toEqual([AGENTS]);
  });
});

describe("#127 · the staff main reserves space only for chrome that is there", () => {
  it("drops the bottom reserve when no client context is active", () => {
    const bare = staffMainClass(false);
    expect(bare).toMatch(/\bpb-6\b/);
    expect(bare).toMatch(/\bmd:pb-8\b/);
    expect(bare).not.toMatch(/\bpb-28\b/);
    expect(bare).not.toMatch(/\bmd:pb-16\b/);
  });

  it("keeps the full reserve when the bar and the strip are on screen", () => {
    const withCtx = staffMainClass(true);
    expect(withCtx).toMatch(/\bpb-28\b/); // copilot strip on the 54px bar
    expect(withCtx).toMatch(/\bmd:pb-16\b/); // strip alone
    expect(withCtx).toMatch(/\blg:pb-8\b/);
  });

  it("changes nothing but the bottom reserve between the two", () => {
    // The over-correction guard: the fix must not quietly take the horizontal
    // padding or the top rhythm with it.
    const withoutBottom = (c: string) =>
      c.split(" ").filter((token) => !/(^|:)pb-/.test(token)).join(" ");
    expect(withoutBottom(staffMainClass(true))).toBe(withoutBottom(staffMainClass(false)));
    expect(withoutBottom(staffMainClass(false))).toContain("pt-6");
    expect(withoutBottom(staffMainClass(false))).toContain("md:pt-8");
  });

  it("keys the reserve to the value both pieces of chrome gate on", () => {
    expect(source("src/components/staff-shell-main.tsx")).toContain("useActiveClient()");
    // The dock: null without a context.
    expect(flat(source("src/components/staff-chatbot-widget.tsx"))).toContain(
      "if (!activeClient) return null;",
    );
    // The bar: mounted only inside the truthy arm of the clientCtx branch.
    const branch = sidebar.indexOf("{clientCtx ? (");
    expect(branch).toBeGreaterThan(-1);
    const armOpen = sidebar.indexOf("(", branch);
    const armClose = matchingParen(sidebar, armOpen);
    expect(armClose).toBeGreaterThan(armOpen);
    const bar = sidebar.indexOf("<MobileTabBar");
    expect(bar).toBeGreaterThan(armOpen);
    expect(bar).toBeLessThan(armClose);
  });

  it("leaves the client shell's own main unconditional", () => {
    // Its bottom bar always renders, so its flat reserve is correct — the whole
    // point of #127 is that the staff copy was not.
    const layout = source(LAYOUT);
    expect(flat(layout)).toContain(
      '<main className="flex-1 overflow-x-clip px-4 pb-28 pt-6 md:px-8 md:pt-8 md:pb-16 lg:pb-8">',
    );
    // …and the staff branch no longer writes a <main> of its own.
    expect(layout.match(/<main\b/g) ?? []).toHaveLength(1);
    expect(layout).toContain("<StaffShellMain>");
  });
});
