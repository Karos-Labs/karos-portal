/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isStringDelimiter,
  matchingBrace,
  matchingParen,
  skipStringLiteral,
  stripComments,
} from "./source-scan";

/**
 * #43 — AN IMPERSONATING ADMIN REWRITES SOMEONE ELSE'S IDENTITY, WITH NO TRACE.
 *
 * A handful of endpoints authorize by taking the SUBJECT of the write from the
 * session: the profile action, the password change, the avatar and resume
 * routes, and the three onboarding actions. Under "View as Client"
 * `getCurrentUser` returns the TARGET (auth.ts), so the subject is the CLIENT —
 * and the profile form stayed fully editable. Saving rewrote their display name
 * and phone, replaced their avatar or their CV, and pushed the name and photo
 * onto their FIREBASE AUTH record. No marker on the write, and no activity row
 * at all. The avatar route's own comment asserted the model that made this
 * safe: "Scoped to self — no clientId or role check needed."
 *
 * The three onboarding actions already refused, each with its own inline test
 * and its own sentence. Five siblings did not. This is that rule, once, proved
 * at all eight entry points — and proved not to have closed over the ordinary
 * client, who owns every one of these surfaces.
 */

const CLIENT_USER = {
  uid: "u-client",
  email: "client@acme.test",
  name: "Real Client",
  role: "CLIENT_USER",
  clientId: "c1",
  disabled: false,
  createdAt: 0,
  photoURL: "https://cdn.test/avatar.png",
  resumeUrl: "https://cdn.test/cv.pdf",
  primarySeatId: "seat1",
};

/** The same person, as the session reads while an admin is in "View as Client". */
const IMPERSONATED = { ...CLIENT_USER, impersonatedBy: "u-admin" };

const REFUSAL =
  "You're viewing this workspace as another person. Exit impersonation before changing their account.";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/server", async (io) => {
  const actual = await io<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => fn() };
});
vi.mock("@/lib/data");
vi.mock("@/lib/auth", async (io) => ({
  ...(await io<typeof import("@/lib/auth")>()),
  getCurrentUser: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({ uploadBytes: vi.fn() }));
vi.mock("@/lib/email", async (io) => ({
  ...(await io<typeof import("@/lib/email")>()),
  sendEmail: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/firebase/admin", () => {
  const authApi = {
    updateUser: vi.fn().mockResolvedValue(undefined),
    createUser: vi.fn().mockResolvedValue({ uid: "u-new" }),
    deleteUser: vi.fn().mockResolvedValue(undefined),
  };
  return { adminAuth: () => authApi, adminDb: () => ({}) };
});
vi.mock("@/lib/actions/seat-actions", () => ({
  addEmployeeSeatAction: vi.fn(async () => ({ ok: true, seatId: "seat-new" })),
}));

import * as data from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { adminAuth } from "@/lib/firebase/admin";
import { uploadBytes } from "@/lib/storage";
import { updatePasswordAction, updateUserProfileAction } from "@/lib/actions/user-actions";
import {
  completeOnboardingAction,
  ensureOwnEmployeeSeatAction,
  saveOnboardingProfileAction,
} from "@/lib/actions/onboarding-actions";
import * as avatarRoute from "@/app/api/users/avatar/route";
import * as resumeRoute from "@/app/api/users/resume/route";

function as(user: unknown) {
  vi.mocked(getCurrentUser).mockResolvedValue(user as any);
}

function upload(name: string, type: string) {
  const form = new FormData();
  form.set("file", new File(["bytes"], name, { type }));
  return new Request("http://t/x", { method: "POST", body: form });
}

/**
 * Everything one of these endpoints can leave behind. Firestore, Firebase Auth
 * and Storage are all asked, because two of the three writes this finding is
 * about (the Auth display name and photo, and the uploaded object) outlive the
 * Firestore document and are not covered by watching `upsertUser` alone.
 */
function expectNothingWritten() {
  expect(data.upsertUser, "wrote the Firestore user document").not.toHaveBeenCalled();
  expect(data.clearUserAvatar).not.toHaveBeenCalled();
  expect(data.clearUserResume).not.toHaveBeenCalled();
  expect(data.clearUserPhone).not.toHaveBeenCalled();
  expect(data.updateEmployeeSeat).not.toHaveBeenCalled();
  expect(data.completeOnboarding).not.toHaveBeenCalled();
  expect(adminAuth().updateUser, "wrote the Firebase Auth identity").not.toHaveBeenCalled();
  expect(uploadBytes, "put an object in Storage").not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(data.upsertUser).mockResolvedValue(undefined);
  vi.mocked(data.clearUserPhone).mockResolvedValue(undefined);
  vi.mocked(data.clearUserAvatar).mockResolvedValue(undefined);
  vi.mocked(data.clearUserResume).mockResolvedValue(undefined);
  vi.mocked(data.updateEmployeeSeat).mockResolvedValue(undefined);
  vi.mocked(data.completeOnboarding).mockResolvedValue(undefined);
  vi.mocked(data.tryAcquireAiProcessingLock).mockResolvedValue(false);
  vi.mocked(uploadBytes).mockResolvedValue({ url: "https://cdn.test/new", path: "p" } as any);
});

describe("the profile action", () => {
  it("refuses an impersonated session, and writes neither record", async () => {
    as(IMPERSONATED);
    await expect(updateUserProfileAction("Admin Was Here", "+1 555")).rejects.toThrow(REFUSAL);
    expectNothingWritten();
  });

  it("still lets the client change their own name and phone", async () => {
    as(CLIENT_USER);
    await updateUserProfileAction("Real Client Renamed", "+1 555");
    expect(data.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "u-client", name: "Real Client Renamed" }),
    );
    expect(adminAuth().updateUser).toHaveBeenCalledWith("u-client", {
      displayName: "Real Client Renamed",
    });
  });
});

describe("the password change", () => {
  it("refuses an impersonated session before it reaches Firebase at all", async () => {
    as(IMPERSONATED);
    await expect(updatePasswordAction("whatever", "newpassword")).rejects.toThrow(REFUSAL);
    expect(adminAuth().updateUser).not.toHaveBeenCalled();
  });
});

describe("the avatar route", () => {
  it("refuses an impersonated upload with 403, and stores nothing", async () => {
    as(IMPERSONATED);
    const res = await avatarRoute.POST(upload("me.png", "image/png"));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: REFUSAL });
    expectNothingWritten();
  });

  it("refuses an impersonated DELETE too — the half that destroys something", async () => {
    as(IMPERSONATED);
    const res = await avatarRoute.DELETE();
    expect(res.status).toBe(403);
    expectNothingWritten();
  });

  it("still accepts the client's own upload", async () => {
    as(CLIENT_USER);
    const res = await avatarRoute.POST(upload("me.png", "image/png"));
    expect(res.status).toBe(200);
    expect(uploadBytes).toHaveBeenCalledTimes(1);
    expect(data.upsertUser).toHaveBeenCalledTimes(1);
  });

  it("still clears the client's own avatar", async () => {
    as(CLIENT_USER);
    expect((await avatarRoute.DELETE()).status).toBe(200);
    expect(data.clearUserAvatar).toHaveBeenCalledWith("u-client");
  });
});

describe("the resume route", () => {
  it("refuses an impersonated upload with 403, and stores nothing", async () => {
    as(IMPERSONATED);
    const res = await resumeRoute.POST(upload("cv.pdf", "application/pdf"));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: REFUSAL });
    expectNothingWritten();
  });

  it("refuses an impersonated DELETE too", async () => {
    as(IMPERSONATED);
    expect((await resumeRoute.DELETE()).status).toBe(403);
    expectNothingWritten();
  });

  it("still accepts the client's own CV, and still mirrors it onto their seat", async () => {
    as(CLIENT_USER);
    const res = await resumeRoute.POST(upload("cv.pdf", "application/pdf"));
    expect(res.status).toBe(200);
    expect(data.updateEmployeeSeat).toHaveBeenCalledWith("c1", "seat1", {
      resumeUrl: "https://cdn.test/new",
    });
  });
});

describe("the three onboarding actions keep refusing, through the shared rule", () => {
  it("saveOnboardingProfileAction", async () => {
    as(IMPERSONATED);
    await expect(saveOnboardingProfileAction({ name: "Admin Was Here" })).rejects.toThrow(REFUSAL);
    expectNothingWritten();
  });

  it("completeOnboardingAction", async () => {
    as(IMPERSONATED);
    await expect(
      completeOnboardingAction({ name: "Admin Was Here", clientName: "Acme" }),
    ).rejects.toThrow(REFUSAL);
    expectNothingWritten();
  });

  it("ensureOwnEmployeeSeatAction returns the same sentence in its own shape", async () => {
    as(IMPERSONATED);
    expect(await ensureOwnEmployeeSeatAction()).toEqual({ error: REFUSAL });
    expectNothingWritten();
  });

  it("still runs the wizard for a real client session", async () => {
    as({ ...CLIENT_USER, hasCompletedOnboarding: false });
    await saveOnboardingProfileAction({ name: "Real Client" });
    expect(data.upsertUser).toHaveBeenCalledTimes(1);
  });
});

describe("a lapsed session is still 401, not the impersonation sentence", () => {
  it("on the route", async () => {
    as(null);
    const res = await avatarRoute.POST(upload("me.png", "image/png"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("and on the action", async () => {
    as(null);
    await expect(updateUserProfileAction("x")).rejects.toThrow("Unauthorized");
  });

  it("and a disabled account is refused as well", async () => {
    as({ ...CLIENT_USER, disabled: true });
    await expect(updateUserProfileAction("x")).rejects.toThrow("Unauthorized");
    expectNothingWritten();
  });
});

/* ─────────────── the guard that outlives these blocks ─────────────── */

/**
 * KEYED TO THE SHAPE, not to the eight endpoints above.
 *
 * A list of files would have certified exactly the five that were open. The
 * property that actually defines this family is mechanical: the module writes
 * to the record the SESSION names — `upsertUser({ ...user`, a `user.uid` handed
 * to a data-layer or Firebase Auth writer — rather than to a record named by
 * the request. Every module in the actions and API trees that does that must
 * also ask `ownAccountSession`, so a ninth self-write added tomorrow fails here
 * until it does.
 *
 * The two-directional inventory is what keeps this honest: a module that stops
 * writing to its own session's subject has to leave the list, so the list
 * cannot quietly stop describing the tree.
 */
describe("every function that writes to its own session's subject asks the shared gate", () => {
  const ROOTS = ["src/lib/actions", "src/app/api"].map((r) => join(process.cwd(), r));

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }

  /**
   * The brace that opens a function BODY, from the paren that closes its
   * parameter list — never `indexOf("{")`, which finds the brace inside a
   * return type like `Promise<{ error?: string }>` and slices a body that
   * contains none of the code being asked about.
   */
  function bodyBraceAfter(s: string, closingParen: number): number {
    let angle = 0;
    for (let i = closingParen + 1; i < s.length; i++) {
      const ch = s[i]!;
      if (isStringDelimiter(ch)) {
        i = skipStringLiteral(s, i);
        continue;
      }
      if (ch === "<") angle++;
      else if (ch === ">") {
        if (s[i - 1] !== "=") angle--;
      } else if (ch === "{" && angle <= 0) return i;
      else if (ch === ";" && angle <= 0) return -1;
    }
    return -1;
  }

  /** Every `function NAME(...) { … }` in already-stripped source. */
  function functionsIn(src: string): Array<{ name: string; body: string }> {
    const out: Array<{ name: string; body: string }> = [];
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)) {
      const openParen = m.index! + m[0].length - 1;
      const closeParen = matchingParen(src, openParen);
      const openBrace = closeParen < 0 ? -1 : bodyBraceAfter(src, closeParen);
      const closeBrace = openBrace < 0 ? -1 : matchingBrace(src, openBrace);
      if (closeBrace < 0) continue;
      out.push({ name: m[1]!, body: src.slice(openBrace, closeBrace + 1) });
    }
    return out;
  }

  /**
   * A write whose SUBJECT came from the session. `upsertUser({ ...user` is the
   * profile/avatar/resume/onboarding shape; `adminAuth().updateUser(user.uid`
   * is the Firebase Auth half, which no Firestore spy would see; the `clearUser*`
   * writers take the uid alone.
   *
   * Deliberately NOT matched: a uid that came off a request or a document
   * (`updateUser(uid`, `upsertUser({ ...existing`) — those are administered
   * writes with their own authorizer, and `updateTeamMemberAction` is exactly
   * that. The distinction is the binding name, which is why this reads the
   * ARGUMENT rather than the function.
   */
  /**
   * A write whose SUBJECT is THIS SESSION'S OWN USER.
   *
   * KEYED TO WHERE THE VALUE CAME FROM, not to what the binding is called. The
   * first version read `user.uid` literally, so renaming that binding — a
   * refactor with no behavioural meaning — made the whole family stop seeing the
   * function, and with it the two-directional inventory and the `it.each`
   * generated from it. That is enumerated trap #6, on a guard whose own prose
   * promises "a ninth self-write added tomorrow fails here until it does".
   *
   * Loosening it to ANY identifier's `.uid` was worse in the other direction and
   * is why this shape exists: it swept in `approveRegistrationAction`,
   * `updateTeamMemberAction`, `toggleGroupAdminAction` and the LinkedIn callback
   * — admin and OAuth writes whose subject is somebody ELSE, which must not ask
   * this gate. A guard that fails on correct code is useless the other way round.
   *
   * So the binding is RESOLVED per function: find what the session reader was
   * assigned to, then look for a write whose subject is that. A write to a uid
   * that came from a parameter, a lookup or a request body is not a self-write
   * and is not this gate's business.
   *
   * STATED RESIDUAL, because its sibling scan states one and this did not: a
   * session reached some other way — destructured (`const { uid } = await
   * getCurrentUser()`), passed down through a helper, or read by a reader not
   * listed here — is not seen. The writer names are the closed half.
   */
  const SESSION_READERS = ["getCurrentUser", "requireUser", "ownAccountSession"];

  /**
   * Every binding in this function that holds THIS SESSION'S user.
   *
   * Two hops, because the codebase has two shapes: `getCurrentUser()` returns
   * the user directly, while `ownAccountSession()` returns a result the caller
   * destructures (`const { user } = session`). Missing the second hop reported
   * an empty inventory — which is the silent direction, so it is followed here
   * rather than assumed away.
   */
  function sessionBindings(body: string): string[] {
    const found: string[] = [];
    for (const reader of SESSION_READERS) {
      for (const m of body.matchAll(
        new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*await\\s+${reader}\\s*\\(`, "g"),
      )) {
        const held = m[1]!;
        found.push(held);
        // …and whatever the result was destructured into.
        const d = new RegExp(`(?:const|let)\\s*\\{[^}]*\\buser\\b\\s*(?::\\s*(\\w+))?[^}]*\\}\\s*=\\s*${held}\\b`).exec(body);
        if (d) found.push(d[1] ?? "user");
      }
    }
    return found;
  }

  /** Writers whose FIRST argument names the subject being written. */
  function selfWritePatterns(binding: string): RegExp[] {
    const b = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [
      new RegExp(`\\bupsertUser\\s*\\(\\s*\\{\\s*\\.\\.\\.${b}\\b`),
      new RegExp(`\\bupdateUser\\s*\\(\\s*${b}\\.uid\\b`),
      new RegExp(`\\bclearUser\\w+\\s*\\(\\s*${b}\\.uid\\b`),
      new RegExp(`\\bcompleteOnboarding\\s*\\(\\s*${b}\\.uid\\b`),
    ];
  }

  /** Every (file, function) in the two trees that writes to its own subject. */
  const selfWriters = ROOTS.flatMap(sourceFiles).flatMap((abs) => {
    const rel = abs.slice(process.cwd().length + 1).split(sep).join("/");
    const src = stripComments(readFileSync(abs, "utf8"));
    return functionsIn(src)
      .filter((fn) => {
        return sessionBindings(fn.body).some((b) =>
          selfWritePatterns(b).some((re) => re.test(fn.body)),
        );
      })
      .map((fn) => ({ where: `${rel}#${fn.name}`, body: fn.body }));
  });

  /**
   * Every function known to write to its own session's subject. PER FUNCTION,
   * not per file: user-actions.ts exports eleven actions and only two of them
   * are self-writes, and a file-level answer is exactly what let one handler in
   * a two-handler route be guarded while the other was not.
   */
  const EXPECTED = [
    "src/app/api/users/avatar/route.ts#DELETE",
    "src/app/api/users/avatar/route.ts#POST",
    "src/app/api/users/resume/route.ts#DELETE",
    "src/app/api/users/resume/route.ts#POST",
    // Steps 1 and 2 of the wizard. (ensureOwnEmployeeSeatAction writes
    // `{ ...user, primarySeatId }` through the same shape.)
    "src/lib/actions/onboarding-actions.ts#completeOnboardingAction",
    "src/lib/actions/onboarding-actions.ts#ensureOwnEmployeeSeatAction",
    "src/lib/actions/onboarding-actions.ts#saveOnboardingProfileAction",
    // The profile action and the password change.
    "src/lib/actions/user-actions.ts#updatePasswordAction",
    "src/lib/actions/user-actions.ts#updateUserProfileAction",
  ];

  it("the inventory matches the tree exactly, in both directions", () => {
    // A missing entry is a self-write nobody classified; a stale entry is this
    // list still vouching for a function that no longer does one.
    expect(selfWriters.map((w) => w.where).sort()).toEqual([...EXPECTED].sort());
  });

  it.each(selfWriters.map((w) => [w.where, w.body] as const))(
    "%s asks ownAccountSession",
    (where, body) => {
      // The CALL inside THIS function, not the mention anywhere in the file —
      // an import line carries the identifier, and a sibling handler's guard is
      // not this one's.
      expect(
        /\bownAccountSession\s*\(/.test(body),
        `${where} writes to its own session's subject and never asks the gate`,
      ).toBe(true);
    },
  );

  it("has the gate itself refuse an impersonated session", () => {
    // Non-vacuity for every scan above: they all rest on this one function
    // actually being the refusal, rather than on its name appearing.
    const src = stripComments(
      readFileSync(join(process.cwd(), "src/lib/actions/_shared.ts"), "utf8"),
    );
    expect(src).toMatch(/function\s+ownAccountSession\b/);
    expect(src).toMatch(/user\.impersonatedBy/);
  });
});
