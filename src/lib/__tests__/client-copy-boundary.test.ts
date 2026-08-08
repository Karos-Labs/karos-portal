import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as ACTIVITY_TITLES from "@/lib/activity-titles";
import { isRunMachineryTitle } from "@/lib/activity-titles";
import { CONTEXT_DOC_LABEL, contextDocLabel } from "@/lib/context-doc-copy";
import { CLIENT_SAFE_COPILOT_TOOLS } from "@/lib/copilot-tool-access";
import { ALL_LAUNCH_PROFILES } from "@/lib/custom-agent-launch";
import { queueCapacitySkipNote } from "@/lib/task-dedup";

/**
 * Two rules about text a CLIENT reads, asked as SHAPES over the channels that
 * carry it: no dash between clauses (neither a spaced hyphen nor an em dash),
 * and no Firestore enum used as prose.
 *
 * THE FIRST RULE REVERSED ON 2026-08-03 (AF-8). It used to read "no spaced
 * hyphen where an em dash BELONGS" — the em dash was the house fix. The product
 * owner ruled the character out of client copy altogether ("Why is there an M
 * dash? We don't use those"), so both dashes are offences now and the
 * replacement is a comma, a period, or the "·" this app already separates with.
 * The en dash is untouched: "3–4 posts" is a range, not punctuation.
 *
 * That reversal is why this file is the guard rather than a one-off sweep. The
 * dash rule has now changed direction once and been re-fixed per-site four
 * times before that: ledger F71 banned `" - "` in client copy and it came back
 * at least four times, in two files, in text a client's own model paraphrases.
 * A per-site fix cannot hold a rule that any new string can break, so this asks
 * the rule of a CHANNEL rather than of a list of strings.
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
 *     at, which is why this channel is the sharpest of them.
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
 *  3. THE BRANDED CLIENT EMAIL WRAPPER. `emailShell` — the shared shell every
 *     mail this product sends is rendered through. (It USED to describe itself
 *     as being "for client-facing deliveries"; #150 removed that framing along
 *     with the deliverable footer it justified. The channel is unchanged — the
 *     shell is still the branded wrapper — so this guard stays keyed to the
 *     symbol, not to the sentence that used to be above it.)
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
 *  7. THE COPY THAT TRAVELS THROUGH THE DATABASE. Every channel above reads a
 *     string where it is written or rendered IN THE SAME EXPRESSION, so none of
 *     them can see a string stored in Firestore on one day and painted on
 *     somebody's screen on another — which is where `recommendedReason: "One post
 *     per day - assigned by the content chain"` sat, on every chained draft, while
 *     all six read clean. The write side is derived from the Firestore writers'
 *     own bodies; the read side is a CLASSIFICATION of every field they find, one
 *     citation each, failing closed on a field nobody has answered for. Its own
 *     long docstring is at the section, including the parts of the copy standard
 *     it cannot mechanise.
 *
 * ── WHAT THIS DOES NOT CLAIM ─────────────────────────────────────────────────
 * SCOPE, stated rather than discovered later:
 *
 *  • It is not every client-reachable string in the repo. `route.ts` HTTP
 *    handlers are NOT channel 5: their bodies are JSON to a fetch caller, not
 *    page copy — except the OAuth popup, where `errorPage()`
 *    (lib/integrations/oauth-popup.ts) renders its `message` argument as HTML in
 *    the client's own browser. Those messages in
 *    `api/auth/social/[provider]/callback/route.ts` were corrected by hand in this
 *    same pass, so the punctuation defect there is gone — but the handler is still
 *    UNGUARDED, verified by planting a fresh spaced hyphen into it and watching
 *    this suite stay green. So the next one to arrive there arrives unnoticed. The
 *    fix is a copy channel over that handler; until then this is a stated hole and
 *    not a covered surface.
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
 *    email in `publishIntegrationAction` and the `[Karos Labs] New client access
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

/**
 * src-relative path with forward slashes, whatever the platform's separator.
 * `join`/`readdirSync` return backslash-joined paths on Windows, and every
 * comparison in this file is written against forward-slash literals — so an
 * absolute path is normalised the instant it is made relative, here, once.
 */
const toRel = (abs: string): string => abs.slice(SRC.length + 1).split(sep).join("/");

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

/**
 * MEMOIZED, and it has to be: the credit-ledger follow searches every file in
 * the tree for callers, once per followed field, and re-parsing ~700 modules
 * each time turned this suite from seconds into minutes. Nothing mutates a file
 * during the run, so one tree per path is the same tree.
 */
const PARSE_CACHE = new Map<string, ts.SourceFile>();
const parse = (abs: string): ts.SourceFile => {
  let cached = PARSE_CACHE.get(abs);
  if (!cached) {
    cached = ts.createSourceFile(
      abs,
      readFileSync(abs, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    PARSE_CACHE.set(abs, cached);
  }
  return cached;
};

const lineOf = (sf: ts.SourceFile, pos: number) =>
  sf.getLineAndCharacterOfPosition(pos).line + 1;

/** src-relative path of a parsed file — a chunk names the file it came FROM. */
const relOf = (sf: ts.SourceFile) => toRel(sf.fileName);

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
      out.push("spaced hyphen — use a comma, a period or ·");
      break;
    }
  }
  // AF-8. "Why is there an M dash? We don't use those."
  //
  // This rule used to point the other way: a spaced hyphen was an offence
  // BECAUSE an em dash belonged there. The product owner reversed the house
  // style for client copy, so both are offences now and the fix is a comma, a
  // period, or the "·" this app already separates with.
  //
  // The en dash is untouched and still wanted: "3–4 posts", "~10–25 min",
  // "1–10" are ranges, not punctuation between clauses.
  if (text.includes("—")) out.push("em dash — use a comma, a period or ·");
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
  });

  it("flags the em dash it used to prescribe (AF-8)", () => {
    // The reversal, asserted in both directions so neither half can rot: the
    // dash is an offence, and the punctuation that replaces it is not.
    expect(offences("Nothing changed — try again")).toHaveLength(1);
    expect(offences("Nothing changed, try again")).toEqual([]);
    expect(offences("Nothing changed. Try again.")).toEqual([]);
    expect(offences("Drafted · not posted")).toEqual([]);
    // Anywhere in the line, not only between clauses — an em dash opening a
    // sentence fragment is the same character and the same ruling.
    expect(offences("— and then it stopped")).toHaveLength(1);
  });

  it("flags a spaced-hyphen NUMERIC RANGE too, and that is on purpose", () => {
    // A known sharp edge, stated rather than discovered by whoever trips it:
    // "3 - 4 posts" is the same `\S - \S` shape and is flagged. In client copy
    // that range wants an en dash, so the fix is `3–4`, not an exemption — and
    // the existing copy already writes it that way ("~10–25 min").
    expect(offences("3 - 4 posts a week")).toHaveLength(1);
    expect(offences("3–4 posts a week")).toEqual([]);
    // The en dash survived the AF-8 reversal on purpose: a range is not
    // punctuation between clauses, and "3—4" was never the alternative.
    expect(offences("~10–25 min, 1–10 people")).toEqual([]);
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
      out.push({ name: n.name.getText(sf), rel: toRel(abs), chunks });
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

const ALL_RENDER_ENTRIES = walk(join(SRC, "app")).filter((f) => RENDER_ENTRY.test(toRel(f)));
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
    const rel = new Set(CLIENT_ROUTE_ROOTS.map(toRel));
    expect(rel.has("app/(app)/jobs/page.tsx"), "a requireUser([KAROS_…]) page is in scope").toBe(false);
    expect(rel.has("app/signup/page.tsx")).toBe(true);
    expect(rel.has("app/(onboarding)/onboarding/page.tsx")).toBe(true);
    // And the component tree: the wizard step and the Reddit review surface both
    // carried offences, so both have to be reachable from a root.
    const mods = new Set(CLIENT_RENDER_MODULES.map(toRel));
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
        rel: toRel(abs),
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
      .map(toRel);
    expect(offenders, "call queueCapacitySkipNote instead of writing your own").toEqual([HOME]);
  }, 20_000);
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
      .map(toRel);
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

/* ── channel 7: the client copy that travels through the DATABASE ─────────── */

/**
 * All six channels above read a string where it is WRITTEN or RENDERED IN THE
 * SAME EXPRESSION. None can see a string stored in Firestore on one day and
 * painted on somebody's screen on another — and this codebase has a lot of those:
 * `applyChainAssignments` (lib/data.ts) stamped `recommendedReason: "One post per
 * day - assigned by the content chain"` onto every chained draft, and asset-card
 * renders that field as visible text AND as a `title` tooltip. Found by accident,
 * which is the tell that the channel was missing rather than clean.
 *
 * The question has two halves and the second is the hard one.
 *
 *  1. WRITTEN. A string literal at a named field of an object literal handed to a
 *     call that PERSISTS it. Both ends are derived, not listed: the writers are
 *     the exports of lib/data.ts whose own bodies perform a Firestore write
 *     (`.set`/`.update`/`.add`), plus one hop of wrappers that forward their own
 *     `data`/`patch`/`fields` parameter into one (which is how `logActivity` gets
 *     in), plus the raw batch/transaction writes inside data.ts itself — because
 *     the one known live instance was one of those, not a call site.
 *
 *  2. READ BY A CLIENT. NOT ASSUMED. A persisted field is only client copy if it
 *     reaches a client's screen, and several of these do not: `Job.events[].message`
 *     is painted on `app/(app)/jobs/[id]/page.tsx`, which opens with
 *     `requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"])`; `ClientTask.sourceLabel`
 *     is written and never read at all; `ClientTask.metadata.executionError` is
 *     read ONLY as `Boolean(task.metadata?.executionError)` (tasks-board.tsx:241),
 *     which paints its own "Execution failed." instead. Rewriting those as client
 *     copy would be busywork at best and would put an operator's diagnostics in a
 *     client's register at worst.
 *
 *     So every field the write scan finds is CLASSIFIED, in one of the three
 *     lists below, each entry citing the render fact that put it there. FAIL
 *     CLOSED: a field this scan finds and the lists do not name turns this red
 *     asking who reads it. That is the property that matters, because the way
 *     this defect arrives is a new persisted field, not a new writer.
 *
 * ── THE ROW GATE, WHICH IS NOT A FIELD FACT ──────────────────────────────────
 * `ActivityLog.title` is the sharpest case: SOME rows are staff-only and the
 * field is the same field. The client's timeline drops two kinds
 * (tasks-body.tsx:127) — `type === "MANUAL_NOTE"`, the staff composer's own rows,
 * and any title `isRunMachineryTitle` recognises. So "SEO/GEO fix approved" and
 * the ops-import bookkeeping are OUT OF SCOPE BY DESIGN, and the exclusion is
 * computed per call site from the row's own `type` literal and from actually
 * CALLING the activity-titles builder the site uses — not from a list of files.
 *
 * ── WHAT THIS DOES NOT CLAIM ─────────────────────────────────────────────────
 *  • It is not every persisted string. It reads LITERALS at the write. A value
 *    computed into a variable and then persisted, or arriving from the agent
 *    service, or typed by a user, is not source text and cannot be swept here.
 *  • One hop of parameter-following, same module: a literal handed to a private
 *    helper that forwards it to the writer IS caught (this is how the credit
 *    ledger's "Document correction · …" reasons are in scope at all). Two hops,
 *    or a helper in another module, is not.
 *  • `...spread` properties are not followed, so a message assembled into an
 *    object elsewhere and spread in escapes it.
 *  • THE TWO RULES ARE NOT THE WHOLE COPY STANDARD, and this channel's own worst
 *    finding proves it. `${doc.docType} corrected (targeted)` printed a kebab-case
 *    Firestore value into a client's timeline, and no rule here can see it: the
 *    enum half matches stored tokens that appear AS LITERALS, and this one arrives
 *    through an interpolation whose source text is `doc.docType`. Same for the
 *    template slug in "Feedback on <agent> · by-the-numbers". Both were found by READING
 *    the inventory this channel produces, not by a sweep — and a rule that flagged
 *    every interpolation ending in `.docType` would flag the staff refresh
 *    proposals too, which is the path-allowlist road this file does not take.
 *    Sentence case, lab jargon and "does an ampersand belong here" are judgement
 *    on the same inventory, for the same reason.
 *  • A field composed by a BUILDER leaves the write-site scan: `title:
 *    researchReportReadyTitle()` has no literal at the call. That hole is closed
 *    behaviourally instead — every string-returning export of activity-titles.ts
 *    is called and judged, machinery ones exempted — but only for that module.
 *  • The RETROACTIVITY hole, and it is a real one: these strings are already on
 *    live documents. Fixing the source changes what NEW rows say and nothing
 *    about old ones. Where a matcher keys off one of these strings, changing it
 *    would un-redact live data — `isRunMachineryTitle` is exactly that, and
 *    activity-titles.test.ts holds both spellings of every title reworded here
 *    for that reason. Where no matcher exists, old rows simply render their old
 *    words, and reconciling them is a Firestore backfill, not a code change.
 */

const PERSIST_WRITE = /\.(set|update|add|create)\s*\(/;

/** Past the type-assertion wrappers to the value itself. */
function unwrapValue(n: ts.Node): ts.Node {
  let q = n;
  for (;;) {
    if (ts.isParenthesizedExpression(q) || ts.isAsExpression(q) || ts.isSatisfiesExpression(q)) {
      q = q.expression;
      continue;
    }
    return q;
  }
}

interface WriterFact {
  /** The text of the parameter type that carries the document, if there is one. */
  typeText: string;
  /** Where the writer is declared, so a failure can name it. */
  rel: string;
}

/**
 * The functions that put a document in Firestore, read off their own bodies.
 *
 * DERIVED twice over, because a hand-listed set of writers is a set that goes
 * stale the first time somebody adds a collection. The seed is "an export of
 * data.ts whose body performs a Firestore write"; the second pass is ONE hop,
 * over the seed snapshot only (a transitive closure would depend on file order),
 * for helpers that forward their own document parameter into a seed writer.
 *
 * DELIBERATELY STILL ONE HOP. Widening this to "any function whose call to a
 * known writer mentions one of its parameters", run twice, was tried when the
 * credits consolidation moved the ledger reasons two calls further out. It
 * promoted 29 unrelated functions — every action that forwards an argument into
 * any writer — and each one arrives as a new unclassified `writer.field` pair
 * this channel must fail closed on. The reasons are recovered by widening the
 * one-hop parameter FOLLOW below instead, which adds chunks under the existing
 * `chargeClientCredits.reason` key rather than minting new keys.
 */
const PERSISTING_WRITERS: ReadonlyMap<string, WriterFact> = (() => {
  const out = new Map<string, WriterFact>();
  const dataRel = "lib/data.ts";
  const dataSf = parse(join(SRC, dataRel));
  const docParam = (n: ts.FunctionDeclaration, sf: ts.SourceFile) =>
    n.parameters.find((p) => /^(data|patch|fields|doc|entry|input)$/.test(p.name.getText(sf)))
      ?.type?.getText(sf) ?? "";
  dataSf.forEachChild((n) => {
    if (!ts.isFunctionDeclaration(n) || !n.name || !n.body) return;
    if (!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
    if (!PERSIST_WRITE.test(n.body.getText(dataSf))) return;
    out.set(n.name.getText(dataSf), { typeText: docParam(n, dataSf), rel: dataRel });
  });
  const seeds = [...out.keys()];
  for (const abs of walk(join(SRC, "lib"))) {
    if (abs.includes("__tests__") || abs === join(SRC, dataRel)) continue;
    const sf = parse(abs);
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) {
        const body = n.body.getText(sf);
        for (const seed of seeds) {
          if (new RegExp(`\\b${seed}\\s*\\(\\s*(data|patch|fields|doc|entry|input)\\b`).test(body)) {
            out.set(n.name.getText(sf), {
              typeText: docParam(n, sf),
              rel: toRel(abs),
            });
          }
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return out;
})();

/**
 * THE ARGUMENT THAT DECIDES THE AUDIENCE, and why the pair `(writer, field)` is
 * not on its own a unit anyone can classify.
 *
 * `upsertClientContextDoc.content` was exempted as 'tier "internal-only"; no
 * document tab reads it'. That sentence is true of ONE call site
 * (transcripts/ingest.ts, which writes the meeting-notes signal doc at tier
 * "internal-only"). The same writer is called at intel-actions.ts with
 * `tier: "client" as ContextDocTier` — the condensed docs that
 * client-documents.tsx resolves and paints for a client viewer. Keyed to the
 * pair, one site's fact exempted the other site's audience, which is the
 * fail-open shape: the exemption's own citation is what made it look justified.
 *
 * So a write that carries an audience argument gets it into the key, and the two
 * AUDIENCE lists must match that longer key exactly. `tier` is the argument:
 * `ClientContextDoc.tier` is typed `ContextDocTier`, a union that names the
 * client as one of its three values, and client-documents.tsx resolves a tab per
 * tier. The rot guard is a test below, which reds if that declaration moves.
 *
 * FAILS CLOSED TWICE. A tier this file has not seen produces a key nothing
 * classifies, so it reds. A tier the scan cannot read as a literal
 * (`existingDoc?.tier ?? "internal"`) becomes `tier=?` — an audience decided at
 * runtime is not an audience a citation can claim, so that reds too rather than
 * inheriting whichever tier a neighbouring site happened to name.
 *
 * WHAT IS NOT A DISCRIMINATOR, deliberately: `actorRole`, `creatorRole` and
 * `authorRole` are unions that also name "client", and all three say who WROTE
 * the row, not who reads it — a client's own comment is still read by that
 * client. The audience question for an activity row is answered by the row gate
 * above instead, which is the same question asked of the field that decides it.
 */
const AUDIENCE_ARG = "tier";

function audienceOf(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): string | null {
  const p = obj.properties.find((x) => x.name?.getText(sf) === AUDIENCE_ARG);
  if (!p) return null;
  const v = ts.isPropertyAssignment(p) ? unwrapValue(p.initializer) : null;
  return v && ts.isStringLiteralLike(v)
    ? `${AUDIENCE_ARG}="${v.text}"`
    : `${AUDIENCE_ARG}=?`;
}

interface PersistedChunk extends Chunk {
  /** The persisting call this literal was handed to. */
  writer: string;
  /** Field path inside the document — `title`, `events[].message`, `metadata.type`. */
  path: string;
  /** `${writer}.${path}` — audience-blind, and what NOT_TEXT is keyed by. */
  pair: string;
  /**
   * The pair plus the write's own audience argument when it has one — what the
   * two AUDIENCE lists are keyed by. Equal to `pair` where no such argument
   * exists, which is every writer but this one today.
   */
  key: string;
  /** Non-null when the ROW this literal belongs to never reaches a client. */
  rowGate: string | null;
  /** True when this literal was reached through the one-hop parameter follow. */
  viaParam: boolean;
}

/** Only the `title` of an activity row can be a machinery title, so gate on that. */
function activityRowGate(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): string | null {
  const prop = (name: string) =>
    obj.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === name,
    )?.initializer;
  const type = prop("type");
  if (type && ts.isStringLiteralLike(type) && type.text === "MANUAL_NOTE") {
    return "a MANUAL_NOTE row — the timeline's own staff composer";
  }
  const title = prop("title");
  if (!title) return null;
  if (ts.isStringLiteralLike(title) && isRunMachineryTitle(title.text)) {
    return "a machinery title, dropped for client viewers";
  }
  // Behavioural, not textual: the builder is CALLED and its output classified, so
  // a builder whose wording moves takes this gate with it instead of drifting out.
  if (ts.isCallExpression(title) && ts.isIdentifier(title.expression)) {
    const name = title.expression.text;
    const fn = (ACTIVITY_TITLES as Record<string, unknown>)[name];
    if (typeof fn === "function") {
      try {
        const built = (fn as (...a: unknown[]) => unknown)(
          ...Array.from({ length: (fn as (...a: unknown[]) => unknown).length }, () => "x"),
        );
        if (typeof built === "string" && isRunMachineryTitle(built)) {
          return `a machinery title from ${name}()`;
        }
      } catch {
        /* a builder this reader cannot call is left in scope — fail loud, not open */
      }
    }
  }
  return null;
}

/** The follow's search space: the whole tree minus this directory's own scans. */
const FOLLOW_FILES: readonly string[] = walk(SRC).filter((abs) => !abs.includes("__tests__"));

const PERSISTED_CHUNKS: PersistedChunk[] = (() => {
  const out: PersistedChunk[] = [];
  for (const abs of walk(SRC)) {
    if (abs.includes("__tests__")) continue;
    const sf = parse(abs);
    const isDataModule = abs === join(SRC, "lib/data.ts");

    /** The nearest named function around a node — the hop the follow goes back through. */
    const enclosingFn = (n: ts.Node): ts.FunctionDeclaration | null => {
      for (let q: ts.Node | undefined = n; q; q = q.parent) {
        if (ts.isFunctionDeclaration(q) && q.name && q.body) return q;
      }
      return null;
    };

    /**
     * A literal handed to THIS function by one of its callers, for a field whose
     * value is (or mentions) one of its parameters.
     *
     * The channel-2 lesson in a different position: the persisting call is not
     * where the sentence was written. `chargeClientCredits({ reason })` inside
     * `chargeClientModelCall` says nothing, and the ledger reasons that reach a
     * client's Recent activity feed are literals at that helper's call sites.
     *
     * ── WHAT IT FOLLOWS, and why each shape had to be added ──────────────────
     *
     * ACROSS FILES, for the one field `followableAcrossFiles` admits. The follow
     * used to search only the file holding the persisting call. That was true
     * while every charge helper was private to the action file that used it;
     * consolidating them into one home (lib/client-model-charge.ts) put every
     * caller in a different file and the follow went blind — the strings were
     * unchanged, still stored, still client copy, and silently no longer swept.
     *
     * THROUGH A PROPERTY of a parameter. `{ reason: call.reason }` forwards a
     * FIELD of the spec object, not the whole parameter, so the caller's literal
     * is the matching field of the object it passed. Following the bare
     * parameter instead would collapse a spec's `reason` and its `operation`
     * onto one key, which is the merge the "only at a NAMED field" rule below
     * exists to prevent.
     *
     * THROUGH A LOCAL CONST. A site that needs the same spec twice — charge now,
     * refund later — binds it (`const simulationCharge = { … }`) instead of
     * writing it inline, and the argument is then an identifier.
     *
     * TWO HOPS, bounded. `withClientModelCharge` passes its own parameter
     * straight to `chargeClientModelCall`, so one hop lands on an identifier
     * rather than a literal. Depth is capped and the recursion carries a `seen`
     * set, so a mutually recursive pair cannot spin.
     */
    const FOLLOW_DEPTH = 2;

    /** `x.reason` → ["reason"]; `x` → []; anything else → null (not followable). */
    const propertyPath = (expr: ts.Node, root: string): string[] | null => {
      const parts: string[] = [];
      let q: ts.Node = unwrapValue(expr);
      while (ts.isPropertyAccessExpression(q)) {
        parts.unshift(q.name.text);
        q = unwrapValue(q.expression);
      }
      return ts.isIdentifier(q) && q.text === root ? parts : null;
    };

    /** Dig `path` out of an object literal, following a local const binding once. */
    const atPath = (arg: ts.Node, path: string[], owner: ts.SourceFile): ts.Node | null => {
      let node = unwrapValue(arg);
      if (ts.isIdentifier(node)) {
        // `const spec = { … }; charge(spec)` — resolve the binding in this file.
        let bound: ts.Node | null = null;
        const findConst = (n: ts.Node) => {
          if (
            ts.isVariableDeclaration(n) &&
            ts.isIdentifier(n.name) &&
            n.name.text === (node as ts.Identifier).text &&
            n.initializer
          ) {
            bound = unwrapValue(n.initializer);
          }
          n.forEachChild(findConst);
        };
        findConst(owner);
        if (!bound) return null;
        node = bound;
      }
      for (const key of path) {
        if (!ts.isObjectLiteralExpression(node)) return null;
        const prop = node.properties.find((p) => p.name?.getText(owner) === key);
        if (!prop) return null;
        node = unwrapValue(
          ts.isPropertyAssignment(prop)
            ? prop.initializer
            : ts.isShorthandPropertyAssignment(prop)
              ? prop.name
              : prop,
        );
      }
      return node;
    };

    const followFrom = (
      fnName: string,
      argIndex: number,
      path: string[],
      depth: number,
      seen: Set<string>,
      scope: readonly string[],
    ): Chunk[] => {
      const stamp = `${fnName}#${argIndex}#${path.join(".")}`;
      if (depth <= 0 || seen.has(stamp)) return [];
      seen.add(stamp);
      const found: Chunk[] = [];
      for (const abs of scope) {
        const callerSf = parse(abs);
        const visitCalls = (n: ts.Node) => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fnName) {
            const arg = n.arguments[argIndex];
            if (arg) {
              const target = atPath(arg, path, callerSf);
              if (target) found.push(...messageChunks(target, callerSf));
              else {
                // The caller forwarded ITS own parameter — hop out one more.
                const outer = ((): ts.FunctionDeclaration | null => {
                  for (let q: ts.Node | undefined = n; q; q = q.parent) {
                    if (ts.isFunctionDeclaration(q) && q.name && q.body) return q;
                  }
                  return null;
                })();
                if (outer?.name) {
                  const plain = unwrapValue(arg);
                  const idx = outer.parameters.findIndex(
                    (p) => ts.isIdentifier(plain) && p.name.getText(callerSf) === plain.text,
                  );
                  if (idx >= 0) {
                    found.push(
                      ...followFrom(outer.name.getText(callerSf), idx, path, depth - 1, seen, scope),
                    );
                  }
                }
              }
            }
          }
          n.forEachChild(visitCalls);
        };
        visitCalls(callerSf);
      }
      return found;
    };

    /**
     * WHICH FIELD MAY BE FOLLOWED ACROSS FILES, and why it is only one.
     *
     * `reason` on the two credit writers is the only field of a ledger row that
     * carries prose — its siblings are ids, enums and numbers, which is why
     * `chargeClientCredits.operation` and `creditClientCredits.kind` sit in
     * NOT_TEXT. It is also the field whose literals moved out of reach when the
     * charge helpers were consolidated into lib/client-model-charge.ts.
     *
     * Enabling the cross-file follow for EVERY field was tried and backed out. It
     * works, and it surfaces thirteen further `writer.field` pairs that have never
     * been classified (`chargeClientCredits.actorName`, `logActivity.actor`,
     * `upsertClientContextDoc.clientId@tier=?` and so on) — including several that
     * do carry real client-facing prose, like the reconciler's own auto-refund
     * reasons. Every one of them is a judgement about who reads that field, and
     * making thirteen of those silently, inside the sweep that is supposed to
     * catch them, is how a guard turns green over a leak. Widening this is worth
     * doing; it is its own piece of work, with its own classifications.
     */
    const followableAcrossFiles = (writer: string, path: string): boolean =>
      path === "reason" && (writer === "chargeClientCredits" || writer === "creditClientCredits");

    const followParams = (expr: ts.Node, at: ts.Node, path: string, writer: string): Chunk[] => {
      // Only at a NAMED field. Following the whole document parameter instead
      // (`createActivityLog(data)`) collapses every field of every caller's row
      // onto one key, which merges audiences that the lists below have to keep
      // apart — a title and a MANUAL_NOTE type are not the same question.
      if (!path || path.startsWith("(arg")) return [];
      const fn = enclosingFn(at);
      if (!fn?.name) return [];
      const names = new Set<string>();
      const collect = (n: ts.Node) => {
        if (ts.isIdentifier(n)) names.add(n.text);
        n.forEachChild(collect);
      };
      collect(expr);
      const wanted = fn.parameters
        .map((p, i) => ({ i, name: p.name.getText(sf) }))
        .filter((p) => names.has(p.name));
      if (wanted.length === 0) return [];
      const fnName = fn.name.getText(sf);
      const found: Chunk[] = [];
      for (const w of wanted) {
        const prop = propertyPath(expr, w.name);
        // TWO FOLLOWS, and the narrow one is left byte-for-byte as it was.
        //
        // The precise cross-file follow needs a property path to know which part
        // of the caller's argument to read, and it is admitted for one field
        // (see followableAcrossFiles). Every other field takes the ORIGINAL
        // follow — same file, whole argument, no const resolution — because
        // changing it at all changes what the sweep sees everywhere: adding just
        // the const-resolution step surfaced `updateClientTask.metadata
        // .autoCompletedReason`, an unclassified field with nothing to do with
        // this cluster. A repair to one channel must not quietly re-scope another.
        if (prop !== null && followableAcrossFiles(writer, path)) {
          found.push(...followFrom(fnName, w.i, prop, FOLLOW_DEPTH, new Set(), FOLLOW_FILES));
          continue;
        }
        const visitCalls = (n: ts.Node) => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fnName) {
            const arg = n.arguments[w.i];
            if (arg) found.push(...messageChunks(arg, sf));
          }
          n.forEachChild(visitCalls);
        };
        visitCalls(sf);
      }
      return found;
    };

    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = ts.isIdentifier(n.expression)
          ? n.expression.text
          : ts.isPropertyAccessExpression(n.expression)
            ? n.expression.name.text
            : "";
        const known = PERSISTING_WRITERS.get(callee);
        // A raw batch/transaction write inside data.ts. `applyChainAssignments`
        // is one of these, which is why they cannot be left out.
        const raw = isDataModule && !known && /^(set|update|add|create)$/.test(callee);
        if (known || raw) {
          const writer = known ? callee : "(data.ts raw write)";
          const isActivity = /\bActivityLog\b/.test(known?.typeText ?? "");
          for (let i = 0; i < n.arguments.length; i++) {
            // `{ … } satisfies CreditLedgerEntry` and `{ … } as const` are the
            // two ways this codebase types a document inline, and BOTH hide the
            // object literal behind a wrapper node. Missing that is not a small
            // gap: every field of the credit-ledger row collapsed into a single
            // `(arg1)` key, so nine audiences became one classification.
            const arg = unwrapValue(n.arguments[i]!);
            const rowGate =
              isActivity && ts.isObjectLiteralExpression(arg) ? activityRowGate(arg, sf) : null;
            // Read off the DOCUMENT, once, so every field of this write carries
            // the audience the write itself declares.
            const audience = ts.isObjectLiteralExpression(arg) ? audienceOf(arg, sf) : null;
            const take = (raw: ts.Node, path: string): void => {
              const node = unwrapValue(raw);
              if (ts.isObjectLiteralExpression(node)) {
                for (const p of node.properties) {
                  // SHORTHAND COUNTS. `chargeClientCredits({ …, reason, … })` is
                  // how a forwarded parameter almost always looks, and skipping
                  // skipping it silently dropped every forwarded ledger reason —
                  // the guard read clean on the field it was added to cover.
                  const value = ts.isPropertyAssignment(p)
                    ? p.initializer
                    : ts.isShorthandPropertyAssignment(p)
                      ? p.name
                      : null;
                  if (!value) continue;
                  const k = p.name!.getText(sf).replace(/^["']|["']$/g, "");
                  take(value, path ? `${path}.${k}` : k);
                }
                return;
              }
              if (ts.isArrayLiteralExpression(node)) {
                for (const el of node.elements) take(el, `${path}[]`);
                return;
              }
              if (ts.isConditionalExpression(node)) {
                take(node.whenTrue, path);
                take(node.whenFalse, path);
                return;
              }
              const direct = messageChunks(node, sf).map((c) => ({ c, viaParam: false }));
              const followed = followParams(node, n, path, writer).map((c) => ({ c, viaParam: true }));
              for (const { c, viaParam } of [...direct, ...followed]) {
                if (c.shape.trim() === "") continue;
                const pair = `${writer}.${path}`;
                out.push({
                  ...c,
                  writer,
                  path,
                  pair,
                  key: audience ? `${pair}@${audience}` : pair,
                  rowGate,
                  viaParam,
                });
              }
            };
            take(arg, ts.isObjectLiteralExpression(arg) ? "" : `(arg${i})`);
          }
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return out;
})();

/**
 * WHO READS THIS FIELD. One entry per unit the scan finds, and the scan is total
 * over the writers, so a unit missing from all three lists turns the first test
 * below red.
 *
 * THE UNIT IS NOT ALWAYS THE PAIR. `${writer}.${field path}` is the unit for a
 * writer whose whole document has one audience; where the write DECLARES its
 * audience in an argument, that argument is part of the unit
 * (`upsertClientContextDoc.content@tier="internal-only"`) — see the
 * `AUDIENCE_ARG` docstring for why the pair alone let one call site's fact
 * exempt another call site's audience. NOT_TEXT is the exception and stays keyed
 * by the pair, because "this value is not text" is not a question about readers.
 *
 * The answer is a RENDER fact, cited per entry. It is not guessable from the
 * field's name: `Job.events[].message` looks like client-facing narration and is
 * painted only on a `requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"])` page, while
 * `ClientCompetitor.positioning` looks like an internal analyst note and reaches
 * a client through the copilot's system prompt.
 */

/** Reaches a client's screen — swept by the two rules. */
const CLIENT_READ: readonly string[] = [
  // The Workspace timeline. tasks-body.tsx projects `title` and `description`
  // through for every row it does not drop; the row gate above handles the rows
  // it does drop.
  "logActivity.title",
  "logActivity.description",
  // "Recent activity" in CreditsPanel renders `{e.reason}` for every ledger row,
  // and clients/[id]/settings mounts that panel with no role condition (only the
  // Profile tab is staff-gated). A client reads why their credits went.
  "chargeClientCredits.reason",
  "creditClientCredits.reason",
  // The comment list in task-ticket-modal renders `{c.content}` — and the client
  // is the author of the one literal here (their adjustment request).
  "createTaskComment.content",
  // asset-card renders `recommendedReason` as visible text AND as the `title`
  // tooltip; redactLockedAsset withholds it only for LOCKED future-dated assets,
  // so an unlocked draft carries it. This is the instance the channel was built
  // for, found by accident before the channel existed.
  "(data.ts raw write).recommendedReason",
  // Asset title and template name are painted on every card and in the detail
  // modal; redactLockedAsset substitutes the template NAME as the title for a
  // locked row, so both are client-facing either way.
  "createAsset.title",
  "createAsset.templateName",
  // task-ticket-modal reads `metadata.agentName` into `executingAgentName` and
  // shows it while a task runs.
  "updateClientTask.metadata.agentName",
  // Not on a screen — through the MODEL. buildCopilotSystemPrompt composes the
  // fields below into the competitor block it hands the copilot ("<tier>", "<level>
  // threat", "overlap: <x>", "Strengths: …", "Positioning: …"), and the copilot
  // paraphrases whatever it is handed to the client. Same reasoning that put
  // MANAGED_PRODUCTS in channel 6.
  "createClientCompetitor.marketTier",
  "createClientCompetitor.threatLevel",
  "createClientCompetitor.overlap",
  "createClientCompetitor.keyStrengths[]",
  "createClientCompetitor.positioning",
];

/**
 * Persisted, but never on a client's screen — NOT swept, with the reason.
 *
 * Two different reasons live here on purpose: "only staff see it" and "nobody
 * reads it". Both are answers to the same question, and both mean the two rules
 * would be rewriting text no client reads.
 *
 * EVERY CITATION HERE IS A PROPERTY OF THE FIELD, not of one call site. That is
 * the rule the `content` entry broke — it cited the tier ONE of its callers
 * writes — and the other six were re-read against it: each now names either the
 * single surface that renders the field or the fact that nothing does.
 *
 * WHICH OF THEM A TEST CHECKS, stated because "cited" and "checked" are not the
 * same word. The two NO-READER claims (`sourceLabel`, `metadata.executionError`)
 * are repo-wide negatives, so they are asked of the AST in the last test below.
 * The four STAFF-GATED claims are not mechanised: each names its one reader
 * (`jobs/[id]`, `my-action-items.tsx`, `token-manager.tsx`), and the field names
 * they turn on — `events`, `history`, `name` — are too common for a property-name
 * sweep to ask the question without answering a different one. They are read
 * facts, re-read this pass, not guarded ones.
 */
const NOT_ON_A_CLIENT_SCREEN: Readonly<Record<string, string>> = {
  // app/(app)/jobs/[id]/page.tsx paints the event log, and opens with
  // requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]). "Cancellation requested" and
  // "Submitted to agent service" are the operator's trace of a dispatch.
  "createJob.events[].message": "jobs/[id] event log — a staff-gated page",
  "updateJob.events[].message": "jobs/[id] event log — a staff-gated page",
  // Read ONLY as `Boolean(task.metadata?.executionError)` (tasks-board.tsx:241),
  // which paints its own "Execution failed." No surface renders the string, on
  // either side of the boundary — which is also why its own spaced hyphen
  // ("couldn't be reached - please try again") is out of scope here rather than
  // an offence. It is a diagnostic, and it should stay one.
  "updateClientTask.metadata.executionError": "truthiness only; no textual reader",
  // Written by the copilot's task creation and read by nothing at all — no
  // component or route module mentions `sourceLabel` (the only other mentions in
  // src are activity-titles' unrelated `sourceLabel` parameter and the type).
  "createClientTask.sourceLabel": "written, never read",
  // The audit trail in my-action-items.tsx, mounted behind `isAdmin` on a
  // dashboard that redirects CLIENT_USER away before it renders.
  "updateActionItem.history[]": "admin-only action-item audit trail",
  // token-manager.tsx on app/(app)/connect, requireUser(["KAROS_ADMIN",
  // "KAROS_EMPLOYEE"]).
  "createAccessToken.name": "staff-gated personal access tokens",
  // KEYED BY TIER, because the audience is the argument and not the field. The
  // transcript signal doc is the only literal content this writer takes, and it
  // is written at tier "internal-only": client-documents.tsx resolves a tab to
  // tier "client" or (for staff) tier "internal" — never "internal-only", and
  // `meeting-notes` has no tab at all. The `tier: "client"` call site
  // (intel-actions.ts, refreshClientContextDocsAction) hands over
  // `doc.content` — model output from lib/intel/condense.ts, not source text, so
  // there is nothing in it for these two rules to read. The day a literal lands
  // there its key is `content@tier="client"`, which nothing classifies, and this
  // channel goes red asking who reads it.
  'upsertClientContextDoc.content@tier="internal-only"':
    'tier "internal-only"; no document tab reads that tier',
};

/**
 * A stored token, id, flag or enum — not text anybody reads as text.
 *
 * KEPT HONEST, not taken on trust: the test below asserts that nothing in this
 * list is PROSE. A stored value does not contain two adjacent English words, so
 * a message parked here to silence the sweep fails instead.
 *
 * KEYED BY THE AUDIENCE-BLIND PAIR, and that is the one list where that is the
 * right unit: "this value is not text" cannot depend on who reads it. So no
 * entry here may carry an `@tier=…` discriminator, and no field may appear both
 * here and in an audience list — the tests below hold both, which is what stops
 * a pair being parked here to shadow a per-tier audience claim.
 */
const NOT_TEXT: readonly string[] = [
  "(data.ts raw write).kind",
  "(data.ts raw write).status",
  "addEmployeeSeat.status",
  // "open" | "covered" — the state a direction request is in. The intake box
  // sorts and groups on it and prints its own words ("Already covered"); the
  // stored enum never reaches a screen.
  "addLiDirectionRequest.status",
  // Always the literal "company" — newsletter has no seats, so the field exists
  // only to keep the four feedback ledgers structurally identical. The intake
  // box prints the ACTION and the issue number; it never reads this.
  "addNewsletterDraftFeedback.account",
  // A MIME type on a captured state file, chosen so the injection re-attaches
  // the file with the shape the skill reads. Nothing renders it.
  "upsertLiAgentState.contentType",
  "chargeClientCredits.operation",
  "claimTaskForExecution.(arg2)[]",
  "clearAgentIntakeFields.(arg1)[]", // field NAMES to clear, not values
  "createAsset.agentId",
  "createAsset.channels[]",
  "createAsset.createdBy",
  "createAsset.meta.source",
  "createAsset.mimeType",
  "createAsset.publishMode",
  "createAsset.status",
  "createAsset.type",
  "createCampaign.status",
  // `Client.domains` holds hostnames, which no reader reads as prose — and the
  // literal the walk sees at this path is the "," handed to `.split()`.
  "createClient.domains",
  "createClient.onboardingStatus",
  "createClient.status",
  "createClientCompetitor.source",
  "createClientTask.owner",
  "createClientTask.priority",
  "createClientTask.source",
  "createClientTask.status",
  "createCustomAgent.color",
  "createCustomAgent.icon",
  "createJob.agentId",
  "createJob.events[].level",
  "createJob.status",
  "createPlannedScheduledRun.status",
  "creditClientCredits.kind",
  "creditClientCredits.operation",
  "logActivity.actorRole",
  "logActivity.type", // drives the timeline's icon/label config, never printed raw
  "logActivity.metadata.runType", // metadata is dropped at the RSC boundary entirely
  "logActivity.metadata.taskType",
  "logFeedback.agentId",
  "logFeedback.creatorRole",
  "logFeedback.scope",
  "markIntegrationExpired.(arg1)",
  "releaseTaskClaim.(arg1)",
  "replaceReportCompetitors.(arg1)",
  "updateActionItem.status",
  "updateAsset.publishMode",
  "updateAsset.status",
  "updateClient.onboardingStatus",
  "updateClientCompetitor.source",
  "updateClientTask.metadata.type",
  "updateClientTask.status",
  "updateEmployeeSeat.status",
  "updateJob.events[].level",
  "updateJob.external.taskType",
  "updateJob.status",
  // Same enum, same audience answer as createPlannedScheduledRun.status above —
  // the cascade-pause on agent disable/unassignment (custom-agent-actions.ts) is
  // the first UPDATE call site to plant a literal here.
  "updatePlannedScheduledRun.status",
  "updateTranscript.assignment",
  "upsertAgentIntake.agent",
  "upsertClientContextDoc.docType",
  "upsertClientContextDoc.tier",
  "upsertClientIntegration.method",
  "upsertClientIntegration.platform",
  "upsertClientIntegration.status",
  "upsertClientMarketingAnalytics.assetType",
  "upsertClientMarketingAnalytics.platform",
  // Jira issue type name (Task/Bug/Story) — an admin-only config value read
  // only by the Jira API client, never rendered on any client screen.
  "upsertJiraConfig.issueType",
];

describe("the client copy that travels through the database", () => {
  it("found the writers, the writes, and the fields", () => {
    // Non-vacuity, three ways. Both halves of the writer derivation have to work
    // (the data.ts seed AND the one-hop wrapper pass, which is the only way
    // `logActivity` — the writer that matters most here — gets in at all), and
    // the field walk has to produce a realistic inventory. If any of the three
    // broke, every sweep below would hold over nothing and read as green.
    expect(PERSISTING_WRITERS.size, "found no Firestore writers in data.ts").toBeGreaterThan(40);
    expect(PERSISTING_WRITERS.has("createActivityLog")).toBe(true);
    expect(PERSISTING_WRITERS.has("logActivity"), "the wrapper hop found nothing").toBe(true);
    expect(/\bActivityLog\b/.test(PERSISTING_WRITERS.get("logActivity")!.typeText)).toBe(true);
    // A reader that never persists must NOT be in here, or "is this persisted"
    // stopped being a question.
    expect(PERSISTING_WRITERS.has("listClientActivityLogs")).toBe(false);
    expect(PERSISTING_WRITERS.has("getClientTask")).toBe(false);

    expect(PERSISTED_CHUNKS.length, "found no persisted literals").toBeGreaterThan(250);
    // The two parts of the scan that a call-site-only reader would not have, both
    // asked STRUCTURALLY. Naming the strings instead would pin their spelling and
    // fail the day somebody improves the copy this channel exists to improve.
    //
    // Raw writes inside data.ts: the one leak we already know about
    // (applyChainAssignments' recommendedReason) is a batch.set, not a call to a
    // named writer.
    expect(
      PERSISTED_CHUNKS.some((c) => c.writer === "(data.ts raw write)"),
      "raw batch/transaction writes inside data.ts are out of scope",
    ).toBe(true);
    // The one-hop parameter follow: the credit ledger's client-facing reasons are
    // literals at a private helper's CALL SITES, not at the persisting call.
    const followed = PERSISTED_CHUNKS.filter((c) => c.viaParam);
    expect(followed.length, "the parameter follow contributed nothing").toBeGreaterThan(5);
    expect(
      followed.some((c) => CLIENT_READ.includes(c.key)),
      "the follow reached nothing a client reads, so it is decorative",
    ).toBe(true);
  });

  it("has an audience for every persisted field it found", () => {
    // FAIL CLOSED, and this is the property the channel exists for. A new
    // persisted string field is not skipped — it is a failure that asks the one
    // question only the person adding it can answer.
    //
    // Two units, and the difference is the BLOCKING fix: an audience claim is
    // matched on the key WITH the write's own tier, a "not text" claim on the
    // audience-blind pair. So a per-tier exemption cannot cover a sibling call
    // site that writes a different tier.
    const audienceKeys = new Set([...CLIENT_READ, ...Object.keys(NOT_ON_A_CLIENT_SCREEN)]);
    const notText = new Set(NOT_TEXT);
    // ONE REPRESENTATIVE PER KEY, carried as the chunk itself. The first shape of
    // this joined the key and the pair into one string and split them back apart,
    // and the separator went in as a literal NUL byte — which turns this whole
    // file binary to grep, silently, and is the third relapse of guard zone 12 in
    // this campaign. There is no separator to get wrong if nothing is joined.
    const perKey = new Map(PERSISTED_CHUNKS.map((c) => [c.key, c] as const));
    const unclassified = [...perKey.values()]
      .filter((c) => !audienceKeys.has(c.key) && !notText.has(c.pair))
      .map((c) => c.key)
      .sort();
    expect(
      unclassified,
      "add each to CLIENT_READ, NOT_ON_A_CLIENT_SCREEN or NOT_TEXT, citing who renders it",
    ).toEqual([]);
    // And no field may be filed twice, which is how a "client" entry gets
    // quietly neutralised by a duplicate in NOT_TEXT.
    const all = [...audienceKeys, ...NOT_TEXT];
    expect(all.length, "a field is filed under two audiences").toBe(new Set(all).size);
    // The same trap one level up: NOT_TEXT is audience-blind, so a pair parked
    // there would swallow EVERY tier of a field an audience list classifies per
    // tier. The two lists must not overlap on the pair either.
    expect(
      NOT_TEXT.filter((k) => k.includes("@")),
      "NOT_TEXT is keyed by the audience-blind pair — drop the @tier",
    ).toEqual([]);
    const audiencePairs = new Set([...audienceKeys].map((k) => k.split("@")[0]!));
    expect(
      NOT_TEXT.filter((k) => audiencePairs.has(k)),
      "this field is classified per audience elsewhere; NOT_TEXT would shadow every tier of it",
    ).toEqual([]);
    // Every list entry must still name a field that EXISTS, or the citations rot
    // into a list of fields nobody writes any more.
    const foundKeys = new Set(PERSISTED_CHUNKS.map((c) => c.key));
    const foundPairs = new Set(PERSISTED_CHUNKS.map((c) => c.pair));
    expect(
      [...audienceKeys].filter((k) => !foundKeys.has(k)),
      "no writer puts a literal in these",
    ).toEqual([]);
    expect(NOT_TEXT.filter((k) => !foundPairs.has(k)), "no writer puts a literal in these").toEqual(
      [],
    );
  });

  it("keys a write's audience off the argument that decides it", () => {
    // The BLOCKING fix, asked in all three directions.
    //
    // ROT GUARD first: `tier` is the discriminator because the schema says that
    // field names an audience and names the client as one of its values. If that
    // declaration moves, the discriminator is keyed to a field that no longer
    // decides anything, and this is where that shows up.
    expect(
      code(src("lib/types.ts")),
      "ContextDocTier no longer names the client, so `tier` may not be the discriminator",
    ).toMatch(/export type ContextDocTier =[^;]*"client"/);
    expect(code(src("lib/types.ts")), "ClientContextDoc.tier moved or was renamed").toMatch(
      /\n\s*tier: ContextDocTier;/,
    );

    // It is DOING WORK: the same writer's fields carry more than one audience,
    // which is the whole reason the pair was not a classifiable unit.
    const tiers = new Set(
      PERSISTED_CHUNKS.filter((c) => c.writer === "upsertClientContextDoc")
        .map((c) => c.key.split("@")[1])
        .filter((t): t is string => Boolean(t)),
    );
    expect(
      tiers.size,
      "one tier only — the discriminator is not separating the call sites",
    ).toBeGreaterThan(2);
    expect(tiers.has('tier="client"')).toBe(true);
    expect(tiers.has('tier="internal-only"')).toBe(true);
    // A tier decided at runtime gets its own key rather than inheriting a
    // neighbour's citation: `existingDoc?.tier ?? "internal"` is not a literal.
    expect(tiers.has("tier=?"), "a computed tier must not read as a named one").toBe(true);
    // And writers with no audience argument are untouched — key IS pair, so the
    // other 80-odd classifications keep their unit.
    const undiscriminated = PERSISTED_CHUNKS.filter((c) => c.writer !== "upsertClientContextDoc");
    expect(undiscriminated.every((c) => c.key === c.pair)).toBe(true);
    expect(undiscriminated.length).toBeGreaterThan(200);
  });

  it("lets no AUDIENCE citation cover a positional bucket", () => {
    // The `tier` fix closed one shape of this; here is the other. When a writer's
    // argument is not an object literal its literals land at the positional path
    // `(argN)`, so SEVERAL distinct strings can share one key — and the
    // classification lists are keyed, with `perKey` carrying one representative.
    // One citation would then vouch for strings nobody read.
    //
    // Verified rather than assumed, and the answer differs by list. NOT_TEXT is
    // safe: its prose check runs over ALL of PERSISTED_CHUNKS, not the
    // representative, so a sentence hiding behind a token in the same bucket still
    // fails ("puts no prose in a field it calls a stored value", below). An
    // AUDIENCE entry has no such per-chunk half — "who reads this" is answered once
    // per key — so a positional path there IS fail-open, and is forbidden.
    const positional = [...CLIENT_READ, ...Object.keys(NOT_ON_A_CLIENT_SCREEN)].filter((k) =>
      /\(arg\d+\)/.test(k),
    );
    expect(
      positional,
      "an audience citation must name a field, not an argument position — several literals share that key",
    ).toEqual([]);

    // Non-vacuity: positional keys exist in the scan at all, so this is not green
    // because the path shape never occurs.
    expect(
      PERSISTED_CHUNKS.filter((c) => /\(arg\d+\)/.test(c.pair)).length,
      "no positional paths found — the recogniser or the scan changed shape",
    ).toBeGreaterThan(0);
  });

  it("puts no prose in a field it calls a stored value", () => {
    // What keeps NOT_TEXT from becoming the place offences go to die. "A stored
    // token" and "a sentence" are different shapes, and the difference is
    // checkable, so the claim is checked rather than trusted.
    const bad = PERSISTED_CHUNKS.filter(
      (c) => NOT_TEXT.includes(c.pair) && IS_PROSE.test(c.shape),
    ).map((c) => `${c.pair} at ${c.rel}:${c.line} — ${JSON.stringify(c.shape.slice(0, 60))}`);
    expect(bad, "this reads as a sentence; classify it by who reads it").toEqual([]);
  });

  it("knows which activity rows a client never sees", () => {
    // The row gate, both directions. Without it this sweep would be pressing
    // somebody to rewrite the ops-import bookkeeping and the staff composer's own
    // notes as client copy; if it over-fired, the client-facing rows would fall
    // out of scope and the sweep would pass by looking at nothing.
    const gated = PERSISTED_CHUNKS.filter((c) => c.rowGate);
    expect(gated.length, "recognised no staff-only activity row anywhere").toBeGreaterThan(3);
    // BOTH recognisers have to be doing work, and the assertion is about the
    // gate's own reason string — vocabulary this file owns — rather than about
    // the wording of any row, which is the copy this channel exists to improve.
    expect(
      gated.some((c) => /MANUAL_NOTE/.test(c.rowGate!)),
      "the MANUAL_NOTE gate did not fire",
    ).toBe(true);
    expect(
      gated.some((c) => /machinery title from \w+\(\)/.test(c.rowGate!)),
      "no row was gated by CALLING its title builder",
    ).toBe(true);
    // …and the rows a client DOES read are still in scope, with sentences in them.
    const open = PERSISTED_CHUNKS.filter((c) => c.key === "logActivity.title" && !c.rowGate);
    expect(open.length, "every activity title was gated out").toBeGreaterThan(8);
    expect(
      open.filter((c) => IS_PROSE.test(c.shape)).length,
      "the in-scope titles hold no prose, so the sweep reads nothing",
    ).toBeGreaterThan(5);
  });

  it("carries no spaced hyphen and no stored enum in any of it", () => {
    // Where this was broken. The research-report row's persisted descriptions
    // carried the exact `" - "` ledger F71 bans, on the client's own timeline: the
    // recurring cron's "…(5 core research agents + SEO/GEO multi-model vertical) -
    // recurring schedule" and the regenerate's " - with run-specific context: …".
    // The doc-correction rows printed a kebab-case Firestore value straight into
    // prose a client reads — "branding-guidelines corrected (targeted)" on the
    // timeline and "Doc correction · branding-guidelines" in their credit ledger.
    const bad = PERSISTED_CHUNKS.filter((c) => CLIENT_READ.includes(c.key) && !c.rowGate).flatMap(
      (c) =>
        say(c).map(
          (o) =>
            `${c.key} (${c.rel}:${c.line}) — ${o}: ${JSON.stringify(c.shape.replace(/\s+/g, " ").slice(0, 90))}`,
        ),
    );
    expect(bad, "stored on one day, rendered to a client on another").toEqual([]);
  });

  it("checks a title composed by a builder through the builder", () => {
    // The hole consolidation opens: once a writer says `title:
    // researchReportReadyTitle()`, the literal moves to activity-titles.ts and
    // the write-site scan above can no longer see it. So the module is swept
    // BEHAVIOURALLY and in full — every exported function that returns a string,
    // called with placeholders — rather than by naming the two that exist today.
    //
    // Machinery titles are exempt because the timeline drops them for client
    // viewers; that is the same boundary as the row gate, asked of the builder
    // instead of the call site.
    let checkedClientFacing = 0;
    for (const [name, value] of Object.entries(ACTIVITY_TITLES)) {
      if (typeof value !== "function") continue;
      let out: unknown;
      try {
        out = (value as (...a: unknown[]) => unknown)(
          ...Array.from({ length: (value as (...a: unknown[]) => unknown).length }, () => "x"),
        );
      } catch {
        continue;
      }
      if (typeof out !== "string") continue;
      if (isRunMachineryTitle(out)) continue;
      checkedClientFacing++;
      expect(offences(out), `${name}() reads: ${JSON.stringify(out)}`).toEqual([]);
    }
    // Non-vacuity: the machinery skip must not have swallowed the whole module.
    expect(checkedClientFacing, "no client-facing builder was checked").toBeGreaterThan(1);
    // The description builder takes an object, so the placeholder call above
    // exercises only its default branch. Both branches, explicitly.
    expect(
      ACTIVITY_TITLES.researchReportReadyDescription({ recurring: true }),
    ).not.toContain(" - ");
    expect(
      offences(ACTIVITY_TITLES.researchReportReadyDescription({ recurring: false, focus: '"spring launch"' })),
    ).toEqual([]);
  });

  it("holds its two no-reader claims to being checkable", () => {
    // A citation that says "nobody renders this" is a repo-wide negative, and a
    // negative nobody checks is the overstated-guarantee shape. These two are the
    // ones the lists above lean on hardest, so both are asked of the source — and
    // the first shape of this asking was fail-open twice over:
    //
    //  • IT ONLY LOOKED AT `.tsx`, while the citation said "no component OR ROUTE
    //    MODULE", and a route module is `route.ts`. Printing either field into a
    //    handler's JSON — or into a lib module the copilot's system prompt reads,
    //    which is a client-read path this very file relies on elsewhere — left
    //    both negatives green. Proved by plant, in both fields.
    //  • THE TRUTHINESS EXEMPTION WAS A PER-LINE REGEX. "Every mention is inside a
    //    Boolean(…)" was asked as "this LINE contains `Boolean(…executionError`",
    //    so `Boolean(t.metadata?.executionError) ? <span>{t.metadata.executionError}</span> : null`
    //    — the guard and the render on one line, which is how anyone would write
    //    it — excluded itself. Proved by plant into a live component.
    //
    // So both are asked of the AST, over every .ts and .tsx in src, and a USE is
    // sorted by what it is: reading `x.field` or destructuring `{ field }` is a
    // READ, while `field: value`, `field?: string` in an interface and a parameter
    // or local that happens to share the name are not. That distinction is what
    // lets the question be repo-wide instead of extension-bound — `executionError`
    // is written in nine lib modules and read in exactly one component.
    const TRUTHINESS = (n: ts.Node): boolean => {
      const p = n.parent;
      if (!p) return false;
      if (ts.isCallExpression(p) && p.expression.getText() === "Boolean") return true;
      if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
      if (ts.isIfStatement(p) || ts.isWhileStatement(p)) return p.expression === n;
      if (ts.isConditionalExpression(p)) return p.condition === n;
      return false;
    };

    const readsOf = (field: string) => {
      const reads: string[] = [];
      const mentions: string[] = [];
      for (const abs of walk(SRC)) {
        if (abs.includes("__tests__")) continue;
        const sf = parse(abs);
        const where = (n: ts.Node) => `${relOf(sf)}:${lineOf(sf, n.getStart(sf))}`;
        const visit = (n: ts.Node) => {
          const named =
            (ts.isPropertyAccessExpression(n) && n.name.text === field) ||
            (ts.isElementAccessExpression(n) &&
              n.argumentExpression &&
              ts.isStringLiteralLike(n.argumentExpression) &&
              n.argumentExpression.text === field) ||
            (ts.isBindingElement(n) &&
              ts.isObjectBindingPattern(n.parent) &&
              (n.propertyName ?? n.name).getText(sf) === field);
          if (named) reads.push(`${where(n)} ${TRUTHINESS(n) ? "(truthiness)" : "AS TEXT"}`);
          if (
            (ts.isPropertyAssignment(n) ||
              ts.isShorthandPropertyAssignment(n) ||
              ts.isPropertySignature(n)) &&
            n.name.getText(sf).replace(/^["']|["']$/g, "") === field
          ) {
            mentions.push(where(n));
          }
          n.forEachChild(visit);
        };
        visit(sf);
      }
      return { reads, mentions };
    };

    // NON-VACUITY FIRST, and it is the half the old shape had none of: a negative
    // over a file list nobody counted is green when the list is empty. Both fields
    // must be FOUND in src as written fields, or the walk is not reading source.
    const sourceLabel = readsOf("sourceLabel");
    const executionError = readsOf("executionError");
    expect(sourceLabel.mentions.length, "found no sourceLabel field in src at all").toBeGreaterThan(1);
    expect(executionError.mentions.length, "found no executionError field in src at all").toBeGreaterThan(8);

    // `sourceLabel`: written by the copilot's task creation, read by nothing. The
    // day anything reads it — a component, a route handler, or a lib module
    // composing the copilot's prompt — this fails and asks for a reclassification.
    expect(
      sourceLabel.reads,
      "sourceLabel now has a reader — move it out of NOT_ON_A_CLIENT_SCREEN",
    ).toEqual([]);

    // `metadata.executionError`: read for truthiness and never printed, which is
    // why its own spaced hyphen is out of scope here. The read must EXIST (or the
    // detector is broken and the claim is vacuous) and every read must be a
    // truthiness one.
    expect(
      executionError.reads.length,
      "found no executionError read at all — the detector is not working",
    ).toBeGreaterThan(0);
    expect(
      executionError.reads.filter((r) => r.endsWith("AS TEXT")),
      "executionError is read as text now — it is a diagnostic, not client copy",
    ).toEqual([]);
  });

  it("names the documents those rows interpolate, rather than their stored keys", () => {
    // The rows fixed above interpolate a doc-type NAME into prose a client reads
    // ("Brand voice corrected", "Document correction · Brand voice"). The Record
    // type makes a missing entry a compile error; what it cannot make an error is
    // an entry that just echoes the stored key back, which is the defect itself.
    for (const [key, label] of Object.entries(CONTEXT_DOC_LABEL)) {
      expect(label, `${key} has no name of its own`).not.toBe(key);
      expect(label, `${key}'s label is still kebab-case`).not.toMatch(/-/);
      expect(offences(label)).toEqual([]);
    }
    expect(contextDocLabel("brand-voice")).not.toBe("brand-voice");
    // The fallback still returns the stored key for a type Firestore holds and the
    // union does not — stated in the module, and pinned so it stays deliberate.
    expect(contextDocLabel("some-future-doc")).toBe("some-future-doc");
  });

  it("keeps the three tellings of the research report in one home", () => {
    // A client reads exactly ONE of these — the cron's row, the regenerate's row,
    // or the row the timeline derives from the stored report when neither exists
    // (hasIntelLog). They had three spellings, so which words a client saw
    // depended on which writer got there first.
    //
    // The search term is READ FROM THE BUILDER, not typed here. Pinning
    // "Research report ready" would make this go red the day somebody improves
    // the sentence — a canary blocking its own improvement — and would say
    // "call the builder instead" about a file that already does. Derived, a
    // rewording moves the question with it.
    //
    // Over string literals via the AST, so the docstrings that quote the retired
    // wording cannot make their own guard red. Non-vacuity is built in: the home
    // file is what the expectation names, so a broken walk fails here rather than
    // reporting an empty offender list.
    const title = ACTIVITY_TITLES.researchReportReadyTitle();
    const offenders = walk(SRC)
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => {
        const sf = parse(f);
        let hit = false;
        const visit = (n: ts.Node) => {
          if (hit) return;
          for (const c of messageChunks(n, sf)) if (c.shape.trim() === title) hit = true;
          if (!hit) n.forEachChild(visit);
        };
        visit(sf);
        return hit;
      })
      .map(toRel);
    expect(offenders, "call researchReportReadyTitle() instead").toEqual([
      "lib/activity-titles.ts",
    ]);
    // And the three surfaces that narrate this event go through it. Named, like
    // the WRITERS list in activity-titles.test.ts and for the same reason: the
    // repo-wide question above catches a fourth site retyping the CURRENT words,
    // and this one catches these three drifting away from the builder.
    //
    // The CALL, with its paren. `toContain("researchReportReadyTitle")` alone was
    // satisfied by the IMPORT: a writer that dropped the call and re-inlined
    // "Intel Report generated" kept this green, which is the exact drift the test
    // is for. The two persisted writers own the description as well; the timeline
    // composes its own from the report's score and date.
    for (const rel of [
      "app/api/intel-report-schedule/route.ts",
      "lib/actions/intel-actions.ts",
      "components/activity-timeline.tsx",
    ]) {
      expect(code(src(rel)), `${rel} no longer CALLS the title builder`).toContain(
        "researchReportReadyTitle(",
      );
    }
    for (const rel of ["app/api/intel-report-schedule/route.ts", "lib/actions/intel-actions.ts"]) {
      expect(code(src(rel)), `${rel} no longer CALLS the description builder`).toContain(
        "researchReportReadyDescription(",
      );
    }
  }, 20_000);

  it("calls the correction one thing on the card that prices it and records it", () => {
    // The OTHER half of a consolidation, and this file's own rename walked into
    // it: giving the ledger reasons one home ("Document correction · Brand voice",
    // "Global document correction") put a second name for one purchase on a screen
    // that already had one. CreditsPanel prices "doc correction" at the top, tells
    // a blocked client "doc corrections are paused" nineteen lines above the
    // ledger, and then renders `{e.reason}` — the row that says "Document
    // correction". One card, two nouns, and the client is meant to match the
    // charge to the price.
    //
    // Asked as AGREEMENT, not as a spelling. The head noun is read off both sides
    // and they must be the SAME word, so renaming both to "content correction"
    // passes and renaming one does not — a pinned "document" here would be the
    // canary trap this campaign keeps walking into.
    const HEAD_NOUN = /\b(docs?|documents?)\s+correction/gi;
    const nounsIn = (strings: string[]) =>
      new Set(
        strings.flatMap((s) =>
          [...s.matchAll(HEAD_NOUN)].map((m) => m[1]!.toLowerCase().replace(/s$/, "")),
        ),
      );

    const panel = (() => {
      const abs = join(SRC, "components/credits-panel.tsx");
      const sf = parse(abs);
      return messageChunks(sf, sf).map((c) => c.shape);
    })();
    const ledger = PERSISTED_CHUNKS.filter(
      (c) => c.pair === "chargeClientCredits.reason" || c.pair === "creditClientCredits.reason",
    ).map((c) => c.shape);

    // Non-vacuity on BOTH sides: an empty side makes a one-spelling claim true by
    // finding nothing, which is exactly how this defect survived a rename.
    const panelNouns = nounsIn(panel);
    const ledgerNouns = nounsIn(ledger);
    expect(panelNouns.size, "credits-panel.tsx names no correction at all").toBeGreaterThan(0);
    expect(ledgerNouns.size, "no ledger reason names a correction at all").toBeGreaterThan(0);
    expect(
      [...new Set([...panelNouns, ...ledgerNouns])],
      "the panel and the ledger rows it renders use two different nouns for one purchase",
    ).toHaveLength(1);
  });
});
