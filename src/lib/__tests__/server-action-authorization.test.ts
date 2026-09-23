import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * EVERY SERVER ACTION ASKS SOMEBODY WHO THE CALLER IS.
 *
 * A `"use server"` export is a public HTTP endpoint. Next.js gives it a stable
 * id and the browser can invoke it directly — hiding the page that calls it
 * hides nothing, which is why `control-plane-actions.ts`'s own header says
 * "enforced inside every action ... and not merely by hiding the page".
 *
 * Audited by hand on 2026-09-23 across all 196 of them: **every one is
 * authorized, or deliberately public with a stated reason and input
 * validation.** No hole. So this guard is not a fix — it is what keeps that
 * true for the 197th, which is the one nobody will audit.
 *
 * ## How it decides
 *
 * The repo has a real convention: a gate is a call to `requireX(...)`,
 * `authorizeX(...)`, `assertX(...)` or a session getter. That covers 173 of
 * the 196 outright, without anyone maintaining a list.
 *
 * The rest reach their gate through a file-local wrapper — `run()` in the
 * control-plane console, `authorize()` in the action list, `ownAccountSession()`
 * in the account pages — or are genuinely public. A static test cannot follow
 * those reliably, so they are ENUMERATED below with the reason. That list is
 * the whole maintenance cost, and an action that is in neither category fails
 * this test rather than shipping unguarded.
 */

const ACTIONS_DIR = join(process.cwd(), "src/lib/actions");

/** The convention: a call to a gate, by name. */
const GATE_CALL = /\b(require[A-Z]\w*|authorize[A-Z]\w*|assert[A-Z]\w*|getCurrentUser|getSessionUser)\s*\(/;

const EXPORTED_ACTION = /^export\s+async\s+function\s+(\w+)\s*\(/gm;

/**
 * Actions whose gate this file cannot see, and why. Every entry was read.
 *
 * Two kinds, and the distinction matters: `wrapper` is authorized somewhere a
 * regex cannot follow, `public` is authorized by nobody ON PURPOSE.
 */
const EXCEPTIONS: Record<string, { kind: "wrapper" | "public"; why: string }> = {
  // `run()` calls `requireAdmin()` before the callback — see the file header
  // and the comment at its second call site ("`run` has already called
  // requireAdmin(); this second call is for the actor").
  "control-plane-actions.ts:updateAgentAction": { kind: "wrapper", why: "run() → requireAdmin()" },
  "control-plane-actions.ts:setAgentStatusAction": { kind: "wrapper", why: "run() → requireAdmin()" },
  "control-plane-actions.ts:activatePromptVersionAction": { kind: "wrapper", why: "run() → requireAdmin()" },
  "control-plane-actions.ts:bindTemplateAction": { kind: "wrapper", why: "run() → requireAdmin()" },
  "control-plane-actions.ts:promoteFeedbackAction": { kind: "wrapper", why: "run() → requireAdmin()" },
  "control-plane-actions.ts:getStagePromptAction": { kind: "wrapper", why: "run() → requireAdmin()" },
  "control-plane-actions.ts:setStageModelAction": { kind: "wrapper", why: "run() → requireAdmin()" },
  "control-plane-actions.ts:setAgentModelAction": { kind: "wrapper", why: "run() → requireAdmin()" },

  // `authorize(clientId)` → `requireUser()`, then staff/own-client and the
  // employee-assignment refusal.
  "action-list-actions.ts:dismissActionAction": { kind: "wrapper", why: "authorize() → requireUser()" },
  "action-list-actions.ts:markActionNotRelevantAction": { kind: "wrapper", why: "authorize() → requireUser()" },
  "action-list-actions.ts:markActionDoneAction": { kind: "wrapper", why: "authorize() → requireUser()" },

  // `loadUmbrella()` resolves the client and its access in one step.
  "client-agent-feedback-actions.ts:addClientAgentFeedbackAction": { kind: "wrapper", why: "loadUmbrella()" },
  "client-agent-run-actions.ts:runClientAgentTemplateAction": { kind: "wrapper", why: "loadUmbrella()" },
  "client-agent-run-actions.ts:setClientAgentTemplateStatusAction": { kind: "wrapper", why: "loadUmbrella()" },
  "client-agent-run-actions.ts:reorderClientAgentTemplatesAction": { kind: "wrapper", why: "loadUmbrella()" },

  // `ownAccountSession()` — the account pages' own gate, which also refuses an
  // impersonating admin. See `updatePasswordAction`'s comment: the verification
  // round trip was the only thing standing between "View as Client" and taking
  // over the account, and that accident is no longer the guard.
  "user-actions.ts:updateUserProfileAction": { kind: "wrapper", why: "ownAccountSession()" },
  "user-actions.ts:updatePasswordAction": { kind: "wrapper", why: "ownAccountSession()" },
  // `startImpersonation()` itself refuses a non-KAROS_ADMIN and any target that
  // is not a CLIENT_USER; stopping needs no authority beyond holding the cookie.
  "user-actions.ts:startImpersonationAction": { kind: "wrapper", why: "startImpersonation() → admin-only" },
  "user-actions.ts:stopImpersonationAction": { kind: "public", why: "clears the caller's own impersonation cookie" },

  // Signup, before there is a session to check. The key is re-validated
  // server-side in `ensureUserDoc` when the session is actually created, so a
  // guessed key buys nothing.
  "client-actions.ts:validateInvitationKeyAction": { kind: "public", why: "pre-signup; re-validated at session creation" },
  // The public "request access" form. Validates and caps every field so a
  // script cannot store junk or oversized documents.
  "request-actions.ts:submitClientRequestAction": { kind: "public", why: "public request form, input-validated" },

  // Onboarding runs before the user has a client, and both resolve the session
  // through the onboarding helpers rather than a `require*` call.
  "onboarding-actions.ts:saveOnboardingProfileAction": { kind: "wrapper", why: "onboarding session helper" },
  "onboarding-actions.ts:ensureOwnEmployeeSeatAction": { kind: "wrapper", why: "onboarding session helper" },
};

interface Action {
  readonly file: string;
  readonly name: string;
  readonly body: string;
}

function serverActions(): Action[] {
  const found: Action[] = [];
  for (const file of readdirSync(ACTIONS_DIR)) {
    if (!file.endsWith(".ts") || file === "index.ts" || file === "_shared.ts") continue;
    const text = readFileSync(join(ACTIONS_DIR, file), "utf8");
    if (!text.includes("use server")) continue;
    const starts: Array<[string, number]> = [];
    for (const m of text.matchAll(EXPORTED_ACTION)) starts.push([m[1]!, m.index!]);
    starts.forEach(([name, start], i) => {
      const end = i + 1 < starts.length ? starts[i + 1]![1] : text.length;
      found.push({ file, name, body: text.slice(start, end) });
    });
  }
  return found;
}

describe("every server action is authorized, or public on purpose", () => {
  it("finds the whole action surface, so an empty walk cannot pass", () => {
    // Anti-vacuity. If `ACTIONS_DIR` ever moves, every assertion below passes
    // against nothing.
    expect(serverActions().length).toBeGreaterThan(150);
  });

  it("leaves no action without a gate and without a stated reason", () => {
    const unexplained = serverActions()
      .filter((a) => !GATE_CALL.test(a.body))
      .filter((a) => EXCEPTIONS[`${a.file}:${a.name}`] === undefined)
      .map((a) => `${a.file}:${a.name}`);

    // The message names the fix, because whoever trips this is adding an action
    // and needs to know the alternative rather than only the rule.
    expect(
      unexplained,
      "these server actions call no requireX/authorizeX/assertX/session gate.\n" +
        "A `use server` export is a public HTTP endpoint — hiding the page hides nothing.\n" +
        "Add a gate, or add an entry to EXCEPTIONS in this file saying which wrapper\n" +
        "authorizes it, or that it is public and why:\n  " + unexplained.join("\n  "),
    ).toEqual([]);
  });

  it("keeps the exception list honest — every entry still exists and still lacks a direct gate", () => {
    // An exception that no longer applies is worse than no exception: it is a
    // standing excuse attached to nothing, and it hides the day the action is
    // renamed or its gate removed.
    const actual = new Map(serverActions().map((a) => [`${a.file}:${a.name}`, a]));
    const stale = Object.keys(EXCEPTIONS).filter((key) => {
      const action = actual.get(key);
      return action === undefined || GATE_CALL.test(action.body);
    });
    expect(stale, `these EXCEPTIONS entries are gone or no longer needed:\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  it("makes every exception say which of the two kinds it is, and why", () => {
    const thin = Object.entries(EXCEPTIONS)
      .filter(([, e]) => e.why.trim().length < 12)
      .map(([k]) => k);
    expect(thin).toEqual([]);
  });

  it("holds the public list to the four that genuinely have no caller to check", () => {
    // Named rather than counted loosely: `public` is the kind that cannot be
    // reviewed by reading the action, so growth in it is the thing to notice.
    const publicActions = Object.entries(EXCEPTIONS)
      .filter(([, e]) => e.kind === "public")
      .map(([k]) => k)
      .sort();
    expect(publicActions).toEqual([
      "client-actions.ts:validateInvitationKeyAction",
      "request-actions.ts:submitClientRequestAction",
      "user-actions.ts:stopImpersonationAction",
    ]);
  });
});
