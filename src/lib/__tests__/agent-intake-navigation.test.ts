import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  clientArchiveLink,
  intakeAnchorId,
  intakePageAction,
  intakeRowHref,
  intakeSeatAnchorId,
} from "@/lib/agent-intake-links";
import {
  isStringDelimiter,
  matchingBrace,
  matchingParen,
  skipStringLiteral,
  stripComments,
} from "./source-scan";
import type { AgentIntake, ClientSeat } from "@/lib/types";

vi.mock("server-only", () => ({}));

const { toAgentInputRows } = await import("@/lib/agent-detail-sections");

/**
 * The three navigation defects on the intake cluster, and the pairing that keeps
 * the first one fixed.
 *
 *  #85 THE BAND TOLD THE READER TO OPEN ROWS THAT WERE NOT LINKS. "Open any of
 *      them to change what it knows" sat above plain `<li>`s with a
 *      `hover:border-neon/40` and nothing to click; the one real link went to the
 *      top of the intake page with nothing identifying the row. Every row is now
 *      a Link to its own card — and the interesting half is not that the Link
 *      exists but that its target EXISTS: a hash matching no element scrolls
 *      nowhere and raises nothing, which is a dead end that looks like a fix. So
 *      the anchor is derived on both sides from the row's own id, and this file
 *      walks the real row set of every family and asserts the matching card
 *      renders that anchor.
 *
 *  #90 STAFF WERE SENT TO A CLIENT-SHAPED URL. `?tab=` is read only by
 *      ProgressView, and TasksBody mounts ProgressView only with a client in
 *      scope — so the hard-coded `/tasks?tab=archive` on all three staff-reachable
 *      intake pages dropped a staff viewer onto the cross-client board with no
 *      archive at all.
 *
 *  #82 "RUN THE AGENT →" LANDED A CLIENT ON THE ONE PAGE BUILT TO HAVE NO RUN
 *      BUTTON. Fixed per role, which is why the decision is a pure function
 *      asked here rather than a ternary in three page bodies.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");
/** The component that owns one family's intake surface — named by the family. */
const surfaceOf = (family: AgentIntake["agent"]) => `src/components/${family}-agent-intake.tsx`;

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function makeSeat(overrides: Partial<ClientSeat> = {}): ClientSeat {
  return {
    id: "seat-1",
    clientId: "c1",
    name: "Maya Cohen",
    slug: "maya-cohen",
    createdBy: "uid-staff",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeIntake(overrides: Partial<AgentIntake> = {}): AgentIntake {
  return {
    id: "intake-1",
    clientId: "c1",
    agent: "x",
    seatId: null,
    handle: "@karoslabs",
    offLimits: "No politics",
    roster: [],
    createdBy: "uid-staff",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/* ───────────── keying an assertion to an ELEMENT, not to a file ─────────── */

/**
 * WHY THIS SECTION EXISTS. Every defect in this file is "the control goes
 * somewhere the copy does not promise", and every one of them is invisible to
 * `expect(wholeFile).toContain(x)` — two of those on one file say the two
 * strings are both SOMEWHERE in it, never that they are on the same element.
 * That is not a hypothetical: with `intakePageAction(...)` still called and
 * `{action.label}` still rendered, putting `/clients/${id}/agents` back on the
 * anchor left this whole file green, which is #82 shipping again behind a
 * resolver. So the assertions below are keyed to the element's own delimiters.
 */

/**
 * The index of the `>` that ends the opening tag starting at `at`, or -1.
 *
 * Braces and string literals are skipped whole, so a `>` inside an expression
 * (`{a > b}`) or inside a className cannot end the tag early and hand the caller
 * a truncated attribute list to assert over.
 */
function openingTagEnd(code: string, at: number): number {
  for (let i = at; i < code.length; i++) {
    const ch = code[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(code, i);
      continue;
    }
    if (ch === "{") {
      const brace = matchingBrace(code, i);
      if (brace < 0) return -1;
      i = brace;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

/** The element `<name …>` opening at `at`: its opening tag, and its children. */
function elementAt(code: string, name: string, at: number): { tag: string; body: string } | null {
  const gt = openingTagEnd(code, at);
  if (gt < 0) return null;
  const end = code.indexOf(`</${name}>`, gt);
  if (end < 0) return null;
  return { tag: code.slice(at, gt + 1), body: code.slice(gt + 1, end) };
}

/** Where `<name` opens, on or after `from` — the tag itself, not a longer one starting with it. */
function elementOpensAt(code: string, name: string, from = 0): number {
  const re = new RegExp(`<${name}(?=[\\s/>])`, "g");
  re.lastIndex = from;
  return re.exec(code)?.index ?? -1;
}

/**
 * The anchor ENCLOSING each occurrence of a rendered expression — found from the
 * thing it renders rather than from a class string (owned by the design tokens,
 * and worn by other anchors on these pages) or a character distance.
 *
 * ONE ENTRY PER OCCURRENCE, and `null` for an occurrence that sits inside no
 * anchor at all. Taking the first occurrence only would be a guard that a SECOND
 * copy of the label, pasted onto a hard-coded link, walks straight past.
 */
function anchorsRendering(code: string, child: string): Array<{ tag: string; body: string } | null> {
  const out: Array<{ tag: string; body: string } | null> = [];
  const opens = [...code.matchAll(/<a(?=[\s/>])/g)].map((m) => m.index);
  for (let at = code.indexOf(child); at >= 0; at = code.indexOf(child, at + child.length)) {
    const open = opens.filter((i) => i < at).at(-1);
    const el = open === undefined ? null : elementAt(code, "a", open);
    out.push(el && el.body.includes(child) ? el : null);
  }
  return out;
}

/**
 * Every `href=` value on one opening tag, delimiter-matched rather than
 * regex-terminated so a template literal's `${…}` cannot truncate the value and
 * make a hard-coded URL read as something else.
 *
 * Returned as a LIST so the assertion can say "exactly this one href" — a second
 * href attribute is a different list, and an absent one is the empty list.
 */
function hrefValues(tag: string): string[] {
  const out: string[] = [];
  for (const m of tag.matchAll(/\bhref\s*=\s*/g)) {
    const at = m.index + m[0].length;
    if (tag[at] === "{") {
      const close = matchingBrace(tag, at);
      out.push(close > at ? tag.slice(at, close + 1) : tag.slice(at));
      continue;
    }
    if (isStringDelimiter(tag[at])) {
      const close = skipStringLiteral(tag, at);
      out.push(close > at ? tag.slice(at, close + 1) : tag.slice(at));
      continue;
    }
    out.push(tag.slice(at));
  }
  return out;
}

/* ───────────────────────── #85: the anchors pair up ─────────────────────── */

describe("intake row anchors", () => {
  it("composes a seat's anchor exactly as the band composes its row id", () => {
    // toAgentInputRows mints `seat-${seat.id}`. If the two spellings ever come
    // apart the band links to `#intake-abc` while the card renders
    // `#intake-seat-abc`, and the browser scrolls nowhere without erroring —
    // the silent failure this pairing exists to make loud.
    expect(intakeSeatAnchorId("abc")).toBe(intakeAnchorId("seat-abc"));
    const rows = toAgentInputRows({
      agent: "x",
      company: null,
      seats: [makeSeat({ id: "abc" })],
      intake: [],
      news: [],
      takes: [],
    });
    const seatRow = rows.find((r) => r.id.startsWith("seat-"));
    expect(seatRow?.id).toBe("seat-abc");
    expect(intakeAnchorId(seatRow!.id)).toBe(intakeSeatAnchorId("abc"));
  });

  it("prefixes the anchor, so an ordinary word cannot be claimed twice", () => {
    expect(intakeAnchorId("company")).toBe("intake-company");
    expect(intakeRowHref("/clients/c1/x-agent", "news")).toBe(
      "/clients/c1/x-agent#intake-news",
    );
  });
});

/**
 * Does the surface render an ELEMENT whose `id` is the anchor for this row?
 *
 * IT MUST BE AN `id=`, and that is the whole correction. This asked only whether
 * the composing CALL appeared anywhere in RAW source — so both anchors could be
 * changed from `id={intakeAnchorId("news")}` to `data-anchor={…}`, or deleted
 * outright with the references left alive in a JSX comment, and the suite stayed
 * 16/16 green. A hash matching no element scrolls nowhere and raises nothing,
 * which is the dead end this file's own header says it exists to catch.
 *
 * Comments are stripped for the same reason: x-agent-intake.tsx carries a comment
 * naming `intakeAnchorId` eleven lines above the real anchors, so a scan over raw
 * text is satisfied by prose describing the thing it is looking for.
 */
function anchorRendered(raw: string, rowId: string): boolean {
  const src = stripComments(raw);
  // A seat's id is a Firestore id, so the anchor can only be matched as the CALL
  // that composes it — but it must still be the value of an `id` attribute.
  const expr = rowId.startsWith("seat-")
    ? String.raw`intakeSeatAnchorId\(\s*seat\.id\s*\)`
    : String.raw`intakeAnchorId\(\s*"${rowId}"\s*\)`;
  return new RegExp(String.raw`\bid=\{\s*${expr}\s*\}`).test(src);
}

describe("#85 — every row the band paints has somewhere to land", () => {
  /** The fullest row set each family can produce. */
  const cases: Array<{ family: AgentIntake["agent"]; rows: string[] }> = (
    ["x", "linkedin", "reddit"] as const
  ).map((family) => ({
    family,
    rows: toAgentInputRows({
      agent: family,
      company: makeIntake({ agent: family }),
      seats: [makeSeat()],
      intake: [makeIntake({ id: "i2", agent: family, seatId: "seat-1" })],
      news: [
        { id: "n1", clientId: "c1", title: "Series A", date: "2026-07-20", createdBy: "u", createdAt: NOW },
      ],
      takes: [
        { id: "t1", clientId: "c1", seatId: "seat-1", take: "Agents are the new SaaS", date: "2026-07-25", createdBy: "u", createdAt: NOW },
      ],
      directionRequests: [
        { id: "d1", clientId: "c1", account: "company", request: "Build up to the launch", date: "2026-08-04", status: "open", createdBy: "u", createdAt: NOW },
      ],
    }).map((row) => row.id),
  }));

  it("reads a non-empty row set for each family", () => {
    // Non-vacuity: an empty row list would make the sweep below assert nothing.
    // LinkedIn is 4 as of v2: company, the seat, the shared news drop, and its
    // own "what to cover next" steering wheel.
    expect(cases.map((c) => c.rows.length)).toEqual([4, 4, 1]);
  });

  for (const { family, rows } of cases) {
    it(`renders the anchor for every ${family} row on ${surfaceOf(family)}`, () => {
      const src = read(surfaceOf(family));
      const missing = rows.filter((rowId) => !anchorRendered(src, rowId));
      expect(missing, `${surfaceOf(family)} paints no anchor for these rows`).toEqual([]);
    });
  }

  it("builds each row's link from the row id, in the band itself", () => {
    const code = stripComments(read("src/components/client-agents/agent-sections.tsx"));
    const at = code.indexOf("view.rows.map(");
    expect(at).toBeGreaterThan(-1);
    const end = matchingParen(code, code.indexOf("(", at));
    const block = code.slice(at, end);
    // A Link per row — and the assertions are keyed to that Link's own opening
    // tag, not to the map body. Three `toContain`s on the block would pass with
    // the href on one element and the hover border on another, which is the
    // exact state #85 was: a `hover:border-neon/40` on something that was not
    // the link.
    // TWO ROW SHAPES SINCE AF-7, and #85's rule has to hold for both. A row with
    // saved answers is a `<details>` that shows them in place and carries the
    // per-row link inside its expansion; a row with nothing saved is still the
    // plain Link straight to its own card on the form, which is the case #85 was
    // actually about (a client with four empty seats clicked the empty seat and
    // got nothing).
    const linkAt = elementOpensAt(block, "Link");
    expect(linkAt, "the band paints no <Link> per row").toBeGreaterThan(-1);

    // EVERY per-row link, not just the first: two shapes means two links, and a
    // rule that only held for whichever came first in the file is the shape the
    // original finding had.
    const links: string[] = [];
    for (let at = linkAt; at > -1; at = elementOpensAt(block, "Link", at + 1)) {
      const link = elementAt(block, "Link", at);
      expect(link, "a row's <Link> never closes").not.toBeNull();
      links.push(link!.tag);
    }
    expect(links.length, "both row shapes carry a link").toBeGreaterThanOrEqual(2);
    for (const tag of links) {
      // Derived through the shared function — not a hand-built hash, and not the
      // bare page href every row used to share.
      expect(hrefValues(tag)).toEqual(["{intakeRowHref(view.href, row.id)}"]);
    }

    // The hover that made the old `<li>`s look clickable is on the thing that IS
    // clickable — the Link on the plain branch, the `<details>` on the
    // disclosure branch. Asserted as a count over the row block so neither shape
    // can lose it, and so it cannot drift onto some inner span again.
    //
    // round 6: the hand-written `hover:border-neon/40` is the shared `row-lift`
    // utility now (globals.css) — one fill step plus the accent hairline, the
    // one hover a bordered interactive row gets portal-wide (rule 3).
    const hovers = block.match(/row-lift/g) ?? [];
    expect(hovers.length, "each row shape wears the hover affordance").toBe(2);
    const detailsAt = elementOpensAt(block, "details");
    expect(detailsAt, "the answers row is not a disclosure").toBeGreaterThan(-1);
    expect(
      elementAt(block, "details", detailsAt)!.tag,
      "the disclosure is not the thing that looks clickable",
    ).toContain("row-lift");
    expect(
      links.some((tag) => tag.includes("row-lift")),
      "the plain row's link is not the thing that looks clickable",
    ).toBe(true);
  });
});

/* ─────────────────────── #90: the archive a reader reaches ──────────────── */

describe("#90 — the archive link resolves for the viewer who is reading it", () => {
  it("sends each reader to the calendar archive their own route reaches", () => {
    // THE ARCHIVE IS A CALENDAR VIEW (portal feedback round 2, 2026-09):
    // "Archive does not need to be in settings, it's in the calendar." It was
    // Account Center's `?tab=archive` before this pass and the Workspace
    // board's `/tasks?tab=archive` before that — one list, three homes, which
    // is why every caller asks the helper instead of spelling a URL.
    //
    // Two routes to the one view, split the way every other calendar link in
    // the app splits: the flat route scopes itself to the viewer's own client,
    // so it is a CLIENT's own calendar and STAFF's cross-client overview —
    // which has no single archive to show.
    //
    // TWO LABELS since the flow audit (2026-09, R7 · GOV.UK "do not use
    // different link text for the same destination"): `linkLabel` is what a
    // CONTROL says and is the same three words for every reader, `label` is the
    // noun for a link inside a sentence, where a control label will not parse.
    // The client's "your archive" is gone with the other seven spellings this
    // destination had grown; only the staff/client scoping split survives,
    // because that is about whose archive it is.
    expect(clientArchiveLink({ clientId: "c1", isStaff: false })).toEqual({
      href: "/calendar?view=archive",
      label: "the archive",
      linkLabel: "Open archive",
    });
    expect(clientArchiveLink({ clientId: "c1", isStaff: true })).toEqual({
      href: "/clients/c1/calendar?view=archive",
      label: "this client's archive",
      linkLabel: "Open archive",
    });
  });

  it("gives every control that offers the archive the same three words", () => {
    // R7's actual claim: one vocabulary per destination. The control label does
    // NOT move with the reader — a staff member and a client press a button
    // that says the same thing; only the sentence-noun and the route differ.
    for (const isStaff of [true, false]) {
      expect(clientArchiveLink({ clientId: "c1", isStaff }).linkLabel).toBe("Open archive");
    }
    // …and the surfaces that carry a control use it rather than composing one.
    // "Open your archive" on the agent page and "See all activity" on Home were
    // two of the eight names this one destination answered to.
    for (const rel of [
      "src/app/(app)/clients/[id]/agents/[agentId]/page.tsx",
      "src/components/client-home-overview.tsx",
    ]) {
      const code = stripComments(read(rel));
      expect(code, `${rel} composes its own archive control label`).toContain(
        "{archive.linkLabel}",
      );
      expect(code, `${rel} still says "See all activity"`).not.toContain("See all activity");
      expect(code, `${rel} still says "Open your archive"`).not.toContain("Open your archive");
    }
  });

  it("names the view the calendar actually reads, on a route that exists", () => {
    // The failure this guards is silent in exactly the way #90 was: a `?view=`
    // the calendar does not recognise opens the ordinary week with no error at
    // all. Both ends are asked — the param the helper writes, and the union
    // calendar-body validates it against.
    for (const isStaff of [true, false]) {
      const { href } = clientArchiveLink({ clientId: "c1", isStaff });
      const url = new URL(href, "https://example.test");
      expect(url.pathname.endsWith("/calendar"), href).toBe(true);
      expect(url.searchParams.get("view")).toBe("archive");
    }
    // The list lives in a PLAIN module: calendar-body.tsx is a server component,
    // and importing the array from the "use client" run-calendar.tsx handed it a
    // client-reference proxy whose `.find` threw on every /calendar render.
    const modes = stripComments(read("src/lib/calendar-view-modes.ts"));
    expect(modes).toContain('export const CALENDAR_VIEW_MODES');
    expect(modes).toMatch(/"day",\s*"week",\s*"month",\s*"archive",/);
    const body = stripComments(read("src/app/(app)/calendar/calendar-body.tsx"));
    expect(body).toContain("CALENDAR_VIEW_MODES.find(");
    expect(body).toMatch(/import \{[^}]*CALENDAR_VIEW_MODES[^}]*\} from "@\/lib\/calendar-view-modes"/);
    expect(body).not.toMatch(/import \{[^}]*CALENDAR_VIEW_MODES[^}]*\} from "@\/components\/run-calendar"/);
  });

  it("moves the label with the destination", () => {
    // "your archive" pointed at one client's workspace would be telling a staff
    // member that this client's archive is theirs.
    const staff = clientArchiveLink({ clientId: "c1", isStaff: true });
    expect(staff.label).not.toContain("your");
  });

  it("leaves no hard-coded client-shaped archive URL on the three surfaces", () => {
    for (const family of ["x", "linkedin", "reddit"] as const) {
      const code = stripComments(read(surfaceOf(family)));
      expect(code, surfaceOf(family)).not.toContain('"/tasks?tab=archive"');
      expect(code, surfaceOf(family)).toContain("clientArchiveLink({ clientId, isStaff })");
    }
  });

  it("carries the resolved label on the same anchor as the resolved href", () => {
    // The pure function moves the two together; this is the half that says the
    // SURFACE does. Asking the file for `href={archive.href}` alone would pass
    // with the sentence hard-coded back to "your archive" on that anchor — a
    // staff member told this client's archive is theirs, which is half of #90
    // returning with the URL left correct.
    for (const family of ["x", "linkedin", "reddit"] as const) {
      const rel = surfaceOf(family);
      const links = anchorsRendering(stripComments(read(rel)), "{archive.label}");
      expect(links.length, `${rel}: nothing renders {archive.label}`).toBeGreaterThan(0);
      for (const link of links) {
        expect(link, `${rel}: {archive.label} is rendered outside any <a>`).not.toBeNull();
        expect(hrefValues(link!.tag), rel).toEqual(["{archive.href}"]);
      }
    }
  });
});

/* ──────────────── #82: the header control, resolved per role ────────────── */

describe("#82 — the intake page's one control per role", () => {
  /**
   * THIS TEST USED TO PIN A FALSE CLAIM. Its name was "keeps the run promise for
   * staff, whose destination carries run controls" — and the staff branch of
   * `/clients/<id>/agents` carries none: CD-I1 moved every staff run gesture onto
   * the agent's own detail page, and that page's own comments say so. So staff
   * read a verb their destination could not honour, exactly like the client, and
   * the fix that closed the client half wrote the other half's error down as
   * intended behaviour. A test is the worst place for a wrong premise to live.
   */
  it("promises staff no run on a page that has none either", () => {
    const withAgent = intakePageAction({ clientId: "c1", isStaff: true, agentId: "ag1" });
    expect(withAgent.href).toBe("/clients/c1/agents/ag1");
    expect(withAgent.label).not.toMatch(/run/i);

    // No resolvable instance: name the roster, drop the verb — same rule as the
    // client's fallback, which is the point.
    const noAgent = intakePageAction({ clientId: "c1", isStaff: true, agentId: null });
    expect(noAgent.href).toBe("/clients/c1/agents");
    expect(noAgent.label).not.toMatch(/run/i);
  });

  it("promises a run to nobody, because no destination it can reach offers one", () => {
    // The closed question, over every combination rather than the two above.
    for (const isStaff of [true, false]) {
      for (const agentId of ["ag1", null]) {
        expect(
          intakePageAction({ clientId: "c1", isStaff, agentId }).label,
          `isStaff=${isStaff} agentId=${agentId}`,
        ).not.toMatch(/\brun\b/i);
      }
    }
  });

  it("sends a client to the agent's own page, where their run gesture lives", () => {
    const action = intakePageAction({ clientId: "c1", isStaff: false, agentId: "ag1" });
    expect(action.href).toBe("/clients/c1/agents/ag1");
    expect(action.label).not.toMatch(/run/i);
  });

  it("drops the promise rather than keeping it over a roster that refuses it", () => {
    // The client branch of the roster renders a header and a roster and states
    // in its own comment that it carries no Run button. A control that still
    // said "Run the agent" there would be the original defect with a fallback
    // in front of it.
    const action = intakePageAction({ clientId: "c1", isStaff: false, agentId: null });
    expect(action.href).toBe("/clients/c1/agents");
    expect(action.label).not.toMatch(/run/i);
  });

  it("is asked by all three pages, and hard-coded by none of them", () => {
    for (const family of ["x", "linkedin", "reddit"] as const) {
      const rel = `src/app/(app)/clients/[id]/${family}-agent/page.tsx`;
      const code = stripComments(read(rel));
      expect(code, rel).toContain("intakePageAction({ clientId: id, isStaff, agentId })");
      expect(code, rel).toContain("{action.label}");
      // The old shape: one href and one label for everybody.
      expect(code, rel).not.toContain("Run the agent");
    }
  });

  it("puts the resolved href on the control, not just the resolved label", () => {
    // THE HALF THAT SHIPS. Asking the resolver and rendering `{action.label}`
    // says nothing about where the control GOES: with both of those left
    // untouched, putting `/clients/${id}/agents` back on the anchor was green
    // everywhere, which is a client reading "Back to the agent" and landing on
    // the one page whose own comment says it has no Run button — #82 with a
    // resolver bolted on the front.
    //
    // The pages now render the pair through ONE shared component
    // (IntakePageActionLink), so the invariant is asserted in two halves:
    // every page hands BOTH resolved fields to the same element, and the
    // component's one Link puts its href prop on the element rendering its
    // label prop — so the pair still cannot come apart into a right
    // destination under a wrong promise.
    for (const family of ["x", "linkedin", "reddit"] as const) {
      const rel = `src/app/(app)/clients/[id]/${family}-agent/page.tsx`;
      const controls =
        stripComments(read(rel)).match(/<IntakePageActionLink\b[^>]*\/>/g) ?? [];
      expect(controls.length, `${rel}: nothing renders IntakePageActionLink`).toBe(1);
      const control = controls[0]!;
      expect(hrefValues(control), rel).toEqual(["{action.href}"]);
      expect(control, rel).toContain("label={action.label}");
      expect(control, rel).toContain("back={action.back}");
    }
    const component = stripComments(read("src/components/intake-page-action-link.tsx"));
    const links = [...component.matchAll(/<Link(?=[\s/>])/g)].map((m) => m.index);
    expect(links.length, "component: exactly one Link").toBe(1);
    const link = elementAt(component, "Link", links[0]!);
    expect(link, "component: Link parses").not.toBeNull();
    expect(hrefValues(link!.tag), "component").toEqual(["{href}"]);
    expect(link!.body, "component: the Link renders the label prop").toContain("{label}");
  });
});
