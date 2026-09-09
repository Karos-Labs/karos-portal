/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * updateClientAction's forbidden-topics lane (docs/dynamic-agent-guardrails.md).
 *
 * The parse happens on the WRITE side, not in the browser, and this file is
 * why that matters: the action takes a whole `Partial<Client>`, so a caller
 * that never touches the form can still post the array directly. Both doors
 * have to be held to the same limits, and the last test here is the one that
 * would go red if someone "simplified" the parse into the component.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth");
vi.mock("@/lib/data");
vi.mock("@/lib/branding", () => ({ applyBrandingForClient: vi.fn() }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));

import { getCurrentUser } from "@/lib/auth";
import * as data from "@/lib/data";
import { MAX_FORBIDDEN_TOPICS } from "@/lib/dynamic-agent-guardrails";

const STAFF = {
  uid: "u-staff",
  email: "staff@karoslabs.test",
  name: "Staff",
  role: "KAROS_EMPLOYEE",
  disabled: false,
  createdAt: 0,
} as any;

function patchWritten() {
  const calls = (data.updateClient as any).mock.calls;
  return calls.length > 0 ? calls[calls.length - 1][1] : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getCurrentUser as any).mockResolvedValue(STAFF);
  (data.updateClient as any).mockResolvedValue(undefined);
});

describe("updateClientAction — forbidden topics", () => {
  it("parses the textarea into the stored array", async () => {
    const { updateClientAction } = await import("@/lib/actions/client-actions");
    const result = await updateClientAction("c1", {
      forbiddenTopicsText: "competitor pricing\npending litigation",
    });
    expect(result).toEqual({ ok: true });
    expect(patchWritten().forbiddenTopics).toEqual(["competitor pricing", "pending litigation"]);
  });

  it("never leaks the raw textarea field into the stored document", async () => {
    const { updateClientAction } = await import("@/lib/actions/client-actions");
    await updateClientAction("c1", { forbiddenTopicsText: "alpha" });
    expect(patchWritten()).not.toHaveProperty("forbiddenTopicsText");
  });

  it("writes an EMPTY array when the box is cleared, rather than dropping the key", async () => {
    // updateClient merges, so a dropped key would leave the old list in force
    // and clearing the box would appear to do nothing.
    const { updateClientAction } = await import("@/lib/actions/client-actions");
    await updateClientAction("c1", { forbiddenTopicsText: "" });
    expect(patchWritten().forbiddenTopics).toEqual([]);
  });

  it("does not touch the field at all when the caller did not send it", async () => {
    // A save from a different form must not clear a client's guardrails.
    const { updateClientAction } = await import("@/lib/actions/client-actions");
    await updateClientAction("c1", { name: "Renamed" });
    expect(patchWritten()).not.toHaveProperty("forbiddenTopics");
  });

  it("de-duplicates and drops blanks on the way in", async () => {
    const { updateClientAction } = await import("@/lib/actions/client-actions");
    await updateClientAction("c1", { forbiddenTopicsText: "Alpha\n\nalpha\n   \nbeta" });
    expect(patchWritten().forbiddenTopics).toEqual(["Alpha", "beta"]);
  });

  it("caps the list rather than storing an unbounded one", async () => {
    const { updateClientAction } = await import("@/lib/actions/client-actions");
    const many = Array.from({ length: MAX_FORBIDDEN_TOPICS + 20 }, (_, i) => `topic ${i}`).join("\n");
    await updateClientAction("c1", { forbiddenTopicsText: many });
    expect(patchWritten().forbiddenTopics).toHaveLength(MAX_FORBIDDEN_TOPICS);
  });

  it("holds a caller that posts the ARRAY directly to the same rules", async () => {
    // The form is not the fence — the action is. This is the door a "simplify
    // it into the component" refactor would leave open.
    const { updateClientAction } = await import("@/lib/actions/client-actions");
    await updateClientAction("c1", {
      forbiddenTopics: ["Alpha", "alpha", "   ", "y".repeat(500)],
    });
    const stored = patchWritten().forbiddenTopics as string[];
    expect(stored).toHaveLength(2);
    expect(stored[0]).toBe("Alpha");
    expect(stored[1]!.length).toBeLessThanOrEqual(120);
  });

  it("still refuses a non-staff session before writing anything", async () => {
    (getCurrentUser as any).mockResolvedValue({ ...STAFF, role: "CLIENT_USER", clientId: "c1" });
    const { updateClientAction } = await import("@/lib/actions/client-actions");
    await expect(updateClientAction("c1", { forbiddenTopicsText: "x" })).rejects.toThrow();
    expect(data.updateClient).not.toHaveBeenCalled();
  });
});
