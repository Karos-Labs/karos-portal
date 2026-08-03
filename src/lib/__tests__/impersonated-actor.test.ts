/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #41 — an action taken in "View as Client" is not the client's action.
 *
 * `getCurrentUser` returns the TARGET user carrying `impersonatedBy`, so a
 * staff member in View as Client arrives at every writer as a CLIENT_USER with
 * the client contact's own name. Fifteen activity writers stamp rows with
 * `actor: user.name, actorRole: user.role === "CLIENT_USER" ? "client" : "staff"`,
 * so every one of them signed the agency's work with the client's name — on the
 * timeline the client reads and the one staff debug from.
 *
 * The correction lives in the funnel (`logActivity`), because the writers are
 * not the thing that is wrong: what is wrong is the session they all read.
 */
import { CLIENT_SAFE_ACTOR, SYSTEM_AI_ACTOR_NAME, sessionSafeActor } from "@/lib/activity-actors";

const REAL_CLIENT = { impersonatedBy: undefined };
const IMPERSONATED = { impersonatedBy: "u-admin" };

const clientRow = () => ({
  clientId: "c1",
  timestamp: 1,
  type: "CAMPAIGN_CREATED" as const,
  title: "Instagram agent started a run",
  actor: "Jane Client",
  actorRole: "client" as const,
});

describe("sessionSafeActor", () => {
  it("stops an impersonated action being recorded as the client's own", () => {
    const row = sessionSafeActor(clientRow(), IMPERSONATED);
    expect(row.actor).not.toBe("Jane Client");
    expect(row.actor).toBe(CLIENT_SAFE_ACTOR);
    expect(row.actorRole).toBe("staff");
  });

  it("records WHICH staff member, without putting a uid on the row's face", () => {
    const row = sessionSafeActor(clientRow(), IMPERSONATED);
    expect(row.impersonatedBy).toBe("u-admin");
    // The uid is the debugging half and stays out of the display fields — the
    // timeline's RSC projection is a whitelist that does not include it.
    expect(row.actor).not.toContain("u-admin");
    expect(row.title).not.toContain("u-admin");
  });

  it("leaves a real client's own action exactly as it was", () => {
    const before = clientRow();
    expect(sessionSafeActor(before, REAL_CLIENT)).toBe(before);
    expect(sessionSafeActor(before, null)).toBe(before);
    expect(sessionSafeActor(before, undefined)).toBe(before);
  });

  it("leaves system and staff rows alone even under impersonation", () => {
    // A cron or an AI writer really did fire, and a row already claiming staff
    // is already true. Rewriting either would be a second falsehood, and the
    // system row would lose which pipeline wrote it.
    const system = { ...clientRow(), actor: SYSTEM_AI_ACTOR_NAME, actorRole: "system" as const };
    const staff = { ...clientRow(), actor: "Tomer H.", actorRole: "staff" as const };
    expect(sessionSafeActor(system, IMPERSONATED)).toBe(system);
    expect(sessionSafeActor(staff, IMPERSONATED)).toBe(staff);
  });

  it("carries the rest of the row through untouched", () => {
    const row = sessionSafeActor({ ...clientRow(), description: "kept" }, IMPERSONATED);
    expect(row.title).toBe("Instagram agent started a run");
    expect(row.description).toBe("kept");
    expect(row.clientId).toBe("c1");
    expect(row.type).toBe("CAMPAIGN_CREATED");
  });
});

/**
 * The retroactivity check, run as a test rather than asserted in a comment.
 *
 * Changing what a writer stores is only safe if nothing READS the old shape by
 * matching on it. `actor` is matched in exactly one place — `isInternalActor`,
 * against four registered internal names — and `actorRole` is matched nowhere:
 * the timeline's three role branches resolve to the same style. So rows already
 * on disk keep rendering exactly as they did.
 */
describe("the correction is not retroactive", () => {
  it("does not make an impersonated row match the internal-actor registry", async () => {
    const { isInternalActor } = await import("@/lib/activity-actors");
    const row = sessionSafeActor(clientRow(), IMPERSONATED);
    // If it did, clientSafeActor would rewrite its role to "system" for a
    // client viewer and the row would read as automation rather than as us.
    expect(isInternalActor(row.actor)).toBe(false);
  });

  it("survives the client-viewer projection with the honest attribution intact", async () => {
    const { clientSafeActor } = await import("@/lib/activity-actors");
    const row = sessionSafeActor(clientRow(), IMPERSONATED);
    expect(clientSafeActor(row.actor, row.actorRole, true)).toEqual({
      actor: CLIENT_SAFE_ACTOR,
      actorRole: "staff",
    });
  });

  it("keeps the staff uid out of the browser payload", () => {
    // The marker is stored for debugging, and the promise attached to storing a
    // uid on a client-readable collection is that it does not travel. Two
    // whitelists decide that: the RSC projection in tasks-body.tsx, and the
    // TimelineActivity interface the "use client" component is typed by.
    const projection = readFileSync(
      join(process.cwd(), "src/app/(app)/tasks/tasks-body.tsx"),
      "utf8",
    );
    const block = projection.slice(
      projection.indexOf("const timelineActivity"),
      projection.indexOf("const agentLabelByAssetId"),
    );
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toContain("impersonatedBy");

    const ui = readFileSync(join(process.cwd(), "src/components/activity-timeline.tsx"), "utf8");
    const iface = ui.slice(
      ui.indexOf("export interface TimelineActivity"),
      ui.indexOf("/* ── Unified display event"),
    );
    expect(iface.length).toBeGreaterThan(50);
    expect(iface).not.toContain("impersonatedBy");
  });

  it("does not put the marker where an activity row's own copy is read", () => {
    // Nothing may render it, precisely because absent cannot mean "the client
    // did this" — history never recorded the difference. A reader would be
    // making that claim about every row written before the field existed.
    const ui = readFileSync(join(process.cwd(), "src/components/activity-timeline.tsx"), "utf8");
    expect(ui).not.toContain("impersonatedBy");
  });
});

describe("logActivity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function load(sessionUser: unknown) {
    const created: any[] = [];
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/auth", () => ({ getCurrentUser: async () => sessionUser }));
    vi.doMock("@/lib/data", () => ({
      createActivityLog: async (row: any) => {
        created.push(row);
        return "log-1";
      },
      getClientTask: async () => null,
    }));
    const { logActivity } = await import("@/lib/actions/_shared");
    return { logActivity, created };
  }

  it("re-attributes a client-claimed row written in View as Client", async () => {
    const { logActivity, created } = await load({
      uid: "u-client",
      name: "Jane Client",
      role: "CLIENT_USER",
      impersonatedBy: "u-admin",
    });
    await logActivity(clientRow());
    expect(created).toHaveLength(1);
    expect(created[0].actor).toBe(CLIENT_SAFE_ACTOR);
    expect(created[0].actorRole).toBe("staff");
    expect(created[0].impersonatedBy).toBe("u-admin");
  });

  it("writes a real client's row unchanged, and does not invent the marker", async () => {
    const { logActivity, created } = await load({
      uid: "u-client",
      name: "Jane Client",
      role: "CLIENT_USER",
    });
    await logActivity(clientRow());
    expect(created[0].actor).toBe("Jane Client");
    expect(created[0].actorRole).toBe("client");
    expect(created[0].impersonatedBy).toBeUndefined();
  });

  it("still writes the row when the session cannot be resolved", async () => {
    // Attribution, not authorization: a cron has no session, and dropping a
    // real event from the trail is worse than leaving the caller's own claim on
    // it. The row is written exactly as built.
    const { logActivity, created } = await load(null);
    await logActivity(clientRow());
    expect(created).toHaveLength(1);
    expect(created[0].actor).toBe("Jane Client");
  });

  it("does not consult the session for a row that never claimed the client", async () => {
    let asked = 0;
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/auth", () => ({
      getCurrentUser: async () => {
        asked++;
        return null;
      },
    }));
    const created: any[] = [];
    vi.doMock("@/lib/data", () => ({
      createActivityLog: async (row: any) => void created.push(row),
      getClientTask: async () => null,
    }));
    const { logActivity } = await import("@/lib/actions/_shared");
    await logActivity({ ...clientRow(), actor: SYSTEM_AI_ACTOR_NAME, actorRole: "system" });
    await logActivity({ ...clientRow(), actor: "Tomer H.", actorRole: "staff" });
    expect(created).toHaveLength(2);
    expect(asked).toBe(0);
  });

  it("stays fire-and-forget when the write throws", async () => {
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/auth", () => ({ getCurrentUser: async () => null }));
    vi.doMock("@/lib/data", () => ({
      createActivityLog: async () => {
        throw new Error("firestore down");
      },
      getClientTask: async () => null,
    }));
    const { logActivity } = await import("@/lib/actions/_shared");
    await expect(logActivity(clientRow())).resolves.toBeUndefined();
  });
});
