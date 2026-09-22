import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { matchingBrace, readSource, stripComments } from "./source-scan";

const { getClientMock } = vi.hoisted(() => ({ getClientMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/data", () => ({
  getClient: getClientMock,
  getClientTask: vi.fn(),
  createActivityLog: vi.fn(),
}));

import { staffAssignmentRefusal } from "@/lib/actions/_shared";
import type { AppUser } from "@/lib/types";

/**
 * THE ASSIGNMENT HALF, WHEREVER THE ROLE HALF IS WRITTEN BY HAND.
 *
 * `canViewClient` fences a KAROS_EMPLOYEE to the clients they are assigned to.
 * `requireClientAccess`, `listClients({ employeeId })` and the MCP actor check
 * all ask it. A dozen server actions did not: each had rewritten the ROLE half
 * inline —
 *
 *     const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
 *     if (!isStaff && …) return { ok: false, error: … };
 *
 * — and then stopped, so any staff member passed for ANY client. That reached
 * LinkedIn seat credentials, a client's join token, the client profile whose
 * `website` the branding capture later fetches, and auto-publish on a live
 * channel.
 *
 * WHY A SOURCE SWEEP AND NOT A BEHAVIOURAL TEST FOR EACH ACTION: the defect is
 * the SHAPE — an inline role check with nothing after it — and it recurs by
 * being copied. A per-action test would cover the twelve that exist today and
 * say nothing about the thirteenth, which is exactly how these twelve happened.
 * The behaviour of the fence itself is tested directly below, against the real
 * `canViewClient`, so this file asserts placement and that file asserts truth.
 *
 * THE PREMISE IS ASSERTED. A sweep that finds nothing because its pattern
 * stopped matching is a guard that cannot fail, so the first test pins that the
 * inline shape is still present in the tree and still found. If the codebase
 * ever stops writing the role half by hand, that test fails and this file
 * should be deleted rather than quietly kept green.
 */

const ACTIONS_DIR = join(process.cwd(), "src/lib/actions");

/** The inline role half, in the two spellings the tree actually uses. */
const INLINE_STAFF_CHECK =
  /const\s+isStaff\s*=\s*user\.role\s*===\s*"KAROS_ADMIN"\s*\|\|\s*user\.role\s*===\s*"KAROS_EMPLOYEE"/;

/**
 * Anything that asks the assignment question. `requireClientAccess` throws it,
 * `staffAssignmentRefusal` returns it, `canViewClient` is the predicate itself —
 * a function body carrying any of them has asked.
 */
const ASKS_ASSIGNMENT =
  /\b(staffAssignmentRefusal|requireClientAccess|canViewClient|clientAccessRefusal)\b/;

/**
 * `_shared.ts` is where the rule LIVES, so its own `isStaff` lines are the
 * definition rather than a copy of it. Every other module is in scope.
 */
const RULE_MODULE = "_shared.ts";

interface Fn {
  file: string;
  name: string;
  body: string;
}

/** Every function declaration in a module, with its body, comments stripped. */
function functionsIn(file: string): Fn[] {
  const src = stripComments(readSource(join(ACTIONS_DIR, file)));
  const out: Fn[] = [];
  const decl = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src))) {
    const open = src.indexOf("{", decl.lastIndex);
    if (open === -1) continue;
    const close = matchingBrace(src, open);
    if (close === -1) continue;
    out.push({ file, name: m[1]!, body: src.slice(open, close + 1) });
  }
  return out;
}

function actionModules(): string[] {
  return readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts") && f !== RULE_MODULE);
}

/** Functions that write the role half by hand, across the whole actions layer. */
function inlineRoleCheckFunctions(): Fn[] {
  return actionModules()
    .flatMap(functionsIn)
    .filter((fn) => INLINE_STAFF_CHECK.test(fn.body));
}

describe("the client-assignment fence", () => {
  it("still finds the inline role-check shape it is keyed to", () => {
    // The premise. Without this, a regex that stopped matching would report
    // "no violations" forever.
    const found = inlineRoleCheckFunctions();
    expect(found.length).toBeGreaterThan(0);
  });

  it("is asked by every action that writes the role half by hand", () => {
    const missing = inlineRoleCheckFunctions()
      .filter((fn) => !ASKS_ASSIGNMENT.test(fn.body))
      .map((fn) => `${fn.file} › ${fn.name}`);

    expect(
      missing,
      [
        "These server actions decide that the caller is staff and then act on a",
        "clientId without asking whether that staff member is assigned to it.",
        "Add `const refusal = await staffAssignmentRefusal(user, clientId);` and",
        "return or throw it, or call `requireClientAccess(clientId)` instead of",
        "the inline check. See src/lib/actions/_shared.ts.",
      ].join(" "),
    ).toEqual([]);
  });

  it("is exported from the module that owns the rule", () => {
    const shared = stripComments(readSource(join(ACTIONS_DIR, RULE_MODULE)));
    expect(shared).toMatch(/export\s+async\s+function\s+staffAssignmentRefusal\s*\(/);
  });
});

/* ───────────────────────── the fence itself, not its placement ───────────── */

function user(patch: Partial<AppUser>): AppUser {
  return {
    uid: "u1",
    email: "e@karoslabs.com",
    name: "E",
    role: "KAROS_EMPLOYEE",
    disabled: false,
    createdAt: 0,
    ...patch,
  } as AppUser;
}

describe("staffAssignmentRefusal", () => {
  beforeEach(() => {
    getClientMock.mockReset();
  });

  it("refuses an employee who is assigned to nobody", async () => {
    getClientMock.mockResolvedValue({ id: "c1", assignedEmployeeIds: [] });
    expect(await staffAssignmentRefusal(user({}), "c1")).toBe("You are not assigned to this client.");
  });

  it("refuses an employee assigned to a DIFFERENT client", async () => {
    getClientMock.mockResolvedValue({ id: "c1", assignedEmployeeIds: ["someone-else"] });
    expect(
      await staffAssignmentRefusal(user({ assignedClientIds: ["c2"] }), "c1"),
    ).toBe("You are not assigned to this client.");
  });

  it("allows an employee recorded on the CLIENT's side", async () => {
    getClientMock.mockResolvedValue({ id: "c1", assignedEmployeeIds: ["u1"] });
    expect(await staffAssignmentRefusal(user({}), "c1")).toBeNull();
  });

  it("allows an employee recorded on the USER's side", async () => {
    // The two fields are written by different screens and nothing keeps them in
    // step, so either one alone has to be enough — see client-visibility.ts.
    getClientMock.mockResolvedValue({ id: "c1", assignedEmployeeIds: [] });
    expect(await staffAssignmentRefusal(user({ assignedClientIds: ["c1"] }), "c1")).toBeNull();
  });

  it("allows an admin", async () => {
    getClientMock.mockResolvedValue({ id: "c1", assignedEmployeeIds: [] });
    expect(await staffAssignmentRefusal(user({ role: "KAROS_ADMIN" }), "c1")).toBeNull();
  });

  it("says so when the client does not exist", async () => {
    getClientMock.mockResolvedValue(null);
    expect(await staffAssignmentRefusal(user({}), "nope")).toBe("Client not found.");
  });

  it("returns null for a non-staff caller without reading the client", async () => {
    // Their own branch has already decided; this function answers only the
    // staff half, and must not add a Firestore read to every client write.
    expect(
      await staffAssignmentRefusal(user({ role: "CLIENT_USER", clientId: "c1" }), "c1"),
    ).toBeNull();
    expect(getClientMock).not.toHaveBeenCalled();
  });
});
