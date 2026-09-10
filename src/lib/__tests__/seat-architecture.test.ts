import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateSeatAddition, CREDIT_COSTS } from "@/lib/credits";

/* ── Monetization gate (pure) ────────────────────────────────────────── */

describe("evaluateSeatAddition — monetization gate", () => {
  const base = { seatLimit: 2, availableCredits: 1000, seatCost: CREDIT_COSTS.employeeSeat };

  it("is free within the plan seat limit", () => {
    const a = evaluateSeatAddition({ ...base, currentSeatCount: 0 });
    expect(a).toMatchObject({ allowed: true, requiresCharge: false, cost: 0 });
    expect(evaluateSeatAddition({ ...base, currentSeatCount: 1 }).requiresCharge).toBe(false);
  });

  it("charges credits for the first seat at/over the limit", () => {
    const a = evaluateSeatAddition({ ...base, currentSeatCount: 2 });
    expect(a).toMatchObject({ allowed: true, requiresCharge: true, cost: CREDIT_COSTS.employeeSeat });
  });

  it("blocks with an upgrade prompt when the client can't afford the seat", () => {
    const a = evaluateSeatAddition({ ...base, currentSeatCount: 2, availableCredits: 0 });
    expect(a.allowed).toBe(false);
    expect(a.requiresCharge).toBe(true);
    expect(a.reason).toMatch(/upgrade|credits/i);
  });

  it("prices the blocked seat as a one-time credit charge, never a monthly fee", () => {
    const a = evaluateSeatAddition({ ...base, currentSeatCount: 2, availableCredits: 0 });
    // The charge fires once per seat added over the limit. Quoting a dollar
    // "≈ $29/mo" equivalence sold that one-off as a subscription price.
    expect(a.reason).toMatch(/one-time/i);
    expect(a.reason).not.toMatch(/\$|\/mo\b|per month|monthly/i);
    expect(a.reason).toContain(String(CREDIT_COSTS.employeeSeat));
  });

  it("lets staff (non-billable) exceed the limit for free", () => {
    const a = evaluateSeatAddition({ ...base, currentSeatCount: 5, availableCredits: 0, billable: false });
    expect(a).toMatchObject({ allowed: true, requiresCharge: false, cost: 0 });
  });
});

/* ── Seat data boundaries (encrypted at rest, active-only sync) ───────── */

const store = new Map<string, Record<string, unknown> | undefined>();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => {
  const docRef = (id: string) => ({
    id,
    async get() {
      const data = store.get(id);
      return { exists: data !== undefined, id, data: () => data };
    },
  });
  const db = {
    collection: () => ({ doc: (id: string) => docRef(id) }),
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        async get(ref: { id: string }) {
          const data = store.get(ref.id);
          return { exists: data !== undefined, id: ref.id, data: () => data };
        },
        set(ref: { id: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) {
          const prev = opts?.merge ? store.get(ref.id) ?? {} : {};
          store.set(ref.id, { ...prev, ...data });
        },
      }),
  };
  return { adminDb: () => db };
});

import {
  addEmployeeSeat,
  listEmployeeSeats,
  getEmployeeSeatsForSync,
  updateEmployeeSeat,
  removeEmployeeSeat,
} from "@/lib/data";
import { isEncrypted } from "@/lib/crypto/token-cipher";

describe("employee-seat data layer", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "0".repeat(64);
    store.clear();
    store.set("c1_linkedin", {
      id: "c1_linkedin",
      clientId: "c1",
      platform: "linkedin",
      credentials: {},
      method: "oauth",
      employeeSeats: [],
      connectedBy: "u1",
      connectedAt: 0,
      updatedAt: 0,
    });
  });
  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("stores seat tokens ENCRYPTED at rest", async () => {
    await addEmployeeSeat("c1", {
      employeeName: "Ada",
      employeeEmail: "ada@acme.com",
      credentials: { accessToken: "secret-at", refreshToken: "secret-rt" },
      status: "active",
      addedBy: "u1",
    });
    const seats = await listEmployeeSeats("c1");
    expect(seats).toHaveLength(1);
    expect(isEncrypted(seats[0].credentials.accessToken)).toBe(true);
    expect(seats[0].credentials.accessToken).not.toContain("secret-at");
  });

  it("getEmployeeSeatsForSync returns only ACTIVE seats with DECRYPTED tokens", async () => {
    await addEmployeeSeat("c1", { employeeName: "Ada", employeeEmail: "a@x.com", credentials: { accessToken: "at1" }, status: "active", addedBy: "u1" });
    await addEmployeeSeat("c1", { employeeName: "Grace", employeeEmail: "g@x.com", credentials: { accessToken: "at2" }, status: "paused", addedBy: "u1" });

    const forSync = await getEmployeeSeatsForSync("c1");
    expect(forSync).toHaveLength(1);
    expect(forSync[0].employeeName).toBe("Ada");
    expect(forSync[0].credentials.accessToken).toBe("at1"); // decrypted
  });

  it("pausing a seat removes it from the sync set", async () => {
    const seat = await addEmployeeSeat("c1", { employeeName: "Ada", employeeEmail: "a@x.com", credentials: { accessToken: "at" }, status: "active", addedBy: "u1" });
    await updateEmployeeSeat("c1", seat.id, { status: "paused" });
    expect(await getEmployeeSeatsForSync("c1")).toHaveLength(0);
  });

  it("removes a seat entirely", async () => {
    const seat = await addEmployeeSeat("c1", { employeeName: "Ada", employeeEmail: "a@x.com", credentials: {}, status: "active", addedBy: "u1" });
    await removeEmployeeSeat("c1", seat.id);
    expect(await listEmployeeSeats("c1")).toHaveLength(0);
  });

  it("refuses to add a seat when the LinkedIn integration is missing", async () => {
    store.clear(); // no c1_linkedin doc
    await expect(
      addEmployeeSeat("c1", { employeeName: "Ada", employeeEmail: "a@x.com", credentials: {}, status: "active", addedBy: "u1" }),
    ).rejects.toThrow(/LinkedIn/i);
  });
});
