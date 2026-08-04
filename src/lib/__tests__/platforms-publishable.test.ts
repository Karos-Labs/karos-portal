import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PUBLISHABLE_PLATFORMS,
  READ_ONLY_PLATFORM_IDS,
} from "@/lib/integrations/platforms";
import { guessAssetType } from "@/lib/lab-outputs-shared";
import {
  DRAFT_ONLY_ASSET_TYPE,
  deliverableAssetType,
  hasPublishTargets,
  isDraftOnlyDeliverable,
} from "@/lib/agent-service/deliverable-asset-type";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import { recommendedScheduleFields } from "@/lib/scheduling";
import type { AssetType, ManagedTaskType } from "@/lib/types";
import { isStringDelimiter, matchingBrace, skipStringLiteral } from "./source-scan";

/**
 * Reddit is draft-only by hard contract — a human always posts, from their own
 * account. That was previously enforced by nothing: no test covered
 * PUBLISHABLE_PLATFORMS at all, so adding "reddit" to it, or typing a Reddit
 * asset as a publishable type, would have shipped silently.
 *
 * Two distinct failures are pinned here, because the second is the one that
 * nearly happened: Reddit does not appear as a publish TARGET, and a Reddit
 * deliverable does not land on an asset type that can be pushed to some OTHER
 * platform. social_post publishes to twitter/linkedin/facebook/tiktok, so a
 * Reddit reply typed social_post would have been offered for cross-posting to
 * a platform it was never written for.
 */
describe("Reddit stays unpublishable", () => {
  it("is never a publish target for any asset type", () => {
    for (const [assetType, targets] of Object.entries(PUBLISHABLE_PLATFORMS)) {
      expect(targets, `${assetType} must not publish to reddit`).not.toContain("reddit");
    }
  });

  it("is registered as a read-only integration", () => {
    // The Reddit connector exists for account health and own-history reads
    // (karma, age, removal rate). There is deliberately no publisher.
    expect(READ_ONLY_PLATFORM_IDS.has("reddit")).toBe(true);
  });

  it("maps a Reddit lab folder to an asset type with no publish targets", () => {
    const type = guessAssetType("reddit-agent");
    expect(PUBLISHABLE_PLATFORMS[type] ?? []).toEqual([]);
  });
});

/* ── #49: every path that sets an asset's type, not just the two we knew ──── */

/**
 * The pin above covered the LAB IMPORT (`guessAssetType`) and the platform map,
 * and the live agent-service webhook — a third path, written later — walked
 * straight past both: `metadata.asset_type` could name any whitelisted type, so a
 * scheduled Reddit run whose schedule row said `social_post` produced a Reddit
 * reply that every publish surface offered and the auto-publish cron would push to
 * whichever of twitter/linkedin/facebook/tiktok was connected.
 *
 * One rule written twice, one copy missed. So the question this section asks is not
 * "is the webhook fixed" but "WHICH PATHS CAN SET AN ASSET'S TYPE", answered by
 * reading the repo rather than by listing the paths anyone happens to remember. The
 * scan below finds every `createAsset` call in `src/`, extracts the `type:`
 * expression each one passes, and splits them in two:
 *
 *   • a SOURCE LITERAL (`type: "social_post"`) — a decision made in the source and
 *     visible in review. It cannot be steered by an agent's identity, a metadata
 *     hint or a tool argument, which is the defect class here.
 *   • anything else — a type derived at RUNTIME. Each distinct derivation must
 *     appear in PINNED_DERIVATIONS below, and each entry there is pinned by a real
 *     call in this file. A new derivation turns this red with the reason.
 *
 * `updateAsset` is asked the mirror question — nothing may change an asset's type
 * after it is created, so a fenced type cannot be un-fenced later — and that
 * sentence USED TO BE A CLAIM THIS FILE COULD NOT VERIFY. The scan read a depth-1
 * `type:` key and nothing else, so `updateAssetAction`'s
 * `updateAsset(id, { ...patch })` walked past it: a server action's arguments are
 * not runtime-validated, its `{ content?, title?, status? }` signature is a
 * compile-time claim about this repo's own callers, and spreading
 * `{ type: "social_post" }` in re-typed a finished Reddit reply into a post every
 * publish surface offers — with this suite reading 11/11 green over it. The action
 * now builds its patch field by field, and the scan below asks THE ARGUMENT: a
 * spread, or a payload built somewhere else, must have its keys visible AT THE CALL
 * or be pinned with the reason it cannot carry a type.
 */

const SRC = resolve(__dirname, "../..");

/** `relative(SRC, …)`, normalized to forward slashes so literals stay portable. */
function relToSrc(file: string): string {
  return relative(SRC, file).split(sep).join("/");
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      tsFiles(path, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * A copy of `src` with every comment blanked to spaces (offsets preserved) and
 * every string literal left intact.
 *
 * Comment-aware because a doc comment in this tree quotes `createAsset` calls, and
 * literal-aware because that is the only way to blank comments without the naive
 * strip's failure — `.replace(/\/\/.*$/gm, "")` truncates any template literal
 * holding a URL and manufactures a stray backtick (see source-scan.ts's docstring).
 * The literal skipping is that module's rule, asked rather than re-implemented.
 */
function maskComments(src: string): string {
  const out = src.split("");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let j = i; j < stop; j++) out[j] = " ";
      i = stop - 1;
    }
  }
  return out.join("");
}

/** The `(` … `)` of the argument list belonging to the call at `callIdx`. */
function argListRange(src: string, callIdx: number): [number, number] | null {
  const open = src.indexOf("(", callIdx);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return [open, i];
    }
  }
  return null;
}

/**
 * `text` with every string literal and every balanced `{ … }` region blanked to
 * spaces (offsets preserved), plus whether any object literal was there to blank.
 * What remains is the expression AROUND the objects — the part that decides
 * whether those objects are the whole story.
 */
function blankObjectLiterals(text: string): { blanked: string; sawObject: boolean } {
  const out = text.split("");
  let sawObject = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (isStringDelimiter(ch)) {
      const end = skipStringLiteral(text, i);
      for (let j = i; j <= end; j++) out[j] = " ";
      i = end;
      continue;
    }
    if (ch === "{") {
      const close = matchingBrace(text, i);
      const stop = close === -1 ? text.length - 1 : close;
      for (let j = i; j <= stop; j++) out[j] = " ";
      sawObject = true;
      i = stop;
    }
  }
  return { blanked: out.join(""), sawObject };
}

/** Whether a leading `(` is the one that closes on the last character. */
function wrapsWholeExpression(text: string): boolean {
  if (text[0] !== "(") return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i === text.length - 1;
    }
  }
  return false;
}

/**
 * The segments of a conditional chain (`a ? X : b ? Y : Z`), each tagged with the
 * separator that FOLLOWED it — which is what tells a condition from a value: a
 * segment followed by `?` is the test, every other segment is a result.
 *
 * `?.` and `??` are not separators and are stepped over, so an optional chain in
 * a condition does not split the expression into nonsense.
 */
function conditionalSegments(text: string): Array<{ text: string; after: "?" | ":" | null }> {
  const segs: Array<{ text: string; after: "?" | ":" | null }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (depth === 0 && ch === "?") {
      if (text[i + 1] === "?" || text[i + 1] === ".") {
        i++;
        continue;
      }
      segs.push({ text: text.slice(start, i), after: "?" });
      start = i + 1;
    } else if (depth === 0 && ch === ":") {
      segs.push({ text: text.slice(start, i), after: ":" });
      start = i + 1;
    }
  }
  segs.push({ text: text.slice(start), after: null });
  return segs;
}

/**
 * Whether every key this payload contributes is SPELLED OUT AT THE CALL.
 *
 * True only for an inline object literal, or a conditional chain whose every
 * result is one (`cond ? { a } : {}` — the two idioms this tree writes). A bare
 * identifier, a call, or a chain with one opaque result is false: its keys are
 * decided elsewhere, so reading `type` out of the call text proves nothing.
 *
 * MECHANICAL ON PURPOSE — this is the exemption line of a fail-closed guard, so it
 * is a property of the expression rather than a sentence somebody wrote about it.
 * Over-strict in one direction (`cond && { a }` is readable but reported), which
 * is the safe direction: a false report costs a pin, a false exemption cost this
 * suite its green tick over `{ ...patch }`.
 */
function keysAreVisible(operand: string): boolean {
  let text = operand.trim();
  while (wrapsWholeExpression(text)) text = text.slice(1, -1).trim();
  const { blanked, sawObject } = blankObjectLiterals(text);
  if (!sawObject) return false;
  return conditionalSegments(blanked).every(
    (seg) => seg.after === "?" || seg.text.trim() === "",
  );
}

/** A `type` KEY in an object literal's source text — `contentType:` is not one. */
const TYPE_KEY = /(^|[{,;\s])type\s*(:|[,}])/;

/** An operand's source text, from `from` to its object's next depth-0 comma. */
function readOperand(src: string, from: number, close: number): { text: string; end: number } {
  let depth = 0;
  let text = "";
  let j = from;
  for (; j < close; j++) {
    const c = src[j]!;
    if (isStringDelimiter(c)) {
      const end = skipStringLiteral(src, j);
      text += src.slice(j, end + 1);
      j = end;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    if (c === "}" || c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) break;
    text += c;
  }
  return { text: text.trim(), end: j };
}

/** A `type` this call can set: named outright, or hidden in a payload. */
type Finding = { kind: "type" | "payload"; expression: string };

/**
 * Every depth-1 expression at this call that could set `type`, as source text.
 *
 * THREE SHAPES, and two of them were invisible — which is where the defect lived:
 *
 *  • `type: <expr>` — the property, read as source text. Only DEPTH-1 counts: a
 *    `type:` inside a nested `meta: { … }` is a different field entirely.
 *  • `type` SHORTHAND (`createAsset({ …, type, … })`), missed by the first draft
 *    of this scan, which looked for the colon — and the shorthand is exactly how
 *    the MCP `upload_asset` tool passed the running agent's own tool argument
 *    straight through.
 *  • A PAYLOAD WHOSE KEYS ARE NOT VISIBLE HERE: every depth-1 `...spread`, and the
 *    whole argument when it is not an object literal at all. THIS is the shape
 *    that made the `updateAsset` half of this suite a green tick over an open
 *    hole. `updateAssetAction` spread its caller-supplied `patch` straight into
 *    `updateAsset`; a server action's arguments are not runtime-validated, so
 *    `{ type: "social_post" }` spread in that way re-typed a finished asset — and
 *    a scan looking only for a depth-1 `type:` read 11/11 green through it.
 *    Asked of THE ARGUMENT rather than of a spelling, so it holds for the next
 *    writer and the next patch shape too.
 *
 * A payload is EXEMPT MECHANICALLY (`keysAreVisible`) or not at all: when its keys
 * are spelled out here, `type` is simply looked for among them; when they are not,
 * it is reported and must be pinned with a reason.
 *
 * AN IDENTIFIER PAYLOAD IS NEVER RESOLVED, unlike a `type:` expression — and that
 * asymmetry is deliberate, because resolving one is how this guard would have
 * exempted the very hole it exists for. `resolveLocal` takes the first
 * `const <name>` in the FILE, so a spread of a PARAMETER resolves to whatever
 * unrelated local happens to share its name — and the shipped hole was exactly
 * that shape: `updateAssetAction`'s caller-supplied `patch` parameter, spread
 * into `updateAsset`, in a file that also held a `const patch = { status:
 * "approved", … }`. Resolved, `...patch` read as the safe local and passed clean.
 *
 * (That collision no longer exists — this round renamed the local to
 * `approvalPatch` — which is why the rule is stated as the principle rather than
 * left resting on the example: A NAME IS A LOCATION, NOT AN ARGUMENT, and the
 * next same-named pair would be invisible again.)
 */
function typeArgument(src: string, callIdx: number): Finding[] {
  const range = argListRange(src, callIdx);
  if (!range) return [];
  const [argOpen, argClose] = range;

  // The object-literal argument, if there is one: a `{` sitting directly in the
  // argument list rather than nested inside another argument's parens.
  let open = -1;
  let depth = 0;
  for (let i = argOpen + 1; i < argClose; i++) {
    const ch = src[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "{") {
      if (depth === 0) {
        open = i;
        break;
      }
      // The shared brace walk (source-scan.ts), not a private copy of it: it skips
      // every string literal, backticks included, so a brace inside one cannot
      // unbalance the range.
      const nested = matchingBrace(src, i);
      i = nested === -1 ? argClose : nested;
    }
  }

  const classify = (text: string): Finding | null => {
    if (!keysAreVisible(text)) return { kind: "payload", expression: text };
    return TYPE_KEY.test(text) ? { kind: "type", expression: text } : null;
  };

  if (open === -1) {
    // No object literal in the argument list at all: whatever the writer is being
    // handed was built somewhere else. `updateAsset(id, patch)` is this shape.
    const { text } = readOperandList(src, argOpen + 1, argClose);
    if (!text) return [];
    const finding = classify(text);
    return finding ? [finding] : [];
  }

  const close = matchingBrace(src, open);
  // -1 means the file does not parse; treat it as "no argument found" rather than
  // scanning to the end of the file.
  if (close === -1) return [];
  const found: Finding[] = [];
  depth = 0;
  for (let i = open; i < close; i++) {
    const ch = src[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    if (src.startsWith("...", i)) {
      const { text, end } = readOperand(src, i + 3, close);
      const finding = classify(text.replace(/\s+/g, " "));
      if (finding) found.push({ kind: finding.kind, expression: `...${finding.expression}` });
      i = end - 1;
      continue;
    }
    const afterSpace = /\s/.test(src[i - 1] ?? " ");
    if (afterSpace && /^type\s*[,}]/.test(src.slice(i))) {
      found.push({ kind: "type", expression: "type" });
      continue;
    }
    if (afterSpace && src.startsWith("type:", i)) {
      const { text, end } = readOperand(src, i + "type:".length, close);
      found.push({ kind: "type", expression: text });
      i = end - 1;
    }
  }
  return found;
}

/** The LAST argument in `[from, to)` — the payload position for both writers. */
function readOperandList(src: string, from: number, to: number): { text: string } {
  let depth = 0;
  let last = from;
  for (let i = from; i < to; i++) {
    const ch = src[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) last = i + 1;
  }
  return { text: src.slice(last, to).replace(/\s+/g, " ").trim() };
}

/** Resolve `assetType` to the initializer of its `const` in the same file. */
function resolveLocal(src: string, expression: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return expression;
  const decl = new RegExp(`\\bconst\\s+${expression}\\s*(?::[^=]+)?=\\s*`).exec(src);
  if (!decl) return expression;
  const start = decl.index + decl[0].length;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    if (ch === "}" || ch === ")" || ch === "]") depth--;
    if (ch === ";" && depth <= 0) return src.slice(start, i).replace(/\s+/g, " ").trim();
  }
  return expression;
}

type AssetTypeSite = { file: string; kind: Finding["kind"]; expression: string; literal: boolean };

function assetTypeSites(fn: "createAsset" | "updateAsset"): AssetTypeSite[] {
  const sites: AssetTypeSite[] = [];
  for (const file of tsFiles(SRC)) {
    // lib/data.ts DEFINES the writer; it does not choose a type.
    if (relToSrc(file) === "lib/data.ts") continue;
    const src = maskComments(readFileSync(file, "utf8"));
    const call = new RegExp(`\\b${fn}\\s*\\(`, "g");
    for (let m = call.exec(src); m; m = call.exec(src)) {
      for (const finding of typeArgument(src, m.index)) {
        sites.push({
          file: relToSrc(file),
          kind: finding.kind,
          // A named type expression is resolved to its local `const`; a payload
          // never is — see typeArgument's note on why that asymmetry is the guard.
          expression:
            finding.kind === "type" ? resolveLocal(src, finding.expression) : finding.expression,
          literal: /^"[a-z_]+"$/.test(finding.expression),
        });
      }
    }
  }
  return sites;
}

/**
 * Every CALL to the writer, whether or not it passes anything type-bearing.
 *
 * The non-vacuity primitive for a half of this suite whose right answer is
 * "nothing found": `assetTypeSites("updateAsset")` is expected to report no `type`,
 * so renaming the writer — or breaking the walk — would satisfy that assertion
 * over an empty list and read green. This says the scan is still looking at
 * something.
 */
function writerCalls(fn: "createAsset" | "updateAsset"): string[] {
  const files: string[] = [];
  for (const file of tsFiles(SRC)) {
    if (relToSrc(file) === "lib/data.ts") continue;
    const src = maskComments(readFileSync(file, "utf8"));
    for (const match of src.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))) {
      void match;
      files.push(relToSrc(file));
    }
  }
  return files;
}

/**
 * Every runtime derivation of an asset type that reaches `createAsset`, and where
 * this file pins it. The KEY is the derivation's own source text, so a change to
 * the expression — not merely to the file it sits in — re-opens the question.
 */
const PINNED_DERIVATIONS: Readonly<Record<string, string>> = {
  // The agent-service delivery handler. Pinned by "the fence holds for every
  // hint" below, exhaustively over every asset type and task type.
  'deliverableAssetType({ taskType: payload.task_type, hint: payload.metadata?.asset_type, content: primaryText?.content, identity: [ job.agentName, job.title, payload.metadata?.karos_agent_key, payload.metadata?.platform, ], })':
    "webhook → deliverableAssetType",
  // MCP `upload_asset`, where the type is the RUNNING AGENT'S OWN tool argument.
  // Same fence, same pin. `agentKey` leads the identity array: it is the job's
  // `customAgentId` resolved to `agent.key`, which is the same value the webhook
  // receives as the signed `karos_agent_key` — the one identity signal no caller
  // can supply or spell. The caller-supplied `title` was removed from this array
  // because free text may not steer a fence that has no undo.
  'deliverableAssetType({ taskType: "custom", hint: type, content, identity: [agentKey, producingJob?.agentName, producingJob?.title], })':
    "mcp upload_asset → deliverableAssetType",
  // The lab-outputs import — THE THIRD RUNTIME DERIVATION, and until this round
  // the one that did NOT go through the shared fence. `guessAssetType` reads the
  // lab-repo FOLDER NAME (a location, not the deliverable) and never the item's
  // text, so a Reddit batch exported under a folder not named for Reddit was
  // typed `social_post`. `labImportAssetType` now applies the same fence over the
  // folder's answer, with both halves. Pinned by the guessAssetType case in the
  // first describe above, by lab-outputs.test.ts, and by the fence cases in
  // deliverable-asset-type's own suite.
  "labImportAssetType(folderAssetType, input.agentFolder, content)":
    "lab import → guessAssetType, fenced by labImportAssetType",
  // The task-approval path materialising an in-process artifact. Its map is keyed
  // by MANAGED task type, and the managed catalog has no Reddit product — pinned
  // just below.
  '(productType && PRODUCT_ASSET_TYPE[productType]) ?? "note"':
    "task approval → PRODUCT_ASSET_TYPE, keyed by the managed catalog",
};

/**
 * Payloads reaching either writer whose key set this scan cannot read at the call,
 * each with the reason it cannot carry a `type`.
 *
 * THE KEY IS THE SOURCE TEXT WITH ITS `...` INCLUDED, so a pin for a whole-argument
 * payload can never exempt a SPREAD of the same name, or the reverse. The two are
 * different holes and it was the spread form that shipped: an entry keyed `patch`
 * would otherwise have gone on exempting `updateAsset(id, { ...patch })` forever.
 */
const PINNED_OPAQUE_PAYLOADS: Readonly<Record<string, string>> = {
  // `recommendedScheduleFields` (lib/scheduling.ts) declares its return as
  // `{ recommendedAt; recommendedReason } | Record<string, never>`, so a `type` on
  // it is a compile error rather than a promise — and the keys are asserted below.
  "...recommendedScheduleFields(assetType, 0, platform)":
    "webhook → recommendedScheduleFields, two declared fields",
  "...(chainFamily ? {} : recommendedScheduleFields(assetType, created))":
    "lab import → the same two declared fields, or nothing",
  // approveAssetAction's own patch, declared `Omit<Partial<Asset>, "type">` — the
  // compiler refuses a type on it. Named for that one action precisely so this pin
  // cannot spread its exemption over anything else's `patch`.
  //
  // AND THE ANNOTATION IS ASSERTED, not trusted: see the test below. The reason
  // written here is a compile-time claim, and this pin was keyed only to the
  // IDENTIFIER TEXT — so widening the declaration to `Partial<Asset>` re-opened
  // exactly the hole this round closed at `updateAssetAction`, with no failing
  // test and no compile error. An exemption whose justification nothing checks is
  // the most dangerous line in a guard.
  approvalPatch: "approveAssetAction → a patch the compiler forbids a `type` on",
  // RESIDUAL, not a clean pin. `scheduleFieldsForApproval` (execution-actions.ts) is
  // declared `Promise<Partial<Asset>>`, which PERMITS a `type`; only its body — which
  // returns scheduling fields and nothing else — keeps this true today. Narrowing
  // that return type to `Omit<Partial<Asset>, "type">` is what would make this pin
  // compiler-checked, and until then this line is the honest statement of the gap.
  "...schedule": "task approval → scheduling fields only, by inspection not by type",
};

/**
 * Every expression the scan reported is pinned, AND every pin is still reported.
 *
 * THE SECOND HALF IS THE ONE THIS FILE WAS MISSING, and it is not symmetry for its
 * own sake: a source scan can only fail by reporting LESS, and "more than zero
 * sites found" reads green straight through that. Measured rather than assumed —
 * loosening `keysAreVisible`'s "there is no object literal here" branch to trust
 * the payload left ONE site standing (a conditional whose other branch is a call)
 * and this suite passed 13/13 with three pins silently unexercised.
 *
 * So a pin nothing reports is a failure: either the site moved and wants
 * re-reviewing, or an exemption widened over it.
 */
function expectPinnedBothWays(
  reported: AssetTypeSite[],
  pins: Readonly<Record<string, string>>,
  advice: string,
): void {
  const seen = new Set(reported.map((s) => s.expression));
  for (const pin of Object.keys(pins)) {
    expect(
      seen,
      `nothing reports this pinned expression any more:\n\n  ${pin}\n\n` +
        `A pin nothing exercises has stopped guarding — the site moved, or the scan's ` +
        `exemption widened over it. Fix the scan, or retire the pin with its site.`,
    ).toContain(pin);
  }
  for (const site of reported) {
    expect(pins[site.expression], `${site.file}\n\n  ${site.expression}\n\n${advice}`).toBeTruthy();
  }
}

describe("#49 — every path that types an asset is fenced or literal", () => {
  it("finds the createAsset call sites at all", () => {
    // Non-vacuity: if the scan found nothing (a rename, a broken walk), every
    // assertion below would hold over an empty list and read green.
    const sites = assetTypeSites("createAsset").filter((s) => s.kind === "type");
    expect(sites.length).toBeGreaterThanOrEqual(6);
    const files = new Set(sites.map((s) => s.file));
    for (const known of [
      "app/api/agent-service/webhook/route.ts",
      "app/api/assets/bulk-upload/route.ts",
      "lib/mcp/tools.ts",
      "lib/actions/lab-output-actions.ts",
      "lib/actions/execution-actions.ts",
      "lib/actions/slot-option-actions.ts",
    ]) {
      expect(files, `${known} writes an asset and the scan missed it`).toContain(known);
    }
  });

  it("routes every runtime-derived asset type through a pinned derivation", () => {
    const derived = assetTypeSites("createAsset").filter((s) => s.kind === "type" && !s.literal);
    expect(derived.length, "no derived types found — the scan or the split broke").toBeGreaterThan(0);
    expectPinnedBothWays(
      derived,
      PINNED_DERIVATIONS,
      "This site derives an asset type from runtime data. Every such derivation must be " +
        "pinned against the Reddit draft-only rule in platforms-publishable.test.ts (add it " +
        "to PINNED_DERIVATIONS with a test that calls it), because the type is what decides " +
        "whether the product offers to publish.",
    );
  });

  it("never lets an asset's type be changed after it is created", () => {
    // NON-VACUITY FIRST, and it was the missing half of this assertion: the answer
    // this test wants is "nothing found", which a renamed writer or a broken walk
    // supplies for free. So say the scan is still looking at something.
    const calls = writerCalls("updateAsset");
    expect(calls.length, "no updateAsset calls found — the writer's name or the walk moved").toBeGreaterThanOrEqual(8);
    expect(new Set(calls)).toContain("lib/actions/asset-actions.ts");
    // A fence applied at creation is only worth anything if nothing re-types the
    // document later. `updateAsset` takes a partial, so this is asked of the calls.
    // Payload sites are a separate question, asked next; a `type` NAMED at an
    // updateAsset call is never pinnable — there is no legitimate one.
    expect(assetTypeSites("updateAsset").filter((s) => s.kind === "type")).toEqual([]);
  });

  it("lets no payload it cannot read reach either writer unpinned", () => {
    // The other half of "nothing re-types an asset": a `type` the scan cannot SEE.
    // `{ ...patch }` in updateAssetAction was exactly this, and it read green.
    const payloads = [...assetTypeSites("createAsset"), ...assetTypeSites("updateAsset")].filter(
      (s) => s.kind === "payload",
    );
    // Non-vacuity is BOTH WAYS here (see expectPinnedBothWays): `keysAreVisible` is
    // the exemption line of a fail-closed guard, and a widened one does not fail —
    // it quietly stops reporting.
    expectPinnedBothWays(
      payloads,
      PINNED_OPAQUE_PAYLOADS,
      "This site hands an asset writer a payload whose keys are not visible at the call. " +
        "Spell the fields out at the call, or add it to PINNED_OPAQUE_PAYLOADS with the " +
        "reason it cannot carry a `type` — the asset type is what decides whether the " +
        "product offers to publish a deliverable, and nothing re-types an asset afterwards.",
    );
  });

  it("keeps approvalPatch's exemption keyed to its ANNOTATION, not to its name", () => {
    /**
     * The mechanical half of the `approvalPatch` pin (house rule 4: an exemption
     * justified by a fact must check that fact). The pin's stated reason is that
     * the COMPILER refuses a `type` on this payload — but the pin was keyed only
     * to the identifier text, so widening the declaration to `Partial<Asset>`
     * re-opened the very hole this round closed at `updateAssetAction`, with no
     * failing test and no compile error. That is the one exemption in this file
     * whose justification lives outside it.
     *
     * Asserted on the DECLARATION rather than by trying to compile a `type` onto
     * it, because a compile failure is not observable from inside vitest.
     */
    const src = readFileSync(join(SRC, "lib/actions/asset-actions.ts"), "utf8");
    const decl = /const\s+approvalPatch\s*:\s*([^=]+)=/.exec(src);
    expect(decl, "approvalPatch lost its explicit type annotation, which IS its exemption").not.toBeNull();
    const annotation = decl![1]!.replace(/\s+/g, " ").trim();
    expect(
      annotation,
      `approvalPatch is declared \`${annotation}\`, which no longer forbids a \`type\`. ` +
        "Its exemption in PINNED_OPAQUE_PAYLOADS rests on that annotation: either restore " +
        "`Omit<Partial<Asset>, \"type\">` or spell the fields out at the updateAsset call.",
    ).toMatch(/Omit<\s*Partial<\s*Asset\s*>\s*,\s*["']type["']\s*>/);
  });

  it("keeps the pinned schedule helper unable to name a type", () => {
    // The mechanical half of two of those pins, asked of the FUNCTION rather than of
    // its declared return: the keys it actually produces, for every asset type.
    for (const assetType of Object.keys(PUBLISHABLE_PLATFORMS) as AssetType[]) {
      expect(Object.keys(recommendedScheduleFields(assetType, 0, "twitter"))).not.toContain("type");
      expect(Object.keys(recommendedScheduleFields(assetType))).not.toContain("type");
    }
  });
});

describe("#49 — the draft-only fence", () => {
  const TYPES = Object.keys(PUBLISHABLE_PLATFORMS) as AssetType[];
  const TASK_TYPES: ManagedTaskType[] = [
    "social_post",
    "newsletter_issue",
    "blog_article",
    "landing_page",
    "custom",
  ];
  const REDDIT_BATCH = "# Reddit answer drafts\n\n## Account 1 · u/acme\n\n### Direct answer\n\n> Hi.\n";

  it("keeps the fence's landing type unpublishable", () => {
    // The fence returns this type; the promise it makes is only true while the
    // type has no publish targets. Add tiktok to `note` and this goes red.
    expect(hasPublishTargets(DRAFT_ONLY_ASSET_TYPE)).toBe(false);
    expect(PUBLISHABLE_PLATFORMS[DRAFT_ONLY_ASSET_TYPE]).toEqual([]);
    // And the type universe is the one this suite iterates, so a sixth asset type
    // cannot appear without landing in the map the publish surfaces read.
    expect(new Set(TYPES)).toEqual(
      new Set(["instagram_post", "social_post", "article", "email", "note"]),
    );
  });

  it("refuses every publishable type to a Reddit run, whatever it asks for", () => {
    for (const taskType of TASK_TYPES) {
      for (const hint of TYPES) {
        // Each identity slot on its own — the agent name, the job title, the
        // echoed agent key, the platform hint — plus the deliverable's own text.
        const signals = [
          { identity: ["Reddit Answer Agent"] },
          { identity: ["Weekly drafts - karos-reddit-agent · Acme"] },
          { identity: ["karos-reddit-agent"] },
          { identity: ["reddit"] },
          { content: REDDIT_BATCH },
        ];
        for (const signal of signals) {
          const type = deliverableAssetType({ taskType, hint, ...signal });
          expect(
            hasPublishTargets(type),
            `${taskType} + hint ${hint} + ${JSON.stringify(signal)} produced ${type}`,
          ).toBe(false);
        }
      }
    }
  });

  it("still honours a hint for a run that is not draft-only", () => {
    // The counterweight: a fence that swallowed every hint would pass the test
    // above and break the LinkedIn/X generators, whose drafts are meant to land as
    // schedulable posts.
    expect(
      deliverableAssetType({
        taskType: "custom",
        hint: "social_post",
        content: "# LinkedIn drafts\n\nA post.",
        identity: ["LinkedIn Company Agent", "LinkedIn Company Agent - Acme"],
      }),
    ).toBe("social_post");
    expect(deliverableAssetType({ taskType: "blog_article" })).toBe("article");
    expect(deliverableAssetType({ taskType: "newsletter_issue" })).toBe("email");
    // An unknown or hostile hint falls back to the task type's own default.
    expect(deliverableAssetType({ taskType: "custom", hint: "video_masterpiece" })).toBe("note");
  });

  it("recognises a Reddit deliverable from its text alone", () => {
    // The identity half is loose by design; the text half is exact, and it is what
    // covers a renamed agent or a path that carries no identity at all.
    expect(isDraftOnlyDeliverable({ content: REDDIT_BATCH })).toBe(true);
    expect(isDraftOnlyDeliverable({ content: "# LinkedIn drafts\n\n> Hi." })).toBe(false);
    expect(isDraftOnlyDeliverable({})).toBe(false);
  });

  it("has no Reddit product in the managed catalog", () => {
    // The pin for PRODUCT_ASSET_TYPE (execution-actions): its keys are managed
    // catalog task types, so it can only return a publishable type for a managed
    // product. The day a Reddit product joins the catalog, that map needs the
    // fence too — and this is the line that says so.
    for (const product of MANAGED_PRODUCTS) {
      expect(/reddit/i.test(product.taskType)).toBe(false);
      expect(/reddit/i.test(product.name)).toBe(false);
    }
  });
});
