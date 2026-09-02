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
const AGENTS_NAV = "src/components/client-rail-agents-nav.tsx";
const AGENTS_PAGE = "src/app/(app)/clients/[id]/agents/page.tsx";
const LAYOUT = "src/app/(app)/layout.tsx";
const SETTINGS_PAGE = "src/app/(app)/clients/[id]/settings/page.tsx";

const sidebar = source(SIDEBAR);
const rail = source(RAIL);
const agentsNav = source(AGENTS_NAV);

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
    // for the only client who reaches this shell — or to /assets, which now
    // bounces on to /calendar (the Workspace board /assets used to land on is
    // gone, 2026-08). Every wordmark goes through one binding.
    //
    // THREE ARMS NOW (parity pass 2026-09, ruling D23). In client context the
    // mark goes where the CLIENT'S mark goes — their own Home — because the
    // agency dashboard is the one destination in this shell that silently drops
    // the context a staff member is standing in. `clientHome` is built from the
    // ACTIVE CLIENT's id, never `user.clientId`, which #137 above still bans.
    expect(flat(sidebar)).toContain(
      'const homeHref = clientHome ?? (isStaff ? "/dashboard" : "/calendar");',
    );
    expect(flat(sidebar)).toContain(
      'const clientHome = clientCtx ? `/clients/${clientCtx.client.id}` : null;',
    );
    // Three mounts: the shared rail/drawer logo, and one mobile top bar in each
    // of the two narrow-width arms.
    expect(flat(sidebar).match(/<Link href=\{homeHref\}/g) ?? []).toHaveLength(3);
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
    expect(flat(settingsPage)).toContain("href={`/transcripts/${t.id}");
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
    // /transcripts is it, and AF-1 is the reason: a client's meetings are the
    // Settings tab above, so the route itself is deliberately not in their nav.
    // The staff shell keeps its own Meetings row for CLIENT_USER, and that is
    // not an oversight left behind by the ruling — that shell renders for
    // exactly one client, the one whose client document did not resolve, and
    // that client has no /clients/<id>/settings to reach. Two shells, two
    // correct answers.
    //
    // /tasks used to be a second exemption — the Workspace board was the one
    // working destination a client with no resolvable client document was left
    // with. The board is gone entirely now (2026-08, locked decision — "The
    // Board is replaced by the action list on Home"), and with it the whole
    // route: the fallback NAV table no longer carries a /tasks row at all, so
    // there is nothing left for the staff shell to offer that the rail could
    // even be asked to match. One exemption, not two.
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
    // Non-vacuity: the exemption is live (the staff shell really does still
    // offer it), it is doing exactly one route's worth of work, and the rail
    // really has stopped offering it — and /tasks is gone from both shells.
    expect(staffShellClientRoutes()).toContain("/transcripts");
    expect(staffShellClientRoutes()).not.toContain("/tasks");
    expect(railSide.has("/transcripts")).toBe(false);
    expect(railSide.has("/tasks")).toBe(false);
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
    //
    // Portal revamp Surface 01: "AI agents" left the client rail's plain
    // `tabNav` array — it renders as ClientRailAgentsNav (starred rows + the
    // roster dropdown) instead, positioned right after Home.
    //
    // IT LEFT THE STAFF TABLE TOO (parity pass 2026-09, ruling D3). The staff
    // nav used to keep it as a plain row on the reasoning that its shell is a
    // "quick-look strip rather than the client's own interactive rail"; the
    // product owner ruled the opposite, so both shells now mount the SAME
    // ClientRailAgentsNav between Home and Calendar and the two label tables
    // are identical rather than merely equivalent.
    const client = navLabels(rail, "const tabNav: NavItem[] = [");
    const staff = navLabels(sidebar, "function clientViewNav(");
    // Workspace is gone from both shells (the locked decision list retires
    // it — "The Board is replaced by the action list on Home").
    expect(client).toEqual(["Home", "Calendar"]);
    expect(staff).toEqual(client);
    // The row that left both tables is a component both shells mount, not a
    // destination either one dropped.
    expect(agentsNav).toContain('<span className="flex-1 text-left">AI agents</span>');
    for (const [rel, src] of [[RAIL, rail], [SIDEBAR, sidebar]] as const) {
      expect(src, `${rel} no longer mounts the agents nav`).toContain("<ClientRailAgentsNav");
    }
  });

  it("carries the same wordmark in both shells", () => {
    // AF-17's half of the parity: the mark at the top of the shell.
    const MARK = 'src="/brand/kairos-head-disc-dark.svg"';
    expect(rail).toContain(MARK);
    expect(sidebar).toContain(MARK);
    // Every mount in each shell — desktop and phone — not just the first. The
    // staff shell has THREE (parity pass 2026-09, ruling D15): the rail/drawer
    // logo, plus a mobile top bar in each of its two narrow-width arms. The
    // client-context arm had no top bar at all before, because the staff shell
    // dropped it along with the hamburger — so a staff member in client view
    // got a phone layout with no wordmark on it and the client got one.
    expect(rail.match(/kairos-head-disc-dark\.svg/g) ?? []).toHaveLength(2);
    expect(sidebar.match(/kairos-head-disc-dark\.svg/g) ?? []).toHaveLength(3);
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

  /* ── V3: the company panel, and the slot it used to sit in ──────────── */

  /**
   * Superseded THREE times over now. V3 originally held ClientProfilePanel,
   * ClientDocuments, CompetitorTrack and BrandColorsSection to an
   * identical-stack rule across both shells. The Account Center pass moved all
   * four out of both rails. Explicit direction then reversed the brand card
   * (ClientProfilePanel), which belongs in the rail prominently rather than
   * collapsed.
   *
   * 2026-08 reverses BRAND COLORS too, by name and for a stated reason: the
   * swatch row is the one thing in the rail a person copies a value OUT of
   * (click-to-copy hex), several times a day, and Account Center is two
   * navigations away from wherever they are working. It is a one-line reader,
   * not a page — the cost the original move was paying down (four stacked
   * sections eating the CD-E3 no-scroll contract) is not a cost a single row
   * carries.
   *
   * So MOVED is down to two, and Brand Colors joins the brand card in a group
   * with the opposite rule: present in BOTH rails and STILL on Account Center,
   * because a one-line reader in the rail and the editor on the settings page
   * are two surfaces, not two copies.
   */
  const MOVED_COMPONENTS = ["ClientDocuments", "CompetitorTrack"];

  /** Reversed by explicit direction — asserted present rather than absent. */
  const RESTORED_COMPONENTS = ["ClientProfilePanel", "BrandColorsSection"];

  it("mounts neither of the two moved sections in either rail any more", () => {
    for (const name of MOVED_COMPONENTS) {
      expect(rail, `client-rail.tsx still mounts <${name}`).not.toContain(`<${name}`);
      expect(sidebar, `sidebar.tsx still mounts <${name}`).not.toContain(`<${name}`);
    }
    // The imports left with the mounts — a stale import is exactly the kind of
    // drift this rule exists to catch before the mount itself reappears.
    for (const name of MOVED_COMPONENTS) {
      expect(rail, `client-rail.tsx still imports ${name}`).not.toContain(name);
      expect(sidebar, `sidebar.tsx still imports ${name}`).not.toContain(name);
    }
  });

  it("keeps Brand Colors in both rails AND on Account Center, on explicit direction", () => {
    // The rail mount is the reversal; the Account Center mount is the build it
    // does NOT revert. Two mounts per shell — desktop aside and phone sheet —
    // the same shape the brand card is held to below, so a staff member
    // previewing a workspace sees what the client sees (AF-3).
    for (const [rel, src] of [[RAIL, rail], [SIDEBAR, sidebar]] as const) {
      const mounts = [...src.matchAll(/<BrandColorsSection[\s\S]*?\/>/g)];
      expect(mounts.length, `${rel} mounts Brand Colors on its rail and in its sheet`).toBe(2);
    }
    expect(source(SETTINGS_PAGE)).toContain("<BrandColorsSection");
  });

  it("re-homes every moved-or-restored section in Account Center, where a client can now reach them", () => {
    // Not a full render test (the page is a server component reaching the
    // Admin SDK, same constraint as the two rails) — a source check that each
    // component actually left the rails FOR here rather than for nowhere, and
    // that the two restored ones did not leave Account Center on the way back.
    const settingsPage = source(SETTINGS_PAGE);
    for (const name of [...MOVED_COMPONENTS, ...RESTORED_COMPONENTS]) {
      expect(settingsPage, `Account Center never mounts <${name}`).toContain(`<${name}`);
    }
  });

  it("keeps the full brand card in both rails, on explicit direction", () => {
    // Reversed after the fact: "restore the full, rich visual brand identity
    // card... without being collapsed into a bare minimal text link." Both
    // rails mount the real ClientProfilePanel again — the desktop aside AND
    // the mobile sheet, in both shells — so the client and a staff member
    // previewing their workspace see the same card (AF-3).
    for (const [rel, src] of [[RAIL, rail], [SIDEBAR, sidebar]] as const) {
      const mounts = [...src.matchAll(/<ClientProfilePanel[\s\S]*?\/>/g)];
      expect(mounts.length, `${rel} mounts the panel on its rail and in its sheet`).toBe(2);
    }
    // It is ALSO still on Account Center's Profile tab — restoring the rail
    // card is additive, not a revert of that build.
    expect(source(SETTINGS_PAGE)).toContain("<ClientProfilePanel");
  });

  /* ── V2: one section rhythm ─────────────────────────────────────────── */

  /* ── V2 (spacing rhythm across the four sections) retired with them —
     both rails are nav-only now, so there is no shared wrapper rhythm left
     to hold two shells to. See V3 above for what replaced the rule. ── */

  /* ── V4: the accent is rationed the same way in both ─────────────────── */

  it("marks the active client-context tab exactly as the client's own rail does", () => {
    // The one genuine colour divergence between the two views of these tabs:
    // the staff shell painted the active row `bg-neon-soft text-neon` while the
    // client's rail paints it paper. Ember rations orange to a single CTA and a
    // nav row is not it.
    //
    // V4 answered that with a ternary in the staff shell — paper in client
    // context, orange in the agency nav — which held the two treatments in
    // step by hand. The parity pass 2026-09 (rulings D5/D6/D11) removed the
    // hand: the row itself is ONE component now, imported by both shells, so
    // there is no second copy of the treatment left to keep in step. Asserted
    // as the import plus the mount, because a shared module nobody renders is
    // not a shared row.
    const NAV_LINK = 'from "@/components/rail-nav-link"';
    for (const [rel, src] of [[RAIL, rail], [SIDEBAR, sidebar]] as const) {
      expect(src, `${rel} does not import the shared nav row`).toContain(NAV_LINK);
      expect(src, `${rel} imports the shared nav row but renders its own`).toMatch(/<NavLink\b/);
      // The give-away that a shell has started painting rows by hand again.
      expect(src, `${rel} declares a NavLink of its own`).not.toMatch(/function NavLink\b/);
    }
    // And the shared row paints the active state in paper, in one place.
    const shared = source("src/components/rail-nav-link.tsx");
    const sharedActive = shared.match(/active\s*\?\s*"([^"]+)"\s*:\s*"text-muted hover:bg-surface-2/);
    expect(sharedActive?.[1]).toBe("bg-surface-2 text-foreground");
    expect(shared).not.toContain("bg-neon-soft");
    // The agency nav keeps the orange highlight — the only nav a client never
    // sees, and the one this ruling deliberately leaves alone.
    expect(flat(sidebar)).toContain(
      'const activeRowClass = "bg-neon-soft text-neon shadow-[inset_0_0_0_1px_rgba(255,107,44,0.15)]";',
    );
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
    // ONE label, in one file, for both shells (parity pass 2026-09, ruling D3).
    // The staff shell used to spell it out again in its own nav table — a
    // second literal that could be re-capitalised without anything noticing,
    // which is the whole of #141 — and now mounts ClientRailAgentsNav like the
    // client's rail does, so the dropdown button below is the only nav row
    // leading there in either shell.
    const labels = [
      ...flat(agentsNav).matchAll(/<span className="flex-1 text-left">([^<]+)<\/span>/g),
      ...flat(sidebar).matchAll(/\/agents`, label: "([^"]+)"/g),
    ].map((m) => m[1]!);
    expect(labels).toHaveLength(1);
    expect([...new Set(labels)]).toEqual([AGENTS]);
    // Non-vacuity for the half that went to zero: the staff shell dropped the
    // literal because it mounts the component, not because it dropped the row.
    expect(sidebar).toContain("<ClientRailAgentsNav");
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
    // The bar: mounted only inside the truthy arm of a clientCtx branch.
    //
    // FOUND BY CONTAINMENT, not by position (parity pass 2026-09). The shell
    // branches on `clientCtx` three times now — the rail body, the rail footer
    // and the narrow-width arm — because in client context all three ARE the
    // client's, not staff variants of them. Taking the first occurrence would
    // pin this rule to whichever branch happens to be written first.
    const branches = [...sidebar.matchAll(/\{clientCtx \? \(/g)];
    expect(branches.length).toBeGreaterThan(0);
    const bar = sidebar.indexOf("<MobileTabBar");
    expect(bar).toBeGreaterThan(-1);
    const inTruthyArm = branches.some((m) => {
      const armOpen = m.index! + m[0]!.length - 1; // the `(` the arm opens with
      const armClose = matchingParen(sidebar, armOpen);
      return armClose > armOpen && bar > armOpen && bar < armClose;
    });
    expect(inTruthyArm, "<MobileTabBar renders outside every clientCtx arm").toBe(true);
    // Exactly one bar, so "inside a truthy arm" is the whole of its condition.
    expect(sidebar.match(/<MobileTabBar\b/g) ?? []).toHaveLength(1);
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
