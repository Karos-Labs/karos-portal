import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isStringDelimiter,
  matchingBrace,
  matchingParen,
  skipStringLiteral,
  stripComments,
} from "./source-scan";

/**
 * #160 — EVERY SERVER ACTION AUTHORIZES, AND NOTHING SAID SO.
 *
 * A server action is a PUBLIC ENDPOINT. Next.js gives each export of a
 * `"use server"` module its own POST-able id, so the button that calls it is
 * not the guard — anything that can reach the origin can call it directly with
 * whatever arguments it likes. The house convention (CLAUDE.md) is that each
 * one authorizes for itself via `getCurrentUser()` / `requireStaff()` /
 * `requireAdmin()`. Roughly forty modules follow it and NOTHING asserted it, so
 * the thirty-eighth module was one review away from not.
 *
 * WHAT THIS SWEEP IS KEYED TO, and why it is not a list of module names: the
 * directive. A module is in scope because its source begins with `"use server"`
 * — which is the very thing that makes its exports network-reachable — so a new
 * module is swept the moment it is written, and there is no inventory to
 * forget. The only hand-written list is the four ACTIONS that deliberately have
 * no authorizer, and each of those is filed in a bucket that checks its own
 * claim rather than taking it (see UNAUTHENTICATED below). That list is
 * asserted in BOTH directions: a new unfenced action fails until someone files
 * it, and an entry that has since been fenced or deleted fails too.
 *
 * WHAT "AUTHORIZES" MEANS HERE, in the order the analyser tries them:
 *
 *   1. it calls one of the gates `_shared.ts` exports — and the gate NAMES are
 *      read out of `_shared.ts` itself, keeping this file from carrying a
 *      second, drifting copy of them. A gate qualifies by shape: it resolves
 *      the session and refuses when there is none (see `refusesOnMissingSession`).
 *   2. it resolves the session itself and refuses on it — `const u = await
 *      getCurrentUser()` followed by an `if` whose condition tests `!u` and
 *      whose branch throws or returns. Keyed to the BINDING, not to a message
 *      spelling, so renaming the variable is honoured and renaming the error
 *      text changes nothing.
 *   3. it calls a function in the same module that does either of the above,
 *      transitively — the `requireActionItem` / `requireSeatAccess` /
 *      `requireXAgentAccess` shape, which is how eight of these modules
 *      actually spell their fence.
 *
 * Anything else is reported. The direction of the error matters: an action the
 * analyser cannot see a fence in is REPORTED, never assumed fine, so every way
 * of getting this wrong — including a fence written in a shape this file does
 * not know — turns the suite red rather than green.
 */

const ACTIONS_DIR = join(process.cwd(), "src/lib/actions");
const SRC_DIR = join(process.cwd(), "src");

/* ────────────────────────── source-text primitives ────────────────────────── */

/** A `"use server"` directive as a STATEMENT — file-level or inside a function. */
const USE_SERVER_DIRECTIVE = /(?:^|\n)\s*["']use server["']\s*;?/;

interface Sliced {
  name: string;
  exported: boolean;
  /** The parameter list, parentheses included. */
  params: string;
  /** The function body, braces included. */
  body: string;
}

/**
 * The opening brace of a function BODY, starting the search after the `)` that
 * closes its parameter list.
 *
 * Not "the next `{`": an async function's return type is written between the
 * two, and `Promise<{ ok: true } | { ok: false; error: string }>` is four
 * braces that are not the body. Angle-bracket depth tells them apart — a `>`
 * preceded by `=` is an arrow inside a type, not a closing bracket. A `;` at
 * depth zero means there was no body at all (a declaration), reported as -1 so
 * the caller can fail rather than slice something arbitrary.
 */
function bodyBraceAfter(src: string, closingParen: number): number {
  let angle = 0;
  for (let i = closingParen + 1; i < src.length; i++) {
    const ch = src[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "<") angle++;
    else if (ch === ">") {
      if (src[i - 1] !== "=") angle--;
    } else if (ch === "{" && angle <= 0) return i;
    else if (ch === ";" && angle <= 0) return -1;
  }
  return -1;
}

/**
 * Every `function NAME(...) { … }` declaration in already-comment-stripped
 * source, exported or not.
 *
 * Sliced from the brace that opens the BODY, found via the paren that closes
 * the PARAMETER LIST — slicing from the first brace after the name would slice
 * from inside a generic parameter list or a return type. Nested declarations
 * come out as their own entries too; harmless, since the only use of a
 * non-exported entry is "may an exported action delegate its fence to this".
 */
function sliceFunctions(src: string): { fns: Sliced[]; malformed: string[] } {
  const fns: Sliced[] = [];
  const malformed: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(export\s+)?(?:async\s+)?function\s+(\w+)\s*(?=[(<])/g)) {
    const name = m[2]!;
    const exported = Boolean(m[1]);
    let i = m.index! + m[0].length;
    if (src[i] === "<") {
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === "<") depth++;
        else if (src[i] === ">" && --depth === 0) {
          i++;
          break;
        }
      }
    }
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== "(") {
      malformed.push(`${name}: no parameter list`);
      continue;
    }
    const closeParen = matchingParen(src, i);
    const openBrace = closeParen < 0 ? -1 : bodyBraceAfter(src, closeParen);
    const closeBrace = openBrace < 0 ? -1 : matchingBrace(src, openBrace);
    if (closeParen < 0 || openBrace < 0 || closeBrace < 0) {
      malformed.push(`${name}: could not slice a body`);
      continue;
    }
    fns.push({
      name,
      exported,
      params: src.slice(i, closeParen + 1),
      body: src.slice(openBrace, closeBrace + 1),
    });
  }
  return { fns, malformed };
}

/** The statement an `if (…)` governs: its braced block, or up to the first `;`. */
function governedStatement(body: string, closingParen: number): string {
  let i = closingParen + 1;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  if (body[i] === "{") {
    const close = matchingBrace(body, i);
    return close > i ? body.slice(i, close + 1) : "";
  }
  let j = i;
  for (; j < body.length; j++) {
    const ch = body[j]!;
    if (isStringDelimiter(ch)) {
      j = skipStringLiteral(body, j);
      continue;
    }
    if (ch === ";") break;
  }
  return body.slice(i, j + 1);
}

/** The two functions that turn a request's cookies into a user, or nothing. */
const SESSION_READER = /const\s+(\w+)\s*=\s*await\s+(?:getCurrentUser|getSessionUser)\s*\(/g;

/**
 * Does this body resolve the session and REFUSE when there is none?
 *
 * The refusal is keyed to the binding the session landed in: an `if` whose
 * condition tests `!thatBinding`, whose branch throws or returns. That is
 * deliberately narrower than "the body contains a throw somewhere" — a body
 * that throws "Client not found" three statements later has not checked
 * anything about the caller, and a rule loose enough to accept it would accept
 * an action with no fence at all.
 *
 * It is deliberately blind to WHICH roles are then allowed. This sweep's
 * question is "did anything ask who the caller is", which is the one that was
 * unasked; the role split per action is a behavioural question and is asked of
 * the money and role paths in credit-actions.test.ts / user-actions.test.ts.
 */
function refusesOnMissingSession(body: string): boolean {
  for (const m of body.matchAll(SESSION_READER)) {
    const binding = m[1]!;
    const testsBinding = new RegExp(`!\\s*${binding}\\b`);
    for (const g of body.matchAll(/\bif\s*\(/g)) {
      const open = g.index! + g[0].length - 1;
      const close = matchingParen(body, open);
      if (close < 0) continue;
      if (!testsBinding.test(body.slice(open, close + 1))) continue;
      const branch = governedStatement(body, close);
      if (/\bthrow\b/.test(branch) || /\breturn\b/.test(branch)) return true;
    }
  }
  return false;
}

/* ─────────────────── the gates, read out of _shared.ts ─────────────────── */

const sharedSrc = stripComments(readFileSync(join(ACTIONS_DIR, "_shared.ts"), "utf8"));
const sharedFns = sliceFunctions(sharedSrc);
/** Exported helpers of `_shared.ts` that themselves refuse a session-less caller. */
const SHARED_GATES = sharedFns.fns
  .filter((f) => f.exported && refusesOnMissingSession(f.body))
  .map((f) => f.name);

/**
 * `requireUser` (lib/auth.ts) redirects to /login, /pending or /dashboard
 * rather than throwing — a refusal the shape test above cannot see because it
 * is a redirect, not a throw. Named here, and only here, so the exception is
 * one line rather than a loosening of the rule.
 */
const CROSS_MODULE_GATES = ["requireUser"];

const GATE_CALL = new RegExp(
  `\\b(?:${[...SHARED_GATES, ...CROSS_MODULE_GATES].join("|")})\\s*\\(`,
);

/* ─────────────────────────── the module analyser ─────────────────────────── */

interface Analysis {
  exported: string[];
  unauthorized: string[];
  malformed: string[];
  byName: Map<string, Sliced>;
}

function analyse(src: string): Analysis {
  const { fns, malformed } = sliceFunctions(src);
  const selfAuthorizes = (fn: Sliced) =>
    GATE_CALL.test(fn.body) || refusesOnMissingSession(fn.body);

  const authorizing = new Set<string>();
  for (let pass = 0; pass < fns.length + 1; pass++) {
    let grew = false;
    for (const fn of fns) {
      if (authorizing.has(fn.name)) continue;
      if (selfAuthorizes(fn)) {
        authorizing.add(fn.name);
        grew = true;
        continue;
      }
      // Delegation: a local helper that authorizes, CALLED (not merely named —
      // a mention in a type or a string is not a fence).
      for (const other of fns) {
        if (other.name === fn.name || !authorizing.has(other.name)) continue;
        if (new RegExp(`\\b${other.name}\\s*\\(`).test(fn.body)) {
          authorizing.add(fn.name);
          grew = true;
          break;
        }
      }
    }
    if (!grew) break;
  }

  const exported = fns.filter((f) => f.exported).map((f) => f.name);
  return {
    exported,
    unauthorized: exported.filter((n) => !authorizing.has(n)),
    malformed,
    byName: new Map(fns.map((f) => [f.name, f])),
  };
}

/* ───────────────────────────── the module list ───────────────────────────── */

const modules = readdirSync(ACTIONS_DIR)
  .filter((n) => n.endsWith(".ts"))
  .sort()
  .map((name) => {
    const src = stripComments(readFileSync(join(ACTIONS_DIR, name), "utf8"));
    return { name, src, isActionModule: /^\s*["']use server["']/.test(src) };
  });

const actionModules = modules.filter((m) => m.isActionModule);
const analyses = new Map(actionModules.map((m) => [m.name, analyse(m.src)]));

/** `module.ts#actionName`, the key the exemption list is written in. */
const unauthorizedFound = actionModules
  .flatMap((m) => analyses.get(m.name)!.unauthorized.map((a) => `${m.name}#${a}`))
  .sort();

/* ───────────────────────── the exemptions, and their claims ───────────────────────── */

/**
 * The four actions that reach no authorizer, and the mechanical property that
 * makes each one safe without it. THIS LIST IS THE MOST DANGEROUS LINE IN THE
 * FILE, so no entry is taken on its word:
 *
 *   public-intake  — reachable before anyone has an account (the prospect form,
 *                    the invitation-key check on the sign-up screen). The claim
 *                    checked is that it may LOOK SOMETHING UP or FILE A NEW
 *                    RECORD and nothing else: no call that updates, deletes or
 *                    replaces existing state, and none that moves credits. An
 *                    unauthenticated endpoint that grew a write is the shape
 *                    this bucket exists to catch, and it catches it by reading
 *                    the calls, not the comment above them.
 *   delegated      — the fence is real but lives in another module. The entry
 *                    NAMES the function and the file; the sweep opens that file,
 *                    slices that function and applies the same refusal shape to
 *                    it. A delegate that stops refusing takes the action red
 *                    with it.
 *   own-session    — it can only affect the caller's own session. Checked as:
 *                    takes NO parameters (nothing the caller says can steer it)
 *                    and calls nothing this module imported from `@/lib/data`
 *                    (so it touches no stored record at all).
 */
type Bucket =
  | {
      kind: "public-intake";
      /**
       * EVERY call this action may make, exactly. Not a list of forbidden verbs —
       * see the note on the bucket. Adding any call, whatever it is spelled,
       * fails until it is recorded here and someone has looked at it.
       */
      mayCall: readonly string[];
    }
  | { kind: "delegated"; fn: string; file: string }
  | { kind: "own-session" };

const UNAUTHENTICATED: Record<string, Bucket> = {
  // The "Request New Client Setup" form on the marketing side of the login
  // screen: a prospect with no account files an intake record for staff to
  // review. Nothing existing is read or changed.
  "request-actions.ts#submitClientRequestAction": {
    kind: "public-intake",
    // Files a new record, and tells staff it arrived. `sendEmail` is the reason
    // this bucket is an allowlist: it changes nothing in Firestore, so a
    // forbidden-verb scan waves it through — while an unauthenticated endpoint
    // that can send mail is exactly the thing worth having looked at.
    // `escapeHtml` sanitizes the prospect's fields before they land in that
    // staff-notification email body — pure string escaping, no I/O.
    mayCall: ["createClientRequest", "sendEmail", "escapeHtml"],
  },
  // The invitation-key box on the sign-up screen, which has to answer before a
  // session can exist. It resolves a key the caller already holds to the
  // workspace it belongs to, and writes nothing.
  "client-actions.ts#validateInvitationKeyAction": {
    kind: "public-intake",
    // A single lookup. Nothing is written.
    mayCall: ["getClientByKeyId"],
  },
  // The admin-only role check lives in `startImpersonation` itself.
  "user-actions.ts#startImpersonationAction": {
    kind: "delegated",
    fn: "startImpersonation",
    file: "src/lib/auth.ts",
  },
  // Dropping the impersonation cookie. Ending an elevation needs no permission.
  "user-actions.ts#stopImpersonationAction": { kind: "own-session" },
};

/**
 * The real module text the planted-shape tests below append to.
 *
 * Resolved at MODULE scope rather than inside that `describe`, on purpose: a
 * throw in a describe BODY is reported as "(0 test)" and drops the whole file
 * quietly, which is the one failure a tripwire must not be able to have. The
 * tree walk further down is hoisted for the same reason.
 */
/**
 * Every function this body CALLS, by name.
 *
 * Deliberately over-collects rather than under: a control keyword that looks
 * like a call (`if (`, `for (`) is filtered by name, and anything else it picks
 * up simply has to be recorded in an allowlist, which is the fail-closed
 * direction. Missing a real call is the failure that matters, and cannot happen.
 */
const NOT_A_CALL = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "await", "function",
  "String", "Number", "Boolean", "Array", "Object", "Date", "Error", "Promise", "Set", "Map",
  // `await import(...)` is the module system, not a callee.
  "import",
]);

function calleesIn(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/([.\w$]?)\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    // A METHOD call on some value (`x.trim()`, `Date.now()`) is not a callee this
    // bucket is about — the question is which FUNCTIONS an unauthenticated
    // endpoint reaches, and a method on a string it was handed is not one.
    if (m[1] === ".") continue;
    const name = m[2]!;
    if (NOT_A_CALL.has(name)) continue;
    out.push(name);
  }
  return out;
}

const PLANT_HOST = modules.find((m) => m.name === "credit-actions.ts")!.src;

/** A call that changes or destroys something that already exists, or moves money. */
const MUTATING_CALL =
  /\b(?:update|delete|remove|set|charge|credit|debit|upsert|revoke|approve|reject|cancel|claim|grant)[A-Z]\w*\s*\(/;

/** The identifiers a module pulled out of the data layer. */
function dataLayerImports(src: string): string[] {
  const m = /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/data["']/.exec(src);
  if (!m) return [];
  return m[1]!
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())
    .filter(Boolean);
}

/* ───────────────────────────────── the tests ───────────────────────────────── */

describe("the sweep can see what it is sweeping", () => {
  it("found the action modules on disk", () => {
    // A floor well below today's count (38 files, 36 of them action modules):
    // it catches "the walk found nothing", without turning red for a deletion.
    expect(actionModules.length).toBeGreaterThanOrEqual(20);
  });

  it("sliced every function it found", () => {
    // A body this file could not slice is a body it did not search. Reported
    // rather than skipped, because skipping is the silent direction.
    const bad = actionModules.flatMap((m) =>
      analyses.get(m.name)!.malformed.map((x) => `${m.name}: ${x}`),
    );
    expect(bad).toEqual([]);
  });

  it("read the gates out of _shared.ts rather than hard-coding them", () => {
    // Non-vacuity for the derivation itself: an empty list would make GATE_CALL
    // a regex matching almost nothing, and every module would then rest on the
    // bare-session rule alone. Named individually as well, because losing one
    // silently is the same failure with a smaller blast radius.
    expect(SHARED_GATES).toEqual(
      expect.arrayContaining(["requireStaff", "requireAdmin", "requireClientAccess"]),
    );
    expect(SHARED_GATES.length).toBeGreaterThanOrEqual(3);
  });

  it("knows every export shape these modules use", () => {
    // FAIL CLOSED on a shape the slicer cannot see. `export const doIt = async
    // () => {}` is a perfectly good server action and this file's enumeration
    // would not find it — so rather than miss it, the sweep refuses the file.
    // (Next.js erases `export type`/`export interface`, so those are not
    // actions and are allowed through.)
    //
    // The word is matched in comment-stripped source but NOT outside string
    // literals, so the word "export" inside a message would be reported here
    // too. That is noise in the safe direction and no module has one today; if
    // one ever does, the fix is to rename the string, not to loosen this.
    const unknown: string[] = [];
    for (const m of actionModules) {
      for (const g of m.src.matchAll(/\bexport\b/g)) {
        const from = g.index! + "export".length;
        const after = m.src.slice(from, from + 40);
        if (!/^\s*(?:async\s+function|function|type\s|interface\s)/.test(after)) {
          unknown.push(`${m.name}: export${after.split("\n")[0]}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe("every exported server action reaches an authorizer", () => {
  it.each(actionModules.map((m) => [m.name] as const))("%s", (name) => {
    const analysis = analyses.get(name)!;
    // Every module here declares at least one action; a file with none would
    // mean the slicer has drifted from how these modules are written.
    expect(analysis.exported.length, "no exported action found").toBeGreaterThan(0);

    const unexplained = analysis.unauthorized.filter((a) => !UNAUTHENTICATED[`${name}#${a}`]);
    expect(
      unexplained,
      `${unexplained.join(", ")} — a server action is a public endpoint; it must resolve the ` +
        `session and refuse, or delegate to something in this module that does`,
    ).toEqual([]);
  });
});

describe("the unauthenticated exemptions", () => {
  it("match what the sweep finds, in both directions", () => {
    // Both directions on purpose. A missing entry is an action nobody
    // classified; a stale entry is this file still vouching for an action that
    // has since been fenced or deleted, which is how a list like this quietly
    // stops describing the tree.
    expect(unauthorizedFound).toEqual(Object.keys(UNAUTHENTICATED).sort());
  });

  it.each(Object.keys(UNAUTHENTICATED).sort().map((k) => [k] as const))("%s", (key) => {
    const [moduleName, actionName] = key.split("#") as [string, string];
    const moduleSrc = modules.find((m) => m.name === moduleName)!.src;
    const analysis = analyses.get(moduleName)!;
    const found = analysis.byName.get(actionName);
    expect(found, "the exemption names an action that does not exist").toBeTruthy();
    const fn = found!;
    const bucket = UNAUTHENTICATED[key]!;

    if (bucket.kind === "public-intake") {
      // AN ALLOWLIST, KEYED TO THE CALLS THIS FUNCTION ACTUALLY MAKES — not a
      // list of forbidden verbs.
      //
      // It was `MUTATING_CALL`, a 15-prefix blocklist
      // (update|delete|remove|set|charge|…), and it FAILED OPEN on everything
      // spelled otherwise: `save*`, `write*`, `add*`, `assign*`, `disable*`,
      // `promote*`, `sendEmail`. That is the only guard standing behind the two
      // genuinely unauthenticated, internet-reachable server actions in this
      // repo, and its failure direction was silent. An exemption written as a
      // list of what is forbidden can only ever be as complete as whoever typed
      // it; an exemption written as what is PERMITTED fails closed by
      // construction, which is the same device the `own-session` bucket uses.
      const permitted = new Set(bucket.mayCall);
      const called = [...new Set(calleesIn(fn.body))].filter((c) => !permitted.has(c)).sort();
      expect(
        called,
        `unauthenticated, and it now calls ${called.join(", ")} — anyone on the internet can ` +
          `reach this. Look at what the new call does, then add it to mayCall with a reason.`,
      ).toEqual([]);
      // Non-vacuity in the other direction: a recorded call nothing makes any
      // more is an exemption still vouching for something that moved.
      const actual = new Set(calleesIn(fn.body));
      for (const name of bucket.mayCall) {
        expect(actual.has(name), `mayCall records ${name}, which ${actionName} no longer calls`).toBe(
          true,
        );
      }
    }

    if (bucket.kind === "delegated") {
      expect(
        new RegExp(`\\b${bucket.fn}\\s*\\(`).test(fn.body),
        `filed as delegating to ${bucket.fn}, which it does not call`,
      ).toBe(true);
      const delegateSrc = stripComments(readFileSync(join(process.cwd(), bucket.file), "utf8"));
      const delegate = sliceFunctions(delegateSrc).fns.find((f) => f.name === bucket.fn);
      expect(delegate, `${bucket.fn} is not in ${bucket.file}`).toBeTruthy();
      expect(
        refusesOnMissingSession(delegate!.body),
        `${bucket.fn} no longer refuses a session-less caller, so nothing fences ${actionName}`,
      ).toBe(true);
    }

    if (bucket.kind === "own-session") {
      expect(fn.params.replace(/\s/g, ""), "it takes an argument, so a caller can steer it").toBe(
        "()",
      );
      const reachable = dataLayerImports(moduleSrc);
      // Non-vacuity: an empty import list would make the filter below pass on
      // any body at all, including one that writes.
      expect(reachable.length, "no @/lib/data import found — the shape has drifted").toBeGreaterThan(0);
      const touched = reachable.filter((id) => new RegExp(`\\b${id}\\s*\\(`).test(fn.body));
      expect(touched, "it reaches the data layer, so it is not session-only").toEqual([]);
    }
  });
});

/**
 * THE SWEEP'S OWN TEETH. source-scan.ts states the rule these scans live by: a
 * scan that silently swallows a region and reports green is worse than no scan,
 * so plant the shape into the very text you scanned and assert it is reported.
 *
 * Both directions, because a guard that only fails is as useless as one that
 * only passes — and this campaign has shipped a guard that went red on correct
 * code. Every fence shape the analyser is supposed to honour gets a case.
 */
describe("the analyser reports what it claims to report", () => {
  const withAction = (text: string) => analyse(`${PLANT_HOST}\n${text}\n`);

  it("reports an exported action with no fence at all", () => {
    const planted = withAction(
      `export async function plantedNakedAction(clientId: string) {
         await setClientCreditLimits(clientId, { weeklyLimit: null, monthlyLimit: null });
       }`,
    );
    expect(planted.unauthorized).toEqual(["plantedNakedAction"]);
  });

  it("reports one that resolves the session but never refuses on it", () => {
    // The near-miss that matters: calling getCurrentUser is not a fence.
    const planted = withAction(
      `export async function plantedLimpAction(clientId: string) {
         const user = await getCurrentUser();
         await creditClientCredits({ clientId, actorUid: user?.uid ?? "anon" });
       }`,
    );
    expect(planted.unauthorized).toEqual(["plantedLimpAction"]);
  });

  it("reports one whose only refusal is unrelated to the caller", () => {
    // A throw three statements later is not a session check, and a rule loose
    // enough to accept this would accept an action with no fence at all.
    const planted = withAction(
      `export async function plantedWrongThrowAction(clientId: string) {
         const user = await getCurrentUser();
         const client = await getClient(clientId);
         if (!client) throw new Error("Client not found");
         await setClientCreditLimits(clientId, { weeklyLimit: 1, monthlyLimit: 1 });
       }`,
    );
    expect(planted.unauthorized).toEqual(["plantedWrongThrowAction"]);
  });

  it("passes one that calls a gate from _shared.ts", () => {
    const planted = withAction(
      `export async function plantedFencedAction(clientId: string) {
         await requireAdmin();
         await setClientCreditLimits(clientId, { weeklyLimit: 1, monthlyLimit: 1 });
       }`,
    );
    expect(planted.unauthorized).toEqual([]);
  });

  it("passes one that resolves the session and refuses on it itself", () => {
    const planted = withAction(
      `export async function plantedOwnFenceAction(clientId: string) {
         const viewer = await getCurrentUser();
         if (!viewer || viewer.disabled) return { error: "Sign in again." };
         await setClientCreditLimits(clientId, { weeklyLimit: 1, monthlyLimit: 1 });
       }`,
    );
    expect(planted.unauthorized).toEqual([]);
  });

  it("passes one that delegates to a local helper which authorizes", () => {
    // The shape eight of these modules actually use. If this regressed, the
    // sweep would report a pile of correctly fenced actions and the real list
    // would drown in them.
    const planted = withAction(
      `async function plantedRequireAccess(clientId: string) {
         const user = await getCurrentUser();
         if (!user) throw new Error("Unauthorized");
         return user;
       }
       export async function plantedDelegatingAction(clientId: string) {
         await plantedRequireAccess(clientId);
         await setClientCreditLimits(clientId, { weeklyLimit: 1, monthlyLimit: 1 });
       }`,
    );
    expect(planted.unauthorized).toEqual([]);
  });

  it("is not fooled by a fence that is only mentioned, never called", () => {
    const planted = withAction(
      `export async function plantedMentionOnlyAction(clientId: string) {
         const note = "this used to call requireAdmin";
         await setClientCreditLimits(clientId, { weeklyLimit: 1, monthlyLimit: 1, note });
       }`,
    );
    expect(planted.unauthorized).toEqual(["plantedMentionOnlyAction"]);
  });
});

/**
 * The sweep above is keyed to a DIRECTORY, and this campaign has already been
 * bitten once by exactly that: the `/api/clients/[id]` scan certified its own
 * folder while four routes outside it took a client id and asked nothing. So
 * the directory's monopoly is checked rather than assumed — if a `"use server"`
 * directive ever appears anywhere else in `src`, including inline inside a
 * component's own function, this says so and the sweep is extended to reach it.
 */
function walkTree(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTree(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const treeFiles = walkTree(SRC_DIR);

describe("src/lib/actions is the only place server actions are declared", () => {
  const files = treeFiles;

  it("walked the tree", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("finds no directive outside the swept directory", () => {
    // Comments are stripped first, so the many files that DISCUSS `"use server"`
    // in prose do not register — only a real directive does.
    const stray = files
      .map((abs) => relative(SRC_DIR, abs).split("\\").join("/"))
      .filter((rel) => !rel.startsWith("lib/actions/"))
      .filter((rel) =>
        USE_SERVER_DIRECTIVE.test(stripComments(readFileSync(join(SRC_DIR, rel), "utf8"))),
      );
    expect(
      stray,
      "a server action outside src/lib/actions is a public endpoint this sweep never looked at",
    ).toEqual([]);
  });

  it("would notice one", () => {
    // The scan's teeth: the same predicate applied to text that DOES carry the
    // directive must see it, and to prose about it must not.
    expect(USE_SERVER_DIRECTIVE.test(stripComments('"use server";\nexport async function a() {}'))).toBe(
      true,
    );
    expect(
      USE_SERVER_DIRECTIVE.test(
        stripComments('async function a() {\n  "use server";\n  return 1;\n}'),
      ),
    ).toBe(true);
    expect(USE_SERVER_DIRECTIVE.test(stripComments('// a "use server" module\nconst a = 1;'))).toBe(
      false,
    );
  });
});
