import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { matchingBrace, matchingParen, stripComments } from "./source-scan";

/**
 * A SERVER ACTION'S PARAMETER TYPE IS NOT A CHECK ON THE WIRE.
 *
 * Every export of a `"use server"` module is a network endpoint: the arguments
 * arrive as a POST body from whoever holds a session, and TypeScript is gone by
 * then. So an action declared as `(id: string, patch: Partial<Client>)` and
 * implemented as `updateClient(id, { ...patch })` is a mass-assignment
 * endpoint — every key of the entity is writable by every session the
 * authorizer lets through, including keys the form never shows and keys added
 * to the type next month. Two such actions existed (2026-09):
 * `updateClientAction` took a whole `Partial<Client>` and stripped the seven
 * fields somebody had noticed were dangerous, and `updateTeamMemberAction`
 * took a whole `Partial<AppUser>` and stripped nothing. Both are allowlists
 * now, and this sweep is what keeps a third from appearing.
 *
 * THE RULE, mechanically: no exported action's parameter list may name a
 * `Partial<…>` of anything, nor a whole stored entity as a parameter type. An
 * action states the fields it accepts, by name, in an inline object type — the
 * way `updateAssetAction` and `updateClientProfileAction` always have. A
 * denylist of dangerous keys is not an alternative; it is the shape this test
 * exists to refuse.
 *
 * Source-text scan, same idiom as `server-action-authorizer-sweep.test.ts`:
 * slice each exported `async function`'s parameter list with the shared
 * paren-matcher (so a nested generic or object type cannot end the list
 * early), then test that text.
 */

const ACTIONS_DIR = join(process.cwd(), "src/lib/actions");
const USE_SERVER_DIRECTIVE = /(?:^|\n)\s*["']use server["']\s*;?/;

/**
 * The stored entities whose whole shape an action must never accept. A
 * value object (a colour palette, a set of social links) is fine: nothing in
 * it is a permission, a tenancy pointer or a billing fact.
 */
const STORED_ENTITIES = [
  "Client",
  "AppUser",
  "Asset",
  "Job",
  "ClientTask",
  "CustomAgent",
  "Transcript",
  "PlannedScheduledRun",
  "ScheduledRun",
  "DynamicAgentSpec",
  "ClientSeat",
  "EmployeeSeat",
  "Campaign",
  "ClientCredits",
  "ClientIntegration",
] as const;

const ENTITY_PARAM = new RegExp(
  String.raw`:\s*(?:Omit<\s*)?(?:${STORED_ENTITIES.join("|")})\b`,
);

interface ExportedAction {
  module: string;
  name: string;
  params: string;
}

function exportedActions(): ExportedAction[] {
  const out: ExportedAction[] = [];
  for (const file of readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts"))) {
    const raw = readFileSync(join(ACTIONS_DIR, file), "utf8");
    if (!USE_SERVER_DIRECTIVE.test(raw)) continue;
    const src = stripComments(raw);
    const pattern = /export\s+async\s+function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(src)) !== null) {
      const open = m.index + m[0].length - 1;
      const close = matchingParen(src, open);
      expect(close, `${file}#${m[1]}: could not find the end of the parameter list`).toBeGreaterThan(open);
      out.push({ module: file, name: m[1]!, params: src.slice(open + 1, close) });
    }
  }
  return out;
}

const ACTIONS = exportedActions();

describe("server actions declare the fields they accept, never a whole entity", () => {
  it("scanned the tree it claims to", () => {
    // Non-vacuity: a sweep that finds no actions passes forever.
    expect(ACTIONS.length).toBeGreaterThan(150);
    expect(ACTIONS.some((a) => a.name === "updateClientAction")).toBe(true);
    expect(ACTIONS.some((a) => a.name === "updateTeamMemberAction")).toBe(true);
  });

  it("no exported action takes a Partial<…> parameter", () => {
    const offenders = ACTIONS.filter((a) => /\bPartial\s*</.test(a.params)).map(
      (a) => `${a.module}#${a.name}(${a.params.replace(/\s+/g, " ").trim()})`,
    );
    expect(offenders, "a Partial<> parameter on a server action is a mass-assignment endpoint").toEqual([]);
  });

  it("no exported action takes a stored entity (or an Omit<> of one) as a parameter", () => {
    const offenders = ACTIONS.filter((a) => ENTITY_PARAM.test(a.params)).map(
      (a) => `${a.module}#${a.name}(${a.params.replace(/\s+/g, " ").trim()})`,
    );
    expect(offenders).toEqual([]);
  });

  it("the two actions this rule was written for build their patch field by field", () => {
    // The positive half, so the rule is anchored to the code it changed and
    // not only to a regex over signatures: neither action spreads its
    // parameter into the write any more.
    const clientActions = stripComments(readFileSync(join(ACTIONS_DIR, "client-actions.ts"), "utf8"));
    expect(clientActions).toContain("const CLIENT_EDITABLE_TEXT_FIELDS = [");
    expect(clientActions).not.toMatch(/const patch: Partial<Client> = \{ \.\.\.input \}/);

    // `updateTeamMemberAction`'s OWN body: the module's profile action also
    // spreads a `patch`, legitimately, because it built that patch itself from
    // named fields — the rule is about the wire parameter, not the word.
    const userActions = stripComments(readFileSync(join(ACTIONS_DIR, "user-actions.ts"), "utf8"));
    const head = userActions.indexOf("export async function updateTeamMemberAction(");
    expect(head).toBeGreaterThan(-1);
    const bodyOpen = userActions.indexOf("{", matchingParen(userActions, userActions.indexOf("(", head)));
    const body = userActions.slice(bodyOpen, matchingBrace(userActions, bodyOpen) + 1);
    expect(body).toContain("const next: Partial<AppUser> = {};");
    expect(body).not.toMatch(/\.\.\.patch\b/);
  });
});
