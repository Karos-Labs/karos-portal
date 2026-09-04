import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CALENDAR_QUERY_KEYS,
  CALENDAR_TIME_VIEW_MODES,
  CALENDAR_VIEW_MODES,
  calendarStateFromQuery,
  formatCalendarDate,
  formatCalendarHidden,
  parseCalendarDate,
  parseCalendarHidden,
  subscribeToCalendarUrl,
} from "@/lib/calendar-view-modes";
import { stripComments } from "./source-scan";

/**
 * THE CALENDAR PUTS ITS STATE IN THE URL, AND ARCHIVE LEFT THE TIME CONTROL.
 *
 * Flow audit 2026-09, R5 and R6. Two findings, one file, because the fix to
 * each is the other's precondition: promoting Archive out of `day | week |
 * month` only helps if pressing it is a real navigation, and writing `?view=`
 * only helps if the control that writes it is legible.
 *
 * What was wrong (audit F5/F6):
 *  · the calendar wrote NOTHING back — view mode, the week/month anchor, the
 *    archive's status/agent/search filters were all local state, so Back left
 *    the page instead of undoing the last move, no week or filtered archive
 *    could be shared, and a `?view=archive` deep link still read `archive`
 *    after the reader had switched to Week (reload snapped back);
 *  · `archive` was the fourth button in a control of three time ranges, with
 *    no back link, no breadcrumb, prev/next hidden, and the grid's legend
 *    chips still on screen doing nothing to a view that has no grid.
 *
 * Much of this is asserted against SOURCE: `vitest.config.ts` runs
 * `environment: "node"` and this repo carries no DOM environment, so there is
 * no button to press — the same precedent chatbot-widget-model-picker.test.ts
 * and the page-threading half of content-status-deeplink.test.ts already set.
 *
 * THE RESTORE PATH IS NOT (review wave, 2026-09). "Back and Forward work" was
 * the one claim here proved only by matching source text, and it is the claim
 * most easily broken without touching the text that was matched. Reading a
 * query and following `popstate` now live in the plain module
 * (`calendarStateFromQuery` / `subscribeToCalendarUrl`), so the behaviour is
 * exercised for real below: a live `EventTarget` stands in for `window`, a real
 * `popstate` event is dispatched through it, and the restored state is asserted
 * — no jsdom needed, and none is installed. The component-side wiring is all
 * that is left to source-matching.
 */

const REPO = path.join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");
/** Source with comments stripped — a param named only in a prose comment is not wiring. */
const code = (rel: string) => stripComments(read(rel));

const CALENDAR = "src/components/run-calendar.tsx";
const ARCHIVE = "src/components/archive-view.tsx";
const BODY = "src/app/(app)/calendar/calendar-body.tsx";
const FLAT_PAGE = "src/app/(app)/calendar/page.tsx";
const SCOPED_PAGE = "src/app/(app)/clients/[id]/calendar/page.tsx";

/* ── R6: Archive is not a fourth time range ─────────────────────────── */

describe("the day/week/month control holds only time ranges", () => {
  it("names the three time views in one shared list, without the archive", () => {
    expect([...CALENDAR_TIME_VIEW_MODES]).toEqual(["day", "week", "month"]);
    // The full union still has it — the archive is a view, it is just not a
    // RANGE. Both lists live in the plain module so the server page and the
    // client calendar read the same one (see calendar-view-modes.ts's header).
    expect([...CALENDAR_VIEW_MODES]).toContain("archive");
  });

  it("renders the segmented control off the time list, never the full union", () => {
    const src = code(CALENDAR);
    // The strip maps the three; mapping the union is exactly the defect.
    expect(src).toMatch(/CALENDAR_TIME_VIEW_MODES\.map\(/);
    expect(src, "the view strip is mapping all four views again").not.toMatch(
      /CALENDAR_VIEW_MODES\.map\(/,
    );
  });

  it("offers Archive as its own labelled control, saying what it holds", () => {
    const src = read(CALENDAR);
    expect(src).toMatch(/goToView\("archive"\)/);
    expect(src).toContain("everything we&apos;ve delivered");
  });

  it("gives the archive panel a way back to the calendar", () => {
    const src = read(CALENDAR);
    expect(src).toContain("Back to calendar");
    // Back to the view they were ON, not a hardcoded Week — and through the
    // same writer the strip uses, so the control and Back cannot disagree.
    expect(code(CALENDAR)).toMatch(/goToView\(lastTimeView\)/);
  });

  it("suppresses the grid legend while the archive is showing", () => {
    const src = code(CALENDAR);
    // The legend block is gated. Asserted by locating the gate immediately
    // before the legend's first chip rather than by counting braces.
    const legendAt = src.indexOf("Scheduled run");
    expect(legendAt, "the legend is gone entirely — this negative proves nothing").toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, legendAt - 400), legendAt);
    expect(before, "the legend renders unconditionally").toMatch(/viewMode !== "archive"/);
  });
});

/* ── R5: the URL carries the view ───────────────────────────────────── */

describe("view mode round-trips through the URL", () => {
  it("writes every view the reader can pick, as a real history entry", () => {
    const src = code(CALENDAR);
    // A push and not a replace: stepping Week -> Archive is the move Back is
    // for. The anchor and the filters are the ones that must NOT push.
    expect(src).toMatch(/writeCalendarQuery\(\s*\{ view: mode[\s\S]{0,160}?"push"/);
    expect(src).toMatch(/mode === "push"[\s\S]{0,60}window\.history\.pushState\(/);
    expect(src).toMatch(/window\.history\.replaceState\(/);
  });

  it("changes the view without refetching the page it is already rendering", () => {
    const src = code(CALENDAR);
    // `router.push` would be a navigation: a full RSC refetch of a page that
    // has just re-read every run, post, asset and archive row, on every press
    // of Day/Week/Month/Archive, to produce markup this component can render
    // from state it already holds. The payload is identical for all four views.
    const writer = src.slice(
      src.indexOf("const writeCalendarQuery"),
      src.indexOf("const lastTimeView"),
    );
    expect(writer, "the view switcher navigates instead of rewriting the URL").not.toMatch(
      /router\.push\(/i,
    );
  });

  it("reads the same param back on load, through the page's own validator", () => {
    const body = code(BODY);
    expect(body).toContain("CALENDAR_VIEW_MODES.find(");
    expect(body).toMatch(/initialViewMode \? \{ initialViewMode \} : \{\}/);
    // …and the calendar opens on it rather than always on Week.
    expect(code(CALENDAR)).toMatch(/useState<CalendarViewMode>\(initialViewMode \?\? "week"\)/);
  });

  it("wires the restore onto its own state, from the subscription and nowhere else", () => {
    const src = code(CALENDAR);
    // NOT from the seed prop: `replaceState` deliberately does not re-render
    // the server component, so the prop is stale exactly when a reader steps
    // back. The behaviour of the subscription itself is exercised further down.
    expect(src).toMatch(/subscribeToCalendarUrl\(/);
    expect(src, "the calendar hand-rolls a second popstate listener").not.toMatch(
      /addEventListener\("popstate"/,
    );
    const wiring = src.slice(
      src.indexOf("subscribeToCalendarUrl("),
      src.indexOf("[viewerIsClient]"),
    );
    for (const setter of ["setViewMode(", "setWeekAnchor(", "setArchiveFilters(", "setHiddenStatuses("]) {
      expect(wiring, `Back does not restore ${setter}`).toContain(setter);
    }
  });

  it("moves the anchor without burying the view-mode entry under it", () => {
    const src = code(CALENDAR);
    // One arrow press per day is not one Back per day.
    for (const fn of ["shiftMonth", "shiftWeek", "shiftDay"]) {
      const at = src.indexOf(`function ${fn}(`);
      expect(at, `${fn} is gone`).toBeGreaterThan(-1);
      const body = src.slice(at, at + 500);
      expect(body, `${fn} does not write the date`).toMatch(
        /writeCalendarQuery\(\{ date: formatCalendarDate\([^)]*\) \}, "replace"\)/,
      );
    }
  });

  it("mirrors the archive's own three filters, and clears the defaults", () => {
    const src = code(CALENDAR);
    const at = src.indexOf("const onArchiveFiltersChange");
    expect(at, "the archive's filters reach no URL").toBeGreaterThan(-1);
    const body = src.slice(at, at + 900);
    expect(body).toMatch(/"replace"/);
    // `status=all` in a shared link is noise, not state.
    expect(body).toMatch(/filters\.status === "all" \? null/);
    expect(body).toMatch(/filters\.agent === "all" \? null/);
    expect(body).toMatch(/filters\.search\.trim\(\) \|\| null/);
    // …and it is the same call that moves the state the archive renders from,
    // so the list and the URL cannot disagree (review wave, 2026-09).
    expect(body).toMatch(/setArchiveFilters\(filters\)/);
    // …and the archive actually reports them, as one triple.
    expect(code(ARCHIVE)).toMatch(/onFiltersChange\(\{ status, agent, search, \.\.\.next \}\)/);
  });
});

describe("both calendar routes thread the whole query", () => {
  for (const rel of [FLAT_PAGE, SCOPED_PAGE]) {
    it(`reads view, status, date, agent and q on ${rel}`, () => {
      const src = code(rel);
      for (const key of ["view", "status", "date", "agent", "q"]) {
        expect(src, `${rel} drops ?${key}=`).toMatch(
          new RegExp(`${key} \\? \\{ ${key} \\} : \\{\\}`),
        );
      }
    });
  }

  it("carries them through the client-scoped route's redirect", () => {
    // A staff link to "that agent's archive, that week" is routinely pasted to
    // a client, and this redirect is the hop it makes.
    const src = code(SCOPED_PAGE);
    const at = src.indexOf("new URLSearchParams({");
    expect(at).toBeGreaterThan(-1);
    const query = src.slice(at, src.indexOf("}).toString()", at));
    for (const key of ["view", "status", "date", "agent", "q"]) {
      expect(query, `the redirect drops ?${key}=`).toContain(`${key} ? { ${key} } : {}`);
    }
  });

  it("validates the anchor and the archive's agent before seeding either", () => {
    const body = code(BODY);
    // Same "fail open" rule `?view=` and `?status=` already follow: a bad param
    // opens the ordinary calendar, never an empty one.
    expect(body).toMatch(/parseCalendarDate\(date\)/);
    expect(body).toMatch(/archiveAgentNames\.has\(agent\)/);
  });
});

/* ── The parser both halves share ───────────────────────────────────── */

describe("parseCalendarDate / formatCalendarDate", () => {
  it("round-trips a local day", () => {
    const d = new Date(2026, 2, 4);
    expect(formatCalendarDate(d)).toBe("2026-03-04");
    expect(parseCalendarDate("2026-03-04")?.getTime()).toBe(d.getTime());
  });

  it("stays on the reader's own day, not UTC's", () => {
    // `toISOString()` would move a local Monday back to Sunday for anyone west
    // of UTC — and every anchor in this calendar is a local midnight.
    const d = new Date(2026, 0, 1, 0, 0, 0, 0);
    expect(formatCalendarDate(d)).toBe("2026-01-01");
  });

  it("pads single-digit months and days", () => {
    expect(formatCalendarDate(new Date(2026, 8, 7))).toBe("2026-09-07");
  });

  it("refuses anything that is not a real day, rather than guessing", () => {
    for (const bad of [undefined, "", "nonsense", "2026-3-4", "20260304", "2026-13-01", "2026-02-31"]) {
      expect(parseCalendarDate(bad), `accepted ${String(bad)}`).toBeNull();
    }
  });

  it("names its params in one place, so a rename is one edit", () => {
    expect(CALENDAR_QUERY_KEYS).toEqual({
      view: "view",
      date: "date",
      status: "status",
      agent: "agent",
      search: "q",
      hidden: "hidden",
    });
  });
});

describe("the archive does not spend the page's history budget on a search box", () => {
  it("debounces the history write, not the filter itself", () => {
    // Moved to the host with the state (review wave, 2026-09): a debounce
    // inside the archive could only work by keeping a second copy of the
    // filters, which is the drift that lost them on re-entry.
    const src = code(CALENDAR);
    const at = src.indexOf("const onArchiveFiltersChange");
    const body = src.slice(at, at + 900);
    // WebKit throttles history writes to ~100 in 30s and then drops the rest,
    // so a keystroke-per-write search box would exhaust the budget and leave
    // the view switcher — the one entry Back needs — unable to write at all.
    expect(body, "filters reach the URL on every keystroke").toMatch(/setTimeout\(/);
    expect(body).toMatch(/clearTimeout\(/);
    // The typed character itself must NOT wait 300ms to appear.
    expect(body.indexOf("setArchiveFilters(filters)")).toBeLessThan(body.indexOf("setTimeout("));
    expect(code(ARCHIVE), "the archive debounces a value it does not own").not.toMatch(
      /setTimeout\(/,
    );
  });
});

describe("R9 · the archive's empty states offer a control", () => {
  it("sends a never-had-anything archive to the agents that would fill it", () => {
    const src = read(ARCHIVE);
    expect(src).toContain("See your agents");
    // Only when there is one client in scope — the staff cross-client overview
    // has no agents page to name.
    expect(code("src/components/run-calendar.tsx")).toMatch(
      /defaultClientId \? \{ agentsHref: `\/clients\/\$\{defaultClientId\}\/agents` \} : \{\}/,
    );
  });

  it("gives a filtered-empty archive the control that undoes the filters", () => {
    const src = code(ARCHIVE);
    expect(read(ARCHIVE)).toContain("Clear filters");
    const at = src.indexOf("No matching deliverables");
    const body = src.slice(at, at + 900);
    // One report of all three, since the host owns them (review wave, 2026-09).
    expect(body, "Clear filters leaves a filter in force").toContain(
      'onFiltersChange({ status: "all", agent: "all", search: "" })',
    );
  });
});

/* ── R17: the archive's expansion has a reverse ─────────────────────── */

describe("the archive can be collapsed again", () => {
  it("offers Show fewer once a group is expanded", () => {
    const src = read(ARCHIVE);
    expect(src).toContain("Show all {group.assets.length} · {hidden} more");
    expect(src, "expansion is still one-way").toContain("Show fewer");
    expect(code(ARCHIVE)).toMatch(/next\.delete\(group\.name\)/);
  });
});

/* ── Review wave 2026-09 · the restore path, for real ────────────────── */

/**
 * A live stand-in for `window`: a real `EventTarget` (so `addEventListener` /
 * `dispatchEvent` are the platform's own) plus the one property the subscriber
 * reads. No jsdom in this repo, and none needed — `subscribeToCalendarUrl`
 * touches exactly these two things, and a whole DOM would only add ways for
 * this test to pass while the calendar is broken.
 */
class FakeWindow extends EventTarget {
  location: { search: string };
  constructor(search: string) {
    super();
    this.location = { search };
  }
  go(search: string) {
    this.location.search = search;
    this.dispatchEvent(new Event("popstate"));
  }
}

function withWindow<T>(search: string, run: (win: FakeWindow) => T): T {
  const win = new FakeWindow(search);
  const globals = globalThis as { window?: unknown };
  const had = "window" in globals;
  const prev = globals.window;
  globals.window = win;
  try {
    return run(win);
  } finally {
    if (had) globals.window = prev;
    else delete globals.window;
  }
}

describe("Back and Forward restore the whole calendar, not just the view", () => {
  it("hands back the state of the entry the reader lands on", () => {
    withWindow("?view=week", (win) => {
      const seen: ReturnType<typeof calendarStateFromQuery>[] = [];
      const stop = subscribeToCalendarUrl((state) => seen.push(state));

      // Stepping back onto the archive entry a filtered search had left behind.
      win.go("?view=archive&status=published&agent=Instagram%20Agent&q=launch");
      expect(seen).toHaveLength(1);
      expect(seen[0].view).toBe("archive");
      expect(seen[0].status).toBe("published");
      expect(seen[0].agent).toBe("Instagram Agent");
      expect(seen[0].search).toBe("launch");

      // …and forward again, onto a week with two legend chips dimmed.
      win.go("?view=week&date=2026-03-04&hidden=draft,failed");
      expect(seen).toHaveLength(2);
      expect(seen[1].view).toBe("week");
      expect(seen[1].date?.getTime()).toBe(new Date(2026, 2, 4).getTime());
      expect(seen[1].hidden).toEqual(["failed", "draft"]);
      // The archive's filters come back to their unfiltered spellings rather
      // than lingering from the previous entry — this is the bug that made a
      // re-entered archive show a list its own URL did not describe.
      expect(seen[1].status).toBe("all");
      expect(seen[1].agent).toBe("all");
      expect(seen[1].search).toBe("");

      stop();
      win.go("?view=day");
      expect(seen, "the subscription outlived its unsubscribe").toHaveLength(2);
    });
  });

  it("opens the ordinary calendar on an entry it cannot honour", () => {
    withWindow("", (win) => {
      let last: ReturnType<typeof calendarStateFromQuery> | null = null;
      const stop = subscribeToCalendarUrl((state) => (last = state));
      win.go("?view=nonsense&date=2026-02-31&hidden=purple");
      stop();
      const restored = last as unknown as ReturnType<typeof calendarStateFromQuery>;
      expect(restored.view).toBe("week");
      expect(restored.date).toBeNull();
      expect(restored.hidden).toEqual([]);
    });
  });
});

describe("the legend chips ride in the URL too (R5, review wave)", () => {
  it("round-trips a dimmed set, in one canonical order", () => {
    const written = formatCalendarHidden(["draft", "failed"]);
    expect(written).not.toBeNull();
    // Same set, whichever order the reader pressed them in — a link that
    // changes character with click order is one nobody can diff.
    expect(formatCalendarHidden(["failed", "draft"])).toBe(written);
    expect(parseCalendarHidden(written ?? undefined)).toEqual(parseCalendarHidden("draft,failed"));
  });

  it("writes nothing at all when nothing is dimmed", () => {
    expect(formatCalendarHidden([])).toBeNull();
    expect(parseCalendarHidden(undefined)).toEqual([]);
    expect(parseCalendarHidden("")).toEqual([]);
  });

  it("is seeded by the page and mirrored by the chip, with replaceState", () => {
    const body = code(BODY);
    expect(body).toMatch(/parseCalendarHidden\(hidden\)/);
    expect(body).toMatch(/initialHiddenStatuses/);
    const src = code(CALENDAR);
    const at = src.indexOf("const toggleStatus");
    expect(at, "the legend chips reach no URL").toBeGreaterThan(-1);
    const toggle = src.slice(at, at + 600);
    expect(toggle).toMatch(/writeCalendarQuery\(\{ hidden: formatCalendarHidden\(next\) \}, "replace"\)/);
    expect(src).toMatch(/useState<Set<CalendarFilterKey>>\(\s*\(\) => new Set\(initialHiddenStatuses \?\? \[\]\)/);
  });
});

describe("the anchor crosses the boundary as a day, not an instant", () => {
  it("passes `?date=` on as YYYY-MM-DD and parses it in the browser", () => {
    const body = code(BODY);
    // An epoch built by parsing a local day IN THE SERVER'S ZONE and re-read in
    // the reader's is off by one for anyone west of the server — and renders a
    // different grid on each side of the hydration boundary.
    expect(body, "the anchor is still shipped as millis").not.toMatch(/initialDateMs/);
    expect(body).toMatch(/formatCalendarDate\(parsedDate\)/);
    const src = code(CALENDAR);
    expect(src).not.toMatch(/initialDateMs/);
    expect(src).toMatch(/parseCalendarDate\(initialDate\) \?\? today/);
  });
});

describe("the three time views share one anchor (review wave)", () => {
  it("carries the view being left into the view being entered", () => {
    const src = code(CALENDAR);
    const at = src.indexOf("const goToView");
    const body = src.slice(at, at + 1400);
    // Month kept its own year/month, which nothing but Month's arrows moved:
    // paging Week to April and pressing Month opened the month the PAGE loaded.
    for (const setter of ["setViewYear(activeAnchor", "setViewMonth(activeAnchor", "setWeekAnchor(startOfWeek(activeAnchor", "setDayAnchor(startOfDay(activeAnchor"]) {
      expect(body, `goToView leaves ${setter} behind`).toContain(setter);
    }
    expect(body).toMatch(/date: formatCalendarDate\(activeAnchor\)/);
  });

  it("keeps Month in step when the week or day arrows move", () => {
    const src = code(CALENDAR);
    for (const fn of ["shiftWeek", "shiftDay"]) {
      const at = src.indexOf(`function ${fn}(`);
      const body = src.slice(at, at + 500);
      expect(body, `${fn} leaves Month behind`).toContain("setViewYear(next.getFullYear())");
      expect(body).toContain("setViewMonth(next.getMonth())");
    }
  });

  it("drops the archive's filters on the way into a time view", () => {
    const src = code(CALENDAR);
    const at = src.indexOf("const goToView");
    const body = src.slice(at, at + 1400);
    // A week link carrying a stranger's `status=`/`agent=`/`q=` applies them the
    // next time anyone opens the archive from it.
    expect(body).toContain('setArchiveFilters({ status: "all", agent: "all", search: "" })');
    expect(body).toMatch(/status: null,\s*agent: null,\s*search: null,/);
  });
});

describe("the archive renders what it is given", () => {
  it("takes its filters as values, and owns none of them", () => {
    const src = code(ARCHIVE);
    for (const own of ['useState<Asset["status"] | "all">', "setStatus(", "setAgent(", "setSearch("]) {
      expect(src, `the archive still holds ${own}`).not.toContain(own);
    }
    expect(code(CALENDAR)).toMatch(/status=\{archiveFilters\.status\}/);
    expect(code(CALENDAR)).toMatch(/agent=\{archiveFilters\.agent\}/);
    expect(code(CALENDAR)).toMatch(/search=\{archiveFilters\.search\}/);
  });

  it("seeds those values from the page's validated params, once", () => {
    const src = code(CALENDAR);
    const at = src.indexOf("const [archiveFilters");
    const body = src.slice(at, at + 400);
    expect(body).toContain('initialArchiveStatus ?? "all"');
    expect(body).toContain('initialArchiveAgent ?? "all"');
    expect(body).toContain('initialArchiveSearch ?? ""');
  });
});

describe("a suggestion gets one interactive row, not three", () => {
  it("lets the week's own day list own the row it already prints", () => {
    const src = code(CALENDAR);
    // Grid chip + week-list row + day-detail row was the "shown up 3 times"
    // complaint reappearing in a different arrangement.
    expect(src).toMatch(/const showSuggestionRows = viewMode !== "week"/);
    expect(src).toMatch(/\{showSuggestionRows \? \(/);
    // …and the panel still says the day has them, rather than reading empty.
    expect(read(CALENDAR)).toContain("Approve or skip them in the list above.");
  });

  it("disables Approve on the row being approved, not on every row", () => {
    const hook = code("src/components/pending-task-suggestions.tsx");
    expect(hook).toMatch(/return \{ pendingIds, removedIds, errors, approve, skip \}/);
    expect(hook, "one transition flag still stands in for every row").not.toMatch(
      /const \[isPending, startTransition\]/,
    );
    expect(code(CALENDAR)).toMatch(/isPending=\{suggestionActions\.pendingIds\.has\(s\.id\)\}/);
  });
});

describe("the calendar's shared list stays out of the client module", () => {
  it("re-exports no VALUE through run-calendar.tsx", () => {
    // A value re-exported through a "use client" module is the exact hazard
    // lib/calendar-view-modes.ts exists to remove; nothing imported this one.
    expect(code(CALENDAR)).not.toMatch(/export \{ CALENDAR_VIEW_MODES \}/);
  });
});
