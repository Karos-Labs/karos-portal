/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as userActions from "@/lib/actions/user-actions";
import * as data from "@/lib/data";
import * as auth from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { adminAuth } from "@/lib/firebase/admin";

/**
 * #160 — ROLE MANAGEMENT, WHICH NOTHING TESTED EITHER.
 *
 * `user-actions.ts` is where an account gets its role, its workspace, its
 * group-admin flag, and where a pending registration is approved or destroyed.
 * Every one of those is a privilege decision and every one is a server action —
 * a public endpoint, reachable by anything that can post to the origin, with the
 * /team page's own buttons being merely the polite way in. No test referenced
 * the module.
 *
 * The refusals are asked as "and it wrote nothing", never as "it threw": an
 * action that throws AFTER minting a Firebase account or deleting a user has
 * still done the thing. So each case names the write it must not have made.
 *
 * `toggleGroupAdminAction` gets a case per rung because it is the one action
 * here that a NON-admin may legitimately call — a client's own group admin
 * managing their colleagues — and a ladder with a legitimate branch is the kind
 * that grows a hole.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true }),
  emailShell: vi.fn(() => "<html></html>"),
}));
vi.mock("@/lib/firebase/admin", () => {
  const authApi = {
    createUser: vi.fn().mockResolvedValue({ uid: "u-new" }),
    updateUser: vi.fn().mockResolvedValue(undefined),
    deleteUser: vi.fn().mockResolvedValue(undefined),
  };
  return { adminAuth: () => authApi, adminDb: () => ({}) };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: vi.fn() };
});

const ADMIN = { uid: "u-admin", name: "Dana Admin", email: "dana@karoslabs.com", role: "KAROS_ADMIN", clientId: null };
const EMPLOYEE = { uid: "u-emp", name: "Eli Employee", email: "eli@karoslabs.com", role: "KAROS_EMPLOYEE", clientId: null };
const CLIENT_USER = { uid: "u-client", name: "Cass", email: "cass@acme.com", role: "CLIENT_USER", clientId: "c1" };
const GROUP_ADMIN = { ...CLIENT_USER, uid: "u-lead", name: "Lee Lead", isGroupAdmin: true };
const DISABLED_ADMIN = { ...ADMIN, uid: "u-ex-admin", disabled: true };

/** Everyone the admin-only actions must turn away. */
const NON_ADMINS = [
  ["nobody at all", null],
  ["a deactivated admin", DISABLED_ADMIN],
  ["an employee", EMPLOYEE],
  ["a client user", CLIENT_USER],
  ["a client's own group admin", GROUP_ADMIN],
] as const;

const PENDING = {
  uid: "u-pending",
  name: "Pat Pending",
  email: "pat@acme.com",
  role: "PENDING",
  clientId: null,
  disabled: true,
  createdAt: 0,
};

function as(user: unknown) {
  vi.mocked(auth.getCurrentUser).mockResolvedValue(user as any);
}

const firebase = () => adminAuth() as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  as(ADMIN);
  vi.mocked(data.getUser).mockResolvedValue(PENDING as any);
  vi.mocked(data.upsertUser).mockResolvedValue(undefined as any);
  vi.mocked(data.deleteUser).mockResolvedValue(undefined as any);
  vi.mocked(data.createClient).mockResolvedValue("c-new" as any);
});

describe("createTeamMemberAction — minting an account with a role", () => {
  const input = {
    name: "New Person",
    email: "New.Person@Acme.com ",
    password: "hunter22",
    role: "KAROS_ADMIN" as const,
  };

  it.each(NON_ADMINS)("refuses %s, and mints nothing", async (_label, actor) => {
    as(actor);

    await expect(userActions.createTeamMemberAction(input)).rejects.toThrow();

    // The escalation this guards: anyone who could reach this action could hand
    // themselves a KAROS_ADMIN account. Both halves of the mint are checked —
    // the Firebase Auth record and the Firestore user document.
    expect(firebase().createUser).not.toHaveBeenCalled();
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("keeps a staff account out of any client workspace", async () => {
    // `clientId` is what makes a session a CLIENT_USER's own workspace. An
    // employee record carrying one is a role and a scope disagreeing.
    await userActions.createTeamMemberAction({
      ...input,
      role: "KAROS_EMPLOYEE",
      clientId: "c1",
      assignedClientIds: ["c1", "c2"],
    });

    expect(vi.mocked(data.upsertUser).mock.calls[0]![0]).toMatchObject({
      role: "KAROS_EMPLOYEE",
      clientId: null,
      assignedClientIds: ["c1", "c2"],
      email: "new.person@acme.com",
    });
  });

  it("keeps a client account out of the staff assignment list", async () => {
    await userActions.createTeamMemberAction({
      ...input,
      role: "CLIENT_USER",
      clientId: "c1",
      assignedClientIds: ["c2"],
    });

    expect(vi.mocked(data.upsertUser).mock.calls[0]![0]).toMatchObject({
      role: "CLIENT_USER",
      clientId: "c1",
      assignedClientIds: [],
    });
  });
});

describe("approveRegistrationAction — turning a pending signup into an account", () => {
  it.each(NON_ADMINS)("refuses %s, and approves nothing", async (_label, actor) => {
    as(actor);

    await expect(
      userActions.approveRegistrationAction("u-pending", { role: "KAROS_ADMIN" }),
    ).rejects.toThrow();

    expect(data.upsertUser).not.toHaveBeenCalled();
    // Nor tells the applicant they are in.
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses a uid with no pending registration behind it", async () => {
    vi.mocked(data.getUser).mockResolvedValue(null as any);

    await expect(
      userActions.approveRegistrationAction("ghost", { role: "KAROS_EMPLOYEE" }),
    ).rejects.toThrow("User not found");
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses to approve a client user with no workspace to put them in", async () => {
    // Approving with neither an existing client nor a new one would leave a
    // CLIENT_USER whose clientId is null — a live account scoped to nothing.
    await expect(
      userActions.approveRegistrationAction("u-pending", { role: "CLIENT_USER" }),
    ).rejects.toThrow();
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("sends an approved client user back through onboarding", async () => {
    await userActions.approveRegistrationAction("u-pending", {
      role: "CLIENT_USER",
      clientId: "c1",
    });

    expect(vi.mocked(data.upsertUser).mock.calls[0]![0]).toMatchObject({
      role: "CLIENT_USER",
      clientId: "c1",
      disabled: false,
      hasCompletedOnboarding: false,
    });
  });

  it("gives an approved employee their assignments and no workspace of their own", async () => {
    await userActions.approveRegistrationAction("u-pending", {
      role: "KAROS_EMPLOYEE",
      assignedClientIds: ["c1"],
    });

    expect(vi.mocked(data.upsertUser).mock.calls[0]![0]).toMatchObject({
      role: "KAROS_EMPLOYEE",
      clientId: null,
      assignedClientIds: ["c1"],
      disabled: false,
    });
  });
});

describe("rejectRegistrationAction — destroying an account", () => {
  it.each(NON_ADMINS)("refuses %s, and deletes nothing", async (_label, actor) => {
    as(actor);

    await expect(userActions.rejectRegistrationAction("u-pending")).rejects.toThrow();

    // The irreversible pair: the Firestore document and the Firebase Auth
    // account. Neither may be reached by an actor the gate refused.
    expect(data.deleteUser).not.toHaveBeenCalled();
    expect(firebase().deleteUser).not.toHaveBeenCalled();
  });

  it("deletes both records for an admin", async () => {
    await userActions.rejectRegistrationAction("u-pending");

    expect(data.deleteUser).toHaveBeenCalledWith("u-pending");
    expect(firebase().deleteUser).toHaveBeenCalledWith("u-pending");
  });
});

describe("updateTeamMemberAction — changing an existing account", () => {
  it.each(NON_ADMINS)("refuses %s, and changes nothing", async (_label, actor) => {
    as(actor);

    await expect(
      userActions.updateTeamMemberAction("u-client", { role: "KAROS_ADMIN" }),
    ).rejects.toThrow();

    expect(data.upsertUser).not.toHaveBeenCalled();
    expect(firebase().updateUser).not.toHaveBeenCalled();
  });

  it("refuses a uid with no account behind it", async () => {
    // The action builds its write as `{ ...existing, ...patch }`. Without this
    // check `existing` is null, so what reaches `upsertUser` is the patch alone
    // — an object with no uid — and the admin gets whatever Firestore says
    // about that instead of "User not found".
    vi.mocked(data.getUser).mockResolvedValue(null as any);

    await expect(
      userActions.updateTeamMemberAction("ghost", { role: "KAROS_ADMIN" }),
    ).rejects.toThrow("User not found");
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("carries a deactivation through to the auth account, not just the document", async () => {
    // A user disabled only in Firestore still holds a valid session cookie.
    await userActions.updateTeamMemberAction("u-pending", { disabled: true });

    expect(vi.mocked(data.upsertUser).mock.calls[0]![0]).toMatchObject({ disabled: true });
    expect(firebase().updateUser).toHaveBeenCalledWith("u-pending", { disabled: true });
  });
});

describe("toggleGroupAdminAction — the one rung a non-admin may climb", () => {
  /** A colleague inside the group admin's own workspace. */
  const PEER = { uid: "u-peer", name: "Pia Peer", email: "pia@acme.com", role: "CLIENT_USER", clientId: "c1" };
  /** Same role, different workspace. */
  const OUTSIDER = { ...PEER, uid: "u-outsider", email: "o@other.com", clientId: "c2" };

  it("refuses a caller with no session", async () => {
    as(null);
    vi.mocked(data.getUser).mockResolvedValue(PEER as any);

    await expect(userActions.toggleGroupAdminAction("u-peer", true)).rejects.toThrow("Unauthorized");
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses a deactivated admin", async () => {
    as(DISABLED_ADMIN);
    vi.mocked(data.getUser).mockResolvedValue(PEER as any);

    await expect(userActions.toggleGroupAdminAction("u-peer", true)).rejects.toThrow("Unauthorized");
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses an employee — this rung is admins and group admins only", async () => {
    as(EMPLOYEE);
    vi.mocked(data.getUser).mockResolvedValue(PEER as any);

    await expect(userActions.toggleGroupAdminAction("u-peer", true)).rejects.toThrow("Forbidden");
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses a client user who is not a group admin", async () => {
    // The self-promotion this exists to stop: an ordinary seat granting itself
    // (or a colleague) the flag that governs their whole workspace.
    as(CLIENT_USER);
    vi.mocked(data.getUser).mockResolvedValue(CLIENT_USER as any);

    await expect(userActions.toggleGroupAdminAction("u-client", true)).rejects.toThrow("Forbidden");
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses a group admin reaching into another workspace", async () => {
    as(GROUP_ADMIN);
    vi.mocked(data.getUser).mockResolvedValue(OUTSIDER as any);

    await expect(userActions.toggleGroupAdminAction("u-outsider", true)).rejects.toThrow(
      /isn't in your workspace/,
    );
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses a group admin changing their own flag", async () => {
    as(GROUP_ADMIN);
    vi.mocked(data.getUser).mockResolvedValue(GROUP_ADMIN as any);

    await expect(userActions.toggleGroupAdminAction("u-lead", false)).rejects.toThrow();
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("lets a group admin promote a colleague in their own workspace", async () => {
    // The legitimate branch. An over-tight ladder here breaks the feature, which
    // is the direction a refusal-only suite would never notice.
    as(GROUP_ADMIN);
    vi.mocked(data.getUser).mockResolvedValue(PEER as any);

    await userActions.toggleGroupAdminAction("u-peer", true);

    expect(vi.mocked(data.upsertUser).mock.calls[0]![0]).toMatchObject({
      uid: "u-peer",
      clientId: "c1",
      isGroupAdmin: true,
    });
  });

  it("lets an admin toggle anyone", async () => {
    as(ADMIN);
    vi.mocked(data.getUser).mockResolvedValue(OUTSIDER as any);

    await userActions.toggleGroupAdminAction("u-outsider", true);

    expect(vi.mocked(data.upsertUser).mock.calls[0]![0]).toMatchObject({
      uid: "u-outsider",
      isGroupAdmin: true,
    });
  });

  it("refuses a target that does not exist", async () => {
    vi.mocked(data.getUser).mockResolvedValue(null as any);

    await expect(userActions.toggleGroupAdminAction("ghost", true)).rejects.toThrow("User not found");
    expect(data.upsertUser).not.toHaveBeenCalled();
  });
});
