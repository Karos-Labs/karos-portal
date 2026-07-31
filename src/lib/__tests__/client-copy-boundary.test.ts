import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { CLIENT_SAFE_COPILOT_TOOLS } from "@/lib/copilot-tool-access";
import { ALL_LAUNCH_PROFILES } from "@/lib/custom-agent-launch";
import { queueCapacitySkipNote } from "@/lib/task-dedup";

/**
 * Two rules about text a CLIENT reads, asked as SHAPES over the channels that
 * carry it: no spaced hyphen where an em dash belongs, and no Firestore enum
 * used as prose.
 *
 * Both had been fixed per-site before. Ledger F71 banned `" - "` in client copy
 * and it came back at least four times, in two files, in text a client's own
 * model paraphrases. A per-site fix cannot hold a rule that any new string can
 * break, so this asks the rule of a CHANNEL rather than of a list of strings.
 *
 * ── WHAT MAKES A STRING CLIENT-REACHABLE ─────────────────────────────────────
 * Deciding that is the whole difficulty, and it is answered by CHARACTERISING
 * each channel rather than by listing files. Staff strings keep their
 * punctuation on purpose (`JOB_TITLE_CLIENT_SEPARATOR` in job-title.ts IS
 * `" - "`, and the delivery handler strips it before a client ever sees a job
 * title); an operator-facing cron response, an admin alert email and a server
 * log are not client copy either. So:
 *
 *  1. THE COPILOT'S TOOL RESULTS. Every string a tool can hand back when the
 *     caller is a client session. Derived from `CLIENT_SAFE_COPILOT_TOOLS` —
 *     the allowlist that decides which tools a client is offered at all — via
 *     the route's own registry object, so a tool moving on or off the allowlist
 *     moves this scan with it. The payload is what the MODEL reads, because it
 *     paraphrases whatever it is handed; there is no render here to sanitize
 *     at, which is why this channel is the sharpest of the five.
 *
 *  2. THE SERVER ACTIONS A CLIENT SESSION REACHES. Every exported action in
 *     `lib/actions/` with no `requireStaff()`/`requireAdmin()` gate — the
 *     codebase's own authorization convention (CLAUDE.md), so "client can reach
 *     it" is read off the gate rather than guessed from the name. Only its
 *     RETURN/THROW contract counts: `requireTaskAccess`'s own docstring states
 *     why ("These strings are RETURNED, not thrown, so several client surfaces
 *     render them verbatim… The status vocabulary stays in the logs"), and
 *     components render a thrown `e.message` straight into an error banner.
 *     FOLLOWED THROUGH MODULE-PRIVATE HELPERS, because the export list is not
 *     the data flow — see the block comment on `CLIENT_REACHABLE_ACTIONS`.
 *
 *  3. THE BRANDED CLIENT EMAIL WRAPPER. `emailShell`, whose own docstring says
 *     "client-facing deliveries".
 *
 *  4. THE LAUNCH FORM a client fills in — `ALL_LAUNCH_PROFILES`, exported
 *     expressly "so guard tests can sweep the whole set".
 *
 *  5. THE PAGES AND COMPONENTS A CLIENT'S BROWSER RENDERS. Route modules under
 *     `src/app` (page/layout/error/not-found/template/loading) minus the ones
 *     whose own source restricts to staff, plus the `src/components` tree those
 *     roots mount — and inside them, minus any string sitting in a staff-gated
 *     JSX region. The earlier version of this file declared this channel
 *     unaskable ("no file-level property says whether a component tree is
 *     mounted for a client") and shipped five live offences behind that
 *     sentence, including "Almost there - verify your email." on the page every
 *     new client sees. The per-render prop is not the boundary; the ROUTE GATE
 *     and the enclosing conditional are, and both are file facts.
 *
 *  6. THE MARKED CATALOGS. A declarative data table's strings reach a client
 *     through somebody else's render, so neither the table nor the renderer
 *     looks like client copy on its own — `PLATFORM_REGISTRY` carried two
 *     spaced hyphens in `description`, rendered ungated in the "Add a channel"
 *     list and every card header, on a page a CLIENT_USER reaches and inside
 *     the onboarding wizard. Audience is read off `@clientCopy` / `@staffCopy` /
 *     `@notCopy` markers on the interface's own fields, and enrolment FAILS
 *     CLOSED: an unmarked string field in an enrolled interface turns this red.
 *     Deriving audience from render sites instead was tried and was worse — the
 *     union of ungated property reads across a module's importers said `hint`
 *     was client copy, which would have pushed the next person to rewrite seven
 *     admin-only credential hints that a client cannot see.
 *
 * ── WHAT THIS DOES NOT CLAIM ─────────────────────────────────────────────────
 * SCOPE, stated rather than discovered later:
 *
 *  • It is not every client-reachable string in the repo. `route.ts` HTTP
 *    handlers are NOT channel 5: their bodies are JSON to a fetch caller, not
 *    page copy — except the OAuth popup, where `errorPage()`
 *    (lib/integrations/oauth-popup.ts) renders its `message` argument as HTML in
 *    the client's own browser. Four of those messages in
 *    `api/auth/social/[provider]/callback/route.ts` still read "Invalid callback
 *    - missing code or state." and similar. UNGUARDED and unfixed here: the
 *    sibling `[provider]/route.ts` already writes em dashes, so the two halves
 *    of one popup disagree, and the fix is a copy pass over that handler rather
 *    than a channel.
 *  • Channel 6 sweeps only interfaces that CARRY markers. Marking is opt-in, so
 *    an unmarked catalog is invisible to it; what fails closed is a new field
 *    inside an already-marked interface. `BriefField`,
 *    `AgentAttachmentProfile` and every other nested shape are deliberately
 *    unmarked and unswept.
 *  • Channel 2 reads the return/throw expression, plus `error`/`message`
 *    properties of a returned object, the two branches of a ternary, the
 *    operands of a `+` chain, and now a module-private helper reached either by
 *    a direct call or through a local `const`. A message assembled into a local
 *    by mutation, or returned from an imported helper in another module, still
 *    escapes it.
 *  • Channel 1 has no return-shape hole — the whole `execute` body is in scope,
 *    since a tool's result IS its message — but says nothing about tool
 *    DESCRIPTIONS and `z.enum` members, which are the API contract with the
 *    model and deliberately name enum values the model must emit. The system
 *    prompt is the same model's reading and is NOT swept as a channel; the one
 *    catalog that feeds it is covered by channel 6 instead.
 *  • The ENUM half is asked of prose, or of anything in a PAYLOAD position (a
 *    return/throw expression, or an `error`/`message` property value). A bare
 *    `error: "review_pending"` is an offence for that reason even though it is
 *    not prose; `status: "review_pending"` inside the same returned object is
 *    not, because it is a stored value at a non-message key.
 *  • A spaced-hyphen NUMERIC RANGE ("3 - 4 posts") is flagged by the same
 *    pattern. Deliberate — client copy wants an en dash there — but it is a
 *    sharp edge, so it is pinned as a unit expectation below rather than left
 *    for whoever adds the first one to discover.
 *  • The default is FLAGGED. Non-message positions are excluded by what they
 *    ARE (an `===` operand, a `case` label, an argument to `console.*`, a
 *    staff-gated JSX region), not by which file they are in. There is no path
 *    allowlist, because a narrower QUESTION did the work a path allowlist would
 *    have done badly — an earlier shape of this sweep flagged the admin alert
 *    email in `publishIntegrationAction` and the `[KarosCMO] New client access
 *    request` subject line, both operator mail sent from a client-reachable
 *    action, and the fix was to stop scanning side effects rather than to name
 *    two files.
 *
 * Comments are never scanned: every string here comes from the TypeScript AST,
 * so the explanations above and the ones this fix left in the source (which
 * quote the exact banned spellings) cannot make their own guard red. The one
 * regex sweep below strips comments the way the status sweeps already do.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const src = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** Source with comments removed — the status sweeps' helper, same reason. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.tsx?$/.test(f)) out.push(f);
  }
  return out;
}

const parse = (abs: string) =>
  ts.createSourceFile(
    abs,
    readFileSync(abs, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const lineOf = (sf: ts.SourceFile, pos: number) =>
  sf.getLineAndCharacterOfPosition(pos).line + 1;

/** src-relative path of a parsed file — a chunk names the file it came FROM. */
const relOf = (sf: ts.SourceFile) => sf.fileName.slice(SRC.length + 1);

/**
 * A string this reader never sees, recognised by what it IS.
 *
 * `console.*` goes to a server log. An `===` operand or a `case` label is a
 * comparison against a stored value, not text — which is what lets the enum
 * rule below be strict about prose without forbidding the code that reads the
 * enum. Nothing here is file-based.
 */
function nonMessagePosition(n: ts.Node): string | null {
  const p = n.parent;
  if (
    p &&
    ts.isBinaryExpression(p) &&
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(p.operatorToken.kind)
  ) {
    return "compared against a stored value";
  }
  if (p && ts.isCaseClause(p)) return "a case label";
  // A VALUE SELECTION, not prose: a ternary whose OTHER branch is also a member of
  // the same stored union is picking a value, not writing a sentence — e.g.
  // `task.source === "manual" ? "client_managed" : "karos_managed"`, whose type IS
  // TaskOwner. Widening the render walk (correctly) surfaced four of these, and
  // "the enclosing function returns the union" is not checkable from text alone;
  // "my sibling branch is the same union" is, and it is the property that actually
  // distinguishes a lookup from a message.
  if (p && ts.isConditionalExpression(p)) {
    const sibling = p.whenTrue === n ? p.whenFalse : p.whenTrue;
    if (ts.isStringLiteralLike(sibling)) {
      const both = [n, sibling].map((x) => (x as ts.StringLiteralLike).text);
      if (both.every((t) => STORED_ENUM_TOKENS.includes(t))) return "a value selection";
    }
  }
  for (let q: ts.Node | undefined = n; q; q = q.parent) {
    if (ts.isCallExpression(q) && /^console\./.test(q.expression.getText())) return "a server log";
  }
  return null;
}

/**
 * Is this text a REFUSAL PAYLOAD — the thing a caller receives, rather than a
 * value stored under some key?
 *
 * The distinction the enum rule needs. `offences` used to gate the enum half on
 * prose, so `return { error: "review_pending" }` escaped it: one word, no two
 * adjacent letters-runs, straight into a client's error banner. But dropping the
 * prose gate outright would flag `return { ok: true, status: "review_pending" }`,
 * which is a stored value being reported and legal. The line between them is
 * POSITION: walking out to the `return`/`throw`, did we pass a property key that
 * is not `error`/`message`?
 *
 * "Is there a `return` above it" is the wrong question, and answering that one
 * first made this flag fourteen legitimate lines — `send("posted_with_edits")`
 * in an onClick, `<option value="KAROS_ADMIN">` — because every one of them sits
 * somewhere under a component's own `return (<div>…)`. The walk therefore stops
 * at the first boundary that means "the return above this is not mine":
 *
 *  • a FUNCTION boundary. The `return` beyond an enclosing arrow or function
 *    belongs to that function, not to this expression. An arrow whose body IS
 *    the expression is the exception, since `() => "text"` returns it.
 *  • a JSX boundary. A string inside JSX is rendered copy, and rendered copy is
 *    judged by the prose test, not as a caller's payload — which keeps
 *    `value="KAROS_ADMIN"` legal without an attribute allowlist.
 */
function isPayloadPosition(n: ts.Node): boolean {
  let child: ts.Node = n;
  for (let q: ts.Node | undefined = n.parent; q; child = q, q = q.parent) {
    if (
      ts.isJsxElement(q) ||
      ts.isJsxSelfClosingElement(q) ||
      ts.isJsxFragment(q) ||
      ts.isJsxAttribute(q) ||
      ts.isJsxExpression(q)
    ) {
      return false;
    }
    if (ts.isPropertyAssignment(q)) {
      const key = q.name.getText();
      if (!/^["']?(error|message)["']?$/.test(key)) return false;
    }
    if (ts.isReturnStatement(q) || ts.isThrowStatement(q)) return true;
    // `child === n` matters: in `() => send("posted_with_edits")` the arrow's
    // body IS the call, so `q.body === child` alone called an ARGUMENT a return
    // value and flagged eight legitimate click handlers.
    if (ts.isArrowFunction(q)) return q.body === child && child === n;
    if (ts.isFunctionDeclaration(q) || ts.isFunctionExpression(q) || ts.isMethodDeclaration(q)) {
      return false;
    }
  }
  return false;
}

interface Chunk {
  /** The string as a READER receives it, interpolations stood in for. */
  shape: string;
  /** Where it lives, so a failure names the file it must be fixed in. */
  rel: string;
  line: number;
  /** True when a caller receives this as its result — see isPayloadPosition. */
  payload: boolean;
  /** True for JSX text, whose newlines the browser collapses to a space. */
  jsx: boolean;
}

/**
 * Stands in for an interpolated value. NON-SPACE on purpose, and this is exactly
 * where the first version of this helper went wrong twice over.
 *
 * `${x}` renders as visible text, so the reader of `` `${a} - ${b}` `` sees a
 * spaced hyphen between two words. Substituting a SPACE for the interpolation
 * turns that into `"  -  "`, which no `\S - \S` pattern can match, and the
 * offence disappears. A `+` chain is the mirror image: concatenation inserts
 * nothing, so joining its parts with a space invented a second space after the
 * hyphen in `"…(or Integrations tab) - " + "you will be prompted…"` and hid a
 * live leak. Interpolations get a non-space stand-in; `+` gets nothing.
 */
// Written as an ESCAPE, never as a literal byte. A literal NUL in source makes
// the whole file binary to grep -- `file` reports "data" and every pattern
// silently finds nothing, which is guard zone 12 and the second relapse of it in
// this campaign. That matters more than it looks: this campaign's recon is
// grep-based, so a file grep cannot read is a file the next reader cannot survey.
// U+FFFC OBJECT REPLACEMENT CHARACTER is the semantically right stand-in for an
// embedded interpolation, is not a space, and cannot occur in real copy.
const INTERPOLATED = "\uFFFC";

/**
 * Every message string under `node`, rendered the way a READER receives it.
 *
 * ONE MESSAGE MEANS ONE SHAPE, and the three ways this codebase splits a
 * sentence across several literals are all joined back before anything is asked
 * of it. This is not a detail — it is where three live offences hid from earlier
 * versions of this very sweep:
 *
 *  • INTERPOLATIONS get a non-space stand-in (see above).
 *  • `+` CHAINS are joined with NOTHING, because that is what concatenation
 *    inserts. `GMAIL_UNAVAILABLE_MESSAGE` is four literals, and its hyphen sat
 *    at the END of the second one with the word that follows it in the third.
 *  • JSX WRAPS. A source line break inside JSX text is whitespace the browser
 *    collapses to a single space, so `"…all six now -\n          you can…"` is
 *    read as "…all six now - you can…". A per-line test sees a hyphen at
 *    end-of-line with nothing after it and passes. `jsx` chunks are normalised
 *    the way the renderer normalises them, which is the only reason the
 *    onboarding wizard's step-3 blurb was catchable at all.
 */
function messageChunks(node: ts.Node, sf: ts.SourceFile): Chunk[] {
  const out: Chunk[] = [];

  /** The rendered shape of a text expression, or null if it is not one. */
  const shapeOf = (n: ts.Node): { shape: string; pos: number; jsx: boolean } | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      return { shape: n.text, pos: n.getStart(sf), jsx: false };
    }
    if (ts.isJsxText(n)) return { shape: n.text, pos: n.getStart(sf), jsx: true };
    if (ts.isTemplateExpression(n)) {
      let s = n.head.text;
      for (const span of n.templateSpans) s += INTERPOLATED + span.literal.text;
      return { shape: s, pos: n.head.getStart(sf), jsx: false };
    }
    if (ts.isParenthesizedExpression(n)) return shapeOf(n.expression);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = shapeOf(n.left);
      const r = shapeOf(n.right);
      // A half that is not text is an interpolated value: `"a " + count + " b"`
      // reads exactly like a template, so it gets the same stand-in rather than
      // being dropped (dropping it is what invents adjacency that isn't there).
      if (!l && !r) return null;
      return {
        shape: (l?.shape ?? INTERPOLATED) + (r?.shape ?? INTERPOLATED),
        pos: (l ?? r)!.pos,
        jsx: false,
      };
    }
    return null;
  };

  const visit = (n: ts.Node) => {
    const isTextNode =
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isJsxText(n) ||
      ts.isTemplateExpression(n) ||
      (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken);
    const shaped = isTextNode ? shapeOf(n) : null;
    if (shaped) {
      if (!nonMessagePosition(n)) {
        out.push({
          shape: shaped.shape,
          rel: relOf(sf),
          line: lineOf(sf, shaped.pos),
          payload: isPayloadPosition(n),
          jsx: shaped.jsx,
        });
      }
      // Interpolated expressions are still code and may hold their own messages,
      // so they are walked; the literal parts have been consumed above.
      const walkExprs = (x: ts.Node) => {
        if (ts.isTemplateExpression(x)) for (const s of x.templateSpans) visit(s.expression);
        else if (ts.isBinaryExpression(x)) {
          walkExprs(x.left);
          walkExprs(x.right);
        } else if (ts.isParenthesizedExpression(x)) walkExprs(x.expression);
        else if (!ts.isStringLiteral(x) && !ts.isNoSubstitutionTemplateLiteral(x) && !ts.isJsxText(x)) {
          visit(x);
        }
      };
      walkExprs(n);
      return;
    }
    n.forEachChild(visit);
  };
  visit(node);
  return out;
}

/**
 * The database's own snake_case vocabulary, read off `types.ts`'s string-literal
 * unions rather than typed out here.
 *
 * DERIVED, so a new stored enum is covered the day it is declared, and so this
 * cannot pin a spelling: renaming `review_pending` renames what is forbidden.
 * snake_case only — a single-word member like `"pending"` or `"posted"` is also
 * ordinary English, and forbidding it would make "this task is pending" a
 * failure. The shape being caught is a value that looks like a database row,
 * which in this schema means it carries an underscore.
 */
const STORED_ENUM_TOKENS = (() => {
  const sf = parse(join(SRC, "lib/types.ts"));
  const found = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal) && n.literal.text.includes("_")) {
      found.add(n.literal.text);
    }
    n.forEachChild(collect);
  };
  collect(sf);
  return [...found];
})();

/** Two adjacent words — the test for "this string is prose, not a token". */
const IS_PROSE = /[A-Za-z]{2,}[ \t]+[A-Za-z]{2,}/;

/**
 * The two rules, asked of one rendered shape.
 *
 * `jsx` collapses source line breaks the way a browser does, BEFORE the per-line
 * split; `payload` widens the enum half from prose to "anything a caller
 * receives as its result".
 */
function offences(shape: string, opts: { payload?: boolean; jsx?: boolean } = {}): string[] {
  const out: string[] = [];
  const text = opts.jsx ? shape.replace(/[ \t]*\n[ \t]*/g, " ") : shape;
  for (const line of text.split("\n")) {
    // A markdown bullet opens with "- ", which is list syntax and not punctuation.
    if (/^\s*-\s/.test(line)) continue;
    if (/\S[ \t]-[ \t]\S/.test(line)) {
      out.push("spaced hyphen — use an em dash");
      break;
    }
  }
  if (IS_PROSE.test(text) || opts.payload) {
    for (const token of STORED_ENUM_TOKENS) {
      if (new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`).test(text)) {
        out.push(`the stored value "${token}" as prose`);
        break;
      }
    }
  }
  return out;
}

const say = (c: Chunk) => offences(c.shape, { payload: c.payload, jsx: c.jsx });

describe("the two rules themselves", () => {
  it("read the database's vocabulary, so the enum rule is not decorative", () => {
    // Without this the enum half is unfalsifiable in the quietest way: if the
    // union walk over types.ts ever returns nothing, every sweep below reports
    // no offences because it is asking about an empty set of words.
    expect(STORED_ENUM_TOKENS.length, "read no stored enum values from types.ts").toBeGreaterThan(20);
    // Derived, not pinned: whichever token the schema actually declares, in
    // prose it is an offence, and alone it is not — that second half is the one
    // that keeps `t.owner === "karos_managed"` legal code.
    const token = STORED_ENUM_TOKENS[0]!;
    expect(offences(`This task is not ${token} yet`)).toHaveLength(1);
    expect(offences(token)).toEqual([]);
    // …unless it is what the caller RECEIVES, which is the hole the prose gate
    // left open: `return { error: "review_pending" }` is one word and reaches a
    // client's error banner verbatim.
    expect(offences(token, { payload: true })).toHaveLength(1);
  });

  it("tells a spaced hyphen from a list bullet and from arithmetic", () => {
    expect(offences("Nothing changed - try again")).toHaveLength(1);
    expect(offences("  - a bullet - inside a list")).toEqual([]);
    // An em dash is the point of the rule, so it must not itself trip.
    expect(offences("Nothing changed — try again")).toEqual([]);
  });

  it("flags a spaced-hyphen NUMERIC RANGE too, and that is on purpose", () => {
    // A known sharp edge, stated rather than discovered by whoever trips it:
    // "3 - 4 posts" is the same `\S - \S` shape and is flagged. In client copy
    // that range wants an en dash, so the fix is `3–4`, not an exemption — and
    // the existing copy already writes it that way ("~10–25 min").
    expect(offences("3 - 4 posts a week")).toHaveLength(1);
    expect(offences("3–4 posts a week")).toEqual([]);
  });

  it("reads a JSX wrap the way the browser does", () => {
    // The onboarding wizard's step-3 blurb, verbatim in shape: the hyphen ends a
    // source line and the word that follows it opens the next. Per-line, no
    // offence. As rendered, a spaced hyphen.
    const wrapped = "Connect one, some, or all now -\n          you can add the rest later.";
    expect(offences(wrapped), "a per-line scan is blind to this").toEqual([]);
    expect(offences(wrapped, { jsx: true })).toHaveLength(1);
    // And normalising must not INVENT one: a hyphen that ends the whole text, or
    // a bullet list, still reads clean.
    expect(offences("Trailing dash -", { jsx: true })).toEqual([]);
  });
});

/* ── channel 1: what a client's copilot tools hand the model ───────────────── */

const CHAT_ROUTE = "app/api/clients/[id]/chat/route.ts";

/**
 * The allowlist, IMPORTED rather than parsed.
 *
 * It used to be scraped with `/"([a-z_]+)"/g`, which is a partial parse wearing
 * a total one's clothes: a future `"x_agent2"` or `"createTasks"` matches
 * nothing and vanishes from this channel silently, and the `length > 5`
 * non-vacuity check still passes with one of nine missing. The module is
 * type-only in its imports, so there is nothing to parse around.
 */
const CLIENT_TOOLS: readonly string[] = CLIENT_SAFE_COPILOT_TOOLS;

/** `execute` body per registry key, discovered from the route's own wiring. */
const CLIENT_TOOL_EXECUTES = (() => {
  const sf = parse(join(SRC, CHAT_ROUTE));
  const registry = new Map<string, string>();
  const byVar = new Map<string, ts.Node>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "copilotToolsFor") {
      const arg = n.arguments[1];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (ts.isPropertyAssignment(p)) registry.set(p.name.getText(sf), p.initializer.getText(sf));
        }
      }
    }
    if (
      ts.isVariableDeclaration(n) &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      n.initializer.expression.getText(sf) === "tool"
    ) {
      const arg = n.initializer.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const ex = arg.properties.find((p) => p.name?.getText(sf) === "execute");
        if (ex) byVar.set(n.name.getText(sf), ex);
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);

  /**
   * The exported string constants a client tool RETURNS, followed out of the
   * route into whichever module holds them.
   *
   * A refusal factored into a constant is still text the tool hands the model,
   * and the first version of this sweep could not see one: `fetch_gmail_context`
   * returns `GMAIL_UNAVAILABLE_MESSAGE`, which lives in copilot-tool-access.ts
   * and carried the exact spaced hyphen this file exists to forbid. Only
   * identifiers this tool actually mentions are followed, and only exported
   * consts whose initializer is text — so this widens the CHANNEL without
   * widening it into unrelated files.
   */
  const referenced = (ex: ts.Node) => {
    const names = new Set<string>();
    const collect = (n: ts.Node) => {
      if (ts.isIdentifier(n)) names.add(n.text);
      n.forEachChild(collect);
    };
    collect(ex);
    return names;
  };
  const constChunks = (names: Set<string>): Chunk[] => {
    const found: Chunk[] = [];
    for (const abs of walk(SRC)) {
      if (abs.includes("__tests__")) continue;
      const s = parse(abs);
      s.forEachChild((n) => {
        if (!ts.isVariableStatement(n)) return;
        if (!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
        for (const d of n.declarationList.declarations) {
          if (!d.initializer || !names.has(d.name.getText(s))) continue;
          // A constant a tool returns IS the tool's result, however it is
          // spelled at the declaration site.
          found.push(...messageChunks(d.initializer, s).map((c) => ({ ...c, payload: true })));
        }
      });
    }
    return found;
  };

  const out = new Map<string, Chunk[]>();
  for (const name of CLIENT_TOOLS) {
    const v = registry.get(name);
    const ex = v ? byVar.get(v) : undefined;
    out.set(name, ex ? [...messageChunks(ex, sf), ...constChunks(referenced(ex))] : []);
  }
  return out;
})();

describe("what a client's copilot tools hand the model", () => {
  it("found an execute body for every allowlisted tool", () => {
    // Non-vacuity, and the load-bearing kind: the scan below walks a discovered
    // registry, so a rename anywhere in that chain would leave every tool with
    // an empty body and the sweep would pass by finding nothing. This is the
    // assertion that turns that into a failure. Exact count, not a floor —
    // "more than five of nine" is a green tick over a missing tool.
    expect(CLIENT_TOOLS.length, "the allowlist changed size").toBe(9);
    for (const name of CLIENT_TOOLS) {
      expect(
        CLIENT_TOOL_EXECUTES.get(name)!.length,
        `no execute body found for the allowlisted tool ${name}`,
      ).toBeGreaterThan(0);
    }
  });

  it("puts no spaced hyphen and no stored enum in any of them", () => {
    // THE rule, over the whole channel. `create_tasks` and `fetch_gmail_context`
    // are where it kept breaking: five of these strings carried `" - "` and one
    // read "N karos_managed dropped - AI queue capacity (15 active) reached",
    // handing a paying client's model a Firestore word to paraphrase.
    const bad: string[] = [];
    for (const [name, chunks] of CLIENT_TOOL_EXECUTES) {
      for (const c of chunks) {
        for (const o of say(c)) {
          bad.push(`${name} (${c.rel}:${c.line}) — ${o}: ${JSON.stringify(c.shape.slice(0, 90))}`);
        }
      }
    }
    expect(bad, "client tool results the model will paraphrase").toEqual([]);
  });

  it("scanned enough of the route to be able to fail", () => {
    // The other half of non-vacuity: the bodies were found AND they contain a
    // realistic amount of prose, so "no offences" is a statement about text
    // rather than about an almost-empty scan.
    const all = [...CLIENT_TOOL_EXECUTES.values()].flat();
    expect(all.length).toBeGreaterThan(80);
    expect(all.filter((c) => IS_PROSE.test(c.shape)).length).toBeGreaterThan(30);
  });
});

/* ── channel 2: the refusals a client session gets back ───────────────────── */

interface ActionScan {
  name: string;
  rel: string;
  chunks: Chunk[];
}

/**
 * Every exported action with no staff/admin gate, and only the strings its
 * return/throw contract carries.
 *
 * FOLLOWED THROUGH MODULE-PRIVATE HELPERS. The export list is not the data flow.
 * `parseFallback` in linkedin-agent-actions.ts is not exported, so an
 * export-shaped scan stops at its name — and both of its refusals ("Paste the
 * piece of writing - it is how we learn a real voice…" and its sibling) were
 * returned VERBATIM by two ungated actions, in the very file where five other
 * strings had just been fixed. Two forms are followed, because those are the two
 * the codebase uses:
 *
 *    return helper(x);                       // the call is the return value
 *    const r = helper(x); … return r;        // a local holds it for one branch
 *
 * A refusal returned from a private helper into a client action's return value
 * IS that action's return value, and the guard has to read it that way or the
 * next helper hides the next leak.
 */
const CLIENT_REACHABLE_ACTIONS: ActionScan[] = (() => {
  const out: ActionScan[] = [];
  for (const abs of walk(join(SRC, "lib/actions"))) {
    if (abs.includes("__tests__")) continue;
    const sf = parse(abs);

    /** Module-private function declarations — the ones an export scan misses. */
    const privateFns = new Map<string, ts.FunctionDeclaration>();
    sf.forEachChild((n) => {
      if (
        ts.isFunctionDeclaration(n) &&
        n.name &&
        n.body &&
        !n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        privateFns.set(n.name.getText(sf), n);
      }
    });

    sf.forEachChild((n) => {
      if (
        !ts.isFunctionDeclaration(n) ||
        !n.name ||
        !n.body ||
        !n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        return;
      }
      if (/\brequireStaff\s*\(|\brequireAdmin\s*\(/.test(n.body.getText(sf))) return;

      const chunks: Chunk[] = [];
      const followed = new Set<string>();

      /** `const x = <expr>` declared anywhere in this function body. */
      const locals = new Map<string, ts.Expression>();
      const collectLocals = (x: ts.Node) => {
        if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.initializer) {
          locals.set(x.name.getText(sf), x.initializer);
        }
        x.forEachChild(collectLocals);
      };
      collectLocals(n.body);

      const collectFrom = (e: ts.Expression | undefined): void => {
        if (!e) return;
        if (ts.isStringLiteral(e) || ts.isTemplateExpression(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
          chunks.push(...messageChunks(e, sf));
          return;
        }
        if (ts.isParenthesizedExpression(e)) return collectFrom(e.expression);
        if (ts.isConditionalExpression(e)) {
          collectFrom(e.whenTrue);
          collectFrom(e.whenFalse);
          return;
        }
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          collectFrom(e.left);
          collectFrom(e.right);
          return;
        }
        if (ts.isObjectLiteralExpression(e)) {
          for (const p of e.properties) {
            if (ts.isPropertyAssignment(p) && /^(error|message)$/.test(p.name.getText(sf))) {
              collectFrom(p.initializer);
            }
          }
          return;
        }
        // `return helper(...)`
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
          return followPrivate(e.expression.getText(sf));
        }
        // `const r = helper(...); … return r;`
        if (ts.isIdentifier(e)) {
          const init = locals.get(e.getText(sf));
          if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
            return followPrivate(init.expression.getText(sf));
          }
        }
      };

      function followPrivate(name: string): void {
        if (followed.has(name)) return;
        followed.add(name);
        const fn = privateFns.get(name);
        if (!fn?.body) return;
        const inner = (x: ts.Node) => {
          if (ts.isReturnStatement(x)) collectFrom(x.expression);
          if (ts.isThrowStatement(x)) chunks.push(...messageChunks(x, sf));
          x.forEachChild(inner);
        };
        inner(fn.body);
      }

      const visit = (x: ts.Node) => {
        if (ts.isReturnStatement(x)) collectFrom(x.expression);
        if (ts.isThrowStatement(x)) chunks.push(...messageChunks(x, sf));
        x.forEachChild(visit);
      };
      visit(n.body);
      out.push({ name: n.name.getText(sf), rel: abs.slice(SRC.length + 1), chunks });
    });
  }
  return out;
})();

describe("the refusals a client session gets back from a server action", () => {
  it("found the ungated actions and their contract strings", () => {
    // Non-vacuity: the gate test and the contract walk both work. If either
    // broke, every list below would be empty and the rule would look kept.
    expect(CLIENT_REACHABLE_ACTIONS.length, "found no ungated actions").toBeGreaterThan(40);
    const withProse = CLIENT_REACHABLE_ACTIONS.flatMap((a) => a.chunks).filter((c) =>
      IS_PROSE.test(c.shape),
    );
    expect(withProse.length, "found no refusal prose to check").toBeGreaterThan(80);
  });

  it("reaches into the module-private helpers those actions return", () => {
    // Non-vacuity for the follow, named: without it this channel reported clean
    // on a file that had two live offences in it. `addLinkedInSeatAction` reaches
    // `parseFallback` only through `const fallback = …; return fallback;`, so
    // the local-`const` form has to work, not just `return helper(x)`.
    const seat = CLIENT_REACHABLE_ACTIONS.find((a) => a.name === "addLinkedInSeatAction");
    expect(seat, "addLinkedInSeatAction is no longer an ungated action").toBeTruthy();
    expect(
      seat!.chunks.some((c) => /how we learn a real voice/.test(c.shape)),
      "the private helper's refusal is not in this action's contract",
    ).toBe(true);
  });

  it("still finds the staff-gated ones, so the gate is doing work", () => {
    // The neighbouring case. "No offences" must not be true because the gate
    // regex matched everything and left nothing in scope.
    const gated = walk(join(SRC, "lib/actions"))
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => /\brequireStaff\s*\(|\brequireAdmin\s*\(/.test(readFileSync(f, "utf8")));
    expect(gated.length).toBeGreaterThan(5);
    const scanned = new Set(CLIENT_REACHABLE_ACTIONS.map((a) => a.name));
    // approveAssetAction opens with `await requireStaff()`, and its own throws
    // legitimately keep a spaced hyphen ("Client has not enabled auto-scheduling
    // - approve as manual/placeholder…"). It must be OUT of scope, or this
    // sweep would be rewriting an operator's words to fix a client's problem.
    expect(scanned.has("approveAssetAction")).toBe(false);
    expect(scanned.has("clientRescheduleAssetAction")).toBe(true);
  });

  it("puts no spaced hyphen and no stored enum in any of them", () => {
    // Where this broke: `clientRescheduleAssetAction` said "give it a moment"
    // after a spaced hyphen while its two neighbouring refusals in the same
    // function used em dashes, and four refusals in execution-actions.ts
    // returned "Task is not in review_pending state" to a client's task card.
    const bad: string[] = [];
    for (const a of CLIENT_REACHABLE_ACTIONS) {
      for (const c of a.chunks) {
        for (const o of say(c)) {
          bad.push(`${a.name} (${c.rel}:${c.line}) — ${o}: ${JSON.stringify(c.shape.slice(0, 90))}`);
        }
      }
    }
    expect(bad, "these are rendered verbatim in a client's error banner").toEqual([]);
  });
});

/* ── channel 4: the launch form a client fills in ─────────────────────────── */

describe("the launch-form copy a client reads", () => {
  // `ALL_LAUNCH_PROFILES` is exported by custom-agent-launch.ts expressly "so
  // guard tests can sweep the whole set", and the client agent detail page reads
  // it through `launchProfileFor`. So the channel is already characterised by
  // the module itself, and it is checked BEHAVIOURALLY here rather than against
  // source — the values are what a client reads.
  //
  // This channel exists because the three named findings did not mention it and
  // it was carrying the defect anyway: the LinkedIn, X and Reddit launch intros
  // all read "built from that data - this form only scopes the run".
  const strings = ALL_LAUNCH_PROFILES.flatMap((p) => [
    p.eyebrow,
    p.intro,
    p.attachments?.hint,
    ...p.fields.flatMap((f) => [f.label, f.helper, f.placeholder, f.defaultValue]),
    // The quick-start chips are plain strings, and they go into the agent's
    // prompt as well as onto the client's screen.
    ...(p.quickStarts ?? []),
  ]).filter((s): s is string => typeof s === "string" && s.length > 0);

  it("found the profile table", () => {
    // Non-vacuity: a shape change in the profile type would otherwise empty this
    // list and the rule below would hold over nothing.
    expect(ALL_LAUNCH_PROFILES.length).toBeGreaterThan(3);
    expect(strings.length).toBeGreaterThan(40);
  });

  it("carries no spaced hyphen and no stored enum", () => {
    const bad = strings.flatMap((s) => offences(s).map((o) => `${o}: ${JSON.stringify(s.slice(0, 90))}`));
    expect(bad).toEqual([]);
  });
});

/* ── channel 3: the branded client email wrapper ──────────────────────────── */

describe("the branded client email wrapper", () => {
  const chunks: Chunk[] = (() => {
    const sf = parse(join(SRC, "lib/email.ts"));
    const found: Chunk[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.getText(sf) === "emailShell" && n.body) {
        found.push(...messageChunks(n.body, sf));
      }
      n.forEachChild(visit);
    };
    visit(sf);
    return found;
  })();

  it("found emailShell", () => {
    // Non-vacuity: an empty body list would make the negative below pass because
    // there was nothing to read, which is what a rename would look like.
    expect(chunks.length, "emailShell no longer exists under that name").toBeGreaterThan(0);
  });

  it("keeps its footer free of a spaced hyphen", () => {
    // Its own docstring says "client-facing deliveries", and its one caller
    // mails a person outside Karos a registration decision. The footer read
    // "Reply to this email to request changes - your Karos team is on it."
    //
    // SCOPE: the wrapper's OWN prose. What a caller passes in as heading/intro/
    // body is that caller's copy, and whether that caller writes to a client is
    // a different question from whether this shell does.
    const bad = chunks.flatMap((c) => say(c).map((o) => `${c.line}: ${o}`));
    expect(bad).toEqual([]);
  });
});

/* ── channel 5: the pages and components a client's browser renders ────────── */

/**
 * Next.js's own render entry points. `route.ts` is deliberately absent: an HTTP
 * handler's body is JSON to a fetch caller, not page copy. See the SCOPE note at
 * the top for the one place that distinction leaks (the OAuth popup).
 */
const RENDER_ENTRY = /\/(page|layout|error|not-found|template|loading|global-error)\.tsx$/;

/**
 * A route module that restricts itself to staff, read off its own guard call.
 * `requireUser(["KAROS_ADMIN", …])` names the roles allowed; a list that opens
 * with a KAROS_ role is a staff page. Pages that call bare `requireUser()` and
 * then branch on `user.role === "CLIENT_USER"` are client-reachable and stay in.
 */
const STAFF_ROUTE_GATE = /\brequireStaff\s*\(|\brequireAdmin\s*\(|\brequireUser\s*\(\s*\[\s*"KAROS_/;

function resolveImport(spec: string, fromAbs: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromAbs), spec);
  else return null;
  for (const c of [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const importedFiles = (abs: string): string[] => {
  const sf = parse(abs);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && !st.importClause?.isTypeOnly) {
      const r = resolveImport(st.moduleSpecifier.text, abs);
      if (r) out.push(r);
    }
  }
  return out;
};

/**
 * A module the walk may follow.
 *
 * `src/app` needed BOTH forms, and the first version only had the entry one:
 * a route's body is routinely co-located beside its page as a non-entry file
 * (`tasks/tasks-body.tsx`, `calendar/calendar-body.tsx`), so requiring
 * RENDER_ENTRY under src/app made those dead ends — and the walk reported green
 * over the client's task board and content calendar, two of the surfaces this
 * channel exists for. Any .tsx under src/app is followable; only the ROOTS are
 * restricted to render entries.
 */
const isRenderModule = (abs: string) =>
  abs.startsWith(join(SRC, "components")) ||
  (abs.startsWith(join(SRC, "app")) && /\.tsx$/.test(abs));

const ALL_RENDER_ENTRIES = walk(join(SRC, "app")).filter((f) => RENDER_ENTRY.test(f));
const CLIENT_ROUTE_ROOTS = ALL_RENDER_ENTRIES.filter((f) => !STAFF_ROUTE_GATE.test(readFileSync(f, "utf8")));

/** The roots plus every component module they mount, transitively. */
const CLIENT_RENDER_MODULES = (() => {
  const seen = new Set<string>();
  const stack = [...CLIENT_ROUTE_ROOTS];
  while (stack.length) {
    const abs = stack.pop()!;
    if (seen.has(abs) || abs.includes("__tests__")) continue;
    seen.add(abs);
    for (const dep of importedFiles(abs)) if (isRenderModule(dep)) stack.push(dep);
  }
  return [...seen].sort();
})();

/**
 * Is this node inside a region only staff render?
 *
 * "Is there an `isAdmin` before it" is the wrong question. The right one is
 * whether the node sits INSIDE a conditional that is still open — the branch of
 * a ternary, the right operand of `&&`, the then-block of an `if` — whose test
 * is a staff predicate. That is what makes the seven admin-only credential hints
 * in the manual-credentials accordion out of scope while `platform.description`
 * two hundred lines away is in it.
 *
 * Returns the predicate text so a false positive can be diagnosed as "this gate
 * was not recognised" rather than as "this copy is wrong".
 */
const STAFF_PREDICATE = /\b(isAdmin|isStaff|isStaffViewer|isKarosStaff|staffOnly)\b|role\s*!==\s*"CLIENT_USER"|role\s*===\s*"KAROS_/;
const NOT_CLIENT_PREDICATE = /^!\s*(isClientViewer|viewerIsClient|isClient)\b/;
const CLIENT_PREDICATE = /^(isClientViewer|viewerIsClient|isClient)\b/;

function staffGatedRegion(n: ts.Node, sf: ts.SourceFile): string | null {
  for (let q: ts.Node | undefined = n; q; q = q.parent) {
    const p: ts.Node | undefined = q.parent;
    if (!p) break;
    if (ts.isConditionalExpression(p)) {
      const t = p.condition.getText(sf).trim();
      if (q === p.whenTrue && (STAFF_PREDICATE.test(t) || NOT_CLIENT_PREDICATE.test(t))) return t;
      // The client branch of `isClientViewer ? … : …` is the STAFF branch.
      if (q === p.whenFalse && CLIENT_PREDICATE.test(t)) return `!(${t})`;
    }
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      q === p.right
    ) {
      const t = p.left.getText(sf).trim();
      if (STAFF_PREDICATE.test(t) || NOT_CLIENT_PREDICATE.test(t)) return t;
    }
    if (ts.isIfStatement(p) && q === p.thenStatement) {
      const t = p.expression.getText(sf).trim();
      if (STAFF_PREDICATE.test(t) || NOT_CLIENT_PREDICATE.test(t)) return t;
    }
  }
  return null;
}

const RENDER_SCAN = (() => {
  const flagged: Chunk[] = [];
  const excluded: Array<Chunk & { gate: string }> = [];
  for (const abs of CLIENT_RENDER_MODULES) {
    const sf = parse(abs);
    const nodeAt = new Map<string, ts.Node>();
    const visit = (n: ts.Node) => {
      const isTextNode =
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isJsxText(n) ||
        ts.isTemplateExpression(n) ||
        (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken);
      if (isTextNode) {
        for (const c of messageChunks(n, sf)) {
          const key = `${c.line}:${c.shape}`;
          if (!nodeAt.has(key)) nodeAt.set(key, n);
          const gate = staffGatedRegion(n, sf);
          if (gate) excluded.push({ ...c, gate });
          else flagged.push(c);
        }
        return;
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return { flagged, excluded };
})();

describe("the pages and components a client's browser renders", () => {
  it("found the client-reachable route modules and the tree they mount", () => {
    // Non-vacuity, both halves. The roots must be a real subset — if the staff
    // gate stopped matching, every staff page would fall in and the sweep would
    // be a different (and much noisier) test than the one described above.
    expect(ALL_RENDER_ENTRIES.length, "found no route modules at all").toBeGreaterThan(30);
    expect(CLIENT_ROUTE_ROOTS.length).toBeGreaterThan(30);
    expect(
      CLIENT_ROUTE_ROOTS.length,
      "no route module reads as staff-only, so the gate matched nothing",
    ).toBeLessThan(ALL_RENDER_ENTRIES.length);
    // The named ones, in both directions: the staff jobs console is out, and the
    // page every new client sees is in.
    const rel = new Set(CLIENT_ROUTE_ROOTS.map((f) => f.slice(SRC.length + 1)));
    expect(rel.has("app/(app)/jobs/page.tsx"), "a requireUser([KAROS_…]) page is in scope").toBe(false);
    expect(rel.has("app/signup/page.tsx")).toBe(true);
    expect(rel.has("app/(onboarding)/onboarding/page.tsx")).toBe(true);
    // And the component tree: the wizard step and the Reddit review surface both
    // carried offences, so both have to be reachable from a root.
    const mods = new Set(CLIENT_RENDER_MODULES.map((f) => f.slice(SRC.length + 1)));
    expect(mods.has("components/onboarding-socials-step.tsx")).toBe(true);
    expect(mods.has("components/reddit-drafts-review.tsx")).toBe(true);
    expect(mods.has("components/integrations-tab.tsx")).toBe(true);
    expect(CLIENT_RENDER_MODULES.length).toBeGreaterThan(100);
  });

  it("scanned enough text to be able to fail", () => {
    const prose = RENDER_SCAN.flagged.filter((c) => IS_PROSE.test(c.shape));
    expect(prose.length, "found almost no rendered prose").toBeGreaterThan(500);
  });

  it("carries no spaced hyphen and no stored enum", () => {
    // Five live offences sat here while the four server-side channels were
    // green, one of them on the signup page every new client sees.
    const bad = RENDER_SCAN.flagged.flatMap((c) =>
      say(c).map((o) => `${c.rel}:${c.line} — ${o}: ${JSON.stringify(c.shape.replace(/\s+/g, " ").trim().slice(0, 90))}`),
    );
    expect(bad, "client-facing page and component copy").toEqual([]);
  });

  it("excludes staff-gated copy by the gate, not by the file", () => {
    // The other direction, and the reason this channel is safe to run at all:
    // staff components live in the same folder and keep their own punctuation.
    // If this recognised no gates, the sweep above would be pressuring somebody
    // to rewrite an operator's words — so the recogniser has to be doing work.
    expect(
      RENDER_SCAN.excluded.length,
      "recognised no staff-gated region anywhere in the client render tree",
    ).toBeGreaterThan(20);
  });
});

/* ── channel 6: the catalogs, by their own audience markers ────────────────── */

const AUDIENCE_MARKERS = ["@clientCopy", "@staffCopy", "@notCopy"] as const;

/** Does this member hold text? Only text fields need an audience. */
function isTextTyped(m: ts.PropertySignature): boolean {
  const t = m.type?.getText() ?? "";
  return /^(string|string\[\]|Array<string>)$/.test(t.trim());
}

interface MarkedCatalog {
  rel: string;
  iface: string;
  /** Members with no marker at all — the fail-closed list. */
  unmarked: string[];
  clientFields: Set<string>;
}

/**
 * Interfaces that carry audience markers, and the exported const literals typed
 * as them.
 *
 * Enrolment is by MARKING, which is opt-in and stated as such at the top. What
 * fails closed is a field added to an interface that is already enrolled: it has
 * no marker, so `unmarked` is non-empty and the first test below goes red asking
 * who reads it. That is the property that matters, because the way this defect
 * arrives is a new channel entry, not a new catalog.
 */
const MARKED_CATALOGS: MarkedCatalog[] = (() => {
  const out: MarkedCatalog[] = [];
  for (const abs of walk(join(SRC, "lib"))) {
    if (abs.includes("__tests__")) continue;
    const raw = readFileSync(abs, "utf8");
    if (!AUDIENCE_MARKERS.some((m) => raw.includes(m))) continue;
    const sf = parse(abs);
    sf.forEachChild((n) => {
      if (!ts.isInterfaceDeclaration(n)) return;
      const members = n.members.filter(ts.isPropertySignature);
      const marked = members.filter((m) => AUDIENCE_MARKERS.some((k) => m.getFullText(sf).includes(k)));
      if (marked.length === 0) return;
      out.push({
        rel: abs.slice(SRC.length + 1),
        iface: n.name.getText(sf),
        unmarked: members
          .filter((m) => isTextTyped(m) && !AUDIENCE_MARKERS.some((k) => m.getFullText(sf).includes(k)))
          .map((m) => m.name.getText(sf)),
        clientFields: new Set(
          marked
            .filter((m) => m.getFullText(sf).includes("@clientCopy"))
            .map((m) => m.name.getText(sf)),
        ),
      });
    });
  }
  return out;
})();

/** Every `@clientCopy` field value in every const literal typed as a marked interface. */
const CATALOG_CHUNKS: Chunk[] = (() => {
  const byFile = new Map<string, MarkedCatalog[]>();
  for (const c of MARKED_CATALOGS) {
    if (!byFile.has(c.rel)) byFile.set(c.rel, []);
    byFile.get(c.rel)!.push(c);
  }
  const found: Chunk[] = [];
  for (const [rel, catalogs] of byFile) {
    const sf = parse(join(SRC, rel));
    const wanted = new Set(catalogs.flatMap((c) => [...c.clientFields]));
    const ifaceNames = new Set(catalogs.map((c) => c.iface));
    sf.forEachChild((n) => {
      if (!ts.isVariableStatement(n)) return;
      for (const d of n.declarationList.declarations) {
        const typeText = d.type?.getText(sf) ?? "";
        if (![...ifaceNames].some((i) => new RegExp(`\\b${i}\\b`).test(typeText))) continue;
        if (!d.initializer) continue;
        const visit = (x: ts.Node) => {
          if (ts.isPropertyAssignment(x) && wanted.has(x.name.getText(sf))) {
            found.push(...messageChunks(x.initializer, sf));
            return;
          }
          x.forEachChild(visit);
        };
        visit(d.initializer);
      }
    });
  }
  return found;
})();

describe("the catalogs a client reads through somebody else's render", () => {
  it("has an audience for every text field in an enrolled interface", () => {
    // FAIL CLOSED. An unmarked text field is not skipped, it is a failure —
    // "which audience reads this" is the question the person adding the field is
    // the only one who can answer, and answering it by guessing from render
    // sites is what made seven admin-only credential hints look like client copy.
    const missing = MARKED_CATALOGS.filter((c) => c.unmarked.length > 0).map(
      (c) => `${c.rel} ${c.iface}: ${c.unmarked.join(", ")}`,
    );
    expect(missing, "mark each with @clientCopy, @staffCopy or @notCopy").toEqual([]);
  });

  it("found the enrolled catalogs and their client fields", () => {
    // Non-vacuity: enrolment is discovered, so a renamed marker or a moved
    // interface would empty this and the sweep would hold over nothing.
    expect(MARKED_CATALOGS.length, "no interface carries audience markers").toBeGreaterThan(2);
    const enrolled = new Set(MARKED_CATALOGS.map((c) => `${c.rel}#${c.iface}`));
    expect(enrolled.has("lib/integrations/platforms.ts#PlatformConfig")).toBe(true);
    expect(enrolled.has("lib/agent-service/products.ts#ManagedProduct")).toBe(true);
    // And the audience split is real: the credential hints must NOT be swept, or
    // this channel would be rewriting operator copy.
    const platformFields = MARKED_CATALOGS.filter((c) => c.rel === "lib/integrations/platforms.ts");
    const clientFields = new Set(platformFields.flatMap((c) => [...c.clientFields]));
    expect(clientFields.has("description")).toBe(true);
    expect(clientFields.has("hint"), "hint is admin-only accordion copy").toBe(false);
    expect(CATALOG_CHUNKS.length, "swept no catalog values").toBeGreaterThan(20);
  });

  it("carries no spaced hyphen and no stored enum in its client fields", () => {
    // PLATFORM_REGISTRY's LinkedIn Company Page line read "…post analytics - a
    // separate LinkedIn app from personal posting (Community Management API)",
    // rendered ungated in the card header and the "Add a channel" list on a page
    // a CLIENT_USER reaches; Reddit's read "(draft-first - never auto-posts)".
    // MANAGED_PRODUCTS carried two more that no screen renders at all — they
    // reach the client through the copilot's system prompt.
    const bad = CATALOG_CHUNKS.flatMap((c) =>
      say(c).map((o) => `${c.rel}:${c.line} — ${o}: ${JSON.stringify(c.shape.slice(0, 90))}`),
    );
    expect(bad).toEqual([]);
  });
});

/* ── the capacity note: one rule, one home ───────────────────────────────── */

describe('the "the cap stopped N of these" note', () => {
  const HOME = "lib/task-dedup.ts";

  it("is composed in one place, and reads as client copy", () => {
    expect(queueCapacitySkipNote(3)).toContain("3");
    expect(queueCapacitySkipNote(3)).toContain("—");
    expect(queueCapacitySkipNote(3)).not.toContain(" - ");
    expect(queueCapacitySkipNote(3)).not.toContain("karos_managed");
  });

  it("says WHOSE queue is full, because the cap only counts one kind of task", () => {
    // The consolidation trap. Three spellings became one, and the one read "N
    // not added — your task queue is at its 15-task limit" — which is false.
    // MAX_ACTIVE_TASKS bounds ACTIVE karos_managed tasks only; a client's own
    // client_managed tasks never count and are never blocked (the policy
    // docstring at the top of task-dedup.ts, `computeBoardCapacity`, and the
    // system prompt all say so). So a client looking at twenty of their own
    // tasks was told their queue was full at fifteen. Giving three spellings one
    // home was right; one home also means one place for a scope error to be
    // wrong everywhere at once.
    //
    // Asked as "does it name the owner", not as a pinned sentence: reword it
    // freely, but a note that does not say whose limit this is cannot be true.
    expect(
      queueCapacitySkipNote(3),
      "the cap counts only Karos-run tasks, so the note has to say so",
    ).toMatch(/Karos/);
  });

  it("is not re-spelled anywhere else in src", () => {
    // The defect was a COUNT, and no per-surface test could have found it: three
    // surfaces composed this note themselves and wrote it three ways, all
    // reaching a client — two copilot tools and the swarm's persisted note,
    // which the war-room console prints verbatim inside the CLIENT dock.
    //
    // Asked as "who else writes this note", not as "who says the old words", so
    // a FOURTH surface inventing a fresh wording fails here too.
    //
    // Over STRING LITERALS, via the AST, for two reasons. Comments: the
    // docstring at HOME quotes all three retired spellings, and a raw-text sweep
    // would be kept green by deleting the explanation. And CODE: the first shape
    // of this sweep ran over source text and flagged both callers — because
    // `capSkipped > 0 ? queue…` contains "skipped" forty characters before
    // "queue". A guard that matches the call site it is meant to bless is worse
    // than none.
    //
    // Non-vacuity is built in: HOME's own literal is what the expectation names,
    // so a broken walk or a pattern that matches nothing fails here rather than
    // reporting an empty offender list.
    const SAYS_THE_CAP_STOPPED_IT = (s: string) =>
      /(deferred|dropped|not added)/i.test(s) && /(queue|capacity|limit)/i.test(s);
    const offenders = walk(SRC)
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => {
        const sf = parse(f);
        let hit = false;
        const visit = (n: ts.Node) => {
          if (hit) return;
          for (const c of messageChunks(n, sf)) if (SAYS_THE_CAP_STOPPED_IT(c.shape)) hit = true;
          if (!hit) n.forEachChild(visit);
        };
        visit(sf);
        return hit;
      })
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders, "call queueCapacitySkipNote instead of writing your own").toEqual([HOME]);
  });
});

/* ── the review refusals: one rule, one home, and two conditions ──────────── */

describe('the "this task left review" refusals', () => {
  /**
   * Read from `_shared.ts`'s SOURCE, not imported.
   *
   * SCOPE, and the reason: that module is `server-only`, so a vitest import of
   * it fails at load — the same constraint this repo already works around by
   * asserting against source (asset-visibility, publish-error-boundary). The
   * sentences' CONTENT is checked behaviourally anyway, by the channel-2 sweep
   * above: they are the return values of five ungated actions, so the AST scan
   * reads the constants' own text through them. What this block adds is the
   * ONE-HOME property, which is a source question either way.
   */
  const shared = code(src("lib/actions/_shared.ts"));
  const literalOf = (name: string) =>
    new RegExp(`${name}\\s*=\\s*\\n?\\s*"([^"]+)"`).exec(shared)?.[1] ?? "";
  const raced = literalOf("TASK_LEFT_REVIEW_MESSAGE");
  const notThere = literalOf("TASK_NOT_IN_REVIEW_MESSAGE");

  it("names no stored status, and both are sentences", () => {
    for (const [name, literal] of [
      ["TASK_LEFT_REVIEW_MESSAGE", raced],
      ["TASK_NOT_IN_REVIEW_MESSAGE", notThere],
    ] as const) {
      expect(literal, `could not read ${name}`).not.toBe("");
      expect(offences(literal, { payload: true })).toEqual([]);
      expect(literal).toMatch(/^[A-Z][\s\S]*\.$/);
    }
  });

  it("keeps the lost-race claim out of the preflight", () => {
    // The same consolidation trap as the capacity note, one file over. One
    // sentence served four sites and was FALSE at one of them: three are atomic
    // claims that returned nothing, which can only mean the task WAS in review
    // and lost a race — but `publishIntegrationAction`'s
    // `preflight.status !== "review_pending"` also fires for a task still
    // pending, or finished last week, and "no longer waiting for review"
    // asserts a past that may never have existed.
    //
    // Asked structurally, so a reworded pair still passes: the preflight site
    // must not use the raced constant, and the two sentences must differ.
    expect(raced).not.toBe(notThere);
    const exec = code(src("lib/actions/execution-actions.ts"));
    const preflight = /preflight\.status !== "review_pending"\)\s*\{\s*return \{[^}]*?(TASK_[A-Z_]+)/.exec(exec)?.[1];
    expect(preflight, "could not find the preflight refusal").toBeTruthy();
    expect(preflight).toBe("TASK_NOT_IN_REVIEW_MESSAGE");
    // …and the race sites still share the other one, so this did not become four
    // hand-written sentences again.
    expect((exec.match(/TASK_LEFT_REVIEW_MESSAGE/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("is the only wording for either of them", () => {
    // Five sites returned the same sentence and could have been reworded one at
    // a time. Sharing the constants is what stops that; this is the closed
    // question that keeps a sixth site from retyping one.
    const offenders = walk(SRC)
      .filter((f) => !f.includes("__tests__"))
      .filter((f) =>
        /is not in review_pending|no longer waiting for review|isn't at the review step/i.test(
          code(readFileSync(f, "utf8")),
        ),
      )
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual(["lib/actions/_shared.ts"]);
  });
});

/* ── #153: two client-facing dialogs and the controls that open them ─────── */

/**
 * A dialog must not rename the thing its own trigger just named, and neither
 * may be Title Case.
 *
 * Asked as AGREEMENT rather than as a spelling. Pinning "Employee seats" here
 * would block the next person from improving it, which is the canary trap this
 * campaign keeps walking into; what matters is that the two strings still name
 * one thing in the client's register.
 *
 * AND NOT AS CONTAINMENT. The first shape of this asked whether the trigger's
 * text CONTAINS the dialog's, which is a canary trap of its own wearing the word
 * "agreement": renaming the dialog to "Your employee seats" reds it while both
 * labels still plainly name one thing. What the two have to share is the THING
 * they name — the head nouns, once an imperative verb the control needs and the
 * dialog does not ("Manage…", "Edit…") and the articles neither needs ("your",
 * "the") are set aside.
 *
 * SCOPE: a source match, because both dialogs are "use client" trees whose
 * imports reach server actions and the Admin SDK — the same reason
 * asset-visibility and publish-error-boundary assert against source. It proves
 * the two labels agree; it does not render them.
 */
const PROPER_NOUNS = ["Karos", "LinkedIn", "Reddit", "Google", "Gmail", "Instagram", "TikTok", "X"];

function isSentenceCase(label: string): boolean {
  return label
    .split(/\s+/)
    .slice(1)
    .every((w) => PROPER_NOUNS.includes(w.replace(/[^A-Za-z]/g, "")) || !/^[A-Z][a-z]/.test(w));
}

/** Articles and possessives: they change the register, never the referent. */
const FUNCTION_WORDS = new Set(["a", "an", "the", "this", "these", "your", "my", "our", "all"]);
/** What a CONTROL adds and a DIALOG does not: the action it performs. */
const CONTROL_VERBS = new Set(["manage", "edit", "set", "view", "open", "add", "change", "update", "review"]);

/** The thing a label names, as a comparable token set. */
function thingNamed(label: string): string[] {
  const words = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !FUNCTION_WORDS.has(w));
  if (words.length > 1 && CONTROL_VERBS.has(words[0]!)) words.shift();
  return words.sort();
}

describe("a client-facing dialog and the control that opens it", () => {
  it("knows agreement from containment", () => {
    // The recogniser itself, both directions — a negative test is worthless if
    // it cannot tell the loosening it forbids from the rewording it must allow.
    expect(thingNamed("Manage employee seats")).toEqual(thingNamed("Employee seats"));
    expect(thingNamed("Manage employee seats")).toEqual(thingNamed("Your employee seats"));
    expect(thingNamed("Manage employee seats")).not.toEqual(thingNamed("Company employee roster"));
    expect(thingNamed("Edit branding guidelines")).toEqual(thingNamed("Branding guidelines"));
  });

  it("agrees with its trigger on the LinkedIn seats dialog", () => {
    const s = code(src("components/integrations-tab.tsx"));
    const modalTitle = /setSeatsOpen\(false\)\}[\s\S]{0,200}?title="([^"]+)"/.exec(s)?.[1] ?? "";
    const trigger = /onClick=\{\(\) => setSeatsOpen\(true\)\}>[\s\S]*?\/>\s*([^\n{<]+)/.exec(s)?.[1]?.trim() ?? "";

    // Non-vacuity first: both strings were actually found, so the comparison
    // below is between two labels and not between two empty strings.
    expect(modalTitle, "could not read the seats dialog title").not.toBe("");
    expect(trigger, "could not read the button that opens it").not.toBe("");

    expect(isSentenceCase(modalTitle), `dialog title is Title Case: ${modalTitle}`).toBe(true);
    expect(isSentenceCase(trigger), `trigger is Title Case: ${trigger}`).toBe(true);
    // "Company Employee Roster" opened from a button reading "Manage Employee
    // Seats" — one control, two names for what it opens.
    expect(
      thingNamed(trigger),
      `the button says "${trigger}" and the dialog it opens calls itself "${modalTitle}"`,
    ).toEqual(thingNamed(modalTitle));
  });

  it("agrees with its trigger on the branding dialog", () => {
    // The client's own audited path to their brand copy: the rail's pencil
    // (aria-labelled) opens BrandingModal, which titled itself "Edit Branding
    // Guidelines" in Title Case while the control said sentence case.
    const rail = code(src("components/client-context-sections.tsx"));
    const modal = code(src("components/branding-modal.tsx"));
    const ariaLabel = /aria-label="(Edit[^"]*branding[^"]*)"/i.exec(rail)?.[1] ?? "";
    const titles = [...modal.matchAll(/title=\{[^}]*"([^"]+)"\s*:\s*"([^"]+)"\s*\}/g)].flatMap((m) => [m[1]!, m[2]!]);

    expect(ariaLabel, "could not read the rail's edit control").not.toBe("");
    expect(titles.length, "could not read the dialog's titles").toBe(2);

    for (const t of titles) expect(isSentenceCase(t), `dialog title is Title Case: ${t}`).toBe(true);
    for (const t of titles) {
      expect(
        thingNamed(t),
        `the pencil says "${ariaLabel}" and the dialog it opens says "${t}"`,
      ).toEqual(thingNamed(ariaLabel));
    }
  });
});
