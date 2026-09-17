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
// Partial: `html` (the escaping tag every template in that module is built
// with) stays REAL, so this file mocks delivery rather than re-implementing
// the escaping the mails depend on.
vi.mock("@/lib/email", async (io) => ({
  ...(await io<typeof import("@/lib/email")>()),
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

/** A client-1 seat, for the seat-linking tests below. */
const SEAT_C1 = { id: "seat-1", clientId: "c1", name: "Albert Kattan", slug: "albert-kattan", createdBy: "u-admin", createdAt: 0, updatedAt: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  as(ADMIN);
  vi.mocked(data.getUser).mockResolvedValue(PENDING as any);
  vi.mocked(data.upsertUser).mockResolvedValue(undefined as any);
  vi.mocked(data.deleteUser).mockResolvedValue(undefined as any);
  vi.mocked(data.createClient).mockResolvedValue("c-new" as any);
  vi.mocked(data.getClientSeat).mockImplementation(async (id: string) =>
    (id === SEAT_C1.id ? SEAT_C1 : null) as any,
  );
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

  it("links a client login to one of that client's seats", async () => {
    await userActions.createTeamMemberAction({
      ...input,
      role: "CLIENT_USER",
      clientId: "c1",
      seatId: "seat-1",
    });

    expect(vi.mocked(data.upsertUser).mock.calls[0]![0]).toMatchObject({
      role: "CLIENT_USER",
      clientId: "c1",
      seatId: "seat-1",
    });
  });

  it("refuses a seat that belongs to a different client, and mints nothing", async () => {
    await expect(
      userActions.createTeamMemberAction({
        ...input,
        role: "CLIENT_USER",
        clientId: "c2",
        seatId: "seat-1", // seat-1 belongs to c1, not c2
      }),
    ).rejects.toThrow();

    expect(firebase().createUser).not.toHaveBeenCalled();
    expect(data.upsertUser).not.toHaveBeenCalled();
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

/**
 * `updateSeatAssignmentAction` links a client login to the ClientSeat the
 * LinkedIn/X agents draft personal content for — the identity
 * isPersonalAssetVisibleToViewer checks. Same dual-permission ladder as
 * toggleGroupAdminAction above (it is the other rung a non-admin may climb),
 * plus the seat-ownership check that action doesn't need.
 */
describe("updateSeatAssignmentAction — linking a login to a seat", () => {
  const PEER = { uid: "u-peer", name: "Pia Peer", email: "pia@acme.com", role: "CLIENT_USER", clientId: "c1" };
  const OUTSIDER = { ...PEER, uid: "u-outsider", email: "o@other.com", clientId: "c2" };
  const GROUP_ADMIN_C1 = { ...CLIENT_USER, uid: "u-lead", name: "Lee Lead", isGroupAdmin: true };

  it("refuses a caller with no session", async () => {
    as(null);
    vi.mocked(data.getUser).mockResolvedValue(PEER as any);

    await expect(userActions.updateSeatAssignmentAction("u-peer", "seat-1")).rejects.toThrow(
      "Unauthorized",
    );
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses an employee — this rung is admins and group admins only", async () => {
    as(EMPLOYEE);
    vi.mocked(data.getUser).mockResolvedValue(PEER as any);

    await expect(userActions.updateSeatAssignmentAction("u-peer", "seat-1")).rejects.toThrow(
      "Forbidden",
    );
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses a client user who is not a group admin", async () => {
    as(CLIENT_USER);
    vi.mocked(data.getUser).mockResolvedValue(PEER as any);

    await expect(userActions.updateSeatAssignmentAction("u-peer", "seat-1")).rejects.toThrow(
      "Forbidden",
    );
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses a group admin reaching into another workspace", async () => {
    as(GROUP_ADMIN_C1);
    vi.mocked(data.getUser).mockResolvedValue(OUTSIDER as any);

    // null (unlinking) skips the seat-ownership check entirely, isolating the
    // workspace-boundary rung this case is actually about.
    await expect(userActions.updateSeatAssignmentAction("u-outsider", null)).rejects.toThrow(
      /isn't in your workspace/,
    );
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses a target that is not a client login", async () => {
    vi.mocked(data.getUser).mockResolvedValue(EMPLOYEE as any);

    await expect(userActions.updateSeatAssignmentAction("u-emp", "seat-1")).rejects.toThrow(
      "Only client logins can be linked to a seat.",
    );
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses a seat that isn't in the target's own client roster", async () => {
    vi.mocked(data.getUser).mockResolvedValue(OUTSIDER as any); // clientId c2, seat-1 belongs to c1

    await expect(userActions.updateSeatAssignmentAction("u-outsider", "seat-1")).rejects.toThrow(
      "That seat isn't in this client's roster.",
    );
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses a group admin changing their own seat link", async () => {
    as(GROUP_ADMIN_C1);
    vi.mocked(data.getUser).mockResolvedValue(GROUP_ADMIN_C1 as any);

    await expect(userActions.updateSeatAssignmentAction("u-lead", "seat-1")).rejects.toThrow();
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("never leaks another tenant's seat roster to a caller this action would refuse anyway", async () => {
    // A plain client user (not a group admin, not staff) has no business
    // calling this at all — permission must be decided before the seat check
    // below ever runs, or the error message becomes a cross-tenant oracle.
    as(CLIENT_USER); // clientId c1
    vi.mocked(data.getUser).mockResolvedValue(OUTSIDER as any); // clientId c2

    await expect(userActions.updateSeatAssignmentAction("u-outsider", "seat-1")).rejects.toThrow(
      "Forbidden",
    );
    expect(data.getClientSeat).not.toHaveBeenCalled();
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("lets a group admin link a colleague in their own workspace", async () => {
    as(GROUP_ADMIN_C1);
    vi.mocked(data.getUser).mockResolvedValue(PEER as any);

    await userActions.updateSeatAssignmentAction("u-peer", "seat-1");

    expect(vi.mocked(data.upsertUser).mock.calls[0]![0]).toMatchObject({
      uid: "u-peer",
      seatId: "seat-1",
    });
  });

  it("lets an admin link anyone, and unlink with null", async () => {
    vi.mocked(data.getUser).mockResolvedValue(PEER as any);

    await userActions.updateSeatAssignmentAction("u-peer", null);

    expect(vi.mocked(data.upsertUser).mock.calls[0]![0]).toMatchObject({
      uid: "u-peer",
      seatId: null,
    });
  });

  it("refuses a target that does not exist", async () => {
    vi.mocked(data.getUser).mockResolvedValue(null as any);

    await expect(userActions.updateSeatAssignmentAction("ghost", "seat-1")).rejects.toThrow(
      "User not found",
    );
    expect(data.upsertUser).not.toHaveBeenCalled();
  });
});

describe("updateTeamMemberAction — writes the three team-page fields and nothing else", () => {
  const TARGET = { ...EMPLOYEE, uid: "u-target", assignedClientIds: ["c1"] };

  beforeEach(() => {
    vi.mocked(data.getUser).mockResolvedValue(TARGET as any);
  });

  it("drops every AppUser field that is not role, disabled or assignedClientIds", async () => {
    // Each of these used to land: `uid` would have written a DIFFERENT document
    // (`upsertUser` keys on it), `clientId` would have re-homed a login into
    // another tenant, and the rest are the record's own bookkeeping.
    await userActions.updateTeamMemberAction("u-target", {
      role: "KAROS_ADMIN",
      uid: "u-someone-else",
      clientId: "c-other",
      email: "attacker@evil.test",
      approvedAt: 1,
      createdAt: 1,
      isGroupAdmin: true,
      impersonatedBy: "x",
    } as any);

    const written = vi.mocked(data.upsertUser).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(written).toMatchObject({ uid: "u-target", role: "KAROS_ADMIN", clientId: null, email: EMPLOYEE.email });
    for (const key of ["approvedAt", "createdAt", "isGroupAdmin", "impersonatedBy"]) {
      expect(written, key).not.toHaveProperty(key);
    }
  });

  it("refuses an unknown role rather than storing the string", async () => {
    await expect(userActions.updateTeamMemberAction("u-target", { role: "SUPERUSER" } as any)).rejects.toThrow(
      "Unknown role",
    );
    expect(data.upsertUser).not.toHaveBeenCalled();
  });

  it("refuses a non-list of client ids, and dedupes and trims a real one", async () => {
    await expect(
      userActions.updateTeamMemberAction("u-target", { assignedClientIds: "c1" } as any),
    ).rejects.toThrow("assignedClientIds");
    expect(data.upsertUser).not.toHaveBeenCalled();

    await userActions.updateTeamMemberAction("u-target", { assignedClientIds: [" c1", "c2", "c1", ""] });
    expect(vi.mocked(data.upsertUser).mock.calls[0]![0]).toMatchObject({ assignedClientIds: ["c1", "c2"] });
  });

  it("will not let an admin demote or disable their own account", async () => {
    // The UI already greys out the self row; the server is where the rule has to
    // hold, because the failure mode is an agency with no admin left to fix it.
    vi.mocked(data.getUser).mockResolvedValue(ADMIN as any);

    await expect(userActions.updateTeamMemberAction(ADMIN.uid, { role: "KAROS_EMPLOYEE" })).rejects.toThrow(
      "your own role",
    );
    await expect(userActions.updateTeamMemberAction(ADMIN.uid, { disabled: true })).rejects.toThrow(
      "your own account",
    );
    expect(data.upsertUser).not.toHaveBeenCalled();
    // Re-enabling oneself is not a lockout and stays allowed.
    await userActions.updateTeamMemberAction(ADMIN.uid, { disabled: false });
    expect(data.upsertUser).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the patch names none of the three fields", async () => {
    await userActions.updateTeamMemberAction("u-target", { name: "Renamed" } as any);
    expect(data.upsertUser).not.toHaveBeenCalled();
    expect(firebase().updateUser).not.toHaveBeenCalled();
  });
});
