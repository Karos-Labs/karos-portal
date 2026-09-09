/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHICH DOCUMENT TIERS THE X ROSTER PROPOSAL IS BUILT FROM (#59).
 *
 * The reported symptom: staff press "Propose accounts" for a client with a
 * complete Intel workspace and read "Not enough client context yet — finish
 * onboarding first". The cause: `getClientContextDoc` gained a required tier and
 * an exact `where("tier","==",tier)`, and this action asks for the CLIENT tier —
 * which a lab-imported client does not have at all
 * (`scripts/import-lab-client.ts` writes tier "internal" and nothing else).
 *
 * The fix is NOT a blanket fallback, and this file is where that is pinned.
 * `src/lib/actions/intel-actions.ts` refuses cross-tier fallback in two places
 * for anything a CLIENT_USER can trigger, because the internal copy is the
 * uncondensed analyst version — `src/lib/intel/condense.ts` exists to strip
 * internal methodology and competitor-derogatory labels out of it — and this
 * action's model output IS rendered to the client (x-agent-intake.tsx paints the
 * per-handle `why`). So the second tier is granted to STAFF only, and the
 * assertions below are on the tier list the action actually passes, not on the
 * text of the branch that chooses it.
 *
 * The last two cases drive the whole action against a client whose documents
 * exist only at the internal tier, which is the reported state.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/auth");
vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: Object.assign((id: string) => ({ id }), {
    tools: { webSearch_20250305: () => ({}) },
  }),
}));
vi.mock("@/services/logger", () => ({
  logger: { logUsage: vi.fn(), logGenerationFailure: vi.fn() },
  readWebSearchCount: () => 0,
}));

import { generateText } from "ai";
import * as data from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";

const CLIENT_USER = {
  uid: "u-client",
  email: "dana@acme.test",
  name: "Dana",
  role: "CLIENT_USER" as const,
  clientId: "c1",
  createdAt: 0,
};
const EMPLOYEE = {
  uid: "u-emp",
  email: "tomer@karoslabs.com",
  name: "Tomer",
  role: "KAROS_EMPLOYEE" as const,
  createdAt: 0,
};
const ADMIN = {
  uid: "u-admin",
  email: "hello@karoslabs.com",
  name: "Daniel",
  role: "KAROS_ADMIN" as const,
  createdAt: 0,
};
/**
 * An admin in "View as Client" reaches a server action AS the client user, with
 * `impersonatedBy` set (auth.ts). Impersonation exists to see what the client
 * sees, so it must get the client's tier list — not the admin's.
 */
/**
 * "View as Client" AS `getCurrentUser` ACTUALLY RETURNS IT.
 *
 * This was `{ ...CLIENT_USER, impersonatedBy }` — role CLIENT_USER — so the role
 * rung alone already yielded ["client"] and the test named for the impersonation
 * clause passed for a reason that had nothing to do with it: deleting
 * `!user.impersonatedBy &&` from the guard left the whole suite green.
 *
 * `getCurrentUser` re-reads the impersonation cookie and returns the TARGET with
 * `impersonatedBy` stamped on it, so the reachable shape depends on the target's
 * role — and an admin impersonating a member of STAFF is the case where the role
 * rung says "staff" and only the impersonation clause says otherwise. That is the
 * shape the exemption exists for, so that is the shape the fixture has to be.
 */
const IMPERSONATING_ADMIN = { ...EMPLOYEE, impersonatedBy: "u-admin" };

/** The original shape too — a client target — so both are covered. */
const IMPERSONATING_INTO_CLIENT = { ...CLIENT_USER, impersonatedBy: "u-admin" };

const ROSTER = JSON.stringify(
  Array.from({ length: 10 }, (_, i) => ({ handle: `@voice${i}`, why: "relevant" })),
);

const propose = async () => {
  const { proposeXRosterAction } = await import("@/lib/actions/x-agent-actions");
  return proposeXRosterAction({ clientId: "c1" });
};

/** Every `tiers` argument the action passed, one entry per document read. */
const tierListsAsked = () =>
  vi.mocked(data.getClientContextDocInTierOrder).mock.calls.map((call) => call[2]);

/** The docTypes the action read, so a tier assertion cannot pass on the wrong document. */
const docTypesAsked = () =>
  vi.mocked(data.getClientContextDocInTierOrder).mock.calls.map((call) => call[1]);

/**
 * A client whose documents exist ONLY at the internal tier, answered the way the
 * real ordered read answers: the internal copy is returned when — and only when —
 * the caller named that tier.
 */
function labImportedClient() {
  // assignedEmployeeIds: ["u-emp"] — EMPLOYEE must clear requireClientAccess's
  // D-77 assignment fence (2026-08) before this file's actual subject (which
  // tier its proposal draws from) is ever reached; this file isn't testing
  // tenancy, so the fixture just needs to be a legitimately-assigned employee.
  vi.mocked(data.getClient).mockResolvedValue({
    id: "c1",
    name: "Acme",
    assignedEmployeeIds: ["u-emp"],
  } as any);
  vi.mocked(data.getClientContextDocInTierOrder).mockImplementation(
    async (_clientId, docType, tiers) =>
      tiers.includes("internal")
        ? ({ content: `INTERNAL ${docType}` } as any)
        : null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(data.chargeClientCredits).mockResolvedValue({ balance: 100 } as any);
  vi.mocked(data.creditClientCredits).mockResolvedValue({ balance: 100 } as any);
  // A brief on the client record keeps the tier-selection cases off the refusal
  // path, so those tests are about the tiers and nothing else.
  // assignedEmployeeIds: ["u-emp"] — same reason as labImportedClient() above.
  vi.mocked(data.getClient).mockResolvedValue({
    id: "c1",
    name: "Acme",
    brief: "We sell things.",
    assignedEmployeeIds: ["u-emp"],
  } as any);
  vi.mocked(data.getClientContextDocInTierOrder).mockResolvedValue(null as any);
  vi.mocked(generateText).mockResolvedValue({ text: ROSTER } as any);
});

describe("proposeXRosterAction — the tiers each actor's context may come from", () => {
  it("asks a CLIENT_USER's proposal for the published copy only", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(CLIENT_USER as any);

    await propose();

    expect(docTypesAsked().sort()).toEqual(["market-strategy", "target-audience"]);
    for (const tiers of tierListsAsked()) expect(tiers).toEqual(["client"]);
  });

  it("lets an employee's proposal fall back to the internal copy", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(EMPLOYEE as any);

    await propose();

    expect(docTypesAsked().sort()).toEqual(["market-strategy", "target-audience"]);
    for (const tiers of tierListsAsked()) expect(tiers).toEqual(["client", "internal"]);
  });

  it("lets an admin's proposal fall back to the internal copy", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN as any);

    await propose();

    for (const tiers of tierListsAsked()) expect(tiers).toEqual(["client", "internal"]);
  });

  it("gives an admin in View as Client the CLIENT's tier list, not an admin's", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(IMPERSONATING_ADMIN as any);

    await propose();

    for (const tiers of tierListsAsked()) expect(tiers).toEqual(["client"]);
  });

  it("never names the never-published tier for anybody", async () => {
    for (const actor of [CLIENT_USER, EMPLOYEE, ADMIN, IMPERSONATING_ADMIN, IMPERSONATING_INTO_CLIENT]) {
      vi.clearAllMocks();
      vi.mocked(data.getClientContextDocInTierOrder).mockResolvedValue(null as any);
      vi.mocked(generateText).mockResolvedValue({ text: ROSTER } as any);
      vi.mocked(data.getClient).mockResolvedValue({
        id: "c1",
        name: "Acme",
        brief: "We sell things.",
        assignedEmployeeIds: ["u-emp"],
      } as any);
      vi.mocked(getCurrentUser).mockResolvedValue(actor as any);

      await propose();

      expect(tierListsAsked().length, `${actor.role} read no documents`).toBe(2);
      for (const tiers of tierListsAsked()) {
        expect(tiers, `${actor.role} named internal-only`).not.toContain("internal-only");
      }
    }
  });
});

describe("proposeXRosterAction — a client whose documents are internal-tier only", () => {
  it("proposes for staff instead of refusing (the reported #59 symptom)", async () => {
    labImportedClient();
    vi.mocked(getCurrentUser).mockResolvedValue(EMPLOYEE as any);

    const out = await propose();

    expect(out.error).toBeUndefined();
    expect(out.handles).toHaveLength(10);
    // The internal copy reached the prompt — a proposal built from the company
    // name alone would satisfy the assertion above.
    const prompt = vi.mocked(generateText).mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain("INTERNAL target-audience");
    expect(prompt).toContain("INTERNAL market-strategy");
  });

  it("still refuses a client user, and names work that would actually unblock it", async () => {
    labImportedClient();
    vi.mocked(getCurrentUser).mockResolvedValue(CLIENT_USER as any);

    const out = await propose();

    expect(out.handles).toBeUndefined();
    expect(out.error).toBe(
      "Not enough about your brand on file yet to suggest accounts. Ask your Karos team to finish your brand documents, or type accounts manually.",
    );
    // The old line sent them to finish an onboarding that is already finished.
    expect(out.error).not.toMatch(/onboarding/i);
    // Refused before the model, so nothing was charged for a refusal.
    expect(generateText).not.toHaveBeenCalled();
    expect(vi.mocked(data.chargeClientCredits).mock.calls).toHaveLength(0);
  });
});
