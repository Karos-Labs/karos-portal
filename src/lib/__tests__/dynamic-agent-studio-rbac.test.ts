import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchingBrace, matchingParen, stripComments } from "./source-scan";

/**
 * DECISION 6, ASKED OF EACH ACTION RATHER THAN OF THE MODULE.
 *
 * The epic's wording is specific: "the entire Agent Studio
 * (`/admin/agents/builder/**`) and all its server actions are ADMIN-ONLY.
 * Enforce the check server-side inside every action, not only in the UI".
 *
 * server-action-authorizer-sweep.test.ts already proves every `"use server"`
 * export authorizes SOMEHOW — but "somehow" is not what decision 6 says. That
 * sweep is equally happy with `requireStaff()`, and a one-word downgrade from
 * `requireAdmin` to `requireStaff` inside these actions would hand the whole
 * no-code agent builder — including each agent's credit price and its
 * per-client allowlist — to every employee session, with the entire suite
 * still green. Nothing caught that, so this file does.
 *
 * It is keyed to the gate CALL inside each exported action's own body, not to
 * an import or a file-level comment: an import is satisfied by one action using
 * it while another quietly uses none, which is the exact shape of the failure
 * being guarded against.
 */

const ACTIONS_FILE = join(__dirname, "..", "actions", "dynamic-agent-actions.ts");

/**
 * The Studio's admin CRUD. Every one of these mutates a spec — its pricing, its
 * pipeline, its client allowlist, or its existence — so every one is admin-only.
 */
const ADMIN_ONLY_ACTIONS = [
  "createDynamicAgentSpecAction",
  "updateDynamicAgentSpecAction",
  "deleteDynamicAgentSpecAction",
  "setDynamicAgentSpecActiveAction",
  // Internal authoring tool (free-text → draft spec), admin-only like the
  // rest of the Studio — never charges credits, never auto-saves.
  "generateDynamicAgentDraftAction",
] as const;

/**
 * The one exported action a CLIENT is meant to reach. It is fenced by
 * `requireClientAccess` (staff: any client; a CLIENT_USER: only their own) —
 * deliberately NOT requireAdmin, because a client running an agent granted to
 * them is the whole point of the feature. The per-agent `allowedClientIds`
 * fence is a second, separate gate inside submitDynamicAgentJob.
 */
const CLIENT_REACHABLE_ACTIONS = ["runDynamicAgentAction"] as const;

const source = stripComments(readFileSync(ACTIONS_FILE, "utf8"));

/**
 * The body text of one exported async function, comments already stripped.
 *
 * Finding the body's opening brace needs a little care: these actions have
 * multi-line parameter lists AND object-literal return annotations
 * (`: Promise<{ ok: boolean; error?: string }>`), so "the first `{` after the
 * first `)`" lands inside the RETURN TYPE and the assertions below would then
 * be reading a type, not a body — which is how the first draft of this file
 * managed to fail against correct source. The body's brace is the first one at
 * angle-bracket depth zero: a `{` inside `Promise<...>` is part of the type.
 */
function bodyOf(fnName: string, from: string = source): string {
  const src = from;
  const signature = new RegExp(`export\\s+async\\s+function\\s+${fnName}\\s*\\(`);
  const match = signature.exec(src);
  expect(match, `${fnName} is no longer an exported async function in dynamic-agent-actions.ts`).not.toBeNull();

  const openParen = src.indexOf("(", match!.index + match![0].length - 1);
  const closeParen = matchingParen(src, openParen);
  expect(closeParen, `could not find the parameter list of ${fnName}`).toBeGreaterThan(openParen);

  let angle = 0;
  let bodyOpen = -1;
  for (let i = closeParen + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "{" && angle === 0) {
      bodyOpen = i;
      break;
    }
  }
  expect(bodyOpen, `could not find the body of ${fnName}`).toBeGreaterThan(closeParen);

  const close = matchingBrace(src, bodyOpen);
  expect(close, `unbalanced body braces in ${fnName}`).toBeGreaterThan(bodyOpen);
  return src.slice(bodyOpen, close);
}

/** Is this action admin-fenced, judged the way the assertions below judge it? */
function isAdminFenced(fnName: string, from: string = source): boolean {
  const body = bodyOf(fnName, from);
  return /\brequireAdmin\s*\(/.test(body) && !/\brequireStaff\s*\(/.test(body);
}

describe("the Agent Studio module is a server-action module at all", () => {
  it('begins with "use server", which is what makes its exports network-reachable', () => {
    const raw = readFileSync(ACTIONS_FILE, "utf8").trimStart();
    expect(raw.startsWith('"use server"') || raw.startsWith("'use server'")).toBe(true);
  });

  it("exports exactly the actions this file knows about — a new one must be classified here", () => {
    const exported = [...source.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g)].map((m) => m[1]);
    expect(exported.sort()).toEqual([...ADMIN_ONLY_ACTIONS, ...CLIENT_REACHABLE_ACTIONS].sort());
  });
});

describe("DECISION 6: every Agent Studio admin action calls requireAdmin in its own body", () => {
  for (const action of ADMIN_ONLY_ACTIONS) {
    it(`${action} calls requireAdmin()`, () => {
      expect(bodyOf(action)).toMatch(/\brequireAdmin\s*\(/);
    });

    it(`${action} does NOT settle for a weaker gate`, () => {
      const body = bodyOf(action);
      // requireStaff would let an employee edit pricing; requireClientAccess
      // would let a client. Either is a downgrade, not an addition.
      expect(body).not.toMatch(/\brequireStaff\s*\(/);
      expect(body).not.toMatch(/\brequireClientAccess\s*\(/);
    });

    it(`${action} authorizes BEFORE it reads or writes anything`, () => {
      const body = bodyOf(action);
      const gateAt = body.search(/\brequireAdmin\s*\(/);
      // Every data call in this module goes through one of these.
      const firstDataAt = body.search(
        /\b(getDynamicAgentSpec|createDynamicAgentSpec|updateDynamicAgentSpec|deleteDynamicAgentSpec)\s*\(/,
      );
      expect(gateAt).toBeGreaterThanOrEqual(0);
      if (firstDataAt >= 0) expect(gateAt).toBeLessThan(firstDataAt);
    });
  }
});

describe("the client-reachable run action is fenced too, by the right gate", () => {
  for (const action of CLIENT_REACHABLE_ACTIONS) {
    it(`${action} calls requireClientAccess() and never runs unauthenticated`, () => {
      const body = bodyOf(action);
      expect(body).toMatch(/\brequireClientAccess\s*\(/);
    });

    it(`${action} passes the resolved user into the submit core rather than trusting an argument`, () => {
      // The allowlist decision inside submitDynamicAgentJob keys off user.role,
      // so the user must be the one the gate returned, not one the caller sent.
      const body = bodyOf(action);
      expect(body).toMatch(/const\s+user\s*=\s*await\s+requireClientAccess\s*\(/);
      expect(body).toMatch(/submitDynamicAgentJob\s*\(\s*user\b/);
    });
  }
});

describe("the Studio's pages are admin-guarded, not just its actions", () => {
  const pages = [
    join(__dirname, "..", "..", "app", "(app)", "admin", "agents", "builder", "page.tsx"),
    join(__dirname, "..", "..", "app", "(app)", "admin", "agents", "builder", "[specId]", "page.tsx"),
  ];

  for (const page of pages) {
    it(`${page.split("builder")[1]} calls requireUser with KAROS_ADMIN`, () => {
      const src = stripComments(readFileSync(page, "utf8"));
      expect(src).toMatch(/requireUser\s*\(\s*\[\s*["']KAROS_ADMIN["']\s*\]\s*\)/);
      // and not a wider role list that would let an employee in
      expect(src).not.toMatch(/KAROS_EMPLOYEE/);
      expect(src).not.toMatch(/CLIENT_USER/);
    });
  }
});

/**
 * THE SWEEP UNDER THE LOOSENINGS IT FORBIDS.
 *
 * A guard that cannot go red is decoration. Each plant below is the cheapest
 * realistic version of the downgrade it is meant to catch, applied to the REAL
 * source, and the plant itself is asserted to have changed something — so if
 * the source is refactored out from under the regex, this file fails loudly
 * instead of passing vacuously.
 */
describe("the sweep under the loosenings it forbids", () => {
  it("goes red when requireAdmin is downgraded to requireStaff", () => {
    const planted = source.replace(/await requireAdmin\(\)/g, "await requireStaff()");
    expect(planted, "requireAdmin is no longer called as `await requireAdmin()` — re-aim this plant").not.toBe(
      source,
    );
    for (const action of ADMIN_ONLY_ACTIONS) {
      expect(isAdminFenced(action, planted), `${action} still read as admin-fenced after the downgrade`).toBe(false);
    }
  });

  it("goes red when the gate is dropped from a single action, leaving the others fenced", () => {
    const body = bodyOf("deleteDynamicAgentSpecAction");
    const planted = source.replace(body, body.replace(/await requireAdmin\(\);/, ""));
    expect(planted).not.toBe(source);
    expect(isAdminFenced("deleteDynamicAgentSpecAction", planted)).toBe(false);
    // the others are untouched — this is what keying to each BODY buys over
    // keying to the file's imports
    expect(isAdminFenced("createDynamicAgentSpecAction", planted)).toBe(true);
  });

  it("goes red when a gate is called only AFTER the write it is supposed to guard", () => {
    const body = bodyOf("setDynamicAgentSpecActiveAction");
    // Move the gate below the first read: still present, no longer a gate.
    const reordered = body
      .replace(/const user = await requireAdmin\(\);\n/, "")
      .replace(/const existing = await getDynamicAgentSpec\(id\);/, "const existing = await getDynamicAgentSpec(id);\n  const user = await requireAdmin();");
    const planted = source.replace(body, reordered);
    expect(planted, "re-aim this plant").not.toBe(source);
    const plantedBody = bodyOf("setDynamicAgentSpecActiveAction", planted);
    const gateAt = plantedBody.search(/\brequireAdmin\s*\(/);
    const dataAt = plantedBody.search(/\bgetDynamicAgentSpec\s*\(/);
    expect(gateAt).toBeGreaterThan(dataAt);
  });

  it("goes red when a new unclassified action is added to the module", () => {
    const planted = `${source}\nexport async function sneakyResetAction(id: string): Promise<void> {\n  await updateDynamicAgentSpec(id, {});\n}\n`;
    const exported = [...planted.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g)].map((m) => m[1]);
    expect(exported.sort()).not.toEqual([...ADMIN_ONLY_ACTIONS, ...CLIENT_REACHABLE_ACTIONS].sort());
  });
});
