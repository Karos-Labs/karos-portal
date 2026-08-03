/* eslint-disable @typescript-eslint/no-explicit-any */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #39 — employee-to-client assignment, enforced where the data is SERVED.
 *
 * The fence exists and is a permission, not a sort order: `listClients({
 * employeeId })` scopes eight staff list pages to an employee's assignments,
 * the MCP server restates it per actor, and `authorizeClient` in
 * planned-run-actions refuses a WRITE with "You are not assigned to this
 * client." What no `/clients/[id]` route asked was the same question — each of
 * them did `getClient(id); if (!client) notFound()`, which answers whether the
 * client exists. An employee who typed a client id they were not assigned to
 * got that client's dashboard, agents, calendar, tasks and settings — settings
 * being the page that prints the join token.
 *
 * Three properties, and the third is the one that survives the next new route:
 *   1. the predicate refuses an unassigned employee (negative),
 *   2. it still passes admins, assigned employees, and a client on their own
 *      account (positive — an over-tight fence that breaks staff is worse than
 *      the hole),
 *   3. every page under `/clients/[id]` asks it, enumerated from the FILESYSTEM
 *      rather than from a list in this file, so a route added tomorrow is a
 *      failure here rather than a silent exemption.
 */
import { canViewClient } from "@/lib/client-visibility";

const ADMIN = { uid: "u-admin", role: "KAROS_ADMIN", clientId: null } as any;
const ASSIGNED = { uid: "u-emp-1", role: "KAROS_EMPLOYEE", clientId: null } as any;
const UNASSIGNED = { uid: "u-emp-2", role: "KAROS_EMPLOYEE", clientId: null } as any;
const OWN_CLIENT = { uid: "u-client", role: "CLIENT_USER", clientId: "c1" } as any;
const OTHER_CLIENT = { uid: "u-client-2", role: "CLIENT_USER", clientId: "c2" } as any;

const CLIENT = { id: "c1", assignedEmployeeIds: ["u-emp-1"] };

describe("canViewClient", () => {
  it("refuses an employee who is not assigned to the client", () => {
    expect(canViewClient(UNASSIGNED, CLIENT)).toBe(false);
  });

  it("refuses a client user pointed at somebody else's account", () => {
    expect(canViewClient(OTHER_CLIENT, CLIENT)).toBe(false);
  });

  it("still passes every legitimate viewer", () => {
    expect(canViewClient(ADMIN, CLIENT)).toBe(true);
    expect(canViewClient(ASSIGNED, CLIENT)).toBe(true);
    expect(canViewClient(OWN_CLIENT, CLIENT)).toBe(true);
  });

  it("reads a legacy client with no assignment array as assigned to nobody", () => {
    // FAILS CLOSED for employees: `assignedEmployeeIds` is required on the type
    // but absent on documents that predate it, and "the field is missing" must
    // not read as "everyone". Admins are unaffected, which is what keeps such a
    // client reachable at all while somebody fixes the record.
    const legacy = { id: "c1" } as any;
    expect(canViewClient(ASSIGNED, legacy)).toBe(false);
    expect(canViewClient(UNASSIGNED, legacy)).toBe(false);
    expect(canViewClient(ADMIN, legacy)).toBe(true);
  });

  /**
   * THE LOCKOUT. The relationship is recorded on two documents and the admin's
   * two assignment UIs write only the USER's side (`assignedClientIds`), while
   * the client's side (`assignedEmployeeIds`) is written only at client
   * creation. A predicate that reads one field fences out everybody assigned
   * through the other — and there is no screen in the app that writes the field
   * it reads, so the permission it demands could not be granted at all.
   */
  describe("the two fields that express one relationship", () => {
    const TEAM_PAGE_ASSIGNED = {
      uid: "u-emp-3",
      role: "KAROS_EMPLOYEE",
      clientId: null,
      // Exactly what createTeamMemberAction / approveRegistrationAction write.
      assignedClientIds: ["c1"],
    } as any;

    it("passes an employee assigned through the team page, whose client document does not name them", () => {
      expect(CLIENT.assignedEmployeeIds).not.toContain(TEAM_PAGE_ASSIGNED.uid);
      expect(canViewClient(TEAM_PAGE_ASSIGNED, CLIENT)).toBe(true);
    });

    it("still passes an employee named on the client, whose user document is empty", () => {
      expect(canViewClient({ ...ASSIGNED, assignedClientIds: [] }, CLIENT)).toBe(true);
    });

    it("refuses when NEITHER document records the relationship", () => {
      expect(canViewClient({ ...UNASSIGNED, assignedClientIds: ["c9"] }, CLIENT)).toBe(false);
      expect(canViewClient({ ...UNASSIGNED, assignedClientIds: [] }, CLIENT)).toBe(false);
      expect(canViewClient(UNASSIGNED, CLIENT)).toBe(false);
    });

    it("does not let a nullish client id match a stray entry on the user side", () => {
      const nameless = { id: undefined as any, assignedEmployeeIds: [] };
      expect(
        canViewClient({ ...UNASSIGNED, assignedClientIds: [undefined as any] }, nameless),
      ).toBe(false);
      expect(canViewClient({ ...UNASSIGNED, assignedClientIds: [""] }, nameless)).toBe(false);
    });

    it("does not widen the other two roles", () => {
      // assignedClientIds is an EMPLOYEE field. A client user carrying one must
      // not gain another workspace from it, and the OR must not leak upward.
      expect(canViewClient({ ...OTHER_CLIENT, assignedClientIds: ["c1"] }, CLIENT)).toBe(false);
      expect(
        canViewClient(
          { uid: "x", role: "SOMETHING_NEW", clientId: null, assignedClientIds: ["c1"] } as any,
          CLIENT,
        ),
      ).toBe(false);
    });
  });

  it("refuses a role that is none of the three", () => {
    expect(canViewClient({ uid: "x", role: "SOMETHING_NEW", clientId: "c1" } as any, CLIENT)).toBe(
      false,
    );
  });

  it("refuses a client user whose account is not linked to any client", () => {
    // `clientId: null` must not match a client whose own id is nullish.
    expect(canViewClient({ uid: "u", role: "CLIENT_USER", clientId: null } as any, CLIENT)).toBe(
      false,
    );
    expect(
      canViewClient({ uid: "u", role: "CLIENT_USER", clientId: null } as any, {
        id: undefined as any,
        assignedEmployeeIds: [],
      }),
    ).toBe(false);
  });
});

describe("requireVisibleClient", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  /**
   * Loads auth.ts against mocked Firebase/Firestore and a `notFound` that
   * throws a recognisable marker, the way Next's own does.
   */
  async function load(client: unknown) {
    vi.doMock("server-only", () => ({}));
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
    vi.doMock("next/navigation", () => ({
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
      redirect: (to: string) => {
        throw new Error(`NEXT_REDIRECT:${to}`);
      },
    }));
    vi.doMock("@/lib/firebase/admin", () => ({ adminAuth: () => ({}) }));
    vi.doMock("@/lib/data", () => ({
      getUser: async () => null,
      upsertUser: async () => {},
      countUsers: async () => 1,
      getClientByKeyId: async () => null,
      getClient: async () => client,
    }));
    return await import("@/lib/auth");
  }

  it("404s an unassigned employee instead of serving the client", async () => {
    const { requireVisibleClient } = await load(CLIENT);
    await expect(requireVisibleClient(UNASSIGNED, "c1")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("gives the same answer for a client that does not exist", async () => {
    // One response for both, so the route is not an oracle for which client ids
    // are real — the idiom requireTaskAccess already uses for foreign task ids.
    const { requireVisibleClient } = await load(null);
    await expect(requireVisibleClient(ADMIN, "nope")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("returns the client to the staff who are allowed to open it", async () => {
    const { requireVisibleClient } = await load(CLIENT);
    await expect(requireVisibleClient(ADMIN, "c1")).resolves.toBe(CLIENT);
    await expect(requireVisibleClient(ASSIGNED, "c1")).resolves.toBe(CLIENT);
    await expect(requireVisibleClient(OWN_CLIENT, "c1")).resolves.toBe(CLIENT);
  });
});

/**
 * The WRITE half of the fence, which was the site still reading one field.
 *
 * `authorizeClient` in planned-run-actions is the refusal an employee actually
 * sees ("You are not assigned to this client."), and it re-derived the rule
 * from `client.assignedEmployeeIds` instead of asking the shared predicate — so
 * it refused every employee assigned through the team page, on a write, with a
 * sentence telling them to get assigned to a client they already were.
 */
describe("planned-run-actions asks the shared predicate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function load(staff: unknown) {
    vi.doMock("server-only", () => ({}));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));
    // Partial, not a replacement: the assignment rule itself now lives in
    // `_shared.clientAccessRefusal` (beside the other authorizers, so the
    // actions layer states it once), and stubbing the whole module out would
    // leave this block driving a fence that had been replaced by a stub. Only
    // the session readers are faked.
    vi.doMock("@/lib/actions/_shared", async (io) => ({
      ...(await io<typeof import("@/lib/actions/_shared")>()),
      requireStaff: async () => staff,
      requireClientAccess: async () => staff,
      logActivity: async () => {},
    }));
    vi.doMock("@/lib/data", () => ({
      getClient: async () => CLIENT,
      // Reached only if the fence lets the caller through — which is exactly
      // what the positive case below detects.
      getCustomAgent: async () => null,
      createPlannedScheduledRun: async () => "p1",
      deletePlannedScheduledRun: async () => {},
      getPlannedScheduledRun: async () => null,
      listJobs: async () => [],
      listPlannedScheduledRuns: async () => [],
      updatePlannedScheduledRun: async () => {},
    }));
    vi.doMock("@/lib/client-agent-gate", () => ({ clientAgentRunRefusal: async () => null }));
    vi.doMock("@/lib/jobs/schedule-gate", () => ({ unfireableScheduleReason: async () => null }));
    const mod = await import("@/lib/actions/planned-run-actions");
    return mod.createPlannedRunAction;
  }

  const INPUT = {
    clientId: "c1",
    customAgentId: "a1",
    prompt: "Draft a weekly post.",
    cadence: "once" as const,
    runAt: Date.now() + 86_400_000,
  };

  it("refuses an employee neither document records", async () => {
    const create = await load(UNASSIGNED);
    await expect(create(INPUT)).resolves.toEqual({
      error: "You are not assigned to this client.",
    });
  });

  it("lets through an employee assigned on the USER document", async () => {
    // The lockout, on the write path: `assignedEmployeeIds` does not name them.
    const create = await load({ ...UNASSIGNED, assignedClientIds: ["c1"] });
    // Past the fence — it fails on the mocked-missing agent instead, which is
    // the next check and proves the refusal above was the fence and not this.
    await expect(create(INPUT)).resolves.toEqual({ error: "Agent not found." });
  });

  it("lets through an employee assigned on the CLIENT document", async () => {
    const create = await load(ASSIGNED);
    await expect(create(INPUT)).resolves.toEqual({ error: "Agent not found." });
  });
});

/**
 * A fence the fenced actor can lift is not a fence.
 *
 * `updateClientAction` is gated on `requireStaff()` alone and takes a whole
 * `Partial<Client>`, so before this it forwarded `assignedEmployeeIds` straight
 * into Firestore — the one field `canViewClient` now reads. An employee 404'd
 * on a client's pages could post their own uid into that array and be let in.
 */
describe("updateClientAction cannot write the field the fence reads", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function load() {
    const updateClient = vi.fn(async (_id: string, _patch: Record<string, unknown>) => {});
    vi.doMock("server-only", () => ({}));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));
    vi.doMock("next/server", () => ({ after: () => {} }));
    vi.doMock("@/lib/branding", () => ({ applyBrandingForClient: async () => {} }));
    vi.doMock("@/lib/auth", () => ({ requireUser: async () => UNASSIGNED }));
    vi.doMock("@/lib/actions/_shared", () => ({
      requireStaff: async () => UNASSIGNED,
      logGenerationFailure: async () => {},
    }));
    vi.doMock("@/lib/data", () => ({
      createClient: async () => "c-new",
      updateClient,
      deleteClientCascade: async () => {},
      getClientByKeyId: async () => null,
      tryAcquireAiProcessingLock: async () => false,
      releaseAiProcessingLock: async () => {},
    }));
    const mod = await import("@/lib/actions/client-actions");
    return { updateClient, updateClientAction: mod.updateClientAction };
  }

  it("strips a self-assignment out of an otherwise ordinary patch", async () => {
    const { updateClient, updateClientAction } = await load();
    await updateClientAction("c1", {
      name: "Acme",
      assignedEmployeeIds: [UNASSIGNED.uid],
    } as any);
    const patch = updateClient.mock.calls[0][1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("assignedEmployeeIds");
    // Positive half: the edit the form actually makes still lands.
    expect(patch.name).toBe("Acme");
  });

  it("still strips the fields it always did", async () => {
    const { updateClient, updateClientAction } = await load();
    await updateClientAction("c1", {
      clientKeyId: "ck_stolen",
      createdBy: "u-emp-2",
      createdAt: 1,
    } as any);
    const patch = updateClient.mock.calls[0][1] as Record<string, unknown>;
    for (const f of ["clientKeyId", "createdBy", "createdAt"]) {
      expect(patch, f).not.toHaveProperty(f);
    }
  });
});

describe("every /clients/[id] route asks the guard", () => {
  const ROUTES_DIR = join(process.cwd(), "src/app/(app)/clients/[id]");

  /** Every page.tsx and layout.tsx below /clients/[id], found on disk. */
  function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...routeFiles(abs));
      else if (entry.name === "page.tsx" || entry.name === "layout.tsx") out.push(abs);
    }
    return out;
  }

  const files = routeFiles(ROUTES_DIR);

  it("found the routes it is about to check", () => {
    // Without this the sweep below passes by looking at nothing. A floor, not a
    // count: the number is expected to grow and pinning it would make adding a
    // route a test edit.
    expect(files.length).toBeGreaterThan(8);
  });

  it.each(files.map((f) => [f.slice(process.cwd().length + 1), f] as const))(
    "%s",
    (_rel, abs) => {
      const src = readFileSync(abs, "utf8");
      // The CALL, not the mention. Asserting the bare identifier passed on a
      // route whose guard had been deleted, because the import line still
      // carried the name — the check was reading the wrong half of the file.
      expect(src).toMatch(/\brequireVisibleClient\s*\(/);
      // The pair this replaced. Reintroducing it is how the guard gets skipped
      // while `requireVisibleClient` is still called somewhere in the file.
      expect(src).not.toMatch(/getClient\(\s*id\s*\)/);
    },
  );
});
