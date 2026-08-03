/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { isStringDelimiter, matchingBrace, skipStringLiteral } from "./source-scan";

/**
 * THE TASK BOARD ON A DEVICE THAT CANNOT HOVER.
 *
 * Every per-card action lived in a row classed `hidden … group-hover:flex` —
 * `display: none` until hover. A touch device has no hover, and
 * `group-focus-within` cannot rescue the row from the inside because a `hidden`
 * child is not focusable, so the only focusable thing in a resting card was the
 * drag handle. Two of the three actions had a modal twin ("Open Details" is the
 * tap; "Run Agent"/"Start" is the ticket footer's Move button). DELETE HAD NONE:
 * a client on a phone could add tasks from the always-visible quick-add bar and
 * never remove one.
 *
 * The CSS half is not asserted as a string of class names — the class list is
 * read off the RENDERED card and put through Tailwind, so what is checked is the
 * declaration a browser would receive. The hide is keyed to `@media (hover:
 * hover)`, which is the same media query Tailwind v4 wraps `group-hover:` in;
 * that co-extensiveness is the actual guarantee and it is what these assert:
 * strip the hover-media blocks (the CSS a hover-less device applies) and NOTHING
 * is left that hides the row.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/actions", () => ({
  deleteTaskAction: vi.fn(),
  previewPendingTasksBatchAction: vi.fn(),
  previewTaskRunAction: vi.fn(),
  runPendingTasksBatchAction: vi.fn(),
  updateTaskStatusAction: vi.fn(),
  getTaskCommentsAction: vi.fn(() => Promise.resolve({ comments: [] })),
  addTaskCommentAction: vi.fn(),
  generateTaskPlanAction: vi.fn(),
  approveTaskArtifactAction: vi.fn(),
  requestAdjustmentsAction: vi.fn(),
  publishIntegrationAction: vi.fn(),
}));

/** Whatever the current test wants `?owner=`/`?task=` to be. */
let searchParams = new URLSearchParams("");
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => searchParams,
  usePathname: () => "/tasks",
}));

const { TasksBoard } = await import("@/components/tasks-board");
const { TaskTicketModal } = await import("@/components/task-ticket-modal");

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

const BOARD_PATH = "src/components/tasks-board.tsx";
const TICKET_PATH = "src/components/task-ticket-modal.tsx";
const board = source(BOARD_PATH);
const ticket = source(TICKET_PATH);

function makeTask(patch: Record<string, any> = {}): any {
  return {
    id: "t1",
    clientId: "c1",
    title: "Draft the launch note",
    status: "pending",
    owner: "karos_managed",
    priority: "high",
    source: "copilot",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function boardMarkup(tasks: any[], props: Record<string, any> = {}): string {
  return renderToStaticMarkup(
    <TasksBoard tasks={tasks} currentUserRole={"CLIENT_USER" as any} clientId="c1" {...props} />,
  );
}

function ticketMarkup(patch: Record<string, any> = {}): string {
  return renderToStaticMarkup(
    <TaskTicketModal
      task={makeTask(patch)}
      onClose={() => {}}
      onStatusChange={() => {}}
      onLocalUpdate={() => {}}
      onDelete={() => {}}
    />,
  );
}

/* ── The class list, as the browser would resolve it ──────────────── */

/** Every `class="…"` in the markup. */
function classLists(markup: string): string[] {
  return [...markup.matchAll(/class="([^"]*)"/g)].map((m) => m[1]!);
}

/** The attributes of the rendered `<button>` whose label is Delete. */
function deleteButtonAttrs(markup: string): string {
  const m = /<button([^>]*)>(?:(?!<\/button>)[\s\S])*?Delete<\/button>/.exec(markup);
  expect(m, "no Delete button in the rendered ticket").toBeTruthy();
  return m![1]!;
}

/**
 * Tailwind's own compiler, so the assertions below are about the CSS that ships
 * rather than about the spelling of a variant.
 *
 * THEME + UTILITIES, and both are load-bearing. Preflight is left out because it
 * carries an unrelated `[hidden] { display: none }` that would drown the signal.
 * The THEME is in because without it a variant whose value comes from the theme —
 * `md:`, which needs `--breakpoint-md` — compiles to NOTHING AT ALL, and a
 * harness that silently drops a candidate reports green for a class list it never
 * read. That was not hypothetical: swapping the hover-keyed hide for a
 * width-keyed `md:hidden` passed the excision check until the theme was added.
 * `emptyCandidates` below is the belt to that braces.
 */
async function compileClasses(classList: string): Promise<string> {
  const compiler = await compile(
    `@import "tailwindcss/theme";\n@import "tailwindcss/utilities";`,
    {
      base: REPO,
      loadStylesheet: async (id: string) => {
        const rel = id.startsWith("tailwindcss") ? `node_modules/${id}.css` : id;
        const p = path.resolve(REPO, rel);
        return { path: p, base: path.dirname(p), content: readFileSync(p, "utf8") };
      },
    },
  );
  return compiler.build(classList.split(/\s+/).filter(Boolean));
}

/**
 * The tokens in this class list that Tailwind emits no declaration for — i.e.
 * the ones the checks below would be blind to. Any at all and the harness is
 * under-reading the row, so it is asserted empty rather than assumed.
 */
async function emptyCandidates(classList: string): Promise<string[]> {
  const dead: string[] = [];
  for (const token of classList.split(/\s+/).filter(Boolean)) {
    const css = await compileClasses(token);
    if (!/[a-z-]+\s*:/.test(css.replace(/\/\*[\s\S]*?\*\//g, ""))) dead.push(token);
  }
  return dead;
}

/**
 * The CSS left once every `@media (hover: hover)` block is removed — i.e. what a
 * device with no hover actually applies. Brace-matched through the shared
 * primitive, so a nested rule inside the block cannot end the excision early.
 */
function withoutHoverMedia(css: string): string {
  let out = css;
  for (;;) {
    const m = /@media\s*\([^)]*hover\s*:\s*hover[^)]*\)\s*\{/.exec(out);
    if (!m) return out;
    const open = m.index + m[0].length - 1;
    const close = matchingBrace(out, open);
    if (close < 0) return out;
    out = out.slice(0, m.index) + out.slice(close + 1);
  }
}

describe("the per-card action row survives a device with no hover", () => {
  const row = classLists(boardMarkup([makeTask()])).find((c) => c.includes("group-hover:flex"));

  it("ships exactly one hover-revealed action row per card", () => {
    expect(row, "no action row in the rendered card").toBeTruthy();
  });

  it("compiles every class in that row, so nothing here is read blind", async () => {
    expect(await emptyCandidates(row!)).toEqual([]);
  });

  it("does not carry an unconditional `hidden`", () => {
    // The pre-fix class list. `hidden` with no condition on it is display:none
    // on every device, and no `group-hover:` can be reached from a touch screen.
    expect(row).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("leaves nothing that hides the row once the hover media is dropped", async () => {
    const css = await compileClasses(row!);
    const noHover = withoutHoverMedia(css);
    // A phone applies this. The row is displayed, and nothing takes it away.
    expect(noHover).toContain("display: flex");
    expect(noHover).not.toContain("display: none");
  });

  it("still keeps the compact resting card where a pointer exists", async () => {
    const css = await compileClasses(row!);
    // The density this row was built for is untouched: with hover, it is hidden.
    expect(css).toContain("display: none");
    expect(css).toMatch(/@media\s*\([^)]*hover\s*:\s*hover/);
  });

  it("hides and reveals under the SAME condition, so neither can strand the row", async () => {
    // Both halves are inside a hover media query, which is what makes them
    // co-extensive: a device told to hide this row is a device that can hover it
    // back. Asserted by excision — each half vanishes with the hover media.
    expect(withoutHoverMedia(await compileClasses("[@media(hover:hover)]:hidden"))).not.toContain(
      "display",
    );
    expect(withoutHoverMedia(await compileClasses("group-hover:flex"))).not.toContain("display");
  });

  it("keeps the keyboard reveal off the hover media, so tabbing works anywhere", async () => {
    // group-focus-within is NOT hover-gated by Tailwind, so the drag handle's
    // focus still opens the row — on a desktop, and on a phone with a keyboard.
    expect(row).toContain("group-focus-within:flex");
    expect(withoutHoverMedia(await compileClasses("group-focus-within:flex"))).toContain(
      "display: flex",
    );
  });
});

/* ── RULE 8: the shape, everywhere ────────────────────────────────── */

const DISPLAY = String.raw`(?:flex|block|grid|inline|inline-flex|inline-block|inline-grid|table|contents|flow-root|list-item)`;
/** `hidden` with nothing qualifying it — display:none on every device. */
const BARE_HIDDEN = /(^|\s)hidden(\s|$)/;
/** A hover variant that restores DISPLAY — the only reveal a hidden row can have. */
const HOVER_RESTORES_DISPLAY = new RegExp(String.raw`(^|\s)(?:group-)?hover:${DISPLAY}(\s|$)`);
/** The conditional hide this fix introduced. */
const HOVER_GATED_HIDDEN = /\[@media\(hover:hover\)\]:hidden/;

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      tsxFiles(p, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(path.relative(REPO, p));
    }
  }
  return out;
}

/**
 * Every string literal that is part of a `className`, and nothing else.
 *
 * KEYED TO THE ATTRIBUTE, not to "any literal in the file": a prose comment may
 * legitimately quote the class list it replaced (the fixed row's own comment
 * does), and a scan that read every literal would report that comment as the
 * defect it describes. The expression after `className=` is brace-matched, so
 * `cn("a", cond && "b")` and a ternary's two branches are all collected.
 *
 * RESIDUAL, stated rather than claimed away: a class list assigned to a
 * top-level constant and then referenced as `className={ROW}` is not read here.
 * Nothing in this tree writes one that way today, and the shape below would have
 * to be re-checked if something did.
 */
function classAttributeLiterals(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className=/g)) {
    const i = m.index! + m[0].length;
    if (src[i] === '"') {
      const close = skipStringLiteral(src, i);
      if (close > i) out.push(src.slice(i + 1, close));
      continue;
    }
    if (src[i] !== "{") continue;
    const close = matchingBrace(src, i);
    if (close < 0) continue;
    const expr = src.slice(i, close + 1);
    for (let j = 0; j < expr.length; j++) {
      if (!isStringDelimiter(expr[j])) continue;
      const end = skipStringLiteral(expr, j);
      if (end > j) out.push(expr.slice(j + 1, end));
      j = end;
    }
  }
  return out;
}

describe("no action row anywhere is display:none until hover", () => {
  const files = tsxFiles(path.join(REPO, "src"));

  const lists = files.flatMap((rel) =>
    classAttributeLiterals(source(rel)).map((literal) => ({ rel, literal })),
  );

  it("reads the app's class attributes at all", () => {
    // A scan that reads nothing is green for the wrong reason, and one that reads
    // no `hidden` cannot have exercised the exemption below.
    expect(files).toContain(BOARD_PATH);
    expect(lists.some(({ rel }) => rel === BOARD_PATH)).toBe(true);
    expect(lists.some(({ literal }) => BARE_HIDDEN.test(literal))).toBe(true);
    expect(lists.some(({ literal }) => HOVER_RESTORES_DISPLAY.test(literal))).toBe(true);
  });

  it("has no class list that is hidden by default and revealed only by hover", () => {
    // THE EXEMPTION IS MECHANICAL: `hidden` beside `group-hover:opacity-100` is
    // not this shape — opacity leaves the element laid out, hit-testable and
    // focusable, so the control is reachable even while invisible. Only a hover
    // variant that restores DISPLAY can be the sole way back from `display:none`.
    const offenders = lists
      .filter(
        ({ literal }) => BARE_HIDDEN.test(literal) && HOVER_RESTORES_DISPLAY.test(literal),
      )
      .map(({ rel, literal }) => `${rel}: ${literal}`);
    expect(offenders).toEqual([]);
  });

  /**
   * THE NEIGHBOURING SHAPE, kept separate on purpose. `opacity-0` +
   * `group-hover:opacity-100` is NOT the defect above — the element stays laid
   * out, hit-testable and focusable, so the control is reachable — and widening
   * the assertion above to cover it would have made that test's own exemption
   * comment false.
   *
   * What it costs is DISCOVERABILITY, which is a different question: on a touch
   * device nothing reveals the control, and a keyboard user tabbing to it gets no
   * visible focus ring, because opacity stays 0 without hover. On a DESTRUCTIVE
   * control (delete a client, stop tracking a competitor) that is worth catching.
   *
   * So this is an inventory with a mechanical exemption rather than a flat ban: a
   * hover-only opacity reveal must either add a focus/no-hover reveal, or be
   * pinned here as decorative. A decorative pin is checked by the class list
   * itself, not by a promise — a pinned list may not contain a cursor or a
   * pointer-events class, which is what a real control carries.
   */
  const DECORATIVE_OPACITY_REVEALS: Readonly<Record<string, string>> = {
    // Each of these is a HINT PAINTED OVER A CONTROL, never the control. The
    // button or label underneath is always laid out, tappable and focusable, so
    // the action works with no hover at all — the overlay only advertises it.
    // That is the line: a hover-only overlay on top of a working control is
    // decoration; a hover-only control is the defect.
    "h-3 w-3 shrink-0 text-muted-2 opacity-0 transition-opacity group-hover:opacity-100":
      "client-context-sections — link arrow on an already-clickable row",
    "absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition-opacity group-hover:bg-black/30 group-hover:opacity-100":
      "asset-card — Maximize hint inside the <button> that opens the lightbox",
    "absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/50 px-2 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100":
      "asset-card — a count badge, not a control",
    "absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100":
      "avatar-uploader — camera hint inside the clickable avatar label",
    "hidden h-3.5 w-3.5 shrink-0 text-muted-2 opacity-0 transition-opacity group-hover:opacity-100 lg:block":
      "chatbot-widget — a chevron hint on a row that is itself the control",
  };

  it("reveals every hover-only control to a keyboard or a touch device too", () => {
    const HOVER_ONLY_OPACITY =
      /(^|\s)opacity-0(\s|$)[\s\S]*group-hover:opacity-100|group-hover:opacity-100[\s\S]*(^|\s)opacity-0(\s|$)/;
    const HAS_ESCAPE = /focus-within:opacity-100|focus-visible:opacity-100|focus:opacity-100|hover:none\)\]:opacity-100/;

    const bare = lists
      .filter(({ literal }) => HOVER_ONLY_OPACITY.test(literal) && !HAS_ESCAPE.test(literal))
      .filter(({ literal }) => !(literal.trim() in DECORATIVE_OPACITY_REVEALS));

    expect(
      bare.map(({ rel, literal }) => `${rel}: ${literal}`),
      "hidden until hover, with no focus or no-hover reveal — invisible to a keyboard " +
        "and to a touch device. Add `group-focus-within:opacity-100` and " +
        "`[@media(hover:none)]:opacity-100`, or pin it as decorative with its reason.",
    ).toEqual([]);
  });

  it("keeps every decorative pin decorative, and still exercised", () => {
    // Both directions. A pin that matches nothing has stopped guarding; a pin that
    // acquired a cursor is a control wearing a decorative exemption.
    for (const [literal, reason] of Object.entries(DECORATIVE_OPACITY_REVEALS)) {
      expect(
        lists.some((l) => l.literal.trim() === literal),
        `nothing carries this pinned class list any more (${reason}) — retire the pin`,
      ).toBe(true);
      expect(literal, `${reason}: pinned as decorative but carries a control class`).not.toMatch(
        /cursor-pointer|pointer-events-auto/,
      );
    }
  });

  it("never gates a display on hover without a hover reveal to undo it", () => {
    // The mirror failure: `[@media(hover:hover)]:hidden` on its own is a row a
    // pointer device can never open. The hide may only exist beside its reveal.
    const stranded = lists
      .filter(
        ({ literal }) => HOVER_GATED_HIDDEN.test(literal) && !HOVER_RESTORES_DISPLAY.test(literal),
      )
      .map(({ rel, literal }) => `${rel}: ${literal}`);
    expect(stranded).toEqual([]);
  });
});

/* ── Delete's second home ─────────────────────────────────────────── */

describe("delete has a home that exists at every width", () => {
  it("offers a delete in the resting ticket footer", () => {
    // The ticket is what a tap on the card opens, and it covers the board — so
    // this is the delete a phone can reach. It needs no hover and no pointer.
    expect(ticketMarkup()).toContain(">Delete<");
  });

  it("arms a question rather than deleting on the press", () => {
    const resting = ticketMarkup();
    expect(resting).not.toContain("Yes, delete it");
    expect(resting).not.toContain("This cannot be undone");
    // Source side of the same fact: the button sets the confirm flag, and the
    // handler is not wired straight to the press.
    expect(flat(ticket)).toContain("onClick={() => setConfirmingDelete(true)}");
    expect(ticket).not.toContain("onClick={onDelete}");
  });

  it("reaches onDelete from the confirmed branch and nowhere else", () => {
    const sites = ticket.match(/onDelete\(\)/g) ?? [];
    expect(sites).toHaveLength(1);
    expect(flat(ticket)).toContain("setConfirmingDelete(false); onDelete(); onClose();");
    expect(ticket).toContain("Keep it");
  });

  it("hides no part of that footer behind a pointer", () => {
    // Whatever else changes in the footer, it may not grow a hover gate: this
    // control exists precisely because the card's row has one.
    const markup = ticketMarkup();
    const footer = markup.slice(markup.lastIndexOf("Created"));
    expect(footer).toContain("Delete");
    for (const list of classLists(footer)) {
      expect(list, footer).not.toMatch(BARE_HIDDEN);
      expect(list, footer).not.toContain("group-hover:");
    }
  });

  it("is off mid-run, for the same reason the server refuses it", () => {
    // deleteTaskAction refuses an executing task (the run would keep burning
    // compute with no task for its webhook to land on, and the charge could
    // never be refunded). The button says so instead of failing after the press.
    expect(ticket).toContain("Wait for the run to finish before dismissing this task");
    // The ATTRIBUTE, not the `disabled:opacity-40` class beside it.
    const DISABLED_ATTR = /(^|\s)disabled(=|\s|$)/;
    expect(deleteButtonAttrs(ticketMarkup({ metadata: { executing: true } }))).toMatch(
      DISABLED_ATTR,
    );
    // And not disabled the rest of the time — a control that is always off is
    // the same dead end by another route.
    expect(deleteButtonAttrs(ticketMarkup())).not.toMatch(DISABLED_ATTR);
  });

  it("authorizes through the board's one delete path", () => {
    // Not a second call site: the ticket hands the board's own handler back, so
    // there is one deleteTaskAction call, one optimistic removal, one rollback.
    expect(flat(board)).toContain("onDelete={() => handleDelete(selectedTask)}");
    expect(board.match(/deleteTaskAction\(/g) ?? []).toHaveLength(1);
    expect(ticket).not.toMatch(/deleteTaskAction\(/);
  });

  it("names delete in sentence case, with no lab vocabulary", () => {
    expect(ticket).toContain("Delete this task? This cannot be undone.");
    expect(ticket).not.toContain("Dismiss Task");
  });
});

/* ── The routed owner the board now follows ───────────────────────── */

describe("the board shows the tab an owner's work lives on", () => {
  const karos = makeTask({ id: "k1", owner: "karos_managed", title: "Automated work item" });
  const client = makeTask({ id: "c1t", owner: "client_managed", title: "Your own action item" });

  it("opens on Automated and shows only karos-owned cards", () => {
    searchParams = new URLSearchParams("");
    const markup = boardMarkup([karos, client]);
    expect(markup).toContain("Automated work item");
    expect(markup).not.toContain("Your own action item");
  });

  it("opens on Depending on you when the link says so", () => {
    searchParams = new URLSearchParams("owner=client");
    const markup = boardMarkup([karos, client]);
    expect(markup).toContain("Your own action item");
    expect(markup).not.toContain("Automated work item");
  });

  it("routes every owner→tab answer through the one mapping", () => {
    // Three sites asked this question with three inline ternaries; the third —
    // the reveal below — is the one that did not exist. `TaskOwner` has two
    // members, so the helper is total and cannot disagree with itself.
    expect(board).toContain("function ownerTab(owner: TaskOwner): OwnerTab");
    expect(flat(board)).toContain("ownerTab(inferOwner(linkedTask))");
    expect(flat(board)).toContain("localTasks.filter((task) => ownerTab(inferOwner(task)) === activeTab)");
    expect(flat(board)).toContain("setActiveTab(ownerTab(revealOwner.owner))");
  });
});

describe("a routed add lands on a card the client can actually see", () => {
  it("has a caller for the callback that reports the routed owner", () => {
    // The whole defect: `onAdded` was declared "fired after a task is
    // successfully added" and the single mount passed only clientId, so the
    // router's verdict never left the bar in any render.
    const view = flat(source("src/components/progress-view.tsx"));
    expect(view).toMatch(/<QuickAddTaskBar[^>]*onAdded=\{/);
    expect(view).toContain("revealOwner={revealOwner}");
  });

  it("keys the reveal on a nonce, so a second add to the same tab still reveals", () => {
    // `{ owner }` alone does not change between two adds that route the same
    // way, so an owner-only comparison fires once and then goes quiet.
    expect(flat(board)).toContain("if (prevRevealNonce !== revealNonce) {");
    expect(flat(source("src/components/progress-view.tsx"))).toContain(
      "nonce: (prev?.nonce ?? 0) + 1",
    );
  });

  it("clears every OTHER filter that could hide a brand-new card", () => {
    // The tab is one of three ways the promised card stays invisible: a status
    // filter on anything but Pending hides a just-created task, and so does a
    // stale search the routed title does not match (the model rewrites what was
    // typed). A reveal that fixes one of three is a promise half kept.
    const reveal = flat(board.slice(board.indexOf("const revealNonce ="), board.indexOf("const hasExecuting")));
    expect(reveal).toContain('setStatusFilter("all")');
    expect(reveal).toContain('setSearch("")');
  });

  it("types the routed owner as TaskOwner, so the mapping cannot be partial", () => {
    const bar = source("src/components/quick-add-task-bar.tsx");
    expect(bar).toContain("onAdded?: (owner: TaskOwner) => void");
    expect(bar).not.toContain("onAdded?: (owner: string) => void");
  });
});
